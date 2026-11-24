import { render, screen } from '@testing-library/react';
import { createRef, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../../pets/conversation/composer/composer';
import { useSlashMenu } from '../../pets/conversation/composer/use-slash-menu';

function Harness({
  running,
  preparing = false,
}: {
  readonly running: boolean;
  readonly preparing?: boolean;
}): ReactElement {
  const slash = useSlashMenu('hello', [], vi.fn());
  return (
    <Composer
      petName="Pip"
      scopeLabel="Workspace chat"
      input={createRef()}
      draft="hello"
      readOnly={preparing}
      onDraftChange={vi.fn()}
      touchLikeComposer={false}
      slash={slash}
      onSubmit={vi.fn()}
      onInterrupt={vi.fn()}
      running={running}
      canSend={!preparing}
      preparing={preparing}
      onFlip={vi.fn()}
      chips={[{ itemId: 'plan', label: 'Plan', sharedText: '' }]}
      onRemoveChip={vi.fn()}
      needsWorkspaceAccess={false}
      onTurnOnWorkspaceAccess={vi.fn()}
      workspaceAccess
      hasNoteScope={false}
      noteReadOnly={false}
      onToggleWorkspaceAccess={vi.fn()}
      applyWithoutAsking={false}
      onApplyChange={vi.fn()}
      hasPage={false}
      contextCount={0}
      hasSelection={false}
      onAttachPage={vi.fn()}
      onShareSelection={vi.fn()}
    />
  );
}

describe('composer send and stop', () => {
  it('shows first-send preparation and prevents draft context or route changes while it waits', () => {
    render(<Harness running={false} preparing />);
    expect(screen.getByRole('status', { name: 'Message preparation' })).toHaveTextContent(
      'Preparing message…',
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add to message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Workspace' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Switch to job' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Message Pip' })).toHaveAttribute('readonly');
  });

  it('keeps focus on the same control when a turn starts and ends', () => {
    const view = render(<Harness running={false} />);
    const send = screen.getByRole('button', { name: 'Send' });
    send.focus();
    view.rerender(<Harness running />);
    const stop = screen.getByRole('button', { name: 'Stop response' });
    expect(stop).toBe(send);
    expect(stop).toHaveFocus();
    view.rerender(<Harness running={false} />);
    expect(screen.getByRole('button', { name: 'Send' })).toHaveFocus();
  });
});
