import { z } from 'zod';

export const ConfigSchema = z.object({
  endpoint: z.string().url(),
  timeoutMs: z.number(),
});

export type Config = z.infer<typeof ConfigSchema>;
