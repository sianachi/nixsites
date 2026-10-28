/**
 * Telemetry hooks for the API client.
 *
 * The client never swallows a failure. Everything that would otherwise be a
 * silent fallback - a response that does not match its schema, a background
 * revalidation that failed, a request that came back as a problem document -
 * is reported here so the host application can forward it to its observability
 * pipeline. All hooks are optional and are invoked defensively: a throwing
 * hook must never break a request, so callers wrap invocations in `report`.
 *
 * Hooks are synchronous and must stay cheap. Anything expensive belongs on the
 * host side of the boundary (queue it, batch it, sample it).
 */

/** A single Zod issue, normalised so telemetry payloads do not depend on Zod. */
export interface ParseIssue {
  /** Dot/bracket path to the offending value, e.g. `items[0].title`. */
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

interface ParseErrorEvent {
  /** Stable label for the call site, e.g. `items.get`. */
  readonly operation: string;
  /** HTTP status the unparseable payload arrived with, when it was a response. */
  readonly status: number | undefined;
  readonly issues: readonly ParseIssue[];
}

interface RequestErrorEvent {
  readonly method: string;
  readonly path: string;
  readonly status: number | undefined;
  /** The stable machine-readable code carried by the resulting NixApiError. */
  readonly code: string;
  readonly kind: string;
}

interface CacheRevalidateErrorEvent {
  readonly key: readonly string[];
  readonly error: unknown;
}

/**
 * Hooks are function-typed properties rather than methods on purpose: they are
 * handed around as values, so they must not depend on a `this` binding.
 */
export interface NixTelemetry {
  readonly onParseError?: ((event: ParseErrorEvent) => void) | undefined;
  readonly onRequestError?: ((event: RequestErrorEvent) => void) | undefined;
  readonly onCacheRevalidateError?: ((event: CacheRevalidateErrorEvent) => void) | undefined;
}

/**
 * Invokes a telemetry hook without letting host bugs escape into request flow.
 * A hook that throws is reported to the console and otherwise ignored.
 */
export function report<TEvent>(hook: ((event: TEvent) => void) | undefined, event: TEvent): void {
  if (hook === undefined) return;
  try {
    hook(event);
  } catch (error) {
    console.error('[nix/api-client] telemetry hook threw', error);
  }
}
