import { cn } from '@nix/ui';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import {
  readPropertyText,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
} from '../../collections/core/container-model';
import { useVirtualWindow } from '../../collections/core/use-virtual-window';
import { CARD_SIZE_GRID, galleryColumnCount, galleryRowEstimate, type CardSize } from './card-size';
import { GalleryCard } from './gallery-card';
import type { Cover } from './gallery-cover';

const VIRTUALIZATION_THRESHOLD = 100;

export interface GalleryGridProps {
  readonly items: readonly Item[];
  readonly label: string;
  readonly cover: Cover;
  readonly size: CardSize;
  readonly secondary: readonly string[];
  readonly schema: readonly PropertyDefinition[];
  readonly onOpen: (itemId: string) => void;
  readonly onWrite: (
    itemId: string,
    propertyKey: string,
    value: PropertyValue,
  ) => Promise<string | null>;
  readonly onRequestCover: (itemId: string) => void;
}

export function GalleryGrid(props: GalleryGridProps): ReactNode {
  const { items, label, cover, size, secondary, schema, onOpen, onWrite, onRequestCover } = props;
  const [failedCovers, setFailedCovers] = useState<ReadonlySet<string>>(() => new Set());

  const card = (item: Item, index: number, virtualIndex?: number): ReactNode => {
    const src = cover.kind === 'ready' ? readPropertyText(item, cover.property.key) : '';
    const failureKey = `${item.id}\u0000${src}`;
    return (
      <GalleryCard
        key={item.id}
        item={item}
        cover={cover}
        size={size}
        secondary={secondary}
        schema={schema}
        onOpen={onOpen}
        onWrite={onWrite}
        coverFailed={failedCovers.has(failureKey)}
        onCoverFailure={() => {
          setFailedCovers((current) => new Set(current).add(failureKey));
        }}
        onRequestCover={() => {
          onRequestCover(item.id);
        }}
        position={index + 1}
        setSize={items.length}
        {...(virtualIndex === undefined ? {} : { virtualIndex })}
      />
    );
  };

  if (items.length <= VIRTUALIZATION_THRESHOLD) {
    return (
      // eslint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind removes the list style, and with it this implicit role in WebKit.
      <ul role="list" aria-label={label} className={CARD_SIZE_GRID[size]}>
        {items.map((item, index) => card(item, index))}
      </ul>
    );
  }

  return <VirtualGalleryGrid {...props} renderCard={card} />;
}

function VirtualGalleryGrid(
  props: GalleryGridProps & {
    readonly renderCard: (item: Item, index: number, virtualIndex: number) => ReactNode;
  },
): ReactNode {
  const { items, label, size, renderCard } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const { width, rowGap } = useGalleryGeometry(rootRef, gridRef);
  const columns = galleryColumnCount(size, width);
  // Keep the same focused item when resizing changes its row.
  const focusedPosition =
    focusedItemId === null ? -1 : items.findIndex((item) => item.id === focusedItemId);
  const rowCount = Math.ceil(items.length / columns);
  // Stable identity keeps the virtualizer's measurement subscriptions intact between renders.
  const keys = useMemo(
    () =>
      Array.from({ length: rowCount }, (_unused, row) => {
        const first = row * columns;
        return `${String(columns)}:${items
          .slice(first, first + columns)
          .map((item) => item.id)
          .join(',')}`;
      }),
    [columns, items, rowCount],
  );
  const windowed = useVirtualWindow({
    keys,
    rootRef,
    estimate: galleryRowEstimate(size),
    measurementGap: rowGap,
    // Five rows above and below the viewport leaves room for one separately retained focused row
    // while keeping even the six-column card size below the 100-card stress ceiling at 900px.
    overscan: galleryRowEstimate(size) * 5,
    retainedIndexes: focusedPosition < 0 ? [] : [Math.floor(focusedPosition / columns)],
  });

  return (
    <div
      ref={rootRef}
      role="list"
      aria-label={label}
      className="relative"
      onFocusCapture={(event) => {
        const position =
          Number(event.target.closest('[aria-posinset]')?.getAttribute('aria-posinset')) - 1;
        setFocusedItemId(items[position]?.id ?? null);
      }}
      onBlurCapture={(event) => {
        if (!(
          event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
        ))
          setFocusedItemId(null);
      }}
      style={{ height: windowed.totalSize }} // design-token-exempt: virtual content height is derived from measured gallery rows at runtime and cannot be represented by a design token
    >
      {/* One parent keeps each retained card's draft and focus as virtual segments change. */}
      <ul
        ref={gridRef}
        role="presentation"
        className={cn(CARD_SIZE_GRID[size], 'absolute inset-x-0 top-0')}
      >
        {windowed.segments.flatMap((segment, segmentIndex) => {
          const firstItem = segment.first * columns;
          const afterLastItem = Math.min(items.length, (segment.last + 1) * columns);
          const previous = windowed.segments[segmentIndex - 1];
          const before = previous === undefined ? 0 : (windowed.offsets[previous.last + 1] ?? 0);
          const spacerHeight = Math.max(
            0,
            (windowed.offsets[segment.first] ?? 0) - before - rowGap,
          );
          return [
            ...(spacerHeight === 0
              ? []
              : [
                  <li
                    key={`gap:${String(segment.first)}`}
                    role="presentation"
                    aria-hidden="true"
                    className="col-span-full"
                    style={{ height: spacerHeight }} // design-token-exempt: omitted gallery rows use their measured offset minus the grid gap
                  />,
                ]),
            ...items
              .slice(firstItem, afterLastItem)
              .map((item, offset) =>
                renderCard(item, firstItem + offset, Math.floor((firstItem + offset) / columns)),
              ),
          ];
        })}
      </ul>
    </div>
  );
}

function useGalleryGeometry(
  rootRef: RefObject<HTMLDivElement | null>,
  gridRef: RefObject<HTMLUListElement | null>,
): { readonly width: number; readonly rowGap: number } {
  const [geometry, setGeometry] = useState(() => ({ width: window.innerWidth, rowGap: 0 }));
  useLayoutEffect(() => {
    const root = rootRef.current;
    const grid = gridRef.current;
    if (root === null || grid === null) return;
    const update = (): void => {
      const width = root.getBoundingClientRect().width;
      const measuredGap = Number.parseFloat(getComputedStyle(grid).rowGap);
      const rowGap = Number.isFinite(measuredGap) ? measuredGap : 0;
      if (root.isConnected && width > 0)
        setGeometry((current) =>
          current.width === width && current.rowGap === rowGap ? current : { width, rowGap },
        );
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(root);
    observer?.observe(grid);
    update();
    window.addEventListener('resize', update, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [rootRef, gridRef]);
  return geometry;
}
