import fs from 'fs';
import { z } from 'zod';
import { homePath } from './home';

/**
 * What a corpus does with a new finding by default.
 *
 * A person recording a trap has just decided, implicitly, whether it was
 * about their organisation or about the platform — and that is the only
 * moment anybody knows. Asking them to revisit it later, per finding, is how
 * everything ends up private by neglect or shared by accident.
 *
 * So: a default in the corpus's own config, overridable per finding, and
 * `private` when nothing says otherwise. The failure mode of guessing the
 * other way is publishing somebody's org data.
 */
const ConfigVisibility = z.object({
  defaultVisibility: z.enum(['private', 'shared']).optional(),
});

export function defaultVisibility(): 'private' | 'shared' {
  try {
    const raw = fs.readFileSync(homePath('cairn.config.json'), 'utf8');
    return ConfigVisibility.parse(JSON.parse(raw)).defaultVisibility ?? 'private';
  } catch {
    return 'private';
  }
}
