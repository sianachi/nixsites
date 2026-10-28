/**
 * The shape every data-bearing view in Nix reports its async state with.
 *
 * The engineering plan (section 4.5) requires loading, empty, error and
 * partial states to be rendered honestly. A discriminated union makes that
 * structural rather than optional:
 *
 *   - There is no "loading with no idea what for": `loading` carries the label
 *     of the thing being fetched, so the UI can say what it is waiting on
 *     instead of showing a bare spinner forever.
 *   - There is no `data | null | undefined` triple that collapses "empty" into
 *     "still loading". `empty` is its own case with its own copy.
 *   - `error` carries a message and, when recovery is possible, a retry. A
 *     failed view without a way out is representable only by deliberately
 *     omitting `retry`.
 *   - `partial` carries real data *and* a note about what is still missing.
 *     This is the canonical Nix case: an item is downloadable at `clean` but
 *     searchable only at `indexed`, and the UI must say so rather than let a
 *     user conclude search is broken.
 *
 * Nothing here fetches. Producing an AsyncStatus is the job of the api-client
 * cache layer in a later goal; this module only defines the contract and the
 * constructors, so it stays testable as plain functions.
 */

export interface LoadingStatus {
  readonly kind: 'loading';
  /** What is being loaded, phrased for a user: "workspace items". */
  readonly label: string;
}

export interface EmptyStatus {
  readonly kind: 'empty';
  readonly title: string;
  readonly detail: string;
}

export interface ErrorStatus {
  readonly kind: 'error';
  readonly title: string;
  readonly detail: string;
  /** Omitted when the failure is not retryable. */
  readonly retry?: () => void;
}

export interface PartialStatus<T> {
  readonly kind: 'partial';
  readonly value: T;
  /** What is present but incomplete, phrased for a user. */
  readonly pending: string;
}

export interface ReadyStatus<T> {
  readonly kind: 'ready';
  readonly value: T;
}

export type AsyncStatus<T> =
  LoadingStatus | EmptyStatus | ErrorStatus | PartialStatus<T> | ReadyStatus<T>;

export function loading(label: string): LoadingStatus {
  return { kind: 'loading', label };
}

export function empty(title: string, detail: string): EmptyStatus {
  return { kind: 'empty', title, detail };
}

export function failed(title: string, detail: string, retry?: () => void): ErrorStatus {
  return retry === undefined
    ? { kind: 'error', title, detail }
    : { kind: 'error', title, detail, retry };
}

export function partial<T>(value: T, pending: string): PartialStatus<T> {
  return { kind: 'partial', value, pending };
}

export function ready<T>(value: T): ReadyStatus<T> {
  return { kind: 'ready', value };
}
