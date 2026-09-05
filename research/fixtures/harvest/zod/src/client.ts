import { ConfigSchema, type Config } from './config';

export function makeClient(config: Config) {
  return { url: config.endpoint, timeout: config.timeoutMs };
}

// Callers construct a Config literal and pass it in.
export const defaultClient = makeClient({ endpoint: 'https://api.internal', timeoutMs: 5000 });
