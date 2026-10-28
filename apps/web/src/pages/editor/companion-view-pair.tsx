import { PaneDivider } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';

import { WIDE_ENOUGH_FOR_COMPANION_BESIDE } from '@nix/web-foundation/layout/regions';
import { useMediaQuery } from '@nix/web-foundation/layout/viewport';

interface CompanionViewPairProps {
  readonly itemId: string;
  readonly paneIndex: number;
  readonly placement: 'below' | 'beside' | null | undefined;
  readonly primaryName: string;
  readonly companionName: string;
  readonly primary: ReactNode;
  readonly companion: ReactNode;
}

/**
 * A primary and companion view sharing one viewport.
 *
 * The splitter is intentionally local to this composition. It controls only the two views an item
 * currently declares, so serializing it into the pane URL would falsely make an item's own layout
 * part of a reader's multi-pane arrangement. A new composition starts balanced; an adjustment
 * survives ordinary re-renders and remains available to pointer and keyboard users alike.
 */
export function CompanionViewPair({
  itemId,
  paneIndex,
  placement,
  primaryName,
  companionName,
  primary,
  companion,
}: CompanionViewPairProps): ReactNode {
  const wide = useMediaQuery(WIDE_ENOUGH_FOR_COMPANION_BESIDE);
  const orientation = placement === 'beside' && wide ? 'vertical' : 'horizontal';
  const [shares, setShares] = useState<readonly [number, number]>([50, 50]);
  const pairRef = useRef<HTMLDivElement>(null);
  const primaryRegionId = `companion-primary-${String(paneIndex)}-${itemId}`;

  function preview(primaryShare: number, companionShare: number): void {
    const pair = pairRef.current;
    if (pair === null) return;
    pair.style.setProperty('--companion-primary-share', String(primaryShare));
    pair.style.setProperty('--companion-secondary-share', String(companionShare));
  }

  function commit(primaryShare: number, companionShare: number): void {
    setShares([primaryShare, companionShare]);
  }

  const style: Record<string, string> = {
    '--companion-primary-share': String(shares[0]),
    '--companion-secondary-share': String(shares[1]),
  };
  const vertical = orientation === 'vertical';

  return (
    <div
      ref={pairRef}
      style={style}
      className={`flex min-h-full min-w-0 ${vertical ? 'flex-row' : 'flex-col'}`}
    >
      <section
        id={primaryRegionId}
        aria-label={primaryName}
        style={{ flexGrow: 'var(--companion-primary-share)', flexBasis: 0 }} // design-token-exempt: a companion pane's share is a runtime ratio adjusted by its divider, not a design-scale value.
        className="min-h-0 min-w-0"
      >
        {primary}
      </section>
      <PaneDivider
        orientation={orientation}
        before={shares[0]}
        after={shares[1]}
        beforeName={primaryName}
        afterName={companionName}
        controls={primaryRegionId}
        onPreview={preview}
        onCommit={commit}
      />
      <section
        aria-label={companionName}
        style={{ flexGrow: 'var(--companion-secondary-share)', flexBasis: 0 }} // design-token-exempt: a companion pane's share is a runtime ratio adjusted by its divider, not a design-scale value.
        className="min-h-0 min-w-0"
      >
        {companion}
      </section>
    </div>
  );
}
