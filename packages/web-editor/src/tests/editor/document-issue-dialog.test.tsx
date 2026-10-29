import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentIssueDialog } from '../../editor/document-issue-dialog';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('one document issue dialog', () => {
  it('leaves healthy and connecting documents quiet, without a footer', () => {
    const { rerender, container } = render(<DocumentIssueDialog noun="note" state="connecting" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<DocumentIssueDialog noun="note" state="live" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.querySelector('footer')).toBeNull();
  });

  it('explains read-only access once and keeps retries quiet', async () => {
    const { rerender } = render(<DocumentIssueDialog noun="note" state="readonly" />);
    expect(screen.getByRole('dialog')).toHaveTextContent('edits cannot be saved');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    rerender(<DocumentIssueDialog noun="note" state="connecting" />);
    rerender(<DocumentIssueDialog noun="note" state="readonly" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows one dialog for simultaneous failures, with no competing alerts', () => {
    render(
      <>
        <DocumentIssueDialog
          noun="note"
          state="offline"
          draftState="error"
          refusal="The last change could not be saved."
        />
        <DocumentIssueDialog noun="canvas" state="offline" />
      </>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Document needs attention' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(dialog).getAllByText(/Nix lost its connection/)).toHaveLength(1);
    expect(dialog).toHaveTextContent('Keep this tab open');
    expect(dialog).toHaveTextContent('could not save your edits on this device');
    expect(dialog).toHaveTextContent('The last change could not be saved.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not reopen a dismissed outage on retries or on edits, but reports a new outage after recovery', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DocumentIssueDialog noun="note" state="offline" />);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    rerender(<DocumentIssueDialog noun="note" state="connecting" />);
    rerender(<DocumentIssueDialog noun="note" state="pending" draftState="local" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<DocumentIssueDialog noun="note" state="live" draftState="synced" />);
    rerender(<DocumentIssueDialog noun="note" state="offline" />);
    expect(screen.getByRole('dialog')).toHaveTextContent('Nix lost its connection');
  });

  it('keeps a dismissed outage quiet when another pane encounters the same connection failure', async () => {
    const { rerender } = render(<DocumentIssueDialog noun="note" state="offline" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    rerender(
      <>
        <DocumentIssueDialog noun="note" state="connecting" />
        <DocumentIssueDialog noun="sheet" state="offline" />
      </>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports a required upgrade even after an outage was dismissed', async () => {
    const { rerender } = render(<DocumentIssueDialog noun="note" state="offline" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    rerender(
      <DocumentIssueDialog
        noun="note"
        state="degraded"
        refusal="Reload to update Nix."
        reloadRequired
      />,
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('Reload to update Nix.');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('offers one stale-copy explanation and Reload, without a duplicate sync warning', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    render(<DocumentIssueDialog noun="note" state="degraded" stale refusal="Reload this note." />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('older copy');
    expect(dialog).toHaveTextContent('changes here are not saved');
    expect(dialog).not.toHaveTextContent('Nix cannot sync');
    expect(dialog).not.toHaveTextContent('Reload this note.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('defers background sync errors while an editor form is open and restores focus on Escape', () => {
    const { rerender } = render(
      <>
        <button type="button">Writing tools</button>
        <DocumentIssueDialog noun="note" state="offline" paused />
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'Writing tools' });
    trigger.focus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(
      <>
        <button type="button">Writing tools</button>
        <DocumentIssueDialog noun="note" state="offline" />
      </>,
    );
    const dialog = screen.getByRole('dialog');
    // jsdom does not implement the platform's Escape-to-cancel default action.
    fireEvent(dialog, new Event('cancel', { cancelable: true, bubbles: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
