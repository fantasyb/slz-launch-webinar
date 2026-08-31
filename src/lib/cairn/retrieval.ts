/**
 * Retrieval for a corpus whose queries are machine output, not prose.
 *
 * Every general-purpose memory system indexes English and retrieves by
 * semantic similarity. That is the right call when the query is a question a
 * person typed. It is the wrong call here, because the query that matters is
 * almost never a question — it is the error the agent just got:
 *
 *     Error: ENOSPC: no space left on device, write
 *     CONNECT tunnel failed, response 403
 *     rg: regex parse error: repetition quantifier expects a valid decimal
 *
 * That text has structure English does not. Error codes, exit statuses, absolute
 * paths and tool names are near-unique identifiers, and the words around them
 * are filler. Matching stderr against stderr is a different problem from
 * matching a question against documents, and it is one we can solve exactly
 * rather than approximately.
 *
 * So there are no embeddings here, and that is not a resource compromise. Four
 * stages, each cheaper than the one after it, each discarding work the next
 * would waste:
 *
 *   0. APPLICABILITY  Does this finding's precondition hold on this machine?
 *                     Microseconds, no query needed. Nobody else can do this
 *                     because nobody else's entries declare machine-checkable
 *                     scope.
 *   1. SIGNATURE      Weight each query term by its information content in
 *                     this corpus. `ENOSPC` is worth a great deal; `on` is
 *                     worth nothing, arithmetically rather than by a stoplist.
 *   2. INFORMATION    Break ties toward findings that models forecast WRONG.
 *                     The searcher is usually a model; the finding it cannot
 *                     derive is the one worth surfacing.
 *   3. CONFIRMATION   Run the check. A finding that fires on this machine now
 *                     is not a search result, it is a diagnosis. See
 *                     `confirmCandidates`, which is opt-in and local-only.
 *
 * Stages 0-2 are pure, offline, and complete in well under a millisecond over
 * a corpus this size. Stage 3 costs seconds and is never automatic.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Finding } from './schema';
import { surprise } from './calibration';
import { confidence } from './decay';
import { matchEnvironment } from './precondition';
import { coOccurrence } from './graph';

/**
 * POSIX errno symbols and their plain-English meanings.
 *
 * This is the vocabulary gap that sank the old search: an agent pastes
 * `ENOSPC` and the finding about disks says "no space", so a substring match
 * returns nothing and a reader concludes the corpus is empty on the single
 * most likely query it will ever get.
 *
 * An embedding model learns this mapping fuzzily and expensively. It is in
 * fact a small closed table that has not changed in decades, so it is written
 * down. Both directions are indexed: the code finds prose findings, and prose
 * queries find findings that quote the raw code.
 */
const ERRNO_ALIASES: Record<string, string[]> = {
  ENOSPC: ['no space', 'disk full', 'out of space', 'quota', 'disk'],
  ENOENT: ['no such file', 'not found', 'missing file'],
  EACCES: ['permission denied', 'access denied', 'forbidden'],
  EPERM: ['operation not permitted', 'permission'],
  ECONNREFUSED: ['connection refused', 'refused', 'not listening'],
  ECONNRESET: ['connection reset', 'reset by peer', 'transfer closed'],
  ETIMEDOUT: ['timed out', 'timeout', 'hang'],
  EADDRINUSE: ['address in use', 'port in use', 'already bound'],
  EMFILE: ['too many open files', 'file descriptor'],
  EPIPE: ['broken pipe'],
  ENOTFOUND: ['dns', 'getaddrinfo', 'could not resolve', 'unknown host'],
  EHOSTUNREACH: ['host unreachable', 'no route'],
  ENETUNREACH: ['network unreachable', 'no route'],
  EISDIR: ['is a directory'],
  ENOTDIR: ['not a directory'],
  EEXIST: ['already exists'],
  EAGAIN: ['resource temporarily unavailable', 'try again'],
};

/**
 * HTTP statuses worth aliasing. Only the ones that mean something specific
 * when an agent hits them — a bare 500 says nothing a finding could be about.
 */
const STATUS_ALIASES: Record<string, string[]> = {
  '401': ['unauthorized', 'auth', 'credential'],
  '403': ['forbidden', 'denied', 'blocked', 'allowlist', 'proxy'],
  '404': ['not found', 'missing'],
  '407': ['proxy authentication', 'proxy'],
  '429': ['rate limit', 'too many requests', 'throttle'],
  '502': ['bad gateway', 'upstream'],
  '504': ['gateway timeout', 'upstream', 'timeout'],
};

/** What a token is, which decides how much a match on it is worth. */
export type TokenKind =
  | 'errno' // ENOSPC, ECONNREFUSED — near-unique
  | 'path' // /opt/pw-browsers — near-unique
  | 'status' // 403, 404
  | 'flag' // --no-sandbox
  | 'word'; // everything else

export interface Token {
  text: string;
  kind: TokenKind;
  /** Multiplier applied on top of the term's information content. */
  weight: number;
}

/**
 * Strip the handful of English suffixes that cost real recall.
 *
 * `proxies` returned nothing while `proxy` returned four findings, which is
 * indefensible on a corpus about tooling — an agent writes whichever the error
 * text used. This is not a stemmer in the Porter sense and should not grow
 * into one: aggressive stemming collapses identifiers that mean different
 * things (`dns`/`dn`, `install`/`instal`), and identifiers are most of what
 * this corpus is about.
 *
 * Guarded on length so short tokens survive intact, and applied to indexing
 * and querying alike so both sides agree.
 */
function stem(t: string): string {
  if (t.includes(' ')) return t; // already-stemmed phrase
  if (t.length < 5) return t;
  if (/[^aeiou]ies$/.test(t)) return `${t.slice(0, -3)}y`; // proxies -> proxy
  if (/(ss|us|is)$/.test(t)) return t; // class, status, axis
  if (/(ches|shes|xes|ses)$/.test(t)) return t.slice(0, -2); // caches -> cache
  if (/[^s]s$/.test(t)) return t.slice(0, -1); // browsers -> browser
  return t;
}

const KIND_WEIGHT: Record<TokenKind, number> = {
  errno: 4,
  path: 3,
  flag: 2.5,
  status: 2,
  word: 1,
};

/**
 * Split text into typed tokens.
 *
 * Deliberately not a natural-language tokenizer. It preserves the things that
 * identify a failure — paths keep their slashes, flags keep their dashes,
 * error codes keep their case — because those are exactly the tokens a
 * word-splitter destroys and they carry nearly all the signal.
 */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const seen = new Set<string>();

  const push = (raw: string, kind: TokenKind) => {
    const t = raw.toLowerCase();
    // Single characters and pure punctuation identify nothing.
    if (t.length < 2) return;
    const key = `${kind}:${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, kind, weight: KIND_WEIGHT[kind] });
    // The stem is emitted as a second, slightly cheaper token rather than
    // replacing the surface form, so an exact match still outranks a
    // morphological one.
    const st = stem(t);
    if (st !== t && !seen.has(`${kind}:${st}`)) {
      seen.add(`${kind}:${st}`);
      out.push({ text: st, kind, weight: KIND_WEIGHT[kind] * 0.85 });
    }
  };

  // Absolute paths first, before the generic splitter eats the slashes.
  for (const m of text.matchAll(/(?:^|[\s"'`(<=])(\/[A-Za-z0-9_.\-/]{2,})/g)) {
    push(m[1], 'path');
  }
  // Long flags.
  for (const m of text.matchAll(/(?:^|\s)(--[A-Za-z][A-Za-z0-9-]{1,40})/g)) {
    push(m[1], 'flag');
  }
  // errno-shaped symbols: all caps, E-prefixed or not, standing alone.
  for (const m of text.matchAll(/\b([A-Z]{2,}[A-Z0-9_]{1,20})\b/g)) {
    const sym = m[1];
    push(sym, ERRNO_ALIASES[sym] ? 'errno' : 'word');
    for (const alias of ERRNO_ALIASES[sym] ?? []) {
      for (const w of alias.split(/\s+/)) push(w, 'word');
    }
  }
  // HTTP statuses.
  for (const m of text.matchAll(/\b([1-5]\d{2})\b/g)) {
    const code = m[1];
    if (!STATUS_ALIASES[code]) continue;
    push(code, 'status');
    for (const alias of STATUS_ALIASES[code]) {
      for (const w of alias.split(/\s+/)) push(w, 'word');
    }
  }
  // Everything else. Keeps dots and dashes inside a token so `node:dns`,
  // `pw-browsers` and `z.infer` survive as single identifiers.
  const words: string[] = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.:-]{1,60}/g)) {
    const w = m[0].replace(/[.:_-]+$/, '');
    push(w, 'word');
    if (w.length >= 2) words.push(w.toLowerCase());
  }

  /*
   * Adjacent word pairs were tried here and removed, because they were
   * measured and they made retrieval worse.
   *
   * The reasoning was sound: single words cannot separate two findings about
   * Playwright browsers or four about commitment schemes, and what differs is
   * the phrasing of the specific claim. Held-out P@1 went from 0.692 to 0.641.
   * Correcting the coverage denominator, which phrases had inflated, recovered
   * it only to 0.667 — still below not having them.
   *
   * The reason is that the queries this corpus receives are paraphrases, not
   * quotations: an agent describes the failure in its own words, or pastes
   * output whose exact phrasing appears nowhere in the prose. A bigram only
   * fires when phrasing survives, which is precisely when single words would
   * have matched anyway. It adds weight without adding signal, and weight
   * without signal is noise with a high IDF.
   *
   * Kept as a comment rather than deleted because the idea is a standard one
   * and will occur to the next person. It was tried. `npm run cairn:eval`
   * reproduces the comparison.
   */

  return out;
}

/** The text of a finding that a query could reasonably match against. */
function findingText(f: Finding): string {
  return [
    f.title,
    f.claim,
    f.subject.name,
    f.subject.ecosystem,
    f.expectation,
    f.reality,
    f.workaround ?? '',
    // The check is machine text about a machine failure, so it carries the
    // error strings the prose paraphrases. Including it is most of why an
    // error-code query finds anything at all.
    f.check.command,
    f.check.confirmedIf,
    f.check.refutedIf,
    ...f.tags,
    /*
     * Evidence — the captured output of the failure — is indexed, and leaving
     * it out was the single largest accuracy defect measured.
     *
     * It is the closest text in the corpus to what a querying agent actually
     * holds: not a description of the failure but the failure's own output.
     * Held-out evaluation put P@1 at 0.548 for queries drawn from evidence
     * text, and every total miss was output with no prose in it at all --
     * `/dev/vda 252G 8.1G 29G 22% /`, `{"a":"x","b":[]}` -- which no amount of
     * weighting on the prose fields could ever reach, because the tokens
     * simply were not there.
     *
     * The cost is that evidence can no longer serve as an evaluation set.
     * `mechanism` and `appliesTo` stay unindexed for exactly that purpose:
     * index what a query looks like, hold out what explains it. scripts/eval.ts
     * depends on that split.
     */
    ...(f.evidence ?? []).flatMap((e) => [e.command ?? '', e.output ?? '']),
  ].join('\n');
}

/** Fields whose match counts for more, because they are what the finding is about. */
function strongText(f: Finding): string {
  return [f.title, f.subject.name, f.subject.ecosystem, ...f.tags].join('\n');
}

interface Indexed {
  id: string;
  finding: Finding;
  /** Cached at index build; see INDEX_TTL_MS. */
  confidence: number;
  surprise: number | null;
  /** token text -> occurrences, over the whole finding. */
  terms: Map<string, number>;
  strong: Set<string>;
}

export interface CorpusIndex {
  docs: Indexed[];
  /** token text -> how many findings contain it. */
  df: Map<string, number>;
  /**
   * token text -> the documents containing it, with term frequency.
   *
   * This is what makes the corpus size stop mattering. Scoring used to walk
   * every document on every query and ask whether it contained each term,
   * which is O(corpus x query) however fast the inner loop is -- 16ms per
   * query at ten thousand findings, and linear in the corpus forever after.
   * Walking postings instead visits only documents that contain at least one
   * query term, so cost tracks the size of the ANSWER rather than the size of
   * the library. A corpus of a million findings costs the same as one of a
   * hundred for a query that matches ten.
   */
  postings: Map<string, Array<{ doc: number; tf: number }>>;
  n: number;
  builtAt: number;
}

/**
 * How long a built index may be reused.
 *
 * The index caches each finding's confidence, which is the expensive part of
 * scoring by a wide margin: confidence() verifies an ed25519 signature per
 * observation, and computing it per query per matched finding cost 7.5ms where
 * the text matching itself costs microseconds.
 *
 * An hour is safe because confidence decays on a half-life measured in days —
 * twenty at the fastest, three thousand at the slowest. The most a cached
 * value can be wrong by is an hour of decay on a twenty-day half-life, which
 * is under 0.15%, well below the precision anything displays it at. Without a
 * TTL a long-running server would freeze these values for its whole lifetime,
 * which is a different and much worse bug.
 */
const INDEX_TTL_MS = 60 * 60 * 1000;

const indexCache = new WeakMap<object, CorpusIndex>();

/*
 * On-disk index cache.
 *
 * Cold start is what an agent actually pays, and it was 681ms. Precompiling
 * the CLI removed 614ms of TypeScript transpilation; of the 79ms that remained,
 * building the index was 49 -- 22ms of ed25519 verification to cache
 * confidence, and 18ms of tokenising every field of every finding. Both produce
 * exactly the same answer every run until the corpus changes, which makes them
 * the definition of work worth doing once.
 *
 * The cache key is a hash of the corpus content, not a timestamp or a file
 * count. A retrieval tool that answers from a stale index is worse than a slow
 * one: it would return findings that no longer say what it thinks they say,
 * silently, which is the exact failure this corpus exists to record about
 * other systems.
 *
 * Every filesystem operation here is best-effort. A read-only deployment, a
 * missing directory or a corrupted file must all degrade to "compute it
 * again", never to an error -- retrieval works without this and is only
 * slower.
 */
const CACHE_DIR = path.join(process.cwd(), '.cairn-cache');

/*
 * One file per corpus, named by fingerprint.
 *
 * A single shared filename was safe -- a mismatched fingerprint is never
 * served -- but it thrashed: benchmarking builds indexes over synthetic
 * corpora, and each one evicted the real corpus's cache, so the next real
 * lookup paid full price again. Any process that indexes more than one corpus
 * hits this, and a cache that is correct but never warm is just slower code.
 */
function cacheFileFor(fingerprint: string): string {
  return path.join(CACHE_DIR, `index-v${CACHE_SCHEMA}-${fingerprint.slice(0, 16)}.json`);
}

/** Keep the directory from growing without bound as the corpus changes. */
const MAX_CACHE_FILES = 4;

/** Cache shape version. Bump when the cached fields change meaning. */
const CACHE_SCHEMA = 2;

function corpusFingerprint(findings: Finding[]): string {
  const h = crypto.createHash('sha256');
  h.update(String(CACHE_SCHEMA));
  // Full content, not ids or mtimes: an edit that leaves the id alone is
  // exactly the change a weaker key would miss.
  for (const f of findings) h.update(JSON.stringify(f));
  return h.digest('hex');
}

interface CachedDoc {
  id: string;
  confidence: number;
  surprise: number | null;
  terms: Array<[string, number]>;
  strong: string[];
}

function readDiskCache(fingerprint: string): CachedDoc[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFileFor(fingerprint), 'utf8')) as {
      fingerprint: string;
      builtAt: number;
      docs: CachedDoc[];
    };
    if (raw.fingerprint !== fingerprint) return null;
    // Confidence decays with wall-clock time, so the cache expires on the same
    // TTL the in-memory index uses. Everything else in here is time-invariant.
    if (Date.now() - raw.builtAt >= INDEX_TTL_MS) return null;
    return raw.docs;
  } catch {
    return null;
  }
}

function writeDiskCache(fingerprint: string, docs: CachedDoc[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // Written via a temp file and renamed, so a reader never sees a half-written
    // index and a crash mid-write leaves the previous one intact.
    const file = cacheFileFor(fingerprint);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fingerprint, builtAt: Date.now(), docs }));
    fs.renameSync(tmp, file);
    pruneCache();
  } catch {
    /* read-only filesystem, or no space. The index is simply rebuilt next time. */
  }
}

/** Drop all but the newest MAX_CACHE_FILES indexes. Best-effort, like the rest. */
function pruneCache(): void {
  try {
    const files = fs
      .readdirSync(CACHE_DIR)
      .filter((f) => f.startsWith(`index-v${CACHE_SCHEMA}-`) && f.endsWith('.json'))
      .map((f) => {
        const full = path.join(CACHE_DIR, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(MAX_CACHE_FILES)) fs.unlinkSync(stale.full);
  } catch {
    /* nothing here is load-bearing */
  }
}


/**
 * Build (and memoize) an inverted index.
 *
 * Memoized on the findings array identity, so repeated queries in one process
 * pay for tokenizing the corpus once. The old search re-scanned and
 * re-lowercased every field of every finding on every keystroke; this is the
 * difference between O(corpus x query) per call and O(query).
 */
export function buildIndex(findings: Finding[]): CorpusIndex {
  const hit = indexCache.get(findings);
  if (hit && Date.now() - hit.builtAt < INDEX_TTL_MS) return hit;
  const at = new Date();

  const fingerprint = corpusFingerprint(findings);
  const cached = readDiskCache(fingerprint);
  const byId = cached ? new Map(cached.map((d) => [d.id, d])) : null;

  const docs: Indexed[] = findings.map((f) => {
    const hit = byId?.get(f.id);
    if (hit) {
      return {
        id: f.id,
        finding: f,
        confidence: hit.confidence,
        surprise: hit.surprise,
        terms: new Map(hit.terms),
        strong: new Set(hit.strong),
      };
    }
    const terms = new Map<string, number>();
    for (const t of tokenize(findingText(f))) {
      terms.set(t.text, (terms.get(t.text) ?? 0) + 1);
    }
    return {
      id: f.id,
      finding: f,
      confidence: confidence(f, at),
      surprise: surprise(f),
      terms,
      strong: new Set(tokenize(strongText(f)).map((t) => t.text)),
    };
  });

  if (!cached) {
    writeDiskCache(
      fingerprint,
      docs.map((d) => ({
        id: d.id,
        confidence: d.confidence,
        surprise: d.surprise,
        terms: [...d.terms],
        strong: [...d.strong],
      })),
    );
  }

  const df = new Map<string, number>();
  const postings = new Map<string, Array<{ doc: number; tf: number }>>();
  docs.forEach((d, i) => {
    for (const [term, tf] of d.terms) {
      df.set(term, (df.get(term) ?? 0) + 1);
      const list = postings.get(term);
      if (list) list.push({ doc: i, tf });
      else postings.set(term, [{ doc: i, tf }]);
    }
  });

  const index: CorpusIndex = { docs, df, postings, n: docs.length, builtAt: Date.now() };
  indexCache.set(findings, index);
  return index;
}

/**
 * Inverse document frequency, the fix for the failure that started this.
 *
 * `no space left on device` used to return the entire corpus, because `on` is
 * a substring of *connection*, *confidence* and *python*, and every term
 * counted the same. Weighting a term by how much it narrows the corpus makes
 * that arithmetic instead of a judgment call: a term in every finding scores
 * zero without anyone maintaining a stoplist, and a term in one finding
 * dominates. No English-specific knowledge, so it works on tool names and
 * error codes that no stoplist would ever contain.
 */
/**
 * Below this, a term appears in so much of the corpus that matching it is not
 * evidence of anything. log(32/28) on a 31-finding corpus — roughly "in more
 * than 85% of findings".
 */
const NOISE_FLOOR = 0.15;

/**
 * A hit needs at least one term this informative to exist at all.
 *
 * Two floors rather than one, because they answer different questions. The
 * noise floor decides what a term is worth; this decides whether a match
 * happened. Without it, a query of nothing but common words still produced
 * hits — each scoring almost nothing, all scoring almost the same, so the
 * relative cutoff had no gap to cut on and returned two thirds of the corpus
 * ranked by rounding error.
 *
 * Low-information terms still contribute to the score of a hit anchored by a
 * discriminating one; they just cannot conjure a hit on their own. On a corpus
 * of 31 this is roughly "appears in no more than half of it".
 */
const SIGNAL_FLOOR = 0.6;

/**
 * Information credited to a query term the corpus has never seen.
 *
 * Not zero: a term absent from every finding tells you nothing about which
 * finding to pick, but it is still part of what the asker asked, and letting
 * it vanish from the denominator makes a query of entirely unknown words look
 * perfectly explained by whatever incidental word did match.
 */
const MIN_TERM_INFORMATION = 0.5;

/**
 * Language prior: measured where measurement works, listed where it does not.
 *
 * The first version was ~150 English words I chose. That is judgement in a
 * project arguing judgement should be replaced by a number wherever one can be
 * had, so it was replaced by a measurement: term frequencies over 421k tokens
 * of markdown, committed to data/word-frequency.json so every machine ranks
 * from the same table rather than from whatever is installed locally.
 *
 * The guard rejected it. Silence-on-unknown fell from 2 of 3 to 1 of 3, and
 * the measurement predicted exactly that: `dig` and `recent` both occur at 7.1
 * per million, so the table cannot tell a command name from an ordinary word.
 *
 * Two further derivations were tried and measured. Machine-versus-prose ratio
 * within the corpus: no separation at all (`dig` 0.25 against `any` 0.25,
 * `playwright` 0.33 against `match` 0.33). Whether a term appears in any
 * finding's title, subject or tags: 8 of 13 good terms anchorable but 2 of 12
 * bad ones too, and it rejects `enospc` and `vda`, which are exactly the terms
 * that should anchor hardest.
 *
 * WHY NONE OF THEM WORK, WHICH IS THE USEFUL PART
 *
 * The failing case is a Python traceback reading "most recent call last"
 * matching a finding titled "Reading only the most recent record lets one
 * party erase a disagreement". That is the SAME lexical event in both texts.
 * No statistic over characters, frequencies or field positions can separate
 * them, because the difference is what the words mean, and the words are
 * identical. A frequency table can only ever damp terms that are common
 * everywhere; it cannot damp a term that is rare, English, and irrelevant.
 *
 * So the two are combined, and the split is stated rather than blurred: the
 * measured table carries every term above COMMON_RATE, which is where it
 * separates cleanly (file 1383, any 1226, error 1040, string 2181 against
 * quantifier 0, vda 0, playwright 0, enospc 2.4). RESIDUAL_COMMON carries only
 * what the table misses -- ordinary words rare in developer documentation --
 * and it is the honest remainder, small enough to read and audit in full.
 *
 * What would actually close it is semantic similarity, which means embeddings
 * and a model, and that is a dependency this deliberately does not take. The
 * gap is real and named rather than papered over.
 */
const WORD_RATES: Record<string, number> = loadWordRates();

/** Occurrences per million above which the measured table damps a term. */
const COMMON_RATE = 100;

/**
 * Ordinary English the developer-documentation sample rates as rare.
 *
 * Everything here is a word the measured table failed on, kept because
 * removing it costs a measured safety property. It is a hand list and calling
 * it anything else would be dishonest; it is 40 words rather than 150, and
 * each is one the table places under COMMON_RATE despite being unremarkable
 * English.
 */
const RESIDUAL_COMMON = new Set([
  'recent', 'did', 'does', 'known', 'unknown', 'last', 'least', 'most', 'much',
  'many', 'few', 'own', 'same', 'such', 'very', 'quite', 'rather', 'either',
  'neither', 'whether', 'while', 'whom', 'whose', 'toward', 'towards', 'upon',
  'beyond', 'within', 'without', 'across', 'along', 'among', 'behind', 'below',
  'beside', 'besides', 'despite', 'except', 'unless', 'until',
]);

function loadWordRates(): Record<string, number> {
  try {
    const file = path.join(process.cwd(), 'data', 'word-frequency.json');
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { rates: Record<string, number> }).rates;
  } catch {
    // Absent table means a weaker prior, not a crash. Retrieval still works.
    return {};
  }
}

function isCommonWord(t: string): boolean {
  return (WORD_RATES[t] ?? 0) >= COMMON_RATE || RESIDUAL_COMMON.has(t);
}

/**
 * Fraction of a query's information the best hit must account for, or the
 * corpus says nothing.
 *
 * Tuned against real uncovered failures rather than against the held-out
 * accuracy set, so it trades on the axis it is meant to: silence when the
 * corpus does not know, at some cost in recall on queries buried in noise.
 */
const MIN_QUERY_EXPLAINED = 0.28;

/**
 * Explained fraction at which a single signal is allowed to stand alone.
 *
 * Above this the query is so nearly accounted for that demanding a second
 * independent detector would only reject short, precise questions — "proxies"
 * explains ~1.0 of itself and can never carry more than one signal.
 */
const MIN_EXPLAINED_ALONE = 0.6;

function idf(df: number, n: number): number {
  if (df <= 0) return 0;
  return Math.max(0, Math.log((n + 1) / df));
}

export type Applicability = 'holds' | 'fails' | 'unknown';

export interface Hit {
  finding: Finding;
  score: number;
  /** Why it matched — the terms that carried the score, best first. */
  matched: Array<{
    term: string;
    kind: TokenKind;
    contribution: number;
    /** IDF of the term in this corpus — how much matching it narrowed things. */
    information: number;
    /**
     * Information for the purpose of deciding whether a hit exists at all.
     * Equal to `information` except for common English, which is damped so it
     * cannot anchor a hit on the strength of being rare in a small corpus.
     */
    anchorInformation: number;
    /** Whether the language prior rates this term as ordinary English. */
    common: boolean;
  }>;
  applicability: Applicability;
  confidence: number;
  surprise: number | null;
  /**
   * Other findings in this result set that are about the same trap.
   *
   * Empty for almost every hit; populated when the ranking genuinely cannot
   * choose. See `linkSiblings`.
   */
  siblings: string[];
  /**
   * How much of the query this finding accounts for, 0 to 1.
   *
   * Reported rather than used as a threshold. See `strength`.
   */
  explained: number;
  /** 'strong' when the match stands on its own; 'weak' when it may be lexical accident. */
  strength: 'strong' | 'weak';
  /**
   * Why the match is weak, in plain language, empty when it is not.
   *
   * Written for a reader that has semantics — which the caller always is, and
   * this code never will be.
   */
  caveats: string[];
}

export interface SearchOptions {
  /**
   * Evaluate preconditions against the CURRENT process's environment.
   *
   * Off by default, and the default is the important part: on a server
   * answering /api/search the asker is on a different machine, so the server's
   * own environment is not evidence about theirs. Gating a remote query on
   * local preconditions would hide exactly the findings the asker needs. Turn
   * it on in a CLI, where the process and the question share a machine.
   */
  useLocalEnvironment?: boolean;
  /** Include findings whose score is zero. Off by default. */
  includeUnmatched?: boolean;
  limit?: number;
}

/**
 * Rank findings against a query.
 *
 * Pure and synchronous. No network, no execution, no state — running this
 * tells the corpus nothing about you, which is a property the install block
 * promises and this preserves.
 */
export function retrieve(
  query: string,
  findings: Finding[],
  opts: SearchOptions = {},
): Hit[] {
  const index = buildIndex(findings);
  const tokens = tokenize(query);

  /*
   * Accumulate over postings, not over documents.
   *
   * Only documents containing a query term are ever touched, and each is
   * touched once per term it actually contains. Everything the old inner loop
   * did per (document, term) pair still happens -- it just no longer happens
   * for pairs that could not have matched.
   */
  const acc = new Map<number, { score: number; matched: Hit['matched'] }>();

  for (const tok of tokens) {
    const information = idf(index.df.get(tok.text) ?? 0, index.n);
    // A word common in English cannot anchor a hit on the strength of being
    // rare in thirty-one documents. Capped rather than dropped: it still
    // contributes to a finding already anchored by something discriminating.
    /*
     * The damping applies to ANCHORING, not to scoring, and separating the two
     * is what makes it free.
     *
     * One value was doing both jobs. Capping it stopped "recent" from
     * anchoring a Python traceback onto a finding about reputation logs --
     * correct -- but it also stripped the weight common words legitimately
     * contribute to a finding already anchored by something discriminating,
     * and that cost held-out P@5 1.000 -> 0.921. Prose queries lean on
     * ordinary English; machine output does not. Both are real, and they
     * wanted different things from the same number.
     *
     * So the term keeps its full weight in the score, and carries a separate,
     * damped `anchorInformation` used only to decide whether a hit may exist
     * at all. A common word can help rank a finding; it cannot summon one.
     */
    /*
     * Common words no longer BLOCK a hit; they annotate it.
     *
     * Suppression was the only tool available while a weak match and a strong
     * one were indistinguishable in the output, and it cost held-out P@5
     * 1.000 -> 0.921: three prose queries whose only anchors were ordinary
     * words vanished entirely. Now that a match carries its own reservations,
     * hiding it buys nothing a caveat does not buy more cheaply, and hiding
     * costs recall that a caveat does not.
     *
     * The information is kept intact and the commonness is remembered, so a
     * hit resting entirely on ordinary English can say so.
     */
    // Kept as a distinct name: the annotation path reads it, and collapsing it
    // into  would hide that anchoring and scoring were once
    // different quantities, which is the change this file records.
    const anchorInformation = information;
    const common = isCommonWord(tok.text);
    // A term in almost every finding distinguishes nothing, and letting it
    // contribute a sliver still puts the finding in the RESULT SET even when
    // it cannot affect the order. Ranking correctly is not enough: an agent
    // reading the first page sees membership, not scores.
    if (information < NOISE_FLOOR) continue;
    for (const { doc, tf } of index.postings.get(tok.text) ?? []) {
      // Saturating term frequency: a finding that says "proxy" nine times is
      // not nine times more about proxies. Without this, long findings win
      // every query by repetition alone.
      const saturation = 1 + Math.log(tf);
      const boost = index.docs[doc].strong.has(tok.text) ? 2.5 : 1;
      const contribution = information * tok.weight * saturation * boost;
      const slot = acc.get(doc) ?? { score: 0, matched: [] };
      slot.score += contribution;
      slot.matched.push({
        term: tok.text,
        kind: tok.kind,
        contribution,
        information,
        anchorInformation,
        common,
      });
      acc.set(doc, slot);
    }
  }

  /*
   * Coverage counts only the terms the asker actually typed.
   *
   * Phrases are derived from adjacent words, so a five-word query carries four
   * more of them. Counting those in the denominator halved every candidate's
   * coverage the moment bigrams were introduced and dropped held-out P@1 from
   * 0.692 to 0.641 — the phrases were not wrong, the metric was: coverage is
   * meant to ask how much of the QUERY a finding explains, and a bigram is not
   * a separate thing the asker asked about.
   */
  const distinctQueryTerms = new Set(tokens.map((t) => t.text)).size;

  const candidates: Hit[] = [...acc].map(([docIdx, slot]) => {
    const doc = index.docs[docIdx];
    slot.matched.sort((a, b) => b.contribution - a.contribution);

    /*
     * Coverage: what fraction of the query this finding actually accounts for.
     *
     * Without it, one rare term decides everything. `disk full` ranked a
     * finding about DNS above the finding about disks, because it happened to
     * contain the word "full" (in "full DNS works") and "full" is rarer in
     * this corpus than "disk". Rarity is a good weight and a terrible sole
     * criterion: a finding that answers half your query should lose to one
     * that answers all of it.
     */
    const coverage = distinctQueryTerms
      ? new Set(slot.matched.map((m) => m.term)).size / distinctQueryTerms
      : 0;
    // Softened, not linear: a single decisive error code is often the whole
    // query even when the surrounding prose does not match anything.
    const score = slot.score * (0.45 + 0.55 * coverage);

    const applicability: Applicability = opts.useLocalEnvironment
      ? doc.finding.precondition?.length
        ? matchEnvironment(doc.finding.precondition).matches
          ? 'holds'
          : 'fails'
        : 'unknown'
      : 'unknown';

    return {
      finding: doc.finding,
      score,
      matched: slot.matched,
      applicability,
      confidence: doc.confidence,
      surprise: doc.surprise,
      siblings: [],
      explained: 0,
      strength: 'strong',
      caveats: [],
    };
  });

  const scored: Hit[] = candidates
    .filter(
      (h) =>
        opts.includeUnmatched ||
        (h.score > 0 && h.matched.some((m) => m.anchorInformation >= SIGNAL_FLOOR)),
    )
    .map((h) => ({ ...h, confidence: h.confidence, surprise: h.surprise }));

  const ranked = scored
    .map((h) => ({ h, final: finalScore(h) }))
    .sort((a, b) => b.final - a.final || b.h.confidence - a.h.confidence)
    .map(({ h, final }) => ({ ...h, score: final }));

  /*
   * Relative cutoff.
   *
   * An absolute threshold cannot work: scores are unnormalised and a
   * one-rare-term query scores an order of magnitude below a five-term one.
   * What is stable is the gap WITHIN a result set — a finding scoring 2% of
   * the top hit matched something incidental, whatever the absolute numbers.
   *
   * This is about the result set, not the order. Returning a long tail ranked
   * correctly still hands an agent a list it will read from the top of and
   * believe is relevant.
   */
  const cut = ranked.length ? ranked[0].score * 0.06 : 0;
  const relevant = opts.includeUnmatched ? ranked : ranked.filter((h) => h.score >= cut);

  /*
   * Absolute floor: how much of the QUERY did the best hit actually explain?
   *
   * The relative cutoff above is scale-free, which is exactly its flaw. When
   * every hit is weak the best weak hit still defines the scale, so everything
   * near it survives and the corpus answers confidently about a failure it has
   * never heard of. Measured against real failures it does not cover -- a
   * Python ImportError, a git pathspec error -- it returned findings about
   * reputation logs and signing oracles, ranked, with no signal that they were
   * noise.
   *
   * That is the dangerous direction. An agent asks precisely when it is stuck,
   * which is when it is least equipped to reject a confident answer, and a
   * wrong finding costs more than no finding: it sends the agent somewhere
   * else entirely. Silence is the correct response far more often than any
   * ranking function will admit on its own.
   *
   * So the gate is normalised per query: of all the information in what was
   * asked, what fraction does this finding account for? A query whose
   * informative terms appear nowhere in the corpus explains nothing, however
   * its handful of incidental matches happen to rank against each other.
   */
  if (!opts.includeUnmatched && relevant.length > 0) {
    const queryInformation = new Map<string, number>();
    for (const tok of tokens) {
      // Deliberately the UNDAMPED idf, floored.
      //
      // Damping is a scoring decision -- a common word must not anchor a hit.
      // It is not a statement that the asker did not type the word. Using the
      // damped value here shrank the denominator every time a query was mostly
      // ordinary English, so one rare term looked like it explained the whole
      // question: a thirteen-word git error matching only "git" scored 0.60
      // explained and answered with a finding about CI gates.
      const info = idf(index.df.get(tok.text) ?? 0, index.n);
      queryInformation.set(tok.text, Math.max(info, MIN_TERM_INFORMATION));
    }
    const total = [...queryInformation.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      const explains = (h: Hit) =>
        [...new Set(h.matched.map((m) => m.term))].reduce(
          (a, t) => a + (queryInformation.get(t) ?? 0),
          0,
        ) / total;
      /*
       * Signal fusion was built here and removed, and the measurement is why.
       *
       * The idea was sound and it separated cleanly on the cases it was built
       * for: three detectors that fail independently -- a discriminating
       * ordinary word, a machine identifier (errno, path, status, flag), and
       * the query naming an executable the finding's check actually runs.
       * Every genuine hit in the agent simulation carried two or three of
       * them; the one surviving false positive carried exactly one.
       *
       * Requiring two agreeing signals took held-out P@1 from 0.684 to 0.237.
       * Long prose queries carry lexical signal and nothing else -- no error
       * codes, no paths, no tool names -- so three quarters of them were
       * rejected outright. The gate was calibrated on machine output and prose
       * cannot satisfy it, which is the same distribution split that made the
       * language prior a trade rather than a win, arriving here as a cliff.
       *
       * Five approaches have now been measured against the one remaining false
       * positive: bigrams, machine-versus-prose ratio, strong-field
       * membership, external word frequency, and this. Each either failed to
       * separate the cases or cost more than it bought. The honest reading is
       * that a git error matching a finding on the word "git" is not a
       * lexical-methods problem, and the next thing to try should be a
       * different kind of signal entirely rather than a sixth weighting of
       * this one.
       */
      /*
       * Report weakness; do not suppress it.
       *
       * Every attempt tonight to make the ranker DECIDE ran into the same
       * wall. Six of them: bigrams, machine-versus-prose ratio, strong-field
       * membership, external word frequency, signal fusion, peak-to-background
       * ratio. Each either failed to separate the cases or cost more recall
       * than it bought, and the last one made the reason explicit — a query
       * that correctly returns one finding and a query that wrongly returns
       * one finding have IDENTICAL spectra. There is no shape in the numbers
       * to tell them apart.
       *
       * The assumption underneath all six was that this code has to decide.
       * It does not, and it is the worst-placed thing in the system to try:
       * the caller is a language model, so the semantics are already in the
       * loop, downstream, at no cost. What the caller cannot recover on its
       * own is HOW the match was made — which terms carried it, how much of
       * the question went unexplained, whether any machine identifier was
       * involved at all.
       *
       * So a weak match is labelled and returned rather than dropped. That
       * also dissolves the trade that has cost recall all evening: nothing has
       * to be hidden to be safe, because a caveat an LLM reads in a dozen
       * tokens is stronger protection than a threshold that is wrong in both
       * directions.
       */
      for (const h of relevant) {
        h.explained = explains(h);
        const typed = h.matched.filter((m) => m.kind !== 'word');
        const caveats: string[] = [];
        // A hit resting only on ordinary English is the shape every false
        // positive tonight has had: "most recent call last" against "the most
        // recent record". Reported, not suppressed.
        const distinctive = h.matched.filter(
          (m) => m.anchorInformation >= SIGNAL_FLOOR && !m.common,
        );
        if (distinctive.length === 0) {
          caveats.push('matched only on ordinary words, not on anything distinctive');
        }
        // "Distinctive" means informative AND not ordinary English. Using raw
        // information here counted "file", "did" and "not" as distinctive the
        // moment the common-word cap was removed, so a git error matching one
        // real term plus four filler words stopped looking thin.
        const discriminating = new Set(distinctive.map((m) => m.term));
        // Only when there IS exactly one: zero distinctive terms is already
        // reported above, and saying both produced "matched only on ordinary
        // words; matched on no distinctive term", which is one fact twice.
        if (discriminating.size === 1) {
          caveats.push(`matched on only one distinctive term, "${[...discriminating][0]}"`);
        }
        if (h.explained < MIN_QUERY_EXPLAINED) {
          caveats.push(`accounts for ${(h.explained * 100).toFixed(0)}% of your query`);
        }
        if (typed.length === 0) {
          caveats.push('no error code, path or flag in common');
        }
        h.caveats = caveats;
        // Two independent reservations is where a match stops standing on its
        // own. One is normal: plenty of correct matches share no path.
        h.strength = caveats.length >= 2 ? 'weak' : 'strong';
      }
    }
  }

  /*
   * Link across the WHOLE result set, then truncate — and let siblings of a
   * surviving hit come with it.
   *
   * Linking after truncation defeated the entire point. At limit 1 the top hit
   * came back with no siblings at all, because the finding it was tied with
   * had already been cut, so an agent taking the first answer never learned a
   * second finding covered the same trap. That is precisely the silent coin
   * flip this was built to stop, reintroduced one line lower down.
   *
   * So the limit is soft, deliberately: siblings arrive as a group or not at
   * all. Returning two findings for a limit of one is a smaller lie than
   * returning one and calling it the answer. The expansion is bounded — it
   * only ever pulls in findings already above the relevance cut, and a hit
   * links only to comparably-scored findings sharing its subject or tags, so
   * a cluster is a handful at most.
   */
  const linked = linkSiblings(relevant);
  if (!opts.limit) return linked;

  const kept = linked.slice(0, opts.limit);
  const ids = new Set(kept.map((h) => h.finding.id));
  for (const h of kept) {
    for (const sib of h.siblings) {
      if (ids.has(sib)) continue;
      const pulled = linked.find((x) => x.finding.id === sib);
      if (!pulled) continue;
      ids.add(sib);
      kept.push(pulled);
    }
  }
  // Re-sort, so a pulled-in sibling sits at its own rank rather than the end.
  return kept.sort((a, b) => b.score - a.score);
}

/**
 * Fold applicability, decay and information gain into the text score.
 *
 * Each is a multiplier rather than an additive bonus, so none of them can
 * manufacture a hit out of a finding the query did not match. A finding that
 * is perfectly applicable and highly surprising still scores zero if it is not
 * about what you asked.
 */
function finalScore(h: Hit): number {
  let s = h.score;

  // A precondition that provably does not hold here is strong evidence this
  // finding is not yours — stronger than any amount of text similarity, since
  // similarity cannot distinguish "about proxies" from "about YOUR proxy".
  // Demoted rather than dropped: a precondition can be incomplete, and being
  // buried is recoverable where being hidden is not.
  if (h.applicability === 'fails') s *= 0.15;
  else if (h.applicability === 'holds') s *= 1.6;

  // Decay, so a stale claim loses to a fresh one that matched equally well.
  // Floored: a stale finding is a lead worth seeing, not noise.
  s *= 0.4 + 0.6 * h.confidence;

  /*
   * Information gain. The searcher here is nearly always a model, and this
   * corpus knows which of its findings models get WRONG — that is what
   * `surprise` measures, and it is the one ranking signal in this file that no
   * other retrieval system could compute.
   *
   * Ranking by relevance alone surfaces what the asker could most easily have
   * derived. Weighting by surprise surfaces what it could not. Kept small: it
   * breaks ties between comparable matches, and must never outrank being about
   * the right subject.
   */
  if (h.surprise !== null) s *= 1 + 0.35 * h.surprise;

  return s;
}


/**
 * Mark findings in the result set that are about the same trap.
 *
 * Measuring retrieval turned up a failure mode that is not really a failure.
 * Held-out P@1 was 0.711 and P@5 was 1.000, and the gap was almost entirely
 * one shape: the right finding sitting at rank 1 behind a SIBLING. cairn-0012
 * behind cairn-0007, both about Playwright browsers on a preconfigured
 * sandbox. cairn-0017, -0018 and -0020 behind cairn-0026, all about what a
 * commitment does and does not bind.
 *
 * Every attempt to rank one sibling above the other made retrieval worse
 * overall, and on reflection that is the correct outcome rather than a
 * limitation, because the premise was wrong. There is no fact about which of
 * two findings on the same trap "should" come first — an agent handed either
 * one has not been misled, and the ranking is being asked to invent a
 * preference the corpus does not contain.
 *
 * So the answer is to stop choosing silently. A caller that knows two hits are
 * siblings can say so, and an agent that is told "these two are the same trap,
 * here is how they differ" is better served than one handed the arbitrary
 * winner of a coin flip it cannot see.
 *
 * Two findings are siblings when a query could not reasonably tell them apart:
 * comparable scores, and either the same subject or substantially the same
 * tags. Both conditions are needed. Score alone links unrelated findings that
 * happen to tie; subject alone links every finding about a popular tool
 * regardless of what was asked.
 */
function linkSiblings(hits: Hit[]): Hit[] {
  if (hits.length < 2) return hits;

  const tagsOf = (h: Hit) => new Set(h.finding.tags.map((t) => t.toLowerCase()));
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const x of a) if (b.has(x)) shared++;
    return shared / (a.size + b.size - shared);
  };

  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const a = hits[i];
      const b = hits[j];
      // Comparable: the weaker scores at least 60% of the stronger. Below
      // that the ranking has expressed a real preference and should be left
      // to express it.
      if (a.score <= 0 || b.score / a.score < 0.6) continue;
      const sameSubject =
        a.finding.subject.name.toLowerCase() === b.finding.subject.name.toLowerCase();
      const sameTags = jaccard(tagsOf(a), tagsOf(b)) >= 0.5;
      if (!sameSubject && !sameTags) continue;
      a.siblings.push(b.finding.id);
      b.siblings.push(a.finding.id);
    }
  }
  return hits;
}


/*
 * Spreading activation was built here and removed. The reasoning was the best
 * idea in this file and the measurement killed it, so the reasoning is kept.
 *
 * A brain does not scan; a cue activates a node and activation propagates
 * along its edges, attenuating with distance, so findings that several strong
 * matches all point at light up even though nothing pointed at them directly.
 * We have edges — co-occurrence records which traps were actually hit together
 * on one machine — and that connects findings sharing no vocabulary at all,
 * which is exactly what ranking over a query can never do.
 *
 * It did not work, and the reason is worth more than the feature:
 *
 * CO-OCCURRENCE IS VACUOUS ON A SINGLE-CONTRIBUTOR CORPUS. One agent working
 * one machine confirms everything in the same environment, so every finding
 * co-occurs with every other and the graph comes out very nearly complete —
 * 27 of 31 findings connected, 18 of 31 adjacent to a single query's seed set.
 * A complete graph carries no information. Activation normalised across ~26
 * edges delivers a rounding error to each, and no threshold distinguishes a
 * real association from the fact that one agent had a long afternoon.
 *
 * Two attempts to fix it by tuning failed, and the second failure was the
 * instructive one: the admission bar sat at 0.12 of the best direct match
 * while the maximum reachable activation was ~0.05, so the feature was dead
 * code that looked like a working feature — "returns nothing extra" and
 * "found nothing to add" are indistinguishable from outside. Making the bar
 * reachable then admitted nothing anyway, for the density reason above.
 *
 * On the eval it was a wash: P@1 identical at 0.711, MRR 0.832 -> 0.831. So it
 * was removed rather than kept dormant against a future that might switch it
 * on, because untested code that activates later is how a corpus of careful
 * claims acquires a component nobody has ever seen run.
 *
 * What would make it worth rebuilding is not a better constant. It is a corpus
 * where distinct attesters confirm distinct subsets from distinct environments,
 * because that is when co-occurrence starts carrying information instead of
 * recording that one machine had many problems. `associationStatus()` measures
 * exactly that and says whether the corpus has got there yet.
 */


/**
 * Whether the co-occurrence graph carries information yet, and if not, why not.
 *
 * A dormant capability that returns nothing looks exactly like a working one
 * with nothing to add, and that ambiguity is what let spreading activation sit
 * in this file as dead code that read like a feature. This makes the state
 * checkable instead of inferred.
 *
 * Density is the test that matters and the one that currently fails. With a
 * single contributor working a single machine, every confirmation shares an
 * attester and an environment, so every finding co-occurs with every other and
 * the graph comes out near-complete. A complete graph says only that one
 * machine had many problems. It is not weak evidence of association; it is no
 * evidence of association.
 */
export function associationStatus(findings: Finding[]): {
  live: boolean;
  edges: number;
  maxAttesters: number;
  density: number;
  reason: string;
} {
  const g = coOccurrence(findings);
  let edges = 0;
  let maxAttesters = 0;
  for (const list of g.values()) {
    edges += list.length;
    for (const e of list) maxAttesters = Math.max(maxAttesters, e.attesters);
  }
  if (edges === 0) {
    return {
      live: false,
      edges,
      maxAttesters,
      density: 0,
      reason: 'no co-occurrence edges: no confirmations share an attester and an environment',
    };
  }
  const nodes = g.size;
  const possible = nodes * (nodes - 1);
  const density = possible > 0 ? edges / possible : 0;
  if (density > 0.5) {
    return {
      live: false,
      edges,
      maxAttesters,
      density,
      reason:
        `the graph is ${(density * 100).toFixed(0)}% complete — with this few contributors every ` +
        'finding co-occurs with every other, so the edges carry no information',
    };
  }
  if (maxAttesters < 2) {
    return {
      live: false,
      edges,
      maxAttesters,
      density,
      reason: `every edge rests on ${maxAttesters} attester, which is one agent's session rather than a pattern`,
    };
  }
  return { live: true, edges, maxAttesters, density, reason: 'informative' };
}


/*
 * `toolsOf` -- extracting the executables a check invokes -- was written here
 * and removed with the fusion gate that was its only consumer.
 *
 * It is worth recording because it is the one genuinely semantic signal this
 * corpus can compute without a model: a finding whose check runs `curl` is
 * about curl, whatever words its prose happens to use, and no corpus of prose
 * could derive that. It failed only because its consumer failed. If a
 * different consumer appears -- something that uses it to rank rather than to
 * gate, or applies it only to queries that are demonstrably machine output --
 * it is a dozen lines of shell-position matching plus a `command -v` case, and
 * the measurement that motivated it is in the comment above.
 *
 * It is not left in place unused. Code that runs but is read by nothing is
 * indistinguishable from code that is wrong.
 */


