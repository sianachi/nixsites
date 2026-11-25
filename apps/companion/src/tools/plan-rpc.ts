import { z } from 'zod';

const toolId = z.string().min(1).max(200);
export const planToolBindingSchema = z.strictObject({
  toolId,
  runId: z.uuid(),
  planId: z.uuid(),
  planVersion: z.int().positive(),
  reviewDigest: z.string().min(1).max(128),
  stepId: z.uuid(),
});
export type PlanToolBinding = z.infer<typeof planToolBindingSchema>;
export const inspectPlanToolsSchema = z.strictObject({ toolIds: z.array(toolId).min(1).max(12) });
export const adoptPlanToolsSchema = z.strictObject({
  bindings: z.array(planToolBindingSchema).min(1).max(12),
});
export const cancelPlanToolsSchema = z.strictObject({
  toolIds: z.array(toolId).min(1).max(12),
  runId: z.uuid(),
});
export const supersedePlanToolsSchema = z.strictObject({
  bindings: z
    .array(
      z.strictObject({
        previous: planToolBindingSchema,
        next: planToolBindingSchema,
      }),
    )
    .min(1)
    .max(12),
});
export const resolvePlanToolSchema = z.strictObject({
  binding: planToolBindingSchema,
  success: z.boolean(),
  result: z.string().min(1).max(32_000),
  lockedContent: z.boolean(),
  sourceItemIds: z.array(z.uuid()).max(128).optional(),
  unboundedSourceProvenance: z.boolean().optional(),
});
export const privatePlanToolOperations = new Set([
  'plan_tools_inspect',
  'plan_tools_adopt',
  'plan_tools_supersede',
  'plan_tools_cancel',
  'plan_tools_resolve',
]);
