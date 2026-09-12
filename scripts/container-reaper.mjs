/** Independent host cleanup. Fixed local Docker endpoint; no application imports. */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' };
const run = (args) => execFileSync('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', ...args], {
  env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
});

export function expiredCairnContainers(containers, now = Date.now()) {
  return containers.filter((c) => {
    const labels = c.Config?.Labels;
    const expiry = labels?.['cairn.expires'];
    return /^[a-f0-9]{64}$/.test(c.Id ?? '')
      && /^\/cairn-[a-f0-9-]{36}$/.test(c.Name ?? '')
      && labels?.['cairn.isolated'] === 'true'
      && typeof expiry === 'string' && /^\d{13}$/.test(expiry)
      && Number(expiry) <= now;
  }).sort((a, b) => Number(a.Config.Labels['cairn.expires']) - Number(b.Config.Labels['cairn.expires']));
}

export function reapExpired() {
  const ids = run(['ps', '--all', '--quiet', '--no-trunc', '--filter=label=cairn.isolated=true']).trim().split(/\s+/).filter(Boolean);
  let removed = 0;
  let failures = 0;
  // Bounded batches; oldest expired containers are removed first within a batch.
  for (let i = 0; i < ids.length; i += 64) {
    const batch = ids.slice(i, i + 64);
    if (batch.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid container ID from Docker');
    let containers;
    try { containers = JSON.parse(run(['inspect', ...batch])); }
    catch { failures++; continue; } // next timer run retries a deletion race or daemon failure
    for (const c of expiredCairnContainers(containers)) {
      try { run(['rm', '--force', c.Id]); removed++; }
      catch { failures++; }
    }
  }
  if (failures) throw new Error(`Container reaper removed ${removed}; ${failures} inspection/removal operation(s) failed; retry required`);
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(`cairn-container-reaper: removed ${reapExpired()} expired container(s)`); }
  catch (error) { console.error(`cairn-container-reaper: ${error.message}`); process.exitCode = 1; }
}
