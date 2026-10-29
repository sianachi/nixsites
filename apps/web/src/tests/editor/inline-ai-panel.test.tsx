import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor } from '@tiptap/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InlineAiPanel } from '@nix/web-editor/editor/inline-ai/inline-ai-panel';
import type {
  InlineAiController,
  InlinePanelState,
} from '@nix/web-editor/editor/inline-ai/use-inline-ai';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

const INITIAL: InlinePanelState = {
  phase: 'composing',
  kind: 'custom',
  instruction: 'Write a poem about the morning.',
  language: '',
  text: '',
  stopped: false,
  failure: null,
  canReplace: true,
  hadSelection: true,
  applying: false,
};

let editor: Editor;
beforeEach(() => {
  editor = new Editor({
    extensions: [...nixEditingExtensions],
    content: '<p>My words stay here until I accept a result.</p>',
  });
});
afterEach(() => {
  editor.destroy();
});

function controllerFor(state: InlinePanelState = INITIAL): InlineAiController {
  return {
    state,
    available: true,
    start: vi.fn(),
    setInstruction: vi.fn(),
    setLanguage: vi.fn(),
    generate: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    accept: vi.fn(),
    discard: vi.fn(),
    anchorRect: () => ({ left: 80, top: 120, bottom: 145 }),
  };
}

function panel(controller: InlineAiController) {
  return (
    <MemoryRouter>
      <InlineAiPanel editor={editor} controller={controller} />
    </MemoryRouter>
  );
}

describe('inline AI across visible viewports', () => {
  it('fits a small visual viewport above the keyboard and follows zoomed panning', async () => {
    stubViewport(320);
    vi.stubGlobal('innerHeight', 800);
    const viewport = Object.assign(new EventTarget(), {
      width: 218,
      height: 280,
      offsetLeft: 50,
      offsetTop: 120,
    });
    vi.stubGlobal('visualViewport', viewport);
    render(panel(controllerFor()));
    const dialog = screen.getByRole('dialog', { name: 'Ask AI' });
    expect(dialog).toHaveStyle({ left: '58px', width: '202px' });
    expect(dialog.style.getPropertyValue('--inline-ai-viewport-height')).toBe('280px');
    expect(dialog.style.getPropertyValue('--keyboard-inset')).toBe('400px');
    expect(dialog).toHaveClass('min-w-0', 'overflow-y-auto', 'overscroll-contain');

    act(() => {
      viewport.width = 180;
      viewport.height = 160;
      viewport.offsetLeft = 70;
      viewport.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => {
      expect(dialog).toHaveStyle({ left: '78px', width: '164px' });
      expect(dialog.style.getPropertyValue('--inline-ai-viewport-height')).toBe('160px');
      expect(dialog.style.getPropertyValue('--keyboard-inset')).toBe('520px');
    });
  });

  it('offers a close control while choosing a writing command on a phone', async () => {
    stubViewport(240);
    const controller = controllerFor({ ...INITIAL, phase: 'choosing', kind: null });
    const user = userEvent.setup();
    render(panel(controller));
    await user.click(screen.getByRole('button', { name: 'Fix spelling and grammar' }));
    expect(controller.start).toHaveBeenCalledWith('fix');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(controller.discard).toHaveBeenCalledOnce();
  });

  it('keeps partial error output and acceptance actions available', () => {
    const controller = controllerFor({
      ...INITIAL,
      phase: 'error',
      failure: 'interrupted',
      text: `https://example.com/${'long-path'.repeat(60)}`,
    });
    render(panel(controller));
    const result = screen.getByRole('region', { name: 'AI writing result' });
    expect(result).toHaveTextContent(controller.state.text);
    expect(result.firstElementChild).toHaveClass('wrap-anywhere');
    expect(screen.getByRole('alert')).toHaveTextContent('What arrived is kept below.');
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    expect(controller.accept).toHaveBeenCalledWith('replace');
    expect(editor.getText()).toBe('My words stay here until I accept a result.');
  });
});

describe('inline AI prompt and result interaction', () => {
  it('keeps touch Enter for new lines and submits with Ctrl+Enter or Generate', async () => {
    stubViewport(800);
    const media = globalThis.matchMedia;
    vi.stubGlobal('matchMedia', (query: string) => {
      const result = media(query);
      if (query === '(any-pointer: coarse)') {
        Object.defineProperty(result, 'matches', { value: true });
      }
      return result;
    });
    const controller = controllerFor();
    const user = userEvent.setup();
    render(panel(controller));
    const prompt = screen.getByRole('textbox', { name: 'What should the AI write?' });
    expect(fireEvent.keyDown(prompt, { key: 'Enter' })).toBe(true);
    expect(controller.generate).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true })).toBe(false);
    expect(controller.generate).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(controller.generate).toHaveBeenCalledTimes(2);
  });

  it('preserves desktop Enter submission, Shift+Enter and IME composition', () => {
    const controller = controllerFor();
    render(panel(controller));
    const prompt = screen.getByRole('textbox', { name: 'What should the AI write?' });
    expect(fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(prompt, { key: 'Enter', isComposing: true })).toBe(true);
    expect(controller.generate).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(prompt, { key: 'Enter' })).toBe(false);
    expect(controller.generate).toHaveBeenCalledOnce();
  });

  it('keeps the prompt after an outside touch and restores focus when dismissal is cancelled', async () => {
    const controller = controllerFor();
    const user = userEvent.setup();
    render(panel(controller));
    fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    expect(screen.getByRole('group', { name: 'Discard this text?' })).toBeInTheDocument();
    const keep = screen.getByRole('button', { name: 'Keep it' });
    expect(keep).toHaveFocus();
    await user.click(keep);
    expect(screen.getByRole('textbox', { name: 'What should the AI write?' })).toHaveFocus();
    expect(controller.discard).not.toHaveBeenCalled();
  });

  it('does not pull a reader back to the bottom of a growing result', () => {
    const controller = controllerFor({ ...INITIAL, phase: 'streaming', text: 'First words' });
    const view = render(panel(controller));
    const result = screen.getByRole('region', { name: 'AI writing result' });
    Object.defineProperties(result, {
      scrollHeight: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 50 },
    });
    result.scrollTop = 0;
    fireEvent.scroll(result);
    view.rerender(
      panel({ ...controller, state: { ...controller.state, text: 'More words arrive' } }),
    );
    expect(result.scrollTop).toBe(0);

    result.scrollTop = 150;
    fireEvent.scroll(result);
    Object.defineProperty(result, 'scrollHeight', { configurable: true, value: 250 });
    view.rerender(
      panel({ ...controller, state: { ...controller.state, text: 'Last words arrive' } }),
    );
    expect(result.scrollTop).toBe(250);
  });
});
