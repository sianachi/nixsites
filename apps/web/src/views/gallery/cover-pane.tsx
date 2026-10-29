import { Text, blueprintFrame, cn } from '@nix/ui';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { isDisplayableImageValue } from '../../collections/properties/inputs/image-reference';
import { CARD_SIZE_COVER, type CardSize } from './card-size';
import { CoverImage } from './cover-image';

/** The longer side of a stored thumbnail, in pixels (Core's `MaximumThumbnailSide`). */
const THUMBNAIL_SIDE = 480;

/**
 * How far a thumbnail may be stretched before the original is worth its download. A cover is a
 * duotone wash behind a title, not a photograph being inspected, so mild softness is the right
 * price for not fetching every original on every dense screen.
 */
const TOLERATED_UPSCALE = 1.5;

/** The card's picture region: the cover, or the words that say why there is not one. */
export function CoverPane({
  src,
  label,
  size,
  failed,
  onFailure,
}: {
  readonly src: string;
  readonly label: string;
  readonly size: CardSize;
  readonly failed: boolean;
  readonly onFailure: () => void;
}): ReactNode {
  // Whether this frame is wider, in device pixels, than a stored thumbnail can fill acceptably.
  // Measured rather than read off the card size: a medium card is one narrow column on a desktop
  // and the full width of a dense phone screen. Until it is measured the answer is no, which is
  // the cheap one - the thumbnail is drawn either way and the original only follows it.
  const frame = useRef<HTMLDivElement>(null);
  const [sharp, setSharp] = useState(false);
  // Only the picture's own frame is measured, so the effect follows the pane into that state.
  const showsPicture = src.length > 0 && isDisplayableImageValue(src) && !failed;
  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const measure = () => {
      const devicePixels = element.getBoundingClientRect().width * window.devicePixelRatio;
      setSharp(devicePixels > THUMBNAIL_SIDE * TOLERATED_UPSCALE);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [showsPicture]);

  if (src.length === 0) {
    // In words, not as an empty box. An empty box is indistinguishable from a cover that failed to
    // load and from a picture that happens to be white.
    return (
      <CoverFrame size={size}>
        <Text variant="caption" tone="muted" as="span">
          No cover
        </Text>
      </CoverFrame>
    );
  }

  if (!isDisplayableImageValue(src)) {
    // **Its own state, and never handed to an `img`.** A schema retype does not revalidate values
    // already stored, so a property that was text yesterday can hold "draft notes" and be a picture
    // property today - the server's write-time scheme check never saw it. Given to an `img` that
    // resolves against this origin, fetches the application shell, fails to decode, and reports as
    // a broken cover: a request fired at our own server, per card, for something nobody ever
    // attempted to load, and the no-referrer reasoning quietly voided because it is same-origin.
    //
    // It is not "No cover" either - there is a value - so it says what is actually wrong. A value
    // an upload wrote is always displayable (see `isDisplayableImageValue`), so this is reachable
    // only for a stored web address that never validated, exactly as before uploading existed.
    return (
      <CoverFrame size={size}>
        <Text variant="caption" tone="muted" as="span">
          This is not a picture address
        </Text>
        <CoverDetail>{src}</CoverDetail>
      </CoverFrame>
    );
  }

  if (failed) {
    // Never the "No cover" state. This item has a cover; it is the fetch that is broken, and
    // telling somebody the property is empty would send them to re-enter an address that is
    // already right. The property is named because that is where the correction is made, and the
    // address is shown because it is the only evidence on the card.
    return (
      <CoverFrame size={size}>
        <Text variant="caption" tone="muted" as="span">
          {`This cover could not be loaded. Check the address in ${label}.`}
        </Text>
        <CoverDetail>{src}</CoverDetail>
      </CoverFrame>
    );
  }

  // **Framed even while it is loading, which is the state the four-way telling forgets.** Covers
  // are lazy, so every card below the fold sits here on first paint; a bare `img` with nothing in
  // it yet is exactly the empty box the "No cover" case exists to avoid, and a grid half-framed and
  // half-hollow reads as a fault. The frame is a hairline rather than a fill, so it claims nothing
  // about progress - it just means the card never has a hole in it, and the geometry is identical
  // in every state so nothing reflows as pictures resolve.
  return (
    <CoverFrame size={size} frameRef={frame}>
      <CoverImage
        src={src}
        // Empty on purpose, and this is the accessible-name decision rather than an omission. The
        // cover carries nothing the card does not already say as text - the title is right beside
        // it, and it is what the picture is *of*. `alt={item.title}` would have a screen reader
        // announce the same words twice, once as a picture and once as the control. A decorative
        // duplicate of adjacent text is exactly what an empty alt is for.
        alt=""
        className="absolute inset-0 size-full object-cover"
        sharp={sharp}
        onError={onFailure}
      />
    </CoverFrame>
  );
}

/**
 * The address under a cover's refusal.
 *
 * Clamped, because a presigned or CDN address runs to hundreds of characters and `break-all` inside
 * a fixed-ratio box wraps it to a dozen lines that spill straight through the frame and collide with
 * the title. The full value stays reachable as the title attribute and, properly, in the property
 * panel - the card's job is to say which address it was, not to be the place it is read.
 */
function CoverDetail({ children }: { readonly children: string }): ReactNode {
  return (
    <Text
      variant="caption"
      as="span"
      tone="muted"
      title={children}
      className="line-clamp-2 break-all"
    >
      {children}
    </Text>
  );
}

/**
 * The picture-shaped space a cover occupies - holding the picture, or the words about it.
 *
 * One box for all four states, so a grid does not reflow as covers resolve and a card is never a
 * hole. `overflow-hidden` is what keeps a long address inside the hairline; `relative` is what the
 * picture fills.
 */
function CoverFrame({
  children,
  size,
  frameRef,
}: {
  readonly children: ReactNode;
  readonly size: CardSize;
  readonly frameRef?: RefObject<HTMLDivElement | null>;
}): ReactNode {
  return (
    <div
      ref={frameRef}
      className={cn(
        blueprintFrame,
        CARD_SIZE_COVER[size],
        'relative flex w-full flex-col items-center justify-center gap-1 overflow-hidden p-3 text-center',
      )}
    >
      {children}
    </div>
  );
}
