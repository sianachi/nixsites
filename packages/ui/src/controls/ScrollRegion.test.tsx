import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { ScrollRegion } from './ScrollRegion';

describe('ScrollRegion', () => {
  it('is a focusable region with the given name', () => {
    render(<ScrollRegion aria-label="Transactions">Rows</ScrollRegion>);

    const region = screen.getByRole('region', { name: 'Transactions' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveTextContent('Rows');
  });

  it('takes its name from aria-labelledby', () => {
    render(
      <>
        <h2 id="title">Log</h2>
        <ScrollRegion aria-labelledby="title">Rows</ScrollRegion>
      </>,
    );

    expect(screen.getByRole('region', { name: 'Log' })).toBeInTheDocument();
  });

  it('forwards className, ref and other props', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <ScrollRegion ref={ref} aria-label="Grid" className="overflow-auto" data-testid="grid">
        Rows
      </ScrollRegion>,
    );

    expect(ref.current).toBe(screen.getByTestId('grid'));
    expect(ref.current).toHaveClass('overflow-auto');
  });

  it('requires a name', () => {
    // @ts-expect-error - a region without aria-label or aria-labelledby does not type-check.
    render(<ScrollRegion>Rows</ScrollRegion>);
  });
});
