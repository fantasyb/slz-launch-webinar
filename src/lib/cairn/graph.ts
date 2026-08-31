/**
 * Relationships between findings, derived rather than declared.
 *
 * Retrieval ranks findings against a query independently, as though the corpus
 * were a bag of unrelated facts. It is not. Traps travel together: the sandbox
 * that redirects UDP/53 is the sandbox with no `dig`, and the machine where
 * `playwright install` re-downloads browsers is the machine whose disk
 * accounting then lies about why. An agent that hits one is very often about
 * to hit the others, and telling it so is worth more than a slightly better
 * score on the one it happened to ask about.
 *
 * TWO KINDS OF EDGE, AND THEY ARE NOT THE SAME KIND OF CLAIM
 *
 *   sibling       topical. Same subject, or substantially the same tags. Says
 *                 these findings are ABOUT the same thing. Computed in
 *                 retrieval.ts per result set, because it depends on what the
 *                 query matched.
 *
 *   co-occurrence empirical. The same attester, on the same environment,
 *                 confirmed both. Says somebody actually hit both, which is a
 *                 fact about the world rather than about vocabulary. Two
 *                 findings can co-occur with no words in common — that is
 *                 exactly when the edge earns its keep, because no amount of
 *                 text similarity would ever have connected them.
 *
 * Co-occurrence is computable only because observations record a structured
 * environment and a signing key. A corpus of prose notes could not derive it
 * at all. That data was collected to count breadth; this comes free.
 *
 * WHAT IS NOT CLAIMED
 *
 * Co-occurrence is not causation and this does not pretend otherwise. Two
 * findings confirmed on one machine may share a cause, or one may lead to the
 * other, or the same agent may simply have had a long afternoon. The edge says
 * "these were seen together, this often, by this many distinct parties", and
 * stops.
 *
 * It is also weak evidence at this corpus size and says so structurally:
 * `attesters` rides on every edge beside `weight`, because a hundred
 * co-occurrences from one key is one agent's afternoon, not a pattern.
 */
import type { Finding, Observation } from './schema';
import { environmentSignature } from './schema';
import { verifyObservation, findingBodyHash } from './signing';
import { loadKeys } from './keys';

/**
 * Who observed this, for joining observations across findings.
 *
 * A verified signature is the identity; free-text `by` is a fallback, and it is
 * namespaced so it can never collide with a key id. Unsigned observations are
 * kept because excluding them would empty the graph on a young corpus, but they
 * stay distinguishable so callers can weigh them differently.
 */
function attesterOf(f: Finding, o: Observation): { id: string; signed: boolean } | null {
  if (o.signature) {
    const keys = loadKeys();
    if (verifyObservation(f.id, o, keys, findingBodyHash(f)) === 'signed') {
      return { id: `key:${o.signature.keyId}`, signed: true };
    }
  }
  return o.by ? { id: `by:${o.by.toLowerCase()}`, signed: false } : null;
}

export interface CoOccurrence {
  /** The other finding's id. */
  id: string;
  /** Distinct (attester, environment) contexts that confirmed both. */
  weight: number;
  /** How many DISTINCT attesters. One is one agent's afternoon. */
  attesters: number;
  /** Whether any contributing attester was cryptographically verified. */
  signed: boolean;
}

/**
 * Build the co-occurrence graph.
 *
 * Only `confirmed` observations count. A refutation says the finding did not
 * reproduce there, which is the opposite of evidence that it travels with
 * anything, and an inconclusive says nothing at all.
 */
export function coOccurrence(findings: Finding[]): Map<string, CoOccurrence[]> {
  // attester -> environment -> the findings confirmed in that context
  const contexts = new Map<string, Map<string, { ids: Set<string>; signed: boolean }>>();

  for (const f of findings) {
    for (const o of f.observations) {
      if (o.verdict !== 'confirmed' || !o.environment) continue;
      const who = attesterOf(f, o);
      if (!who) continue;
      const env = environmentSignature(o.environment);
      let perAttester = contexts.get(who.id);
      if (!perAttester) contexts.set(who.id, (perAttester = new Map()));
      const slot = perAttester.get(env) ?? { ids: new Set<string>(), signed: false };
      slot.ids.add(f.id);
      slot.signed = slot.signed || who.signed;
      perAttester.set(env, slot);
    }
  }

  const pairs = new Map<string, { weight: number; attesters: Set<string>; signed: boolean }>();
  for (const [attester, perEnv] of contexts) {
    for (const { ids, signed } of perEnv.values()) {
      const list = [...ids].sort();
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const key = `${list[i]} ${list[j]}`;
          const slot = pairs.get(key) ?? {
            weight: 0,
            attesters: new Set<string>(),
            signed: false,
          };
          slot.weight += 1;
          slot.attesters.add(attester);
          slot.signed = slot.signed || signed;
          pairs.set(key, slot);
        }
      }
    }
  }

  const graph = new Map<string, CoOccurrence[]>();
  const add = (
    from: string,
    to: string,
    s: { weight: number; attesters: Set<string>; signed: boolean },
  ) => {
    const list = graph.get(from) ?? [];
    list.push({ id: to, weight: s.weight, attesters: s.attesters.size, signed: s.signed });
    graph.set(from, list);
  };
  for (const [key, slot] of pairs) {
    const [a, b] = key.split(' ');
    add(a, b, slot);
    add(b, a, slot);
  }
  // Strongest first; at equal weight prefer the edge more parties vouched for.
  for (const list of graph.values()) {
    list.sort((x, y) => y.weight - x.weight || y.attesters - x.attesters);
  }
  return graph;
}

/**
 * Findings an agent hitting `id` is likely to hit next, strongest first.
 *
 * `minAttesters` defaults to 1 because requiring two would return nothing on a
 * corpus this young. That is a real weakness, and it is why `attesters` rides
 * on every edge: a caller displaying these must not present one agent's
 * afternoon as a pattern.
 */
export function alsoSeenWith(
  id: string,
  findings: Finding[],
  { limit = 5, minAttesters = 1 } = {},
): CoOccurrence[] {
  return (coOccurrence(findings).get(id) ?? [])
    .filter((e) => e.attesters >= minAttesters)
    .slice(0, limit);
}
