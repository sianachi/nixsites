import { z } from 'zod';

const operationStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);

export const operationSchema = z.object({
  id: z.uuid(),
  kind: z.string().min(1),
  status: operationStatusSchema,
  result: z.unknown().nullable(),
  errorCode: z.string().nullable(),
  errorDetail: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  cancellationRequested: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type Operation = z.infer<typeof operationSchema>;
