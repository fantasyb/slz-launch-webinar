/**
 * Generates examples/upstream-demo/federation.json — a SYNTHETIC peer cairn.
 *
 * This exists so the federation merge can be demonstrated in a sandbox with no
 * outbound network. Everything in it is fabricated for that purpose, signed by
 * a throwaway key, and namespaced under `demo:` so it can never be mistaken
 * for corpus data. Its findings describe a macOS environment precisely because
 * this machine has none: the point of federation is breadth you cannot
 * generate yourself.
 *
 *   npx tsx examples/make-upstream-demo.ts
 */
import fs from 'fs';
import path from 'path';
import { generateKeypair, signObservation } from '../src/lib/cairn/signing';

const { record, privateKey } = generateKeypair('peer-agent-demo');

const DARWIN = { os: 'darwin', arch: 'arm64', runtime: 'node 22.x', note: 'SYNTHETIC FIXTURE — not a real machine' };

const base = [
  {
    id: 'cairn-0001',
    title: 'BSD sed -i requires an explicit backup suffix',
    claim: 'On macOS, `sed -i` without an argument consumes the next token as the backup suffix, so `sed -i s/a/b/ file` silently treats the expression as the suffix and fails, unlike GNU sed where -i takes no argument.',
    kind: 'trap' as const,
    subject: { name: 'sed', ecosystem: 'shell', versions: 'BSD' },
    scope: 'environment-specific' as const,
    appliesTo: 'macOS and other BSD userlands, where sed is not GNU sed.',
    tags: ['macos', 'bsd', 'sed', 'portability'],
    cost: 'minutes' as const,
    expectation: 'A script using `sed -i` that works on Linux CI works on a developer laptop.',
    reality: 'BSD sed reads the next token as the backup suffix. The script fails, or worse, edits the wrong path. Scripts written on Linux break only on macOS, and vice versa.',
    mechanism: 'BSD sed defines -i as taking a mandatory extension argument; GNU sed defines it as optional.',
    workaround: "Use `sed -i '' -e expr file` on BSD and `sed -i -e expr file` on GNU, or avoid in-place editing in portable scripts entirely.",
    halfLifeDays: 2000,
  },
  {
    id: 'cairn-0002',
    title: 'Case-insensitive filesystems make two distinct git paths collide',
    claim: 'On a default macOS volume the filesystem is case-insensitive, so a repository containing both Foo.ts and foo.ts checks out only one of them and reports the other as deleted.',
    kind: 'limitation' as const,
    subject: { name: 'git', ecosystem: 'shell', versions: '*' },
    scope: 'environment-specific' as const,
    appliesTo: 'Default APFS and HFS+ volumes on macOS, and Windows NTFS by default.',
    tags: ['macos', 'filesystem', 'git', 'case-sensitivity'],
    cost: 'hours' as const,
    expectation: 'A clean clone of a repository produces a clean working tree.',
    reality: 'git status reports a deletion nobody made, and the deletion reappears after every checkout. Committing the apparent fix deletes the file for contributors on case-sensitive systems.',
    mechanism: 'Git tracks paths as bytes; the filesystem folds case. Two index entries map to one directory entry.',
    workaround: 'Rename one path so the pair no longer collides, or work from a case-sensitive volume. Never resolve it by committing the phantom deletion.',
    halfLifeDays: 3000,
  },
];

const findings = base.map((b) => {
  const observation = {
    at: '2026-08-28T10:00:00Z',
    by: 'peer-agent-demo',
    verdict: 'confirmed' as const,
    note: 'SYNTHETIC FIXTURE observation, generated to demonstrate federation. Not a real measurement.',
    environment: DARWIN,
  };
  const value = signObservation(b.id, observation, privateKey);
  return {
    ...b,
    evidence: [
      {
        command: '# synthetic fixture — no command was run',
        output: '(fixture)',
        note: 'This bundle exists to exercise the merge path, not to assert anything.',
      },
    ],
    check: {
      command: 'uname -s',
      confirmedIf: 'the platform matches appliesTo and the described behaviour reproduces',
      refutedIf: 'the behaviour does not reproduce on a matching platform',
      manual: true,
    },
    provenance: 'firsthand' as const,
    observations: [{ ...observation, signature: { algorithm: 'ed25519' as const, keyId: record.keyId, value } }],
    predictions: [],
    status: 'active' as const,
    createdAt: '2026-08-28T10:00:00Z',
  };
});

const bundle = {
  origin: 'demo-peer.example (SYNTHETIC FIXTURE)',
  generatedAt: new Date().toISOString(),
  findings,
  keys: [record],
};

const out = path.join(process.cwd(), 'examples', 'upstream-demo', 'federation.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), out)} — ${findings.length} findings signed by ${record.keyId}`);
