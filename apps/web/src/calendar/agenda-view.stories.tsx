import { within } from '@testing-library/dom';
import type { ReactNode } from 'react';

import { AgendaView } from './agenda-view';

export default { title: 'Nix/Calendar/Agenda' };

const today = { year: 2026, month: 8, day: 23 };
const noop = (): void => undefined;

export const Week = {
  render: (): ReactNode => (
    <div className="w-full max-w-4xl">
      <AgendaView
        anchor={today}
        today={today}
        byDay={new Map()}
        onOpen={noop}
        onReschedule={noop}
        onAdd={noop}
      />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const tomorrow = canvas.getByRole('region', { name: 'Thursday 24 September 2026' });
    await canvasElement.ownerDocument.fonts.ready;
    const date = within(tomorrow).getByText('24 September 2026', { exact: true });
    const range = canvasElement.ownerDocument.createRange();
    range.selectNodeContents(date);
    const lines = new Set(Array.from(range.getClientRects(), (rect) => rect.top));
    if (lines.size !== 1 || tomorrow.scrollWidth > tomorrow.clientWidth)
      throw new Error('The full date must fit on one line in the three-column agenda.');
  },
};
