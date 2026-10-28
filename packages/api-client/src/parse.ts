/**
 * The one place a response payload becomes a typed value.
 *
 * Parsing happens exactly once, here, at the transport boundary. What comes
 * out is deep-frozen and flows inward untouched - no downstream re-validation,
 * no defensive copies, no "just in case" optional chaining on fields the
 * schema already proved.
 *
 * A parse failure is a broken contract between Core and the frontend. It is
 * reported as telemetry and then thrown as a `response_validation`
 * NixApiError. It is never downgraded into a partial object or a default,
 * because a silent fallback turns a deploy-time contract break into a
 * user-visible mystery weeks later.
 */

import type { z } from 'zod';
import { NixApiError } from './errors.js';
import { report, type NixTelemetry, type ParseIssue } from './telemetry.js';

export interface BoundaryContext {
  /** Stable label for the call site, e.g. `items.get`. */
  readonly operation: string;
  readonly status?: number | undefined;
  readonly telemetry?: NixTelemetry | undefined;
}

function formatPath(path: readonly PropertyKey[]): string {
  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${String(segment)}]`;
    } else {
      formatted += formatted === '' ? String(segment) : `.${String(segment)}`;
    }
  }
  return formatted === '' ? '(root)' : formatted;
}

function toParseIssues(error: z.ZodError): readonly ParseIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
    code: issue.code,
  }));
}

/** Deep-freezes plain JSON structures so parsed data cannot be mutated inward. */
function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeDeep(child);
  }
  return value;
}

export function parseAtBoundary<TResult>(
  schema: z.ZodType<TResult>,
  data: unknown,
  context: BoundaryContext,
): TResult {
  const result = schema.safeParse(data);
  if (result.success) return freezeDeep(result.data);

  const issues = toParseIssues(result.error);
  report(context.telemetry?.onParseError, {
    operation: context.operation,
    status: context.status,
    issues,
  });
  throw NixApiError.responseValidation(context.operation, issues, context.status);
}
