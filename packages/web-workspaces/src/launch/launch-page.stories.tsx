import { within } from '@testing-library/dom';
import type { ReactNode } from 'react';

import type { LaunchIntent } from './launch-intent';
import { ConfirmLaunch } from './launch-page';

export default { title: 'Nix/Launch', parameters: { layout: 'padded' } };

const shared: Extract<LaunchIntent, { kind: 'share' }> = {
  kind: 'share',
  title: 'SharedDraftWithAnUnbrokenTitle'.repeat(8),
  text: [
    'A writing plan shared from another app.',
    'DraftIdentifierWithoutAnySpaces'.repeat(12),
    ...Array.from({ length: 20 }, (_, index) => `Section ${String(index + 1)} of the plan.`),
    'The last line stays available to review before saving.',
  ].join('\n\n'),
  url: `https://example.com/${'shared-document/'.repeat(12)}`,
};

function confirmation(intent: Extract<LaunchIntent, { kind: 'new' | 'share' }>): ReactNode {
  return (
    <ConfirmLaunch
      intent={intent}
      workspaceName="Personal writing and long-term plans"
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />
  );
}

export const NewNote = { render: (): ReactNode => confirmation({ kind: 'new' }) };
export const SharedNote = { render: (): ReactNode => confirmation(shared) };
export const TinyPhoneShare = {
  render: (): ReactNode => (
    <section aria-label="Phone launch" className="w-64 max-w-full">
      {confirmation(shared)}
    </section>
  ),
  play: ({ canvasElement }: { canvasElement: HTMLElement }): void => {
    const canvas = within(canvasElement);
    const phone = canvas.getByRole('region', { name: 'Phone launch' });
    const preview = canvas.getByRole('region', { name: 'Shared text' });
    if (phone.scrollWidth > phone.clientWidth || preview.scrollWidth > preview.clientWidth) {
      throw new Error('The narrow launch confirmation overflows horizontally.');
    }
    if (preview.scrollHeight <= preview.clientHeight) {
      throw new Error('Long shared text must remain available in the scrollable preview.');
    }
  },
};
export const PhoneNewNote = {
  render: (): ReactNode => <div className="w-80 max-w-full">{confirmation({ kind: 'new' })}</div>,
};
export const DarkTinyPhoneShare = { ...TinyPhoneShare, globals: { ground: 'dark' } };
