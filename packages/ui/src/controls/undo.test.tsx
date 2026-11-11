import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { UndoBar, UndoProvider, useUndo } from './undo';
import { useFlash } from './use-flash';

function Harness({ onUndo }: { readonly onUndo: (n: number) => void }): ReactNode {
  const undo = useUndo();
  return (
    <>
      <button
        onClick={() => {
          undo.push('Removed A', () => {
            onUndo(1);
          });
          undo.push('Removed B', () => {
            onUndo(2);
          });
        }}
      >
        go
      </button>
      <input aria-label="field" />
      <UndoBar />
    </>
  );
}

describe('undo history', () => {
  it('undoes newest first, one step at a time, and says so', async () => {
    const onUndo = vi.fn();
    const user = userEvent.setup();
    render(
      <UndoProvider>
        <Harness onUndo={onUndo} />
      </UndoProvider>,
    );
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    await user.click(screen.getByText('go'));
    expect(screen.getByRole('status')).toHaveTextContent('Removed B');
    await user.click(screen.getByRole('button', { name: 'Undo (2)' }));
    expect(onUndo).toHaveBeenLastCalledWith(2);
    expect(screen.getByRole('status')).toHaveTextContent('Undid: Removed B');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenLastCalledWith(1);
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
  });

  it('Cmd/Ctrl+Z undoes outside text fields only', async () => {
    const onUndo = vi.fn();
    const user = userEvent.setup();
    render(
      <UndoProvider>
        <Harness onUndo={onUndo} />
      </UndoProvider>,
    );
    await user.click(screen.getByText('go'));
    await user.click(screen.getByLabelText('field'));
    await user.keyboard('{Control>}z{/Control}');
    expect(onUndo).not.toHaveBeenCalled();
    await user.click(screen.getByText('go'));
    await user.keyboard('{Control>}z{/Control}');
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledWith(2);
  });

  it('goes away on its own, keeps the history, and comes back on the next undo', () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    render(
      <UndoProvider>
        <Harness onUndo={onUndo} />
      </UndoProvider>,
    );
    act(() => {
      screen.getByText('go').click();
    });
    expect(screen.getByRole('button', { name: 'Undo (2)' })).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(onUndo).toHaveBeenCalledWith(2);
    expect(screen.getByRole('status')).toHaveTextContent('Undid: Removed B');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
    vi.useRealTimers();
  });

  it('goes after five seconds, or at once from Dismiss, keeping the history', () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    render(
      <UndoProvider>
        <Harness onUndo={onUndo} />
      </UndoProvider>,
    );
    act(() => {
      screen.getByText('go').click();
    });
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByRole('button', { name: 'Undo (2)' })).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('stays while a mouse is over it, then goes once the mouse leaves', () => {
    vi.useFakeTimers();
    render(
      <UndoProvider>
        <Harness onUndo={vi.fn()} />
      </UndoProvider>,
    );
    act(() => {
      screen.getByText('go').click();
    });
    const bar = screen.getByText('Removed B');
    fireEvent.pointerEnter(bar, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByRole('button', { name: 'Undo (2)' })).toBeVisible();
    fireEvent.pointerLeave(bar, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    vi.useRealTimers();
  });

  it('push is a no-op without a provider', () => {
    const { result } = renderHook(() => useUndo());
    expect(() => {
      result.current.push('x', vi.fn());
    }).not.toThrow();
    expect(result.current.depth).toBe(0);
  });
});

describe('useFlash', () => {
  it('stays quiet on mount, then alternates a/b on each change', () => {
    const { result, rerender } = renderHook(({ t }) => useFlash(t), { initialProps: { t: 1 } });
    expect(result.current).toEqual({});
    rerender({ t: 2 });
    expect(result.current).toEqual({ 'data-flash': 'a' });
    rerender({ t: 3 });
    expect(result.current).toEqual({ 'data-flash': 'b' });
  });
});
