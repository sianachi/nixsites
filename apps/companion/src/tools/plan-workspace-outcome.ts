import { z } from 'zod';
import { READ_ONLY_OPERATIONS } from '@nix/companion/tool-args';

const receipt = z.object({
  complete: z.boolean().optional(),
  contentConfirmed: z.boolean().optional(),
  restoreFailures: z.array(z.string()).optional(),
  truncated: z.boolean().optional(),
});

/** A successful HTTP/tool return may still describe a partial bounded operation. */
export function workspacePlanOutcome(
  operation: string,
  text: string,
): 'completed' | 'partial' | 'unknown' {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'unknown';
  }
  const parsed = receipt.safeParse(value);
  if (!parsed.success) return 'unknown';
  if (Array.from(READ_ONLY_OPERATIONS).some((read) => read === operation)) return 'completed';
  if (parsed.data.truncated === true) return 'unknown';
  if (operation === 'build_blueprint' && parsed.data.complete !== true)
    return parsed.data.complete === false ? 'partial' : 'unknown';
  if (operation === 'create_note' && parsed.data.contentConfirmed === false) return 'unknown';
  if (operation === 'save_as_template' && (parsed.data.restoreFailures?.length ?? 0) > 0)
    return 'partial';
  return 'completed';
}
