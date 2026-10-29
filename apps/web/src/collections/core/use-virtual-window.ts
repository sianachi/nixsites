import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { usePaneViewport } from '@nix/web-foundation/layout/pane-viewport';
import {
  localViewport,
  variableOffsets,
  variableWindow,
  virtualIndexes,
  virtualSegments,
  type VirtualRange,
} from './virtual-window';

export interface VirtualWindow {
  readonly indexes: readonly number[];
  readonly segments: readonly VirtualRange[];
  readonly offsets: readonly number[];
  readonly totalSize: number;
}

/**
 * Windows variable-height content against the pane's scroller and measures mounted rows/cards.
 * Scroll work stays in this leaf hook, below filtering and sorting of the complete container.
 */
export function useVirtualWindow(input: {
  readonly keys: readonly string[];
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly estimate: number;
  readonly measurementGap?: number;
  readonly overscan?: number;
  readonly retainedIndexes?: readonly number[];
}): VirtualWindow {
  const {
    keys: proposedKeys,
    rootRef,
    estimate,
    measurementGap = 0,
    overscan = Math.max(estimate * 8, 320),
  } = input;
  const keys = useStableKeySequence(proposedKeys);
  const pane = usePaneViewport();
  const [measurements, setMeasurements] = useState<ReadonlyMap<string, number>>(() => new Map());
  const measurementsRef = useRef(measurements);
  useEffect(() => {
    measurementsRef.current = measurements;
  }, [measurements]);
  const initialLast = Math.min(
    keys.length - 1,
    Math.max(0, Math.ceil((900 + overscan) / estimate) - 1),
  );
  const [range, setRange] = useState<VirtualRange>({ first: 0, last: initialLast });
  const [focused, setFocused] = useState<number | null>(null);

  // Stable identity keeps the scroll/ResizeObserver effect subscribed until geometry changes.
  const offsets = useMemo(
    () => variableOffsets(keys, estimate, measurements),
    [estimate, keys, measurements],
  );
  const offsetsRef = useRef(offsets);
  useEffect(() => {
    offsetsRef.current = offsets;
  }, [offsets]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return;
    }

    let frame: number | null = null;
    let forceMeasurement = true;

    const measureMounted = (force: boolean): void => {
      const byIndex = new Map<number, number>();
      for (const element of root.querySelectorAll<HTMLElement>('[data-virtual-index]')) {
        const index = Number(element.dataset.virtualIndex);
        if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
          continue;
        }
        const key = keys[index];
        if (
          key === undefined ||
          byIndex.has(index) ||
          (!force && measurementsRef.current.has(key))
        ) {
          continue;
        }
        const size = element.getBoundingClientRect().height + measurementGap;
        byIndex.set(index, size);
      }

      setMeasurements((current) => {
        const retained = new Map<string, number>();
        for (const key of keys) {
          const size = current.get(key);
          if (size !== undefined) {
            retained.set(key, size);
          }
        }

        let changed = retained.size !== current.size;
        for (const [index, size] of byIndex) {
          const key = keys[index];
          if (key === undefined || size <= 0) {
            continue;
          }
          if (Math.abs((retained.get(key) ?? estimate) - size) > 0.5) {
            retained.set(key, size);
            changed = true;
          }
        }
        return changed ? retained : current;
      });
    };

    const update = (): void => {
      frame = null;
      const rootRect = root.getBoundingClientRect();
      const viewportRect = pane?.current?.getBoundingClientRect();
      const viewportTop = viewportRect?.top ?? 0;
      const viewportBottom = viewportRect?.bottom ?? window.innerHeight;
      const firstMounted = root.querySelector<HTMLElement>('[data-virtual-index]');
      const firstIndex = Number(firstMounted?.dataset.virtualIndex ?? 0);
      const contentOrigin =
        firstMounted === null
          ? 0
          : firstMounted.getBoundingClientRect().top -
            rootRect.top -
            (offsetsRef.current[firstIndex] ?? 0);
      const total = offsetsRef.current.at(-1) ?? 0;
      const local = localViewport({
        rootTop: rootRect.top,
        contentOrigin,
        viewportTop,
        viewportBottom,
        totalSize: total,
      });
      const next = variableWindow({
        offsets: offsetsRef.current,
        viewportTop: local.top,
        viewportHeight: local.height,
        overscan,
      });
      setRange((current) =>
        current.first === next.first && current.last === next.last ? current : next,
      );

      const active = document.activeElement;
      const owner =
        active instanceof Element ? active.closest<HTMLElement>('[data-virtual-index]') : null;
      const activeIndex = owner === null ? null : Number(owner.dataset.virtualIndex);
      const nextFocused =
        activeIndex !== null && Number.isInteger(activeIndex) ? activeIndex : null;
      setFocused((current) => (current === nextFocused ? current : nextFocused));
      measureMounted(forceMeasurement);
      forceMeasurement = false;
    };

    const schedule = (force: boolean): void => {
      forceMeasurement ||= force;
      frame ??= window.requestAnimationFrame(update);
    };

    const scheduleScroll = (): void => {
      schedule(false);
    };
    const scheduleResize = (): void => {
      schedule(true);
    };

    const scrollOwner: EventTarget = pane?.current ?? window;
    scrollOwner.addEventListener('scroll', scheduleScroll, { passive: true });
    window.addEventListener('resize', scheduleResize, { passive: true });

    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            schedule(true);
          });
    observer?.observe(root);
    if (pane?.current !== null && pane?.current !== undefined) {
      observer?.observe(pane.current);
    }

    update();
    return () => {
      scrollOwner.removeEventListener('scroll', scheduleScroll);
      window.removeEventListener('resize', scheduleResize);
      observer?.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [estimate, keys, measurementGap, overscan, pane, rootRef]);

  const indexes = virtualIndexes(range, keys.length, focused, input.retainedIndexes);
  return {
    indexes,
    segments: virtualSegments(indexes),
    offsets,
    totalSize: offsets.at(-1) ?? 0,
  };
}

/**
 * Keeps an equal key sequence referentially stable across interaction-only renders.
 *
 * Board grouping and Timeline placement create new arrays while their local gesture or date
 * state changes. The identities in those arrays still describe the same virtual rows, so replacing
 * the sequence would tear down the scroll listener and ResizeObserver for no geometry change.
 */
function useStableKeySequence(proposed: readonly string[]): readonly string[] {
  const [stable, setStable] = useState(proposed);
  if (!sameKeySequence(stable, proposed)) {
    setStable(proposed);
    return proposed;
  }
  return stable;
}

function sameKeySequence(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
