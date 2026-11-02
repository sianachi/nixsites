import type { MirrorItem } from '@nix/sync-core/mirror';

/** What a computed read may see: the synced copy, read-only, and the clock. */
export interface ViewSource {
  /** One item by id, or undefined when it is not in the synced copy. */
  readonly item: (id: string) => Promise<MirrorItem | undefined>;
  /** Every active item of one workspace, siblings in Core's order. */
  readonly workspaceItems: (workspaceId: string) => Promise<readonly MirrorItem[]>;
  /** Now, as Core's clock would read it; fixtures pin it. */
  readonly now: () => Date;
  /** The acting principal's id; undefined when unknown (reads that need it return null). */
  readonly principalId?: string;
  /** The caller's preferred IANA zone; null when they set none (UTC); undefined when unknown. */
  readonly timeZone?: string | null;
  /** Every workspace the caller may read. */
  readonly workspaceIds?: () => Promise<readonly string[]>;
}

export interface ViewRequest {
  readonly method: 'GET' | 'POST';
  readonly url: URL;
  /** The parsed JSON body of a POST read, else null. */
  readonly body: unknown;
}

/** Core's answer: a 200 body in Core's JSON shape, or a problem with Core's code. */
export type ViewAnswer =
  | { readonly status: 200; readonly body: unknown }
  | { readonly status: number; readonly code: string; readonly detail: string };

/**
 * One slice's computation. Returns null when the slice cannot answer this request offline
 * (the caller then says plainly that it needs a connection), never a guess.
 */
export type ViewCompute = (
  source: ViewSource,
  request: ViewRequest,
  match: RegExpExecArray,
) => Promise<ViewAnswer | null>;

export interface ViewRoute {
  readonly method: ViewRequest['method'];
  readonly pattern: RegExp;
  readonly compute: ViewCompute;
}
