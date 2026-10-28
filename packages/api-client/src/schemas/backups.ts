import { z } from 'zod';
import type { components } from '../generated/api.js';

const backupStepSchema = z.enum(['local', 'offsite']);
const backupStatusSchema = z.enum(['succeeded', 'failed']);

/** One recorded step of a nightly backup. `error` is a fixed phrase and exit code: show it as text. */
export const backupRunSchema = z.object({
  id: z.uuid(),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  step: backupStepSchema,
  status: backupStatusSchema,
  snapshotId: z.string().nullable(),
  // int64 may arrive as a number or a digit string.
  bytes: z
    .union([z.number().int().nonnegative(), z.string().regex(/^(?:0|[1-9]\d*)$/)])
    .transform(Number)
    .nullable(),
  error: z.string().nullable(),
});

export const backupRunListSchema = z.object({ runs: z.array(backupRunSchema) });

export type BackupStep = z.infer<typeof backupStepSchema>;
export type BackupRun = z.infer<typeof backupRunSchema>;
export type BackupRunList = z.infer<typeof backupRunListSchema>;

type Schemas = components['schemas'];
const _contracts = [
  backupRunSchema satisfies z.ZodType<Schemas['BackupRunResponse']>,
  backupRunListSchema satisfies z.ZodType<Schemas['BackupRunListResponse']>,
];
void _contracts;
