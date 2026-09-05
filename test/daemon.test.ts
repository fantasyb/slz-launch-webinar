/**
 * The always-on daemon: it ticks on a timer, forever, and stops cleanly on a
 * signal. These pin the two properties the launchd/service wrapper depends on —
 * the tick fires repeatedly without being re-invoked, and SIGTERM ends it with a
 * clean exit rather than leaving launchd to KeepAlive-restart a wedged process.
 * A tick override (CAIRN_DAEMON_TICK_CMD) stands in for the real triage trigger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const SCRIPT = path.join(process.cwd(), 'scripts', 'daemon.ts');
/* The local tsx bin directly, not `npx tsx`: npx is an extra process layer that
 * swallows the signal, so the daemon's own clean exit(0) never reaches us. tsx
 * runs the script in-process and forwards SIGTERM to its handler. */
const TSX = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');

/** Poll a predicate up to `ms`, resolving true as soon as it holds. */
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

test('it ticks repeatedly on the interval, then exits cleanly on SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-daemon-'));
  const marker = path.join(dir, 'ticks');
  /* Every tick appends a line; a fast interval so the test does not crawl. */
  const child = spawn(TSX, [SCRIPT, '--interval', '1'], {
    env: { ...process.env, CAIRN_DAEMON_TICK_CMD: `printf 't\\n' >> "${marker}"` },
    stdio: 'ignore',
  });
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.on('exit', (c, s) => { exitCode = c; exitSignal = s; });

  const ticks = () => {
    try { return fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
  };
  try {
    /* At least two ticks proves the loop runs on its own, not once. */
    const ticked = await until(() => ticks() >= 2, 8000);
    assert.ok(ticked, `daemon ticked at least twice on its own, saw ${ticks()}`);

    child.kill('SIGTERM');
    const stopped = await until(() => exitCode !== null || exitSignal !== null, 4000);
    assert.ok(stopped, 'daemon exited after SIGTERM');
    /* Clean exit(0), not killed by the signal: the handler ran and shut it down. */
    assert.equal(exitSignal, null, 'exited on its own, not by the raw signal');
    assert.equal(exitCode, 0, 'clean exit code so launchd does not treat it as a crash');
  } finally {
    /* Never leak a live daemon on assertion failure — it would keep the runner alive. */
    if (exitCode === null && exitSignal === null) child.kill('SIGKILL');
  }
});

test('the first tick fires immediately, not only after one interval', async () => {
  /* A 300s default must still do useful work at once on boot — the loop ticks
   * before it sleeps. Use a long interval so only the eager first tick can land. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-daemon-'));
  const marker = path.join(dir, 'ticks');
  const child = spawn(TSX, [SCRIPT, '--interval', '3600'], {
    env: { ...process.env, CAIRN_DAEMON_TICK_CMD: `printf 't\\n' >> "${marker}"` },
    stdio: 'ignore',
  });
  const fired = await until(() => fs.existsSync(marker), 8000);
  child.kill('SIGTERM');
  assert.ok(fired, 'ticked once immediately, before the first long sleep');
});
