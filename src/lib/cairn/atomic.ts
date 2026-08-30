import fs from 'fs';
import path from 'path';

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
 * `mode` is applied to the temp file before the rename, so a secret is never
 * briefly world-readable at its final path.
 */
export function writeFileAtomic(file: string, data: string, mode?: number): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w', mode ?? 0o644);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the rename failure is the interesting one */
    }
    throw e;
  }
}

/** As writeFileAtomic, for JSON, with the trailing newline the corpus uses. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}
