import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { LibraryItem } from '@excalidraw/excalidraw/types';

import type { CanvasElement } from './canvas-binding';
import { prepareCanvasElements } from './nix-canvas-model';

const LEGACY_ITEM_TYPE = 'nix-canvas-library-item';
const LEGACY_CREATED_AT = 1;
const LIBRARY_ELEMENT_CEILING = 10_000;

/**
 * Converts every canvas-library representation Nix has stored into Excalidraw's v2 format.
 *
 * Current Excalidraw items are already authoritative and retain object identity. Older
 * Excalidraw array items and the short-lived Nix wrapper are migrated without random IDs or
 * timestamps, so opening the same saved library twice produces byte-for-byte equivalent data.
 * Malformed entries are omitted independently rather than making the caller lose the rest of a
 * usable personal library.
 */
export function prepareCanvasLibraryItems(items: readonly unknown[]): LibraryItem[] {
  const nativeIds = new Set(items.flatMap((item) => (isNativeLibraryItem(item) ? [item.id] : [])));
  const claimedIds = new Set(nativeIds);

  return items.flatMap((item) => {
    if (isNativeLibraryItem(item)) return [item];

    if (Array.isArray(item)) {
      const elements = prepareLibraryElements(item);
      if (elements === null || elements.length === 0) return [];
      return [
        migratedLibraryItem(
          claimId(`nix-excalidraw-v1-${stableHash(JSON.stringify(item))}`, claimedIds),
          elements,
        ),
      ];
    }

    const legacy = parseLegacyLibraryItem(item);
    if (legacy === null) return [];
    const elements = prepareLibraryElements(legacy.elements);
    if (elements === null || elements.length === 0) return [];

    return [
      migratedLibraryItem(
        claimId(
          `nix-native-v1-${stableHash(`${legacy.name}\u0000${legacy.document}`)}`,
          claimedIds,
        ),
        elements,
        legacy.name,
      ),
    ];
  });
}

interface ParsedLegacyLibraryItem {
  readonly name: string;
  readonly document: string;
  readonly elements: readonly CanvasElement[];
}

function parseLegacyLibraryItem(value: unknown): ParsedLegacyLibraryItem | null {
  if (
    !record(value) ||
    value.type !== LEGACY_ITEM_TYPE ||
    typeof value.name !== 'string' ||
    value.name.trim() === '' ||
    typeof value.document !== 'string' ||
    value.document === ''
  ) {
    return null;
  }

  let document: unknown;
  try {
    document = JSON.parse(value.document);
  } catch {
    return null;
  }

  if (!record(document) || document.version !== 1 || !Array.isArray(document.elements)) {
    return null;
  }

  return {
    name: value.name.trim(),
    document: value.document,
    elements: document.elements as readonly CanvasElement[],
  };
}

function prepareLibraryElements(values: readonly unknown[]): NonDeletedExcalidrawElement[] | null {
  if (values.length > LIBRARY_ELEMENT_CEILING || !values.every(isStoredCanvasElement)) {
    return null;
  }

  return prepareCanvasElements(values)
    .filter((element) => !element.isDeleted)
    .map((element) => ({ ...element, isDeleted: false }));
}

function migratedLibraryItem(
  id: string,
  elements: readonly NonDeletedExcalidrawElement[],
  name?: string,
): LibraryItem {
  return {
    id,
    status: 'unpublished',
    created: LEGACY_CREATED_AT,
    elements,
    ...(name === undefined ? {} : { name }),
  };
}

function isNativeLibraryItem(value: unknown): value is LibraryItem {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    (value.status === 'published' || value.status === 'unpublished') &&
    typeof value.created === 'number' &&
    Number.isFinite(value.created) &&
    value.created >= 0 &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.error === undefined || typeof value.error === 'string') &&
    Array.isArray(value.elements) &&
    value.elements.length <= LIBRARY_ELEMENT_CEILING &&
    value.elements.every((element) => isStoredCanvasElement(element) && element.isDeleted !== true)
  );
}

function isStoredCanvasElement(value: unknown): value is CanvasElement {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.type === 'string' &&
    value.type !== '' &&
    typeof value.version === 'number' &&
    Number.isInteger(value.version) &&
    value.version >= 0 &&
    typeof value.versionNonce === 'number' &&
    Number.isInteger(value.versionNonce) &&
    value.versionNonce >= 0 &&
    (value.isDeleted === undefined || typeof value.isDeleted === 'boolean')
  );
}

function claimId(base: string, claimed: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (claimed.has(candidate)) {
    candidate = `${base}-${String(suffix)}`;
    suffix += 1;
  }
  claimed.add(candidate);
  return candidate;
}

/** FNV-1a 64-bit over UTF-16 code units: synchronous, browser-safe, and deterministic. */
function stableHash(value: string): string {
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(36);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
