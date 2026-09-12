import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Write a file so that a reader never sees half of it.
 *
 * Every corpus mutation in this repo is a read-modify-write of a JSON file that
 * something else will later parse and trust. A plain `writeFileSync` killed
 * partway through leaves truncated JSON on disk: `loadCorpus` throws, and the
 * site goes down with the corpus. Writing to a sibling temp file and renaming
 * makes the swap atomic on POSIX, so the file is either the old content or the
 * new one.
 *
 * Hardening:
 *  - the temp name carries a random suffix and is created with `wx` (exclusive),
 *    so a stale temp left by a crashed same-pid run cannot be reused with its old
 *    mode — a 0o600 secret written into a 0o644 leftover was a real exposure.
 *  - a write/fsync failure (ENOSPC — this sandbox, cairn-0008) unlinks the temp
 *    rather than leaving it behind.
 *  - after the rename the DIRECTORY is fsync'd on POSIX, so the rename itself
 *    survives power loss, not just the file contents.
 * `mode` is applied at create so a secret is never briefly world-readable.
 */
export function writeFileAtomic(file: string, data: string, mode?: number): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = fs.openSync(tmp, 'wx', mode ?? 0o644); // exclusive create: never reuse a stale temp's mode
  } catch (e) {
    throw e;
  }
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* nothing better to do */ }
    throw e; // e.g. ENOSPC — leave no truncated temp behind
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* the rename failure is the interesting one */ }
    throw e;
  }
  /* Persist the rename itself: fsync the directory (best-effort; not supported everywhere). */
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch {
    /* directory fsync is unavailable on some platforms/filesystems; the rename is still atomic */
  }
}

/** As writeFileAtomic, for JSON, with the trailing newline the corpus uses. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}
