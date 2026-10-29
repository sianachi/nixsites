/**
 * The sizes a card can be drawn at, in the order the editor offers them.
 *
 * **One tuple, and everything else on this axis is derived from it** - the union below, the two
 * class tables, the resolver's accepted tokens, and the editor's `<Segmented>` options through
 * `view-kinds.tsx`. The vocabulary used to be written out four times with nothing tying the copies
 * together, so a fourth size added to the editor's options compiled clean and drew as medium.
 * Adding one now is this line plus the two tables, and every other site follows or fails to
 * compile.
 *
 * The only copy left outside TypeScript is the server's `GalleryCardSizes`, which the OpenAPI
 * contract check covers.
 */
export const CARD_SIZES = ['small', 'medium', 'large'] as const;

/** The wire tokens; anything else draws as {@link DEFAULT_CARD_SIZE}. */
export type CardSize = (typeof CARD_SIZES)[number];

/**
 * What a gallery that has never been asked draws at.
 *
 * Named once because two places need the same answer for different reasons: this file resolves a
 * null or unrecognised token to it, and the editor marks it current so the control describes what
 * is on screen rather than proposing a change.
 */
export const DEFAULT_CARD_SIZE: CardSize = 'medium';

/**
 * The grid each size lays out, as one whole literal per size.
 *
 * Full class strings rather than assembled ones, because Tailwind only generates what it can read
 * in the source text - a computed `grid-cols-${n}` is a class that does not exist at runtime.
 * Medium is verbatim what this grid was before sizes existed, so a stored gallery that has never
 * been asked keeps looking exactly as it always has.
 */
export const CARD_SIZE_GRID: Record<CardSize, string> = {
  small:
    'grid grid-cols-1 gap-3 @2xl/gallery:grid-cols-3 @5xl/gallery:grid-cols-4 @7xl/gallery:grid-cols-6',
  medium:
    'grid grid-cols-1 gap-3 @2xl/gallery:grid-cols-2 @5xl/gallery:grid-cols-3 @7xl/gallery:grid-cols-4',
  large: 'grid grid-cols-1 gap-3 @5xl/gallery:grid-cols-2 @7xl/gallery:grid-cols-3',
};

/**
 * The shape of the picture region at each size.
 *
 * Part of the size, not left to the grid: a small card keeping a 16:9 cover would be a sliver of
 * letterbox nobody can read a picture in, so the denser the columns the squarer the frame. Medium
 * keeps `aspect-video`, which is what every cover drew at before sizes existed.
 */
export const CARD_SIZE_COVER: Record<CardSize, string> = {
  small: 'aspect-square',
  medium: 'aspect-video',
  large: 'aspect-4/3',
};

/**
 * Which size to draw, given what the view stores.
 *
 * Null is the ordinary state - every gallery stored before the field existed - and an unrecognised
 * token is a newer server's word this build has no classes for. Both draw as medium, because a
 * fallback that keeps every card on screen at the size galleries have always been is honest, and
 * failing the render over a cosmetic token would not be.
 */
export function resolveCardSize(stored: string | null): CardSize {
  // Read off the tuple rather than a hand-written literal check, so a size added there is
  // recognised here without a second edit - and so the resolver can never fall behind the classes.
  return CARD_SIZES.find((size) => size === stored) ?? DEFAULT_CARD_SIZE;
}

export function galleryColumnCount(size: CardSize, availableWidth: number): number {
  // Tailwind's named container tokens are @2xl (42rem), @5xl (64rem) and @7xl (80rem).
  if (size === 'small') {
    return availableWidth >= 1280 ? 6 : availableWidth >= 1024 ? 4 : availableWidth >= 672 ? 3 : 1;
  }
  if (size === 'medium') {
    return availableWidth >= 1280 ? 4 : availableWidth >= 1024 ? 3 : availableWidth >= 672 ? 2 : 1;
  }
  return availableWidth >= 1280 ? 3 : availableWidth >= 1024 ? 2 : 1;
}

export function galleryRowEstimate(size: CardSize): number {
  return size === 'small' ? 260 : size === 'large' ? 420 : 320;
}
