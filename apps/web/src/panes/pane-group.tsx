import { PaneDivider } from '@nix/ui';
import { Fragment, useCallback, useRef, type ReactNode } from 'react';

import { paneClip } from '@nix/web-foundation/layout/regions';
import { PaneProvider } from './pane-context';
import type { PaneState } from './pane-state';
import { paneElementId, type SplitOrientation } from './pane-params';

/**
 * The custom property one pane's share is read from.
 *
 * A property rather than a React-rendered value, because a drag has to move the layout without a
 * render: a `setState` per `pointermove` would re-render every open editor sixty times a second,
 * and one of those editors may be a canvas. The divider writes these directly during a drag; React
 * writes them again, to the same numbers, when the settled value reaches the address.
 */
function shareProperty(index: number): string {
  return `--pane-share-${String(index)}`;
}

export interface PaneGroupProps {
  readonly panes: readonly PaneState[];

  /**
   * How the panes are arranged, which maps onto each handle's *own* axis rather than the
   * arrangement's: a `vertical` split puts the panes side by side and the divider between them is
   * a vertical line. `<PaneDivider>` takes that axis, so the mapping happens here and nowhere
   * else.
   */
  readonly split: SplitOrientation;

  /** One share per pane, or null to divide the space evenly. */
  readonly sizes: readonly number[] | null;

  readonly onSizes: (sizes: readonly number[]) => void;

  /** Renders one pane's contents. The index it is given is the one its parameters are suffixed. */
  readonly renderPane: (pane: PaneState) => ReactNode;

  /** How each pane is described in the divider's name, so the control says what it moves. */
  readonly describePane: (pane: PaneState) => string;
}

/**
 * Panes side by side, with a handle between each pair.
 *
 * **Inside the route element, not the shell.** `AppShell` still owns exactly one `<main>`, so the
 * document keeps one main landmark however many panes are open - splitting the screen is an
 * arrangement of one region, not several regions.
 *
 * **Shares are grow factors, not widths.** A percentage width has to account for the dividers
 * between the panes, so a two-pane 50/50 overflows by the width of the handle; grow factors divide
 * whatever is left after the handles have taken theirs, which is the arithmetic the browser is
 * already doing.
 */
export function PaneGroup({
  panes,
  split,
  sizes,
  onSizes,
  renderPane,
  describePane,
}: PaneGroupProps): ReactNode {
  const groupRef = useRef<HTMLDivElement>(null);

  const shares = sizes ?? panes.map(() => 100 / Math.max(1, panes.length));

  /** Writes a pair's shares straight to the DOM, for the duration of a drag. */
  const preview = useCallback((index: number, before: number, after: number): void => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }

    group.style.setProperty(shareProperty(index), String(before));
    group.style.setProperty(shareProperty(index + 1), String(after));
  }, []);

  const commit = useCallback(
    (index: number, before: number, after: number): void => {
      const next = [...shares];
      next[index] = before;
      next[index + 1] = after;
      onSizes(next);
    },
    [onSizes, shares],
  );

  const style: Record<string, string> = {};
  for (const [index, share] of shares.entries()) {
    style[shareProperty(index)] = String(share);
  }

  return (
    <div
      ref={groupRef}
      // design-token-exempt: a pane's share of the group is a runtime ratio a person dragged, not
      // a step on any scale - the same case as the sheet grid's column offsets.
      style={style}
      className={`flex flex-1 ${paneClip} ${split === 'vertical' ? 'flex-row' : 'flex-col'}`}
    >
      {panes.map((pane, index) => (
        <Fragment key={pane.index}>
          {index === 0 ? null : (
            <PaneDivider
              orientation={split}
              before={shares[index - 1] ?? 50}
              after={shares[index] ?? 50}
              beforeName={describePane(panes[index - 1] ?? pane)}
              afterName={describePane(pane)}
              // The region the handle's value is about, by the id the pane already carries
              // (`pane-params.ts`) - the same one `focusPane` addresses, so nothing new is minted.
              // The pane *before* the handle is the one the announced share is a share of.
              controls={paneElementId((panes[index - 1] ?? pane).index)}
              onPreview={(before, after) => {
                preview(index - 1, before, after);
              }}
              onCommit={(before, after) => {
                commit(index - 1, before, after);
              }}
            />
          )}

          <div
            style={{ flexGrow: `var(${shareProperty(index)})`, flexBasis: 0 }} // design-token-exempt: a pane's share is a runtime ratio somebody dragged, read from the property the group sets - not a step on any scale.
            className={`flex flex-col ${paneClip}`}
          >
            {/* Everything below here addresses this pane's parameters and nothing else. */}
            <PaneProvider index={pane.index}>{renderPane(pane)}</PaneProvider>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
