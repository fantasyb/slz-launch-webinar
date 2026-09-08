/** Durable denial evidence for an isolated workload, outside the corpus. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface WorkloadIdentity { image: string; command: string; args: string[] }
export function quarantineDirectory(): string {
  return process.env.CAIRN_CONTAINER_QUARANTINE_DIR ?? path.join(os.homedir(), '.cairn', 'container-quarantine');
}
export function workloadId(identity: WorkloadIdentity): string {
  // Credentials are neither persisted nor part of the identity: rotating one
  // must not silently readmit the same faulty executable.
  return createHash('sha256').update(JSON.stringify([identity.image, identity.command, identity.args])).digest('hex');
}
export class ContainerQuarantine {
  constructor(private readonly directory = quarantineDirectory()) {}
  private file(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid workload identity');
    return path.join(this.directory, `${id}.json`);
  }
  assertAdmitted(id: string): void {
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(this.directory).isDirectory()) throw new Error('Not a directory');
      fs.accessSync(this.directory, fs.constants.R_OK | fs.constants.W_OK);
    } catch { throw new Error('Cannot verify container quarantine state; refusing launch'); }
    try { fs.lstatSync(this.file(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Cannot verify container quarantine state; refusing launch');
    }
    // Presence is denial, including empty, corrupt or symlinked evidence.
    // An attacker cannot gain permission by making the evidence unparsable.
    throw new Error(`Container workload ${id} is quarantined; operator recovery required`);
  }
  record(id: string): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(this.file(id), 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, workload: id, reason: 'transport-fault', at: new Date().toISOString() }) + '\n');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const directoryFd = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(directoryFd); }
      finally { fs.closeSync(directoryFd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
