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
import { readColumnar, writeColumnar, type ColumnarIndex } from './columnar';

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

/** Everything except the explanatory fields; see weakText. */
function coreText(f: Finding): string {
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
     * `mechanism` and `appliesTo`, indexed as of the eval-set rebuild.
     *
     * These were held out for most of this project's life and were the only
     * unbiased measurement it had. They are also the clearest explanatory
     * prose a finding carries -- WHY it is true and WHERE it applies -- which
     * is exactly what made them a good eval set and exactly what made
     * withholding them from real searchers expensive. Held out, P@1 on queries
     * that need them is 0.895; indexed, it is 1.000.
     *
     * The identical trade was made once before with `evidence`, and indexing
     * that was the single largest accuracy gain ever measured here. The cost
     * both times is the same and is not waved away: a field cannot be indexed
     * and held out, so the eval set had to be REPLACED before this line could
     * be written, not after. See src/lib/cairn/evalset.ts -- observation notes
     * and prediction reasoning, filtered for verbatim quotation, 67 cases
     * against the old split's 38.
     */
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

/** The text of a finding that a query could reasonably match against. */
function findingText(f: Finding): string {
  return `${coreText(f)}\n${weakText(f)}`;
}

/** Fields whose match counts for more, because they are what the finding is about. */
function strongText(f: Finding): string {
  return [f.title, f.subject.name, f.subject.ecosystem, ...f.tags].join('\n');
}

/**
 * Fields whose match counts for LESS, because they are about the subject
 * rather than being it.
 *
 * `mechanism` and `appliesTo` explain why a finding is true and where it
 * holds. Indexing them is worth real accuracy (see findingText), and it also
 * doubled the surface a short query can collide with: `proxies blocked`, two
 * words, started returning a finding about signing oracles whose mechanism
 * prose mentions a proxy in passing, over the finding that IS about the proxy.
 *
 * A term that appears in these fields AND anywhere else in the finding is not
 * affected -- it is already attested by the finding proper. Only a term
 * appearing NOWHERE ELSE is damped, which is exactly the incidental mention
 * this is meant to catch.
 */
function weakText(f: Finding): string {
  return [f.mechanism ?? '', f.appliesTo ?? ''].join('\n');
}

interface Indexed {
  id: string;
  finding: Finding;
  /** Plain-token frequencies and length, for the BM25 arm. */
  bm25: { tf: Map<string, number>; length: number };
  /** Typed-token count, for length normalisation in the typed ranker. */
  length: number;
  /** Cached at index build; see INDEX_TTL_MS. */
  confidence: number;
  surprise: number | null;
  /** token text -> occurrences, over the whole finding. */
  terms: Map<string, number>;
  strong: Set<string>;
  /** Terms attested only by mechanism/appliesTo. See weakText. */
  weak: Set<string>;
}

/**
 * Plain tokenisation for the BM25 arm: lowercase alphanumeric runs.
 *
 * Deliberately NOT this file's tokeniser. Feeding BM25 the typed tokeniser was
 * measured and it was worse than plain — 0.763 against 0.868 P@1 — because
 * stems and errno aliases are extra tokens that inflate document length, and
 * length normalisation then penalises exactly the documents that carry the
 * most alternate spellings. The two methods want different inputs, which is
 * the whole reason they are kept as separate rankers below.
 */
export function plainTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export interface CorpusIndex {
  docs: Indexed[];
  /** token text -> how many findings contain it. */
  df: Map<string, number>;
  /**
   * Flat postings: term id -> [termOffset[id], termOffset[id+1]) into postDoc
   * and postTf.
   *
   * The Map-of-arrays-of-objects below cost one heap object per posting --
   * 1.6 million of them at ten thousand findings, allocated on every load to
   * hold two integers each. These hold the same numbers in three typed arrays,
   * so loading is a view over bytes and scoring is an index walk.
   */
  termId: Map<string, number>;
  termOffset: Int32Array;
  postDoc: Int32Array;
  postTf: Int32Array;
  bmTermId: Map<string, number>;
  bmTermOffset: Int32Array;
  bmPostDoc: Int32Array;
  bmPostTf: Int32Array;
  /**
   * REMOVED from the index: token text -> array of {doc, tf} objects.
   *
   * Nothing in the scoring path read it once the flat arrays existed, and
   * building it cost one heap object per posting -- 1.6 million at ten
   * thousand findings -- on every load, to hold two integers each. The
   * offset table above carries the same information as three typed arrays.
   *
   * Historical note kept because the shape is the obvious one to reach for:
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
  n: number;
  builtAt: number;
  /** Plain-token document frequencies, for the BM25 arm. */
  bm25Df: Map<string, number>;
  /** Mean plain-token document length, for BM25 length normalisation. */
  avgdl: number;
  /** Mean typed-token document length, for the typed ranker's normalisation. */
  avgTypedLen: number;
  /**
   * Term -> the documents where it appears in a strong field.
   *
   * Inverted deliberately. Held per document it is one Set per finding, which
   * is thousands of Sets to allocate on every load; held per term it is one
   * Set per distinct term, and the scorer's question -- "is this query term
   * strong in this document" -- is answered the same way either round.
   */
  strongByTerm: Map<string, Set<number>>;
  weakByTerm: Map<string, Set<number>>;
  /**
   * Plain token -> the documents containing it, with frequency. The BM25 arm's
   * postings, for the same reason the typed arm has them: scoring every
   * document per query is linear in the corpus however fast the inner loop.
   */
  /**
   * Program name -> findings that concern it, precomputed.
   *
   * This was a regex built and run against every document on every query --
   * the exact cost this file criticised in the BM25 baseline, present in its
   * own hot path. A program name is a fixed string, so the mapping is known at
   * index time and is a lookup at query time.
   */
  byCommand: Map<string, Set<string>>;
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

/** Test seam: the in-process memo is keyed on array identity, which a caller
 * cannot reset by constructing an equal array. Benchmarks need to. */
export function clearIndexMemo(): void { /* WeakMap is per-array; nothing to clear */ }

/*
 * On-disk index cache, keyed PER FINDING.
 *
 * It was keyed on a hash of the whole corpus, which is correct and quadratic
 * in practice: changing one finding invalidated all of them. Measured, index
 * build is ~1.6ms per finding and linear -- 15s at ten thousand findings, 40s
 * at twenty-five thousand -- so a corpus that gains one finding paid to
 * re-tokenise and re-verify every finding it already had. Pulling corpus
 * updates would get slower forever.
 *
 * The fix is not a faster rebuild. It is noticing that this project already
 * computes the answer to "has this content changed?" for a different reason.
 * Every finding carries a content hash used to bind signatures to the exact
 * text they attest, and a cache asks precisely the same question. So the
 * integrity primitive becomes the cache key, and nothing new has to be
 * invented or kept in sync: a cache entry is valid exactly when a signature
 * over the same content would still verify.
 *
 * The consequence is that rebuild cost tracks CHANGE rather than corpus size.
 * Adding ten findings to a corpus of a hundred thousand costs ten findings of
 * work, and every entry is reusable across machines because a hash of the
 * content is not machine-specific.
 *
 * Entries are stored in one file rather than one file per finding, because a
 * hundred thousand small files is a different scaling problem, and read back
 * as a map on a single parse.
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
const ENTRY_FILE_NAME = 'entries';

/**
 * Entries retained. Each is a few hundred bytes, so this is a few megabytes at
 * the cap, and it holds a large corpus plus the recent history of edits to it.
 */
const MAX_CACHE_ENTRIES = 50_000;

/** Cache shape version. Bump when the cached fields change meaning. */
const CACHE_SCHEMA = 3;

/**
 * The per-finding entry cache, keyed on the code that produced it.
 *
 * This was `entries-v${CACHE_SCHEMA}.json` with CACHE_SCHEMA bumped by hand,
 * and it is the third cache in this file to have had that bug -- the columnar
 * index and the confusion pairs were both fixed before anyone noticed this one
 * had it too. Adding a field to CachedDoc without bumping the constant leaves
 * entries written by the old code silently accepted by the new, which is how
 * the weak-field tier came back empty for any finding still in the cache.
 *
 * It surfaced as a FLAKY TEST, which is the expensive way to find it: the
 * suite was green run alone and red two times in three when run beside the
 * guard, because whichever process wrote the entry store first decided which
 * shape the other read. A test that fails only under concurrency is the kind
 * that gets dismissed as infrastructure.
 *
 * Lazy, because it depends on constants declared further down this file.
 */
let entryFileMemo: string | null = null;
function entryFile(): string {
  if (!entryFileMemo) {
    entryFileMemo = path.join(
      CACHE_DIR,
      `${ENTRY_FILE_NAME}-v${CACHE_SCHEMA}-${indexerSignature()}.json`,
    );
  }
  return entryFileMemo;
}

/** The assembled index, laid out flat. See columnar.ts for why. */
const COLUMNAR_FILE = path.join(CACHE_DIR, `index-v${CACHE_SCHEMA}.bin`);

export function corpusFingerprint(findings: Finding[]): string {
  const h = crypto.createHash('sha256');
  h.update(String(CACHE_SCHEMA));
  for (const f of findings) h.update(JSON.stringify(f));
  return h.digest('hex');
}

/**
 * What the index was built FROM and what it was built BY.
 *
 * corpusFingerprint answers the first and the cache was keyed on it alone,
 * under a `CACHE_SCHEMA` constant that has to be bumped by hand. That is the
 * confusion-cache bug in the more important cache: changing `findingText`,
 * `strongText` or the tokeniser changes the index completely and changes the
 * corpus fingerprint not at all, so a stale index is silently reused with
 * every ranking wrong and every number still plausible. It nearly happened
 * during the session that found it -- an experiment that altered which fields
 * are indexed was only saved by clearing the cache out of habit.
 *
 * A hand-bumped version cannot fix this, because forgetting to bump it IS the
 * failure. So the identity is derived from the indexing code itself. If the
 * code that decides what goes into the index changes at all, the key changes
 * and the index is rebuilt.
 *
 * Bundling or minifying changes this text without changing behaviour, and the
 * cost of that is one rebuild. That is the correct direction to be wrong in:
 * a spurious rebuild is slow and right, a missed one is fast and wrong.
 */
/**
 * What the indexing CODE is, independent of any corpus.
 *
 * Every derived artefact in this file -- the entry cache, the columnar index,
 * the measured confusions -- is a function of the corpus and of this. Naming
 * it once means a cache cannot be keyed on only half of what produced it,
 * which all three of them were at some point.
 */
let indexerMemo: string | null = null;
export function indexerSignature(): string {
  if (!indexerMemo) {
    indexerMemo = crypto
      .createHash('sha256')
      .update(String(CACHE_SCHEMA))
      // The functions that decide what text is indexed and how it is split.
      .update(findingText.toString())
      .update(strongText.toString())
      .update(weakText.toString())
      .update(coreText.toString())
      .update(tokenize.toString())
      .update(String(NOISE_FLOOR))
      .update(String(GENERATION_SPREAD))
      .digest('hex')
      .slice(0, 12);
  }
  return indexerMemo;
}

export function indexIdentity(findings: Finding[]): string {
  return crypto
    .createHash('sha256')
    .update(corpusFingerprint(findings))
    .update(indexerSignature())
    .digest('hex');
}

/**
 * Cache key for ONE finding.
 *
 * The full record, not `findingBodyHash`, because the index caches confidence
 * as well as tokens and confidence depends on the observations -- which the
 * body hash deliberately excludes, since observations are appended by other
 * parties without invalidating what a signature attested. Same idea, wider
 * scope: this asks "is this record byte-identical", the body hash asks "is the
 * claim byte-identical", and the cache needs the former.
 */
function entryKey(f: Finding): string {
  return crypto.createHash('sha256').update(String(CACHE_SCHEMA)).update(JSON.stringify(f)).digest('hex');
}

interface CachedDoc {
  confidence: number;
  surprise: number | null;
  terms: Array<[string, number]>;
  strong: string[];
  /** Terms attested only by mechanism/appliesTo. See weakText. */
  weak: string[];
  /** Plain-token frequencies and length, so the BM25 arm is cached too. */
  bm25: { tf: Array<[string, number]>; length: number };
}

function readEntryStore(): { at: number; entries: Record<string, CachedDoc> } {
  try {
    const raw = JSON.parse(fs.readFileSync(entryFile(), 'utf8')) as {
      at: number;
      entries: Record<string, CachedDoc>;
    };
    // Confidence decays with wall-clock time; tokens do not. The TTL applies
    // to the store as a whole because the two travel together in one entry.
    if (Date.now() - raw.at >= INDEX_TTL_MS) return { at: Date.now(), entries: {} };
    return raw;
  } catch {
    return { at: Date.now(), entries: {} };
  }
}

function writeEntryStore(entries: Record<string, CachedDoc>): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    /*
     * Bounded, and bounded by DELETION of the oldest keys rather than by
     * refusing to write. An unbounded store grows with every edit any finding
     * ever receives, since each version has its own key; a store that stops
     * writing when full silently stops being a cache.
     */
    let keys = Object.keys(entries);
    if (keys.length > MAX_CACHE_ENTRIES) {
      const keep = new Set(keys.slice(-MAX_CACHE_ENTRIES));
      for (const k of keys) if (!keep.has(k)) delete entries[k];
      keys = Object.keys(entries);
    }
    const tmp = `${entryFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), entries }));
    fs.renameSync(tmp, entryFile());
  } catch {
    /* read-only filesystem, or no space. Entries are recomputed next time. */
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

  /*
   * Fast path: the whole assembled index, read flat.
   *
   * When nothing has changed -- a server starting, a CLI invoked twice, any
   * process after the first -- there is no work to do beyond loading what was
   * already computed. Doing that row by row cost 823ms at ten thousand
   * findings; doing it as typed arrays over one buffer costs 11ms, because
   * the bytes are already in the shape the index needs.
   */
  const fingerprint = indexIdentity(findings);
  const flat = readColumnar(COLUMNAR_FILE, fingerprint);
  if (flat && Date.now() - flat.builtAt < INDEX_TTL_MS) {
    const rebuilt = fromColumnar(flat, findings);
    indexCache.set(findings, rebuilt);
    return rebuilt;
  }

  /*
   * Only findings whose exact record changed are recomputed.
   *
   * Everything derived from a single finding -- its tokens, its strong terms,
   * its length, its plain-token frequencies, its confidence and surprise --
   * depends on nothing but that finding, so it is cached under that finding's
   * own content hash and reused for as long as the record is byte-identical.
   */
  const store = readEntryStore();
  let misses = 0;

  const docs: Indexed[] = findings.map((f) => {
    const key = entryKey(f);
    const hit = store.entries[key];
    if (hit) {
      return {
        id: f.id,
        finding: f,
        bm25: { tf: new Map(hit.bm25.tf), length: hit.bm25.length },
        length: hit.terms.reduce((a, [, n]) => a + n, 0),
        confidence: hit.confidence,
        surprise: hit.surprise,
        terms: new Map(hit.terms),
        strong: new Set(hit.strong),
        weak: new Set(hit.weak),
      };
    }

    misses += 1;
    const terms = new Map<string, number>();
    for (const t of tokenize(findingText(f))) {
      terms.set(t.text, (terms.get(t.text) ?? 0) + 1);
    }
    const strong = new Set(tokenize(strongText(f)).map((t) => t.text));
    // Weak means "attested ONLY by the explanatory prose". A term the finding
    // proper also uses is not incidental and is left alone.
    const core = new Set(tokenize(coreText(f)).map((t) => t.text));
    const weak = new Set(
      tokenize(weakText(f)).map((t) => t.text).filter((t) => !core.has(t)),
    );
    const bm25 = bm25Doc(f);
    const entry: CachedDoc = {
      confidence: confidence(f, at),
      surprise: surprise(f),
      terms: [...terms],
      strong: [...strong],
      weak: [...weak],
      bm25: { tf: [...bm25.tf], length: bm25.length },
    };
    store.entries[key] = entry;

    return {
      id: f.id,
      finding: f,
      bm25,
      length: [...terms.values()].reduce((a, b) => a + b, 0),
      confidence: entry.confidence,
      surprise: entry.surprise,
      terms,
      strong,
      weak,
    };
  });

  if (misses > 0) writeEntryStore(store.entries);

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

  const strongByTerm = new Map<string, Set<number>>();
  docs.forEach((d, i) => {
    for (const t of d.strong) {
      const set = strongByTerm.get(t);
      if (set) set.add(i);
      else strongByTerm.set(t, new Set([i]));
    }
  });

  const weakByTerm = new Map<string, Set<number>>();
  docs.forEach((d, i) => {
    for (const t of d.weak) {
      const set = weakByTerm.get(t);
      if (set) set.add(i);
      else weakByTerm.set(t, new Set([i]));
    }
  });

  const bm25Df = new Map<string, number>();
  for (const d of docs) {
    for (const t of d.bm25.tf.keys()) bm25Df.set(t, (bm25Df.get(t) ?? 0) + 1);
  }
  const avgdl = docs.reduce((a, d) => a + d.bm25.length, 0) / Math.max(1, docs.length);
  const avgTypedLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);

  const bm25Postings = new Map<string, Array<{ doc: number; tf: number }>>();
  docs.forEach((d, i) => {
    for (const [t, tf] of d.bm25.tf) {
      const list = bm25Postings.get(t);
      if (list) list.push({ doc: i, tf });
      else bm25Postings.set(t, [{ doc: i, tf }]);
    }
  });

  // Every program name a finding concerns, from the text a finding uses to say
  // what it is about. Built once; queried by exact lookup.
  const byCommand = new Map<string, Set<string>>();
  for (const d of docs) {
    const surface = `${d.finding.check.command} ${d.finding.title} ${d.finding.subject.name}`;
    for (const t of plainTokens(surface)) {
      const set = byCommand.get(t);
      if (set) set.add(d.finding.id);
      else byCommand.set(t, new Set([d.finding.id]));
    }
  }

  const index: CorpusIndex = {
    docs, df, n: docs.length, builtAt: Date.now(), bm25Df, avgdl, avgTypedLen,
    byCommand, strongByTerm, weakByTerm,
    ...flatten(postings, bm25Postings),
  };
  writeColumnar(COLUMNAR_FILE, toColumnar(index, fingerprint));
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
/**
 * Document-frequency fraction above which an ordinary English word stops
 * generating candidates.
 *
 * Stated as a FRACTION deliberately. The first version of this rule multiplied
 * a term's idf by its English weight and compared against NOISE_FLOOR, which
 * is an absolute threshold, and that is scale-dependent in the wrong
 * direction: over thirty-one findings every idf is small, so damping a
 * genuinely useful mid-frequency term pushed it under the floor and stopped it
 * finding anything. Held-out P@1 went 0.895 -> 0.868 and the rule bought no
 * speed to pay for it.
 *
 * Spread is the quantity that actually matters and it does not move with
 * corpus size: a word that is ordinary English AND already in a quarter of the
 * corpus cannot be evidence that a finding is about anything.
 */
const GENERATION_SPREAD = 0.25;

/**
 * Corpus size below which the rule above is not applied, and the honest
 * accounting for why it exists at all.
 *
 * This is a TRADE, measured in both directions and gated rather than pretended
 * away. At ten thousand findings the rule takes a query from 39.7ms mean /
 * 71.0ms p95 to 24.9ms / 37.5ms, because `not`, `one`, `cannot` and `does`
 * stop walking twenty-three thousand postings and inserting an accumulator
 * entry for each. At thirty-one findings it costs one held-out case of
 * thirty-eight -- P@1 0.895 -> 0.868 -- because in a corpus this small a gold
 * finding can genuinely be reachable only through ordinary words, and there is
 * no cost to bound: the same query is 0.2ms.
 *
 * So each regime gets the answer that is right for it. What must be said
 * plainly is that the accuracy effect ABOVE this line is unmeasured, and
 * cannot be measured until a corpus that large exists with held-out prose to
 * score against. The one direct piece of evidence about this rule's cost is
 * that it cost a case at thirty-one findings. The argument that it will not at
 * ten thousand -- that a word in 84% of the corpus is filler wherever it
 * appears, while at thirty-one findings 84% is nine documents -- is reasoning,
 * not measurement, and is recorded here as such.
 */
const GENERATION_RULE_MIN_CORPUS = 200;

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
 * How much of a term's weight survives subtracting what English does anyway.
 *
 * IDF measures rarity IN THIS CORPUS, and over thirty-one findings that is a
 * poor estimator of meaning. `because` appears in three of them and scores as
 * informative; it means nothing. `egress` appears in one and scores the same;
 * it means everything. Corpus rarity cannot tell them apart, because on the
 * only evidence it has they are identical.
 *
 * The measured table can, and this is the reference it exists to be. A term
 * rare here AND rare in English is a line. A term rare here and ordinary in
 * English is an artefact of a small corpus -- the continuum, not a line.
 *
 * Graded rather than binary, because commonness is: a word at 120 per million
 * is barely ordinary and one at 5000 is filler, and a single threshold has to
 * treat them the same. Returns 1 for anything the table does not rate as
 * common, so a corpus with no table loses this ranking and nothing else.
 */
function lineWeight(t: string): number {
  const rate = WORD_RATES[t] ?? 0;
  if (rate >= COMMON_RATE) return COMMON_RATE / rate;
  // The hand list has no measured rate to grade by. One tenth is the weight a
  // word at ten times COMMON_RATE gets, which is roughly where these sit.
  if (RESIDUAL_COMMON.has(t)) return 0.1;
  return 1;
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
    /**
     * Whether this term matched in the finding's IDENTITY fields -- title,
     * subject, check command -- rather than anywhere in its body.
     *
     * Already computed as the 2.5x scoring boost; recorded here because it is
     * also usable as a ranking signal in its own right, and a multiplier
     * folded into a total cannot be recovered from the total.
     */
    strong: boolean;
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
   * Findings this retriever has been MEASURED to mix up with this one.
   *
   * Distinct from `siblings`, which records findings that look alike by
   * subject or tags. This records findings that are actually confused in
   * practice, learned by querying with each finding's own held-out
   * description. The two overlap but neither contains the other: cairn-0018
   * and cairn-0026 share no subject and no tag, and are confused constantly.
   */
  confusedWith: string[];
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

  /*
   * Informative terms first, so the filler has something to attach to.
   *
   * Addition commutes, so this changes no score. It changes what is KNOWN when
   * each term is processed, which is what makes the rule below possible: by
   * the time `not` is reached, every finding the discriminating terms found is
   * already in the accumulator, and `not` can add weight to them without
   * having to introduce ten thousand findings of its own.
   */
  const ordered = [...tokens].sort(
    (a, b) =>
      idf(index.df.get(b.text) ?? 0, index.n) * b.weight -
      idf(index.df.get(a.text) ?? 0, index.n) * a.weight,
  );

  for (const tok of ordered) {
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
    /*
     * A term may add WEIGHT to a finding without being allowed to introduce
     * one.
     *
     * NOISE_FLOOR is an absolute cut on corpus rarity, and at ten thousand
     * findings it only fires around 86% document frequency -- so `the`, `and`
     * and `is` are dropped and `not` (83.9%), `one` (67.7%), `cannot` (45.1%)
     * and `does` (38.7%) are not. Those four walked twenty-three thousand
     * postings for one query and inserted an accumulator entry for each,
     * introducing thousands of findings whose entire claim to relevance is the
     * word `not`. That is most of what made a query at ten thousand findings
     * cost 33ms against 0.2ms at thirty-one.
     *
     * Corpus rarity cannot see the problem: `not` is genuinely rarer here than
     * `the`. The English reference can, and it is the same one the ordering
     * uses -- a term that is ordinary English and spread across a large
     * fraction of the corpus carries no evidence that a finding is ABOUT
     * anything, whatever its idf.
     *
     * So such a term is demoted from generating candidates to scoring them.
     * Findings the discriminating terms already found still receive its
     * weight, in full, and rank exactly as before. What is dropped is a
     * finding matched by NOTHING BUT filler, which the annotation layer
     * already labels "matched only on ordinary words" and the relative cutoff
     * already discards.
     *
     * That last sentence was written before it was measured, and it was wrong:
     * at thirty-one findings the rule costs one held-out case. See
     * GENERATION_RULE_MIN_CORPUS for what was done about it.
     */
    const generative =
      index.n < GENERATION_RULE_MIN_CORPUS ||
      !(isCommonWord(tok.text) && (index.df.get(tok.text) ?? 0) > index.n * GENERATION_SPREAD);
    // Flat walk: a term's postings are a contiguous slice, so this touches
    // integers in two typed arrays rather than dereferencing one heap object
    // per posting.
    const tid = index.termId.get(tok.text);
    if (tid === undefined) continue;
    const from = index.termOffset[tid];
    const to = index.termOffset[tid + 1];
    for (let k = from; k < to; k++) {
      const doc = index.postDoc[k];
      const tf = index.postTf[k];
      // Saturating term frequency: a finding that says "proxy" nine times is
      // not nine times more about proxies. Without this, long findings win
      // every query by repetition alone.
      /*
       * Saturating term frequency WITH length normalisation.
       *
       * The scorer had saturation but no notion of document length, so a long
       * finding accumulated matches a short one could not and won queries it
       * was only incidentally related to. Measured against textbook BM25 --
       * which normalises by length as a matter of course -- this scorer lost
       * author prose 0.711 to 0.868 on P@1, and prose queries are exactly
       * where many mid-weight terms accumulate.
       *
       * Same form BM25 uses, and B is BM25's default rather than a number
       * chosen here: tf damped toward an asymptote, divided by how much longer
       * this document is than average.
       */
      const doclen = index.docs[doc].length;
      const norm = 1 - LENGTH_B + (LENGTH_B * doclen) / index.avgTypedLen;
      const saturation = ((tf * (LENGTH_K1 + 1)) / (tf + LENGTH_K1 * norm)) || 0;
      const strong = index.strongByTerm.get(tok.text)?.has(doc) ?? false;
      // Three tiers, not two: what the finding IS, what it says, and what it
      // says ABOUT itself. A term attested only by the explanatory prose is
      // evidence, but weaker evidence than the finding's own account.
      const weakOnly = !strong && (index.weakByTerm.get(tok.text)?.has(doc) ?? false);
      const tier = strong ? STRONG_FIELD_BOOST : weakOnly ? WEAK_FIELD_DAMP : 1;
      const contribution = information * tok.weight * saturation * tier;
      const slot = acc.get(doc);
      if (!slot) {
        if (!generative) continue;
        const fresh = { score: contribution, matched: [
          { term: tok.text, kind: tok.kind, contribution, information,
            anchorInformation, common, strong },
        ] };
        acc.set(doc, fresh);
        continue;
      }
      slot.score += contribution;
      slot.matched.push({
        term: tok.text,
        kind: tok.kind,
        contribution,
        information,
        anchorInformation,
        common,
        strong,
      });
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
      confusedWith: [],
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

  /*
   * Two rankers, fused on position.
   *
   * The typed ranker decides MEMBERSHIP -- which findings are candidates at
   * all, and which are silent -- because that is where its errno aliases and
   * anchoring rules do work BM25 cannot: BM25 has no way to return nothing,
   * and no way to reach cairn-0008 from the string "ENOSPC".
   *
   * Ordering is then fused with BM25, which is measurably the better ranker
   * once the candidate set exists. Nothing outside the typed ranker's
   * candidates can be introduced by BM25, so the safety properties measured on
   * unknown ground are preserved exactly while the ordering improves.
   */
  /*
   * How much of the QUESTION a candidate accounts for, computed before the
   * ranking rather than after it.
   *
   * This quantity already existed, as the `explained` caveat, and it was
   * reported to the caller while playing no part in deciding the order. Every
   * held-out failure says that was backwards. Of the eight prose queries that
   * put the wrong finding first, five had the GOLD finding explaining more of
   * the query than the winner did -- the right answer was already identified,
   * by a number sitting one function away from the comparator that ignored it.
   *
   * The two quantities measure genuinely different things and it is worth
   * being precise about which. `score` is document-side: how much matched
   * text this finding contains, so a long finding accumulates more of it. This
   * is query-side: of the information in what was ASKED, what fraction did
   * this finding account for -- normalised by the question, so length buys
   * nothing. A bright lamp beats a tuned line under the first and loses under
   * the second, and a question is answered by the thing that absorbs its
   * wavelengths, not by the thing that returns the most light.
   */
  const queryInformation = new Map<string, number>();
  for (const tok of tokens) {
    // Deliberately the UNDAMPED idf, floored -- see the note at its second use
    // below: damping is a scoring decision, not a claim about what was typed.
    queryInformation.set(
      tok.text,
      Math.max(idf(index.df.get(tok.text) ?? 0, index.n), MIN_TERM_INFORMATION),
    );
  }
  const totalQueryInformation = [...queryInformation.values()].reduce((a, b) => a + b, 0);
  const explains = (h: Hit) => {
    if (totalQueryInformation <= 0) return 0;
    let sum = 0;
    // `matched` is deduplicated per term by the accumulator, so this sums
    // distinct terms without materialising a Set per hit.
    for (const m of h.matched) sum += queryInformation.get(m.term) ?? 0;
    return sum / totalQueryInformation;
  };

  /*
   * A FIFTH signal was built here and removed. The reasoning was good and the
   * measurement was not, which is the only order in which those two matter.
   *
   * A finding's title, subject and check command say what it IS; its body says
   * what it mentions, and both were read as the same evidence. The remaining
   * failures look exactly like that distinction: `getent` is in the TITLE of
   * the finding about getent and in the BODY of a neighbouring DNS finding,
   * and the wrong one wins. So: a second coverage fraction counting only
   * strong-field matches, fused as a fourth ranker.
   *
   * It took held-out P@1 from 0.868 to 0.711, and restricting it to
   * distinctive terms only recovered it to 0.737. RRF is why: position in a
   * SPARSE list is worth exactly what position in a dense one is worth, most
   * findings have no strong-field match at all, and so the handful that
   * matched one ordinary title word were promoted over findings that had
   * answered most of the question. The signal is real; making it a ranking
   * destroys the information that it fires rarely.
   *
   * It survives as `strong` on each matched term, where a caller can see it,
   * and as the 2.5x scoring boost it always was.
   */

  const candidateIds = new Set(scored.map((h) => h.finding.id));
  const typedOrder = scored
    .map((h) => ({ h, final: finalScore(h) }))
    .sort((a, b) => b.final - a.final || b.h.confidence - a.h.confidence);
  const bm25Order = bm25Rank(query, index).filter((id) => candidateIds.has(id));
  /*
   * Bounded to the head of the typed order for the same reason the annotation
   * loop is: nothing below it can reach rank 1 under RRF at any weight this
   * file would accept, and computing coverage for a thousand candidates a
   * broad query never returns is the shape of the quadratic bug above.
   */
  /*
   * The line spectrum: this hit's score with the English continuum subtracted.
   *
   * Reuses each term's own contribution -- so the tf saturation, the length
   * normalisation and the strong-field boost all still apply -- and reweights
   * it by how much the term says beyond being English. A finding that won on
   * `remains`, `does` and `later` keeps almost none of its score here; one
   * that won on `egress` or `decision` keeps all of it.
   *
   * Deliberately a RANKING and not a change to the score. Damping common words
   * in the score itself was tried, in the era when a common word could also
   * block a hit, and it cost held-out P@5 1.000 -> 0.921: three prose queries
   * whose only anchors were ordinary words vanished from the result set
   * entirely. That was a membership effect, not an ordering one, and the two
   * are separable -- membership is still decided by the undamped path, so this
   * cannot remove a hit from the results at any weight. It can only decide
   * which of the hits that already qualify comes first.
   */
  /*
   * Two references, and both are needed.
   *
   * ENGLISH, subtracted globally: `because` is rare in thirty-one findings and
   * ordinary in the language, so its corpus rarity is an artefact.
   *
   * THE CONTEST, subtracted locally: a term matched by every candidate in
   * contention discriminates nothing FOR THIS QUERY whatever its rarity
   * anywhere. When the query is a paragraph about commitment schemes and the
   * top candidates are all findings about commitment schemes, `forecast` and
   * `seal` are the continuum -- shared, bright, and silent about which one is
   * meant. `decision` and `publish`, which only one of them matched, are the
   * lines.
   *
   * Subtracting either alone was measured and neither works. English alone is
   * held-out P@1 0.816 at weight 0.7: it damps the filler the wrong answers
   * win on, and also damps the ordinary English that prose queries legitimately
   * carry, which is the same trade this file has recorded twice before.
   */
  const contested = typedOrder.slice(0, CONTEST_WINDOW);
  const inContest = new Map<string, number>();
  for (const { h } of contested) {
    for (const m of h.matched) inContest.set(m.term, (inContest.get(m.term) ?? 0) + 1);
  }
  const contestants = Math.max(1, contested.length);
  const lineSpectrum = (h: Hit) => {
    let sum = 0;
    for (const m of h.matched) {
      // Shared by everyone -> ~0. Held by one -> ~1. The +0.5 keeps a term
      // matched by a single candidate from being worth an unbounded amount.
      const local = Math.log((contestants + 1) / ((inContest.get(m.term) ?? 1) + 0.5));
      if (local <= 0) continue;
      sum += m.contribution * lineWeight(m.term) * local;
    }
    return sum;
  };

  const head = typedOrder.slice(0, FUSE_WINDOW);
  const byCoverage = (of: (h: Hit) => number) =>
    head
      .map((x) => ({ id: x.h.finding.id, v: of(x.h) }))
      // Zero coverage is not a ranking, it is an absence. Leaving those in the
      // list gives a finding that answered none of the question a position,
      // and a position is worth points under RRF.
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .map((x) => x.id);
  const fused = fuse([
    { order: typedOrder.map((x) => x.h.finding.id), weight: 1 },
    { order: bm25Order, weight: Number(process.env.CAIRN_BM25_WEIGHT ?? BM25_WEIGHT) },
    {
      order: byCoverage(explains),
      weight: Number(process.env.CAIRN_EXPLAINED_WEIGHT ?? EXPLAINED_WEIGHT),
    },
    {
      order: byCoverage(lineSpectrum),
      weight: Number(process.env.CAIRN_LINE_WEIGHT ?? LINE_WEIGHT),
    },
  ]);

  const ranked = typedOrder
    .map(({ h, final }) => ({ ...h, score: final }))
    .sort(
      (a, b) =>
        (fused.get(b.finding.id) ?? 0) - (fused.get(a.finding.id) ?? 0) ||
        b.score - a.score ||
        b.confidence - a.confidence,
    );

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
    /*
     * `queryInformation` and `explains` are the ones built above the ranking.
     *
     * They were computed here first, used only to write caveats, and the
     * UNDAMPED idf is why they are worth reading twice: damping is a scoring
     * decision -- a common word must not anchor a hit -- and not a statement
     * that the asker did not type the word. Using the damped value shrank the
     * denominator every time a query was mostly ordinary English, so one rare
     * term looked like it explained the whole question: a thirteen-word git
     * error matching only "git" scored 0.60 explained and answered with a
     * finding about CI gates.
     */
    if (totalQueryInformation > 0) {
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
      /*
       * The failing command, applied as evidence rather than as a filter.
       *
       * Present and matching  -> the strongest positive signal available.
       * Present and matching nothing -> the strongest NEGATIVE signal
       *   available, and the one six statistical methods could not produce: a
       *   query that names `python3` when no finding concerns python3 is not
       *   a close call, it is a different subject.
       * Absent -> nothing changes. Prose never names a command, and this must
       *   cost those queries nothing.
       */
      const cmd = failingCommand(query);
      const concerned = cmd ? (index.byCommand.get(cmd) ?? new Set<string>()) : null;

      /*
       * Annotate the head, not the tail.
       *
       * Every hit was being given an explained fraction and a caveat list,
       * which walks its matched terms -- so a broad query over a large corpus
       * annotated thousands of results nobody reads. Same shape as the
       * quadratic sibling bug directly below, found in the same profile, and
       * invisible for the same reason: on 31 findings the tail is three rows.
       *
       * Hits past the window keep `strength: 'strong'` and no caveats, which
       * is the pre-annotation default. They are still ranked, still returned,
       * and still correct -- they simply carry no self-assessment, which is
       * what they carried before any of this existed.
       */
      const ANNOTATE_WINDOW = 25;
      for (const h of relevant.slice(0, ANNOTATE_WINDOW)) {
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
        if (concerned) {
          if (concerned.has(h.finding.id)) {
            // Wipes the text-derived doubts: the query named the program this
            // finding is about, which no amount of vocabulary overlap matches.
            caveats.length = 0;
          } else {
            caveats.push(
              `your error came from "${cmd}", which this finding is not about`,
            );
          }
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

  /*
   * Disclose measured confusions alongside declared siblings.
   *
   * `siblings` records findings that LOOK alike -- same subject, same tags.
   * This records findings this retriever has been observed to MIX UP, which is
   * a different and strictly more useful fact: it caught cairn-0018 against
   * cairn-0026 and cairn-0030 against cairn-0001, pairs the declarative rule
   * cannot see because what they share is subject matter rather than metadata.
   */
  if (!opts.includeUnmatched && linked.length > 0) {
    const confusions = confusionPairs(findings);
    for (const h of linked) {
      for (const other of confusions.get(h.finding.id) ?? []) {
        if (other !== h.finding.id && !h.confusedWith.includes(other)) {
          h.confusedWith.push(other);
        }
      }
    }
  }
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

  /*
   * Bounded to the head of the list, because this is pairwise.
   *
   * It compared every hit against every other, which is fine on the 31-finding
   * corpus it was written against and quadratic everywhere else: a broad query
   * over 10,000 findings returned 4,517 hits and spent 4.1 SECONDS here. That
   * cost then multiplied through confusion learning, which issues one query
   * per finding, and produced a 60-second first query that I misattributed to
   * the probing rather than to this.
   *
   * Nothing is lost. A sibling link tells a reader that the thing they are
   * looking at has a near-twin; it is worthless on the four-thousandth result,
   * which nobody will read. Linking the head is the whole of the value, and it
   * turns n^2 into a constant.
   */
  const LINK_WINDOW = 20;
  const window = hits.slice(0, LINK_WINDOW);

  /*
   * Tag sets built once per hit, not once per comparison.
   *
   * They were constructed inside the pairwise loop, so an eight-hit result
   * allocated over a hundred Sets per query to compare fifty-six pairs. The
   * loop is bounded now, so this is not a scaling bug -- it is simply the
   * largest remaining allocation in the hot path, and hoisting it is free.
   */
  const tags = window.map((h) => new Set(h.finding.tags.map((t) => t.toLowerCase())));
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const x of a) if (b.has(x)) shared++;
    return shared / (a.size + b.size - shared);
  };

  for (let i = 0; i < window.length; i++) {
    for (let j = i + 1; j < window.length; j++) {
      const a = window[i];
      const b = window[j];
      // Comparable: the weaker scores at least 60% of the stronger. Below
      // that the ranking has expressed a real preference and should be left
      // to express it.
      if (a.score <= 0 || b.score / a.score < 0.6) continue;
      const sameSubject =
        a.finding.subject.name.toLowerCase() === b.finding.subject.name.toLowerCase();
      const sameTags = jaccard(tags[i], tags[j]) >= 0.5;
      if (!sameSubject && !sameTags) continue;
      a.siblings.push(b.finding.id);
      b.siblings.push(a.finding.id);
    }
  }
  return hits;
}


/*
 * FOUR WALLS, AND WHY SEVENTEEN ATTEMPTS HIT THEM RATHER THAN SEVENTEEN
 * SEPARATE PROBLEMS.
 *
 * The residual failures have now survived approaches from five different
 * families, and they stopped being independent results some time ago. What is
 * below is the structure they all ran into, because that is more useful than
 * the list.
 *
 * 1. THE tf=1 WALL. 63% of postings in this corpus have term frequency 1, and
 *    80% have 2 or less; findings are ~200-340 tokens and mention each word
 *    once. Every method that needs WITHIN-DOCUMENT term weighting therefore
 *    has nothing to weight. Query-likelihood with Dirichlet smoothing failed
 *    on this (no proportions to estimate). So did per-document "signature"
 *    terms: tf x idf degenerates to idf, so a finding's fifteen most
 *    characteristic terms come out tied at 3.5 and are an arbitrary slice of
 *    hundreds. Only presence/absence and cross-document rarity survive here.
 *
 * 2. LENGTH IS ALREADY NORMALISED. Seven of eleven misses are a shorter gold
 *    losing to a longer winner, median length ratio 1.09 and up to 1.85, which
 *    looks like a length-bias problem with a standard knob. It is not: BM25's
 *    b swept from 0.75 to 1.0 moves held-out P@1 not at all. The normalisation
 *    in place is already doing what it can.
 *
 * 3. EVERY RAW QUANTITY FAVOURS THE WINNER, because winners are bigger
 *    documents: more filler information, more same-clause coincidences, more
 *    background heat. Correcting for that empirically is the right idea and
 *    was built (flat-field, below) -- the diagnostic holds, 3 of 4 winners are
 *    hotter than the gold, and the effect is too small to act on before it
 *    starts costing machine-stderr accuracy.
 *
 * 4. NO GATE SEPARATES THE FAILURES FROM THE SUCCESSES. Measured, not assumed;
 *    the numbers are in the block below. Any signal needs to fire on the
 *    failures and not on the successes, and the margin distributions overlap
 *    so thoroughly that the best possible near-tie gate nets under one case
 *    against a standard error of two.
 *
 * WHAT WOULD ACTUALLY CLOSE IT, stated plainly because dancing around it wastes
 * the next person's evening: the remaining failures turn on what a sentence
 * ASSERTS, using vocabulary both findings share. `decision` and `publish` are
 * the crux of one because of what the clause claims, not because of any
 * statistic over the words -- and this file already recorded that conclusion
 * once, about "most recent call last" matching "the most recent record".
 *
 * That is semantic similarity, which means embeddings and a model. It is not
 * an unsolved problem in the field; it is unsolved HERE, because this project
 * deliberately does not take that dependency. The constraint is the wall. It
 * is a defensible constraint -- offline, deterministic, auditable, no model to
 * drift or version -- and it is a CHOICE rather than a limit of ingenuity, so
 * the next person should re-examine the choice rather than re-run the search.
 */

/*
 * WHY THE SIBLING RESIDUAL IS CLOSED, MEASURED RATHER THAN CONCLUDED.
 *
 * Thirteen approaches were tried against the four remaining held-out failures
 * and every one of them followed the same arc: a diagnostic showing the signal
 * really does separate the pairs, then a measurement showing it costs more
 * than it repairs. That pattern needed explaining rather than repeating, and
 * the explanation is arithmetic.
 *
 * At 0.895 there are 34 correct answers to protect and 4 to repair. Any new
 * signal therefore needs a GATE that fires on the 4 and not on the 34. The
 * natural gate is degeneracy: fire only when the top two are closer than this
 * query's own accidental gap, estimated per query from the median gap among
 * ranks 3..9 so that nothing about the eval set enters it.
 *
 * Measured over the 31 cases where that gap is well defined:
 *
 *   normalised split (s1 - s2) / accidental gap
 *     CORRECT    n=28   p25  7.58   median 18.27   p75 55.29
 *     FAILURES   n=3    min  0.53   median  3.22   max  7.58
 *
 * The distributions overlap. A gate loose enough to catch every failure fires
 * on 8 of the 28 correct answers as well. So the BEST case available to any
 * near-tie adjudicator, using the strongest candidate signal measured here
 * (conditional compression, 74% accurate standing alone), is
 *
 *   repair 4 x 0.74 = 2.96      damage 8 x 0.26 = 2.08      net +0.9 cases
 *
 * Under one case. The standard error on P@1 over 38 cases is +/-0.05, which is
 * about two cases. The entire family is worth less than the noise of the
 * instrument measuring it, and that is a fact about the corpus size rather
 * than about any of the thirteen ideas.
 *
 * This is what closes the question honestly. Not "nothing worked" -- several
 * things worked on the pairs and are recorded below -- but that no selector
 * separating 4 from 34 exists to be found, and one built anyway would be
 * fitted to the four cases it was built from. Revisit when the corpus is large
 * enough that near-tie sibling pairs are numerous enough to gate on
 * empirically; the diagnostic above is the test for when that is.
 */

/*
 * COMPRESSION was built here and removed, and it is the closest anything has
 * come to the sibling residual. Recorded in full because the next person will
 * think of it, and because what killed it is not what killed the others.
 *
 * Every ranking in this file is a bag of words. They differ in how a matched
 * term is weighted and agree completely in discarding the order the words came
 * in -- five detectors, one physics, which is why the four residual failures
 * fail identically in all of them. Two findings that use the same vocabulary
 * to assert different things are, to all five, the same finding.
 *
 * A compressor does not discard order. Feed it the finding, let it build a
 * dictionary, then feed it the query: what is left to encode is whatever the
 * finding did not already say.
 *
 *   cost(q | d) = C(d ++ q) - C(d)          (deflate, finding capped at 3000)
 *
 * Direction matters and the symmetric form is much worse -- normalised
 * compression distance is P@1 0.289 alone, dominated by finding length.
 * Conditioned this way it is 0.737 alone, and asked directly about each of the
 * four pairs the fusion cannot separate it picks the gold on ALL FOUR:
 *
 *   cairn-0016 vs -0017    96 bytes vs 100
 *   cairn-0018 vs -0026    61 vs 63
 *   cairn-0019 vs -0027   107 vs 112
 *   cairn-0030 vs -0001    52 vs 57
 *
 * Three ways of using it were measured and all three lose:
 *
 *   fused as a sixth ranking       0.895 -> 0.816 at every weight
 *   adjudicate a near-tie top two  0.895 -> 0.868 (fixes three, breaks four)
 *   ...gated to declared siblings  0.895 -> 0.868 (fires on one wrong pair)
 *
 * The first fails because RRF fuses POSITIONS and the margins are the entire
 * signal: four bytes. The second and third fail on the same arithmetic, which
 * is the real lesson. A signal that is right 74% of the time, let loose on 34
 * correct answers to repair 4 wrong ones, must fire almost exclusively on the
 * 4 to break even -- and no gate built from 38 cases can do that without being
 * fitted to those 4, which is not a retrieval improvement, it is memorising
 * the eval set with extra steps.
 *
 * So the honest reading is that the signal is real and the SELECTOR is not
 * learnable at this corpus size. It becomes viable when the corpus is large
 * enough that near-tie sibling pairs are numerous enough to gate on
 * empirically. Worth trying again then; not worth fitting now.
 */

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



/** Plain-token frequencies and length for one finding. */
function bm25Doc(f: Finding): { tf: Map<string, number>; length: number } {
  const terms = plainTokens(findingText(f));
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { tf, length: terms.length };
}

/**
 * Okapi BM25, as the second ranker.
 *
 * Standard parameters, standard formula, standard tokenisation. It is here
 * because it was measured and it BEAT this file's own scorer on author prose
 * by a wide margin — P@1 0.868 against 0.711 — and the honest response to that
 * is to use it rather than to defend the thing that lost.
 */
function bm25Rank(query: string, index: CorpusIndex): string[] {
  const K1 = 1.2;
  const B = 0.75;
  // Accumulate over postings, not over documents: only documents containing a
  // query term are touched, so cost tracks the answer rather than the corpus.
  const acc = new Map<number, number>();
  for (const t of new Set(plainTokens(query))) {
    const n = index.bm25Df.get(t) ?? 0;
    if (n === 0) continue;
    const idfw = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
    const tid = index.bmTermId.get(t);
    if (tid === undefined) continue;
    const from = index.bmTermOffset[tid];
    const to = index.bmTermOffset[tid + 1];
    for (let k = from; k < to; k++) {
      const doc = index.bmPostDoc[k];
      const tf = index.bmPostTf[k];
      const dl = index.docs[doc].bm25.length;
      const add = idfw * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / index.avgdl)));
      acc.set(doc, (acc.get(doc) ?? 0) + add);
    }
  }
  return [...acc]
    .sort((a, b) => b[1] - a[1])
    .map(([doc]) => index.docs[doc].finding.id);
}

/**
 * Reciprocal rank fusion of the two rankers.
 *
 * The measurement that motivated this is unusually clean. BM25 over plain
 * tokens wins on author prose (P@1 0.868 vs 0.711); the typed ranker — errno
 * aliases, paths, HTTP statuses, light stemming — wins on machine output
 * (1.000 vs 0.875) and is the only one that finds `ENOSPC` at all, since no
 * finding contains that string. Combining them INSIDE one scorer was tried and
 * made both worse, because they want incompatible inputs: derived tokens are
 * alternate spellings, and BM25 reads them as extra length.
 *
 * So they are not combined. They rank independently and are fused on POSITION,
 * which needs no shared scale, no shared tokenisation, and no weight to tune
 * between two quantities that are not comparable. A document both rankers like
 * rises; one that only a single ranker likes still places, but behind.
 *
 * k=60 is the value from the original RRF work and is left alone deliberately:
 * this file has three separate records of a threshold tuned against eight
 * cases and then found to mean nothing.
 */
/** BM25's standard saturation and length-normalisation constants, unchanged. */
const LENGTH_K1 = 1.2;
const LENGTH_B = 0.75;

const RRF_K = 60;

/**
 * How much more a term counts when it matched a finding's identity fields --
 * title, subject, check command -- than when it matched anywhere in its body.
 */
const STRONG_FIELD_BOOST = 2.5;

/**
 * How much less a term counts when the explanatory prose is its only source.
 *
 * Indexing mechanism/appliesTo is worth real accuracy and it also doubled the
 * surface a short query can collide with. `proxies blocked` -- two words --
 * began returning a finding about signing oracles whose mechanism prose
 * mentions a proxy in passing, ahead of the finding that IS about the proxy.
 * Damping rather than excluding, because the mention is still evidence; it is
 * just weaker than the finding's own account of itself.
 */
const WEAK_FIELD_DAMP = 0.5;

/**
 * How much the BM25 ordering counts against the typed ordering.
 *
 * Equal weight was measured first and it was a trade, not a win: prose P@1
 * rose 0.711 -> 0.763 and machine output fell 1.000 -> 0.875, because BM25
 * over plain tokens cannot match "proxies" to "proxy" and pulled the wrong
 * finding up. A ranker that is confidently wrong on a case should not be able
 * to override one that is right about it.
 */
const BM25_WEIGHT = 0.3;

/**
 * How much the query-coverage ordering counts.
 *
 * The third ranker is the only one of the three that is normalised by the
 * QUESTION rather than by the document, which is exactly why it is worth
 * fusing and exactly why it cannot be trusted alone: a finding that matches
 * one rare word and nothing else covers a large fraction of a short query.
 * Fused, it breaks ties the other two decide by document mass; weighted to
 * dominate, it would hand short queries to whatever shares their rarest term.
 */
const EXPLAINED_WEIGHT = 1.0;

/**
 * How far down the typed order coverage is computed.
 *
 * Nothing below this can reach rank 1 under RRF at these weights -- the best a
 * rank-50 candidate can gain is 1/(60+1) against the leader's 1/61 already
 * held -- so the work is bounded without changing any answer.
 */
const FUSE_WINDOW = 50;

/**
 * How much the English-subtracted ordering counts.
 *
 * The other three rankings all measure a term by its rarity in this corpus.
 * This is the only one that consults a reference outside it, which is why it
 * is worth fusing separately rather than folding into any of them.
 */
const LINE_WEIGHT = 0.4;

/**
 * How many candidates count as "in contention" when subtracting the shared
 * continuum. Wide enough to include the sibling that actually competes,
 * narrow enough that a long tail of incidental matches does not dilute what
 * counts as shared.
 */
const CONTEST_WINDOW = 10;

function fuse(rankings: Array<{ order: string[]; weight: number }>): Map<string, number> {
  const fused = new Map<string, number>();
  for (const { order, weight } of rankings) {
    order.forEach((id, i) => {
      fused.set(id, (fused.get(id) ?? 0) + weight / (RRF_K + i + 1));
    });
  }
  return fused;
}


/**
 * The command that failed, recovered from what it printed.
 *
 * Everything else in this file matches text against text. This is a different
 * KIND of evidence, and it was being discarded: a shell failure does not just
 * describe itself in words, it names the program that produced it, in a
 * position the convention fixes. `curl: (56) ...`, `rg: regex parse error`,
 * `/bin/sh: 1: dig: not found`.
 *
 * That is nearly deterministic where words are probabilistic. Measured over
 * the agent scenarios it narrowed 31 findings to between one and three on
 * every covered failure, and returned nothing at all for the three the corpus
 * does not cover -- which is precisely the case six statistical approaches
 * could not get right.
 *
 * Returns undefined when the text does not name a command, which is common and
 * fine: prose queries never will, and the caller falls back to text with
 * nothing lost.
 */
export function failingCommand(text: string): string | undefined {
  // "/bin/sh: 1: dig: not found" — the missing program, not the shell.
  const notFound = text.match(/\d+:\s*([a-z][a-z0-9_.-]{1,20}):\s*(?:command )?not found/i);
  if (notFound) return notFound[1].toLowerCase();
  // "curl: (56) ..." / "rg: regex parse error" — program at the head of a line.
  const prefixed = text.match(/(?:^|\n)\s*([a-z][a-z0-9_.-]{1,20}):\s/);
  if (!prefixed) return undefined;
  const c = prefixed[1].toLowerCase();
  // Words that occupy the same position without being programs. `git` writes
  // "error: pathspec ...", `node` writes "Error: Cannot find module".
  return ['error', 'warning', 'warn', 'info', 'fatal', 'note', 'usage', 'debug'].includes(c)
    ? undefined
    : c;
}

/*
 * `findingsNaming` was here. It built a regex and tested it against every
 * document, on every query -- linear in the corpus, in the hot path, and the
 * precise cost this file had just criticised in the BM25 baseline. A program
 * name is a fixed string, so the mapping belongs in the index. See
 * `byCommand`.
 */


/**
 * Which findings this retriever actually confuses, measured on itself.
 *
 * The sibling rule links findings that share a subject or most of their tags.
 * Measured against the held-out set, that catches one confusion in four:
 * cairn-0018 loses to cairn-0026 and cairn-0030 to cairn-0001 without either
 * pair sharing a subject or a tag, because what they share is a SUBJECT MATTER
 * — what a commitment binds, what the proxy does — and no field records that.
 *
 * Rather than invent a similarity measure for it, the corpus is asked. Every
 * finding carries `mechanism` and `appliesTo`, prose describing itself that is
 * deliberately never indexed. That makes each finding a labelled probe: query
 * with a finding's own description and the right answer is known. When the
 * retriever returns something else, that is not a metric — it is this
 * retriever, on this corpus, stating which pairs it cannot tell apart.
 *
 * The result is a confusion structure derived from measurement rather than
 * from a theory of similarity, and it is exactly as accurate as the retriever
 * is wrong. It costs one query per finding, computed once per index.
 *
 * This is possible because the corpus ships held-out prose per document. A
 * corpus of documents alone could not do it; there would be nothing to probe
 * with whose answer was already known.
 */
/**
 * Corpus size above which confusions are not computed at query time.
 *
 * 400 findings is roughly a second of probing on this hardware, which is
 * acceptable once per corpus version and unacceptable per query. Beyond it the
 * map must be precomputed and committed rather than derived on demand.
 */
const CONFUSION_MAX_CORPUS = 400;

let confusionCache: WeakMap<object, Map<string, string[]>> = new WeakMap();

export function confusionPairs(findings: Finding[]): Map<string, string[]> {
  const hit = confusionCache.get(findings);
  if (hit) return hit;

  /*
   * Cached on disk beside the index, on the same content fingerprint.
   *
   * Probing costs one full query per finding -- 28ms on 31 findings, measured,
   * which was a third of the entire cold path and would grow linearly with the
   * corpus. It is a pure function of the corpus, so it is exactly the work
   * that should happen once. Same best-effort rules as the index cache: any
   * filesystem failure degrades to recomputing, never to an error.
   */
  /*
   * Only computed for corpora small enough that probing is cheap.
   *
   * Measured, not assumed: on ten thousand findings the first query took 60
   * SECONDS. Capping the probe count to 400 was not enough, because each probe
   * is itself O(N) -- vocabulary shared across documents puts most of the
   * corpus in the postings, so 400 probes walk the whole thing 400 times.
   *
   * Above the threshold this returns empty and retrieval degrades to
   * declarative siblings, which is where it was an hour ago and is correct if
   * less informative. The right answer at that scale is to precompute the map
   * offline and commit it as data, exactly as data/word-frequency.json is
   * committed; that is not built, and pretending otherwise by shipping an O(N)
   * cost on the cold path would be worse than the gap.
   */
  // Identity, not just the corpus: a confusion pair is what retrieve() did,
  // which depends on the index as much as on the ranking that reads it.
  const fingerprint = indexIdentity(findings);
  const cached = readConfusionCache(fingerprint);
  if (cached) {
    confusionCache.set(findings, cached);
    return cached;
  }

  // Seeded empty first: confusionPairs is reached from retrieve(), so an
  // unseeded recursive call would loop. The probes below run against the
  // seeded empty map and therefore measure ranking WITHOUT confusion
  // disclosure, which is the honest thing to measure anyway.
  const pairs = new Map<string, string[]>();
  confusionCache.set(findings, pairs);

  // Size gate (see the comment above the fingerprint read): beyond this the
  // empty map is cached and retrieval degrades to declarative siblings.
  if (findings.length > CONFUSION_MAX_CORPUS) return pairs;

  /*
   * Bounded, because probing is one full query per finding.
   *
   * At 31 findings that is 28ms. At ten thousand it is twenty thousand
   * queries, which hung a benchmark and would hang a first lookup -- an O(N)
   * cost on a path whose whole design goal was to be independent of N.
   *
   * Above the cap the map is PARTIAL rather than absent: the findings probed
   * still get accurate confusion links, and the rest simply have none, which
   * is the same state every finding was in before this existed. A partial
   * truthful map degrades better than either an unbounded cost or a silent
   * switch-off.
   */
  const MAX_PROBES = 400;
  let probes = 0;

  const add = (a: string, b: string) => {
    const list = pairs.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    pairs.set(a, list);
  };

  for (const f of findings) {
    if (f.status === 'retired') continue;
    if (probes >= MAX_PROBES) break;
    for (const probe of [f.mechanism, f.appliesTo]) {
      if (!probe || probe.length < 40) continue;
      if (probes >= MAX_PROBES) break;
      probes += 1;
      const top = retrieve(probe.slice(0, 240), findings, { limit: 1 })[0];
      if (!top || top.finding.id === f.id) continue;
      // Symmetric: if this finding's own description reaches that one, an
      // agent landing on either should be told about the other.
      add(top.finding.id, f.id);
      add(f.id, top.finding.id);
    }
  }
  writeConfusionCache(fingerprint, pairs);
  return pairs;
}

/**
 * What the cached confusions were measured WITH, not just what they were
 * measured OVER.
 *
 * A confusion pair is the output of running the ranker over the corpus, so it
 * is derived from two things: the corpus and the ranker. The cache was keyed
 * on the corpus alone, under a literal `v1` that was never once bumped, beside
 * a comment asserting that the version covered the ranker. It did not, and the
 * failure is silent in the worst direction: a fusion change reordered results,
 * every measured confusion became a statement about the previous ranker, and
 * the delivery metric read 0.974 with no indication that a stale file was the
 * reason. That is cairn-0028's shape a fifth time -- a guard whose input never
 * varies passes everything -- and a hand-bumped constant would have been the
 * sixth, because the whole problem is that nobody remembers to bump it.
 *
 * So the key is derived rather than declared: every constant that can change
 * an ordering, including the two that an environment variable can override at
 * run time. Sweeping a weight now writes to its own key instead of poisoning
 * the one the next run reads.
 */
export function rankerSignature(): string {
  const constants = [
    RRF_K,
    Number(process.env.CAIRN_BM25_WEIGHT ?? BM25_WEIGHT),
    Number(process.env.CAIRN_EXPLAINED_WEIGHT ?? EXPLAINED_WEIGHT),
    FUSE_WINDOW,
    LENGTH_K1,
    LENGTH_B,
    NOISE_FLOOR,
    SIGNAL_FLOOR,
    MIN_QUERY_EXPLAINED,
    MIN_TERM_INFORMATION,
    STRONG_FIELD_BOOST,
    WEAK_FIELD_DAMP,
    Number(process.env.CAIRN_LINE_WEIGHT ?? LINE_WEIGHT),
    COMMON_RATE,
    CONTEST_WINDOW,
  ].join(',');
  return crypto.createHash('sha256').update(constants).digest('hex').slice(0, 12);
}

function confusionFileFor(fingerprint: string): string {
  return path.join(
    CACHE_DIR,
    `confusions-v2-${fingerprint.slice(0, 16)}-${rankerSignature()}.json`,
  );
}

function readConfusionCache(fingerprint: string): Map<string, string[]> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(confusionFileFor(fingerprint), 'utf8')) as {
      fingerprint: string;
      pairs: Array<[string, string[]]>;
    };
    if (raw.fingerprint !== fingerprint) return null;
    // No TTL: unlike confidence, a confusion does not decay with wall-clock
    // time. It changes only when the corpus or the ranker changes -- the
    // fingerprint covers the first and the ranker signature in the filename
    // covers the second, which is a claim this comment used to make about a
    // literal `v1` that covered nothing.
    return new Map(raw.pairs);
  } catch {
    return null;
  }
}

function writeConfusionCache(fingerprint: string, pairs: Map<string, string[]>): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = confusionFileFor(fingerprint);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fingerprint, pairs: [...pairs] }));
    fs.renameSync(tmp, file);
    /*
     * Drop the entries for rankers that no longer exist.
     *
     * Keying the cache on the ranker fixed a correctness bug and introduced a
     * housekeeping one: a sweep over two fusion weights wrote fifty-seven
     * files in an afternoon, every one of them describing a ranker that is
     * gone. There is exactly one live signature at a time, and a cached
     * confusion for any other is unreachable by construction, so anything
     * whose name does not match the file just written is garbage.
     *
     * Scoped to this corpus. A checkout that retrieves over more than one
     * corpus keeps a live entry for each, and clearing another one to save
     * kilobytes would cost it a rebuild.
     */
    const prefix = `confusions-v2-${fingerprint.slice(0, 16)}-`;
    const keep = path.basename(file);
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (!name.startsWith(prefix) || name === keep) continue;
      try {
        fs.unlinkSync(path.join(CACHE_DIR, name));
      } catch {
        /* another process holds it, or already gone */
      }
    }
  } catch {
    /* recomputed next time */
  }
}

/** Reset the memo. Tests build corpora repeatedly; nothing else needs this. */
export function clearConfusionCache(): void {
  confusionCache = new WeakMap();
}

/**
 * Flatten a built index into columns.
 *
 * Only what is expensive to recompute is stored. `byCommand` and the document
 * frequencies are cheap derivations over the postings, so they are rebuilt on
 * load rather than serialised -- storing them would trade file size for work
 * that costs microseconds.
 */
/**
 * Public wrapper, so the serving route can flatten an index without reaching
 * into the private builder. Same function; the name marks the boundary.
 */
export function toColumnarPublic(index: CorpusIndex, fingerprint: string) {
  return toColumnar(index, fingerprint);
}

function toColumnar(index: CorpusIndex, fingerprint: string) {
  const termIds = new Map<string, number>();
  const idOf = (t: string) => {
    let id = termIds.get(t);
    if (id === undefined) {
      id = termIds.size;
      termIds.set(t, id);
    }
    return id;
  };

  const pDoc: number[] = [], pTerm: number[] = [], pTf: number[] = [];
  const bDoc: number[] = [], bTerm: number[] = [], bTf: number[] = [];
  const strongDoc: number[] = [], strongTerm: number[] = [];
  const weakDoc: number[] = [], weakTerm: number[] = [];
  const confidence = new Float64Array(index.docs.length);
  const surprise = new Float64Array(index.docs.length);
  const docLength = new Int32Array(index.docs.length);
  const bm25Length = new Int32Array(index.docs.length);

  index.docs.forEach((d, i) => {
    confidence[i] = d.confidence;
    // NaN encodes null: surprise is absent for findings nobody forecast, and a
    // sentinel number would be indistinguishable from a real score.
    surprise[i] = d.surprise === null ? Number.NaN : d.surprise;
    docLength[i] = d.length;
    bm25Length[i] = d.bm25.length;
  });

  // Postings come from the flat arrays the index already holds, walked through
  // the offset table so term ids survive into the file unchanged.
  for (const [term, tid] of index.termId) {
    const id = idOf(term);
    for (let k = index.termOffset[tid]; k < index.termOffset[tid + 1]; k++) {
      pDoc.push(index.postDoc[k]); pTerm.push(id); pTf.push(index.postTf[k]);
    }
  }
  for (const [term, tid] of index.bmTermId) {
    const id = idOf(term);
    for (let k = index.bmTermOffset[tid]; k < index.bmTermOffset[tid + 1]; k++) {
      bDoc.push(index.bmPostDoc[k]); bTerm.push(id); bTf.push(index.bmPostTf[k]);
    }
  }
  for (const [term, docs] of index.strongByTerm) {
    const id = idOf(term);
    for (const d of docs) { strongDoc.push(d); strongTerm.push(id); }
  }
  /*
   * Its own loop, deliberately.
   *
   * This was nested inside the strong loop above, which silently wrote almost
   * nothing: a weak term is BY DEFINITION one that appears only in the
   * explanatory prose, so it is precisely the term that is not in
   * `strongByTerm`, and iterating the strong map to find weak entries visits
   * the one collection guaranteed not to contain them. The index was correct
   * when built and lost its weak tier on every reload after -- first run
   * 0.836 held-out with machine 8/8, every run after 0.851 with machine 7/8.
   *
   * cairn-0028's shape once more: a loop whose input selector cannot return
   * what it is looking for does not fail, it finds nothing.
   */
  for (const [term, docs] of index.weakByTerm) {
    const id = idOf(term);
    for (const d of docs) { weakDoc.push(d); weakTerm.push(id); }
  }

  const nTerms = termIds.size;
  const packed = packPostings(pDoc, pTerm, pTf, nTerms);
  const bmPacked = packPostings(bDoc, bTerm, bTf, nTerms);

  // Command index, flattened the same way, so it is stored rather than
  // recomputed by tokenising every finding on every load.
  const byId = new Map(index.docs.map((d, i) => [d.finding.id, i]));
  const cmdIds = new Map<string, number>();
  const cDoc: number[] = [], cTerm: number[] = [];
  for (const [cmd, ids] of index.byCommand) {
    let cid = cmdIds.get(cmd);
    if (cid === undefined) { cid = cmdIds.size; cmdIds.set(cmd, cid); }
    for (const id of ids) {
      const d = byId.get(id);
      if (d !== undefined) { cDoc.push(d); cTerm.push(cid); }
    }
  }
  const cmdPacked = packPostings(cDoc, cTerm, cDoc.map(() => 0), cmdIds.size);

  return {
    fingerprint,
    builtAt: index.builtAt,
    terms: [...termIds.keys()],
    confidence,
    surprise,
    docLength,
    bm25Length,
    postOffset: packed.offset,
    postDoc: packed.postDoc,
    postTf: packed.postTf,
    bmOffset: bmPacked.offset,
    bmDoc: bmPacked.postDoc,
    bmTf: bmPacked.postTf,
    strongDoc: Int32Array.from(strongDoc),
    strongTerm: Int32Array.from(strongTerm),
    weakDoc: Int32Array.from(weakDoc),
    weakTerm: Int32Array.from(weakTerm),
    cmdOffset: cmdPacked.offset,
    cmdDoc: cmdPacked.postDoc,
    commands: [...cmdIds.keys()],
  };
}

/**
 * Rebuild the in-memory index from columns.
 *
 * The point is what is NOT rebuilt. Per-document term maps and plain-token
 * frequency maps existed only so the cold build could construct the postings
 * from them; nothing in the scoring path ever reads them. Repopulating them on
 * load meant allocating 3.2 million Map entries at ten thousand findings to
 * satisfy no reader, which is most of what made loading a flat file take
 * 1.8 seconds instead of the 11ms the file itself costs.
 *
 * What the scorer actually needs is the postings, the per-document scalars,
 * and a strong-term membership test -- all of which come straight off the
 * columns, one allocation per distinct term rather than per document.
 */
function fromColumnar(c: ColumnarIndex, findings: Finding[]): CorpusIndex {
  const docs: Indexed[] = findings.map((f, i) => ({
    id: f.id,
    finding: f,
    // Empty by design: build-time scratch, never read during scoring.
    bm25: { tf: new Map<string, number>(), length: c.bm25Length[i] ?? 0 },
    length: c.docLength[i] ?? 0,
    confidence: c.confidence[i] ?? 0,
    surprise: Number.isNaN(c.surprise[i]) ? null : c.surprise[i],
    terms: new Map<string, number>(),
    strong: new Set<string>(),
    weak: new Set<string>(),
  }));

  /*
   * Flat postings straight from the columns.
   *
   * No Map of arrays of objects is built at any point. `packPostings` groups
   * the triples by term with a counting sort into typed arrays, and document
   * frequency falls out of the offset table -- a term's df is the length of
   * its run -- so the only per-term allocation is the dictionary entry.
   */
  const termId = new Map<string, number>();
  c.terms.forEach((t, i) => termId.set(t, i));

  // Nothing is grouped or tokenised here. The postings arrive already grouped
  // by term and the offset tables arrive with them, so document frequency is
  // the length of a run and the only work is the dictionary.
  const df = new Map<string, number>();
  const bm25Df = new Map<string, number>();
  for (let t = 0; t < c.terms.length; t++) {
    const n1 = c.postOffset[t + 1] - c.postOffset[t];
    if (n1 > 0) df.set(c.terms[t], n1);
    const n2 = c.bmOffset[t + 1] - c.bmOffset[t];
    if (n2 > 0) bm25Df.set(c.terms[t], n2);
  }

  const strongByTerm = new Map<string, Set<number>>();
  for (let k = 0; k < c.strongDoc.length; k++) {
    const term = c.terms[c.strongTerm[k]];
    const set = strongByTerm.get(term);
    if (set) set.add(c.strongDoc[k]);
    else strongByTerm.set(term, new Set([c.strongDoc[k]]));
  }


  const weakByTerm = new Map<string, Set<number>>();
  for (let k = 0; k < c.weakDoc.length; k++) {
    const term = c.terms[c.weakTerm[k]];
    const set = weakByTerm.get(term);
    if (set) set.add(c.weakDoc[k]);
    else weakByTerm.set(term, new Set([c.weakDoc[k]]));
  }
  const byCommand = new Map<string, Set<string>>();
  c.commands.forEach((cmd, ci) => {
    const set = new Set<string>();
    for (let k = c.cmdOffset[ci]; k < c.cmdOffset[ci + 1]; k++) {
      const d = docs[c.cmdDoc[k]];
      if (d) set.add(d.finding.id);
    }
    byCommand.set(cmd, set);
  });

  let sumBm = 0;
  let sumLen = 0;
  for (let i = 0; i < docs.length; i++) {
    sumBm += c.bm25Length[i] ?? 0;
    sumLen += c.docLength[i] ?? 0;
  }

  return {
    docs,
    df,
    n: docs.length,
    builtAt: c.builtAt,
    bm25Df,
    avgdl: sumBm / Math.max(1, docs.length),
    avgTypedLen: sumLen / Math.max(1, docs.length),
    byCommand,
    strongByTerm,
    weakByTerm,
    termId,
    termOffset: c.postOffset,
    postDoc: c.postDoc,
    postTf: c.postTf,
    bmTermId: termId,
    bmTermOffset: c.bmOffset,
    bmPostDoc: c.bmDoc,
    bmPostTf: c.bmTf,
  };
}

/**
 * Group (doc, term, tf) triples into flat postings with an offset table.
 *
 * Sorts by term id, then records where each term's run begins. After this a
 * term's postings are a contiguous slice of two Int32Arrays, which is what
 * lets both the on-disk format and the in-memory index be the same shape --
 * the file stops needing to be unpacked into objects to be usable.
 */
function packPostings(
  doc: ArrayLike<number>,
  term: ArrayLike<number>,
  tf: ArrayLike<number>,
  nTerms: number,
): { offset: Int32Array; postDoc: Int32Array; postTf: Int32Array } {
  const n = doc.length;
  const counts = new Int32Array(nTerms + 1);
  for (let k = 0; k < n; k++) counts[term[k] + 1] += 1;
  for (let t = 0; t < nTerms; t++) counts[t + 1] += counts[t];
  const offset = counts;

  const cursor = Int32Array.from(offset.subarray(0, nTerms));
  const postDoc = new Int32Array(n);
  const postTf = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const at = cursor[term[k]]++;
    postDoc[at] = doc[k];
    postTf[at] = tf[k];
  }
  return { offset, postDoc, postTf };
}

/**
 * Build the flat postings from the Map form.
 *
 * Both construction paths -- cold build and columnar load -- go through here,
 * so the two cannot drift into representing the same postings differently.
 * That matters more than the few milliseconds a specialised path would save:
 * a scorer that silently reads a stale shape is the kind of defect this
 * session has already produced twice.
 */
function flatten(
  postings: Map<string, Array<{ doc: number; tf: number }>>,
  bm25Postings: Map<string, Array<{ doc: number; tf: number }>>,
) {
  const pack = (m: Map<string, Array<{ doc: number; tf: number }>>) => {
    const id = new Map<string, number>();
    let n = 0;
    for (const [term, list] of m) {
      id.set(term, id.size);
      n += list.length;
    }
    const doc = new Int32Array(n);
    const term = new Int32Array(n);
    const tf = new Int32Array(n);
    let k = 0;
    for (const [t, list] of m) {
      const tid = id.get(t)!;
      for (const p of list) {
        doc[k] = p.doc;
        term[k] = tid;
        tf[k] = p.tf;
        k++;
      }
    }
    return { id, ...packPostings(doc, term, tf, id.size) };
  };

  const a = pack(postings);
  const b = pack(bm25Postings);
  return {
    termId: a.id,
    termOffset: a.offset,
    postDoc: a.postDoc,
    postTf: a.postTf,
    bmTermId: b.id,
    bmTermOffset: b.offset,
    bmPostDoc: b.postDoc,
    bmPostTf: b.postTf,
  };
}
