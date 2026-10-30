import type { BoundElement, ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData, DataURL } from '@excalidraw/excalidraw/types';

import { isFetchableImageAddress } from '@nix/web-foundation/lib/image-address';
import type { CanvasElement } from './canvas-binding';

/** Metadata Nix owns inside an otherwise ordinary Excalidraw element. */
interface NixElementMetadata {
  readonly kind?: 'item' | 'file' | 'external-image';
  readonly itemId?: string;
  readonly address?: string;
  readonly alt?: string;
  readonly legacyType?: string;
}

type ElementRecord = CanvasElement & Readonly<Record<string, unknown>>;

const EXCALIDRAW_TYPES = new Set([
  'rectangle',
  'diamond',
  'ellipse',
  'line',
  'arrow',
  'freedraw',
  'text',
  'image',
  'frame',
  'magicframe',
  'iframe',
  'embeddable',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// The retired SVG renderer stored semantic token names rather than CSS colours. Excalidraw draws
// into a canvas, where those names (and CSS custom properties) are not colours, so migration must
// resolve them to stable values. These are the light-ground token values the native records used.
const LEGACY_ACCENT_FILL = '#eef6ff'; // design-token-exempt: durable canvas data needs a resolved colour, not a runtime CSS token.
const LEGACY_SURFACE_FILL = '#e9e9ea'; // design-token-exempt: durable canvas data needs a resolved colour, not a runtime CSS token.
const LEGACY_FOREGROUND_STROKE = '#1d1f20'; // design-token-exempt: durable canvas data needs a resolved colour, not a runtime CSS token.
const LEGACY_ACCENT_STROKE = '#5980a6'; // design-token-exempt: durable canvas data needs a resolved colour, not a runtime CSS token.
const LEGACY_MUTED_STROKE = '#5d5d60'; // design-token-exempt: durable canvas data needs a resolved colour, not a runtime CSS token.
const LEGACY_FILL_COLORS: Readonly<Record<string, string>> = {
  accent: LEGACY_ACCENT_FILL,
  surface: LEGACY_SURFACE_FILL,
  none: 'transparent',
};
const LEGACY_STROKE_COLORS: Readonly<Record<string, string>> = {
  foreground: LEGACY_FOREGROUND_STROKE,
  accent: LEGACY_ACCENT_STROKE,
  muted: LEGACY_MUTED_STROKE,
};
const LEGACY_NO_FILL_TYPES = new Set(['line', 'arrow', 'text', 'freehand', 'image']);
const LEGACY_CARD_LABEL_SUFFIX = '-nix-card-label';
const LEGACY_CARD_FONT_SIZE = 18;
const LEGACY_CARD_LINE_HEIGHT = 1.25;
const LEGACY_CARD_HORIZONTAL_PADDING = 16;
const LEGACY_CARD_TEXT_LIMIT = 120;
const ORDER_KEY_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ORDER_KEY_PADDING = 8;

/**
 * Adapts every canvas shape Nix has shipped to the element vocabulary Excalidraw restores.
 *
 * Complete Excalidraw records pass through unchanged. The short-lived native renderer used
 * `freehand`, `card`, `imageItemId`, and absolute freehand points; those records are translated
 * without changing their identity or reconciliation version. Unknown records become visible
 * placeholders instead of disappearing from somebody's drawing.
 */
export function prepareCanvasElements(elements: readonly CanvasElement[]): ExcalidrawElement[] {
  const source = elements.map((element) => element as ElementRecord);
  const claimedIds = new Set(source.map((element) => element.id));
  const labelIdsByContainer = new Map<string, string>();

  for (const element of source) {
    if (
      element.type === 'text' &&
      typeof element.containerId === 'string' &&
      !labelIdsByContainer.has(element.containerId)
    ) {
      labelIdsByContainer.set(element.containerId, element.id);
    }
  }

  const prepared = source.flatMap((element) => {
    const prepared = prepareElement(element);
    if (element.type !== 'card' || element.isDeleted === true) return [prepared];

    const existingLabelId = labelIdsByContainer.get(element.id);
    const labelId = existingLabelId ?? claimLegacyCardLabelId(element.id, claimedIds);
    const container = bindLegacyCardLabel(prepared, labelId);
    return existingLabelId === undefined
      ? [container, legacyCardLabel(element, labelId)]
      : [container];
  });

  // The retired renderer used short numeric keys such as `z00003`. Excalidraw's fractional
  // index decoder validates the integer-part width and throws before the canvas can mount. If
  // any stored key is invalid, assign deterministic valid keys in the already persisted order.
  return normalizeOrderKeys(prepared);
}

function normalizeOrderKeys(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const misplacedLabels = new Map<string, ExcalidrawElement[]>();
  for (const element of elements) {
    if (element.type !== 'text' || element.containerId === null) continue;
    const container = byId.get(element.containerId);
    if (
      container === undefined ||
      (isValidOrderKey(element.index) &&
        isValidOrderKey(container.index) &&
        element.index > container.index)
    )
      continue;
    const labels = misplacedLabels.get(container.id) ?? [];
    labels.push(element);
    misplacedLabels.set(container.id, labels);
  }
  const movedIds = new Set([...misplacedLabels.values()].flat().map((element) => element.id));
  const ordered = elements.flatMap((element) =>
    movedIds.has(element.id) ? [] : [element, ...(misplacedLabels.get(element.id) ?? [])],
  );
  if (
    misplacedLabels.size === 0 &&
    ordered.every(
      (element, position) =>
        isValidOrderKey(element.index) &&
        (position === 0 || element.index > (ordered[position - 1]?.index ?? '')),
    )
  )
    return ordered;
  return ordered.map((element, position) => {
    const index =
      `a0${base62(position + 1).padStart(ORDER_KEY_PADDING, '0')}1` as ExcalidrawElement['index'];
    // A repaired index must win in Yjs too, or the next snapshot brings the broken order back.
    return element.index === index ? element : { ...element, index, version: element.version + 1 };
  });
}

function isValidOrderKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 2) return false;
  const head = value[0];
  if (head === undefined || !/[A-Za-z]/u.test(head)) return false;
  const integerLength =
    head >= 'a' && head <= 'z'
      ? head.charCodeAt(0) - 'a'.charCodeAt(0) + 2
      : head >= 'A' && head <= 'Z'
        ? 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2
        : 0;
  if (value.length < integerLength) return false;
  if (!/^[A-Za-z0-9]+$/u.test(value)) return false;
  const fractionalPart = value.slice(integerLength);
  return fractionalPart === '' || !fractionalPart.endsWith('0');
}

function base62(value: number): string {
  let remaining = value;
  let result = '';
  do {
    result = ORDER_KEY_DIGITS.charAt(remaining % ORDER_KEY_DIGITS.length) + result;
    remaining = Math.floor(remaining / ORDER_KEY_DIGITS.length);
  } while (remaining > 0);
  return result;
}

export function sceneFingerprint(elements: readonly CanvasElement[]): string {
  return elements
    .map(
      (element) =>
        `${element.id}:${String(element.version)}:${String(element.versionNonce)}:${element.isDeleted === true ? '1' : '0'}:${element.index ?? ''}`,
    )
    .join('|');
}

/** File-item identifiers referenced by image elements, never their transient preview URLs. */
export function canvasFileItemIds(elements: readonly ExcalidrawElement[]): FileId[] {
  return [
    ...new Set(
      elements.flatMap((element) => {
        if (element.type !== 'image' || element.fileId === null) return [];
        const itemId = nixFileItemIdFromElement(element);
        return itemId === element.fileId && UUID.test(itemId) ? [element.fileId] : [];
      }),
    ),
  ];
}

/** Legacy external images remain visible while new images use durable Nix file items. */
export function externalCanvasFiles(elements: readonly ExcalidrawElement[]): BinaryFileData[] {
  return elements.flatMap((element) => {
    if (element.type !== 'image' || element.fileId === null) return [];
    const metadata = nixMetadata(element);
    if (metadata?.kind !== 'external-image' || typeof metadata.address !== 'string') return [];
    const address = metadata.address.trim();
    if (!isFetchableImageAddress(address)) return [];
    return [
      {
        id: element.fileId,
        dataURL: address as DataURL,
        mimeType: imageMimeType(address),
        created: element.updated,
      },
    ];
  });
}

export function nixItemIdFromElement(element: ExcalidrawElement): string | null {
  const metadata = nixMetadata(element);
  return metadata?.kind === 'item' && typeof metadata.itemId === 'string' ? metadata.itemId : null;
}

export function nixFileItemIdFromElement(element: ExcalidrawElement): string | null {
  const metadata = nixMetadata(element);
  return metadata?.kind === 'file' && typeof metadata.itemId === 'string' ? metadata.itemId : null;
}

export function withNixFileMetadata(
  element: ExcalidrawElement,
  fileId: FileId,
): Record<string, unknown> {
  return withNixMetadata(element.customData, { kind: 'file', itemId: fileId });
}

export function nixItemLink(itemId: string): string {
  return `nix://item/${encodeURIComponent(itemId)}`;
}

export function itemIdFromNixLink(link: string | null): string | null {
  if (!link?.startsWith('nix://item/')) return null;
  try {
    const itemId = decodeURIComponent(link.slice('nix://item/'.length));
    return itemId.length > 0 ? itemId : null;
  } catch {
    return null;
  }
}

/** The one place a loosely typed stored record is trusted to be an Excalidraw element. */
function nixElement(value: object): ExcalidrawElement {
  return value as unknown as ExcalidrawElement;
}

function prepareElement(element: ElementRecord): ExcalidrawElement {
  const prepared =
    element.type === 'freehand'
      ? legacyFreehand(element)
      : element.type === 'card'
        ? legacyCard(element)
        : element.type === 'image'
          ? imageElement(element)
          : element.type === 'line' || element.type === 'arrow'
            ? linearElement(element)
            : EXCALIDRAW_TYPES.has(element.type)
              ? nixElement(element)
              : unknownElement(element);

  return isCompleteExcalidrawElement(element)
    ? prepared
    : withLegacyNativeAppearance(prepared, element);
}

/**
 * Distinguishes a stored Excalidraw record from native records whose type names overlap it.
 * `rectangle`, `ellipse`, `text`, `line`, `arrow`, and `image` existed in both formats; the common
 * Excalidraw fields below were never emitted by the native renderer.
 */
function isCompleteExcalidrawElement(element: ElementRecord): boolean {
  const hasNativeMarker =
    (typeof element.fill === 'string' && LEGACY_FILL_COLORS[element.fill] !== undefined) ||
    (typeof element.stroke === 'string' && LEGACY_STROKE_COLORS[element.stroke] !== undefined) ||
    typeof element.cornerRadius === 'number' ||
    element.type === 'freehand' ||
    element.type === 'card' ||
    typeof element.imageItemId === 'string' ||
    typeof element.imageUrl === 'string' ||
    (Array.isArray(element.points) && element.points.some(record));

  return (
    !hasNativeMarker &&
    typeof element.strokeColor === 'string' &&
    typeof element.backgroundColor === 'string' &&
    typeof element.fillStyle === 'string' &&
    typeof element.strokeWidth === 'number' &&
    typeof element.strokeStyle === 'string' &&
    typeof element.roughness === 'number' &&
    typeof element.opacity === 'number' &&
    typeof element.angle === 'number' &&
    typeof element.seed === 'number' &&
    Array.isArray(element.groupIds)
  );
}

/** Converts the native renderer's 0-1 opacity and semantic appearance to Excalidraw fields. */
function withLegacyNativeAppearance(
  prepared: ExcalidrawElement,
  source: ElementRecord,
): ExcalidrawElement {
  const fill = typeof source.fill === 'string' ? LEGACY_FILL_COLORS[source.fill] : undefined;
  const stroke =
    typeof source.stroke === 'string' ? LEGACY_STROKE_COLORS[source.stroke] : undefined;
  const opacity = legacyOpacity(source.opacity);
  const roundness = finite(source.cornerRadius) > 0 ? { type: 3 as const } : null;

  return {
    ...prepared,
    strokeColor: stroke ?? LEGACY_FOREGROUND_STROKE,
    backgroundColor:
      fill ?? (LEGACY_NO_FILL_TYPES.has(source.type) ? 'transparent' : LEGACY_ACCENT_FILL),
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity,
    roundness,
  };
}

function legacyOpacity(value: unknown): number {
  const sourceOpacity = finite(value, 1);
  return Math.min(100, Math.max(0, sourceOpacity <= 1 ? sourceOpacity * 100 : sourceOpacity));
}

function legacyFreehand(element: ElementRecord): ExcalidrawElement {
  const x = finite(element.x);
  const y = finite(element.y);
  const points = Array.isArray(element.points)
    ? element.points.flatMap((point) => {
        if (Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number') {
          return [[point[0], point[1]] as const];
        }
        if (record(point) && typeof point.x === 'number' && typeof point.y === 'number') {
          return [[point.x - x, point.y - y] as const];
        }
        return [];
      })
    : [];

  return nixElement({
    ...element,
    type: 'freedraw',
    x,
    y,
    points,
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: points.at(-1) ?? null,
  });
}

function legacyCard(element: ElementRecord): ExcalidrawElement {
  const itemId = typeof element.itemId === 'string' ? element.itemId : '';
  return nixElement({
    ...element,
    type: 'rectangle',
    link: itemId === '' ? null : nixItemLink(itemId),
    customData: withNixMetadata(element.customData, {
      kind: 'item',
      itemId,
    }),
  });
}

function bindLegacyCardLabel(container: ExcalidrawElement, labelId: string): ExcalidrawElement {
  const existingBindings = validBoundElements(container.boundElements).filter(
    (binding) => !(binding.type === 'text' && binding.id !== labelId),
  );
  const hasLabel = existingBindings.some(
    (binding) => binding.type === 'text' && binding.id === labelId,
  );

  return {
    ...container,
    boundElements: hasLabel
      ? existingBindings
      : [...existingBindings, { type: 'text', id: labelId }],
  };
}

function validBoundElements(value: unknown): BoundElement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((binding): BoundElement[] => {
    if (
      !record(binding) ||
      (binding.type !== 'arrow' && binding.type !== 'text') ||
      typeof binding.id !== 'string'
    ) {
      return [];
    }
    return [{ type: binding.type, id: binding.id }];
  });
}

function legacyCardLabel(element: ElementRecord, id: string): ExcalidrawElement {
  const text = legacyCardText(element);
  const fontSize = LEGACY_CARD_FONT_SIZE;
  const lineHeight = LEGACY_CARD_LINE_HEIGHT;
  const lineCount = text.split('\n').length;
  const height = fontSize * lineHeight * lineCount;
  const containerX = finite(element.x);
  const containerY = finite(element.y);
  const rawWidth = finite(element.width);
  const rawHeight = finite(element.height);
  const containerWidth = Math.abs(rawWidth);
  const containerHeight = Math.abs(rawHeight);
  const x = Math.min(containerX, containerX + rawWidth);
  const y = Math.min(containerY, containerY + rawHeight);

  return nixElement({
    id,
    type: 'text',
    x: x + LEGACY_CARD_HORIZONTAL_PADDING,
    y: y + Math.max(0, (containerHeight - height) / 2),
    width: Math.max(1, containerWidth - LEGACY_CARD_HORIZONTAL_PADDING * 2),
    height,
    angle: finite(element.angle),
    strokeColor: LEGACY_FOREGROUND_STROKE,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: legacyOpacity(element.opacity),
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: stablePositiveInteger(id),
    version: element.version,
    versionNonce: element.versionNonce,
    isDeleted: false,
    boundElements: null,
    updated: finite(element.updated, 1),
    link: null,
    locked: false,
    fontSize,
    fontFamily: 5,
    text,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: element.id,
    originalText: text,
    autoResize: true,
    lineHeight,
  });
}

function legacyCardText(element: ElementRecord): string {
  const customData = record(element.customData) ? element.customData : null;
  const nix = customData !== null && record(customData.nix) ? customData.nix : null;
  const title = firstLegacyCardLine(
    element.title,
    element.itemTitle,
    element.text,
    nix?.title,
    nix?.label,
  );
  const summary = firstLegacyCardLine(element.summary, element.itemSummary, nix?.summary);

  if (title !== null && summary !== null) return `${title}\n${summary}`;
  if (title !== null) return title;
  if (summary !== null) return `Nix item\n${summary}`;

  const itemId = firstLegacyCardLine(element.itemId);
  return itemId === null ? 'Nix item' : `Nix item\n${compactLegacyItemId(itemId)}`;
}

function firstLegacyCardLine(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().replace(/\s+/gu, ' ');
    if (normalized !== '') return normalized.slice(0, LEGACY_CARD_TEXT_LIMIT);
  }
  return null;
}

function compactLegacyItemId(itemId: string): string {
  if (itemId.length <= 28) return itemId;
  return `${itemId.slice(0, 16)}...${itemId.slice(-8)}`;
}

function claimLegacyCardLabelId(cardId: string, claimedIds: Set<string>): string {
  const base = `${cardId}${LEGACY_CARD_LABEL_SUFFIX}`;
  let candidate = base;
  let suffix = 2;
  while (claimedIds.has(candidate)) {
    candidate = `${base}-${String(suffix)}`;
    suffix += 1;
  }
  claimedIds.add(candidate);
  return candidate;
}

function stablePositiveInteger(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0 || 1;
}

function imageElement(element: ElementRecord): ExcalidrawElement {
  const currentMetadata = nixMetadata(nixElement(element));
  const existingFileId = typeof element.fileId === 'string' ? element.fileId : null;
  const markedFileItemId =
    currentMetadata?.kind === 'file' &&
    typeof currentMetadata.itemId === 'string' &&
    UUID.test(currentMetadata.itemId)
      ? currentMetadata.itemId
      : null;
  const transitionalFileItemId =
    typeof element.imageItemId === 'string' && UUID.test(element.imageItemId)
      ? element.imageItemId
      : null;
  const fileItemId = markedFileItemId ?? transitionalFileItemId;
  const rawAddress =
    typeof element.imageUrl === 'string'
      ? element.imageUrl
      : currentMetadata?.kind === 'external-image' && typeof currentMetadata.address === 'string'
        ? currentMetadata.address
        : null;
  const address =
    rawAddress !== null && isFetchableImageAddress(rawAddress) ? rawAddress.trim() : null;
  const fileId =
    fileItemId ?? existingFileId ?? (address === null ? null : `nix-external-${element.id}`);
  const metadata =
    fileItemId !== null
      ? withNixMetadata(element.customData, { kind: 'file', itemId: fileItemId })
      : address !== null
        ? withNixMetadata(element.customData, {
            kind: 'external-image',
            address,
            ...(typeof element.alt === 'string' ? { alt: element.alt } : {}),
          })
        : element.customData;

  return nixElement({
    ...element,
    type: 'image',
    fileId,
    status: element.status === 'error' || element.status === 'pending' ? element.status : 'saved',
    scale: validScale(element.scale),
    crop: record(element.crop) ? element.crop : null,
    customData: metadata,
  });
}

function linearElement(element: ElementRecord): ExcalidrawElement {
  if (Array.isArray(element.points) && element.points.length > 1) {
    return nixElement(element);
  }
  const width = finite(element.width, 1);
  const height = finite(element.height, 1);
  return nixElement({
    ...element,
    points: [
      [0, 0],
      [width, height],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: element.type === 'arrow' ? 'arrow' : null,
    ...(element.type === 'arrow' ? { elbowed: false } : {}),
  });
}

function unknownElement(element: ElementRecord): ExcalidrawElement {
  return nixElement({
    ...element,
    type: 'rectangle',
    customData: withNixMetadata(element.customData, {
      legacyType: element.type,
    }),
  });
}

function nixMetadata(element: ExcalidrawElement): NixElementMetadata | null {
  const customData = element.customData;
  if (!record(customData) || !record(customData.nix)) return null;
  return customData.nix;
}

function withNixMetadata(customData: unknown, nix: NixElementMetadata): Record<string, unknown> {
  const current = record(customData) ? customData : {};
  return {
    ...current,
    nix: {
      ...(record(current.nix) ? current.nix : {}),
      ...nix,
    },
  };
}

function validScale(value: unknown): [number, number] {
  if (!Array.isArray(value)) return [1, 1];
  const horizontal: unknown = value[0];
  const vertical: unknown = value[1];
  return (horizontal === 1 || horizontal === -1) && (vertical === 1 || vertical === -1)
    ? [horizontal, vertical]
    : [1, 1];
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function imageMimeType(address: string): BinaryFileData['mimeType'] {
  const pathname = (() => {
    try {
      return new URL(address).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.bmp')) return 'image/bmp';
  if (pathname.endsWith('.avif')) return 'image/avif';
  return 'image/png';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
