import { isRecord } from '@nix/editor-schema';

export interface BodyAuthorizationItem {
  readonly sourceId: string;
  readonly targetItemId: string;
  readonly itemType: string;
  readonly bodyRequired: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function sourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    /^[A-Za-z0-9._:/-]+$/.test(value)
  );
}

/** Validates Core's per-item body authorization list; throws `invalid()` on any malformed or duplicate entry. */
export function parseBodyAuthorizationItems(
  items: readonly unknown[],
  invalid: () => Error,
): BodyAuthorizationItem[] {
  const seenSources = new Set<string>();
  const seenTargets = new Set<string>();
  return items.map((item): BodyAuthorizationItem => {
    if (
      !isRecord(item) ||
      !sourceId(item.sourceId) ||
      !uuid(item.targetItemId) ||
      typeof item.itemType !== 'string' ||
      item.itemType.length === 0 ||
      item.itemType.length > 64 ||
      typeof item.bodyRequired !== 'boolean' ||
      seenSources.has(item.sourceId) ||
      seenTargets.has(item.targetItemId)
    ) {
      throw invalid();
    }
    seenSources.add(item.sourceId);
    seenTargets.add(item.targetItemId);
    return {
      sourceId: item.sourceId,
      targetItemId: item.targetItemId,
      itemType: item.itemType,
      bodyRequired: item.bodyRequired,
    };
  });
}
