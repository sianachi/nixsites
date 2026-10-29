import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { aView } from '@nix/web-collections/testing/view-fixture';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { EmbeddedNoteViews } from '../../pages/editor/embedded-note-views';
import '../view-registration';

const views = [
  aView({ id: 'all', name: 'All' }),
  aView({ id: 'by-status', name: 'By status', kind: 'board', groupBy: 'status' }),
];

const container = vi.hoisted(() => ({ status: 'ready' as string }));
vi.mock('@nix/web-collections/core/use-container', () => ({
  useContainer: () => ({
    status: container.status,
    views: { views, unrenderable: [], default: 'all', hideDocument: false },
  }),
}));
vi.mock('@nix/web-platform/routing/selected-item', () => ({
  useSelectedItem: () => ({ select: vi.fn() }),
}));
vi.mock('@nix/web-views/core/container-view', () => ({
  ContainerView: ({ view }: { view: { name: string } | null }) => <p>Showing {view?.name}</p>,
}));

function Embed({ initial }: { readonly initial: string | null }) {
  const [viewId, setViewId] = useState(initial);
  return (
    <>
      <p data-testid="stored">{viewId}</p>
      <EmbeddedNoteViews
        itemId="note"
        viewId={viewId}
        onViewChange={setViewId}
        document={<p>The note body</p>}
      />
    </>
  );
}

describe('an embedded note with views', () => {
  it('shows a loading state, not the document, while a remembered view loads', () => {
    container.status = 'loading';
    render(<Embed initial="by-status" />);
    expect(screen.queryByText('The note body')).toBeNull();
    container.status = 'ready';
  });

  it('switches between the document and its views, and reports the choice', async () => {
    stubViewport(true);
    const user = userEvent.setup();
    const { unmount } = render(<Embed initial={null} />);
    // The note's own default opens first.
    expect(screen.getByText('Showing All')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /by status/i }));
    expect(screen.getByText('Showing By status')).toBeVisible();
    expect(screen.getByTestId('stored')).toHaveTextContent('by-status');

    await user.click(screen.getByRole('button', { name: /^document$/i }));
    expect(screen.getByText('The note body')).toBeVisible();
    unmount();

    // A remount with the remembered choice shows the same view.
    render(<Embed initial="by-status" />);
    expect(screen.getByText('Showing By status')).toBeVisible();
  });
});
