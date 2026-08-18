import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const fileMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  media_type: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** Optional so clients can still read file records written by older daemons. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  created_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema.optional(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;
