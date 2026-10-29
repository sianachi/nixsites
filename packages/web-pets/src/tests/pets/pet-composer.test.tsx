import { render, screen } from '@testing-library/react';
import { createRef, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../../pets/conversation/composer/composer';
import { useSlashMenu } from '../../pets/conversation/composer/use-slash-menu';

function Harness({ running }: { readonly running: boolean }): ReactElement {
  const slash = useSlashMenu('hello', [], vi.fn());
  return (
    <Composer
      petName="Pip"
      input={createRef()}
      draft="hello"
      onDraftChange={vi.fn()}
      touchLikeComposer={false}
      slash={slash}
      onSubmit={vi.fn()}
      onInterrupt={vi.fn()}
      running={running}
      canSend
      chips={[]}
      onRemoveChip={vi.fn()}
      needsWorkspaceAccess={false}
      onTurnOnWorkspaceAccess={vi.fn()}
      workspaceAccess={false}
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
