import type { ReactNode } from 'react';

import { useRovingGrid } from '../use-roving-grid';

/**
 * Makes a month's add controls one tab stop with the arrow keys walking the days, the same
 * keyboard model the hour grid uses; the cards in each day keep their ordinary tab order.
 */
export function RovingMonth(props: {
  readonly weeks: number;
  readonly children: ReactNode;
}): ReactNode {
  const { containerRef, onKeyDown, onFocusCapture } = useRovingGrid(props.weeks, 7);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Justification: the handlers only steer which add button is the tab stop; the element is never a target and gets no role, no tab stop and no name.
    <div ref={containerRef} onKeyDown={onKeyDown} onFocusCapture={onFocusCapture}>
      {props.children}
    </div>
  );
}
