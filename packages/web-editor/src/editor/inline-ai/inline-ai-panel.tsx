import {
  Button,
  Input,
  Select,
  Text,
  Textarea,
  focusRing,
  placeFloatingMenu,
  readViewportBounds,
} from '@nix/ui';
import type { Editor } from '@tiptap/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { INLINE_AI_COMMANDS } from './inline-ai-commands';
import { MAX_INSTRUCTION_CHARS } from './inline-ai-stream';
import {
  RETRYABLE,
  type InlineAiController,
  type InlineFailure,
  type InlinePanelState,
} from './use-inline-ai';

/**
 * The small panel the writing assistance works in, anchored to the selection or the caret.
 *
 * It only ever shows a result; the note changes when the person accepts one, never before. The
 * note stays live underneath it - nothing is locked, the page still scrolls - so the panel is a
 * floating box rather than a dialog, placed the way the editor's other floating menus are: beside
 * the text on a wide screen, inside the viewport always, and docked to the bottom above the
 * on-screen keyboard on a phone, as the mobile toolbar is.
 *
 * Escape stops a request that is running and otherwise discards and closes. A pointer press
 * outside is different: with text on the panel it asks first, as a dialog with unsaved work does,
 * because a stray click should not throw away something a model spent a while writing.
 */

const LANGUAGES: readonly string[] = [
  'English',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Portuguese',
  'Dutch',
  'Russian',
  'Chinese (Simplified)',
  'Japanese',
  'Korean',
  'Arabic',
  'Hindi',
  'Turkish',
  'Polish',
];

/** The width the panel asks for on a wide screen, before the viewport narrows it. */
const PANEL_WIDTH = 380;

const TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  INLINE_AI_COMMANDS.map((command) => [command.kind, command.label.replace('…', '')]),
);

function failureMessage(failure: InlineFailure, kept: boolean): string {
  switch (failure) {
    case 'empty':
      return 'There is nothing to work on here. Select some text, or put the cursor in a paragraph, and try again.';
    case 'selection_too_long':
      return 'That selection is larger than 16 KB. Select less and try again.';
    case 'disabled':
      return 'Inline writing is switched off.';
    case 'locked':
      return 'This note is locked, so its text is not sent to the assistant.';
    case 'unavailable':
      return 'No model is connected for the assistant to use.';
    case 'busy':
      return 'Too many writing requests are running at once. Try again in a moment.';
    case 'timeout':
      return kept
        ? 'The assistant took too long to finish. What arrived is kept below.'
        : 'The assistant took too long to answer.';
    case 'too_long':
      return kept
        ? 'The result reached its length limit and stopped. What arrived is kept below.'
        : 'The request was too long for the assistant to answer.';
    case 'refused':
      return 'The assistant declined to write this.';
    case 'provider_failed':
      return kept
        ? 'The assistant stopped before it finished. What arrived is kept below.'
        : 'The assistant could not write this. Your note has not changed.';
    case 'offline':
      return kept
        ? 'The connection dropped. What arrived is kept below.'
        : 'Nix could not be reached. Check your connection and try again.';
    case 'interrupted':
      return kept
        ? 'The connection broke before the result finished. What arrived is kept below.'
        : 'The connection broke before anything arrived.';
    case 'not_found':
      return 'This note could not be found, so nothing was sent.';
    case 'invalid':
      return 'That request was not accepted.';
    case 'not_added':
      return 'The result could not be added to the note. It may have become read-only.';
  }
}

export function InlineAiPanel({
  editor,
  controller,
}: {
  readonly editor: Editor;
  readonly controller: InlineAiController;
}): ReactNode {
  const { state } = controller;
  if (state.phase === 'idle') return null;
  return <OpenPanel editor={editor} controller={controller} state={state} />;
}

function OpenPanel({
  editor,
  controller,
  state,
}: {
  readonly editor: Editor;
  readonly controller: InlineAiController;
  readonly state: InlinePanelState;
}): ReactNode {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const panel = useRef<HTMLDivElement | null>(null);
  const output = useRef<HTMLDivElement | null>(null);
  const followOutput = useRef(true);
  const primary = useRef<HTMLButtonElement | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);
  const place = useRef<(() => void) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [languageChoice, setLanguageChoice] = useState('');

  const streaming = state.phase === 'streaming';
  const hasText = state.text !== '';
  // Something a stray click would lose: a result, a request in flight, or words already typed.
  const worthKeeping =
    hasText || streaming || (state.phase === 'composing' && state.instruction.trim() !== '');

  const { discard, stop, anchorRect } = controller;

  // Placed against the text in viewport coordinates and re-read whenever the text can move: a
  // scroll, a resize, the keyboard opening, an edit above it. The same geometry as the editor's
  // other floating menus, applied to the element directly so a streaming result growing does not
  // re-render the placement.
  useEffect(() => {
    const element = panel.current;
    if (element === null) return;
    let frame: number | null = null;

    function apply(): void {
      if (element === null) return;
      const wide =
        typeof matchMedia === 'function' ? matchMedia('(min-width: 640px)').matches : true;
      const bounds = readViewportBounds();
      if (!wide) {
        // Follow the visible viewport when the keyboard opens or the person zooms and pans.
        element.style.removeProperty('top');
        element.style.removeProperty('transform');
        element.style.removeProperty('max-height');
        element.style.setProperty('left', `${String(bounds.left + 8)}px`);
        element.style.setProperty('width', `${String(Math.max(0, bounds.width - 16))}px`);
        element.style.setProperty('--inline-ai-viewport-height', `${String(bounds.height)}px`);
        const bottom = bounds.height + bounds.top;
        element.style.setProperty(
          '--keyboard-inset',
          `${String(Math.max(0, window.innerHeight - bottom))}px`,
        );
        return;
      }
      const anchor = anchorRect();
      if (anchor === null) return;
      const placed = placeFloatingMenu(anchor, PANEL_WIDTH, bounds, {
        minHeight: Math.max(element.scrollHeight, element.getBoundingClientRect().height) + 8,
      });
      element.style.setProperty('left', `${String(placed.left)}px`);
      element.style.setProperty('width', `${String(placed.maxWidth)}px`);
      element.style.setProperty('max-height', `${String(Math.max(0, placed.maxHeight - 4))}px`);
      element.style.setProperty(
        'top',
        `${String(placed.above ? placed.top - 4 : placed.top + 4)}px`,
      );
      element.style.setProperty('transform', placed.above ? 'translateY(-100%)' : 'none');
    }

    function schedule(): void {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        apply();
      });
    }

    place.current = apply;
    apply();
    const viewport = window.visualViewport;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    editor.on('transaction', schedule);
    return () => {
      place.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      observer?.disconnect();
      editor.off('transaction', schedule);
    };
  }, [anchorRect, editor]);

  // The panel's size follows its content, and a taller one may need to flip to the other side.
  useEffect(() => {
    place.current?.();
  }, [state.phase, state.failure, hasText, confirming]);

  // The prompt opens on "Keep it", so a second stray dismissal cannot compound the first.
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (streaming) followOutput.current = true;
  }, [streaming]);

  // Follow new words until the person scrolls back to read an earlier part of the result.
  useEffect(() => {
    const element = output.current;
    if (streaming && element !== null && followOutput.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [state.text, streaming]);

  // Focus goes where the next decision is: the first control on opening, and the primary action
  // when a result lands - but only if focus was on the panel (the Stop button that just went away)
  // or nowhere, never pulled out of the note a person went back to reading.
  useEffect(() => {
    if (confirming) return;
    const element = panel.current;
    if (element === null) return;
    const active = document.activeElement;
    const lost = active === null || active === document.body || element.contains(active);
    if (!lost && state.phase !== 'choosing' && state.phase !== 'composing') return;
    const target =
      state.phase === 'done' || state.phase === 'error'
        ? (primary.current ?? element)
        : (element.querySelector<HTMLElement>('textarea, select, button') ?? element);
    target.focus();
  }, [state.phase, confirming]);

  // Escape works from the note as well as from the panel: the person may have gone back to the
  // text while a result streams, and the key should still be the way out.
  useEffect(() => {
    const dom = editor.view.dom;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (streaming) stop();
      else discard();
    }
    dom.addEventListener('keydown', onKeyDown, true);
    return () => {
      dom.removeEventListener('keydown', onKeyDown, true);
    };
  }, [discard, editor, stop, streaming]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node) || panel.current?.contains(target) === true) return;
      if (worthKeeping) setConfirming(true);
      else discard();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [discard, worthKeeping]);

  const kind = state.kind;
  const title =
    state.phase === 'choosing' || kind === null
      ? 'Write with AI'
      : (TITLES[kind] ?? 'Write with AI');
  const failure = state.failure;
  const settingsLink =
    failure === 'disabled' || failure === 'unavailable' ? (
      <Link to={`/w/${workspaceId ?? ''}/settings?tab=pets`} className={`underline ${focusRing}`}>
        <Text as="span" variant="note">
          Open pet settings
        </Text>
      </Link>
    ) : null;

  const replaceFirst = state.canReplace && state.hadSelection;
  const replaceLabel = state.hadSelection ? 'Replace selection' : 'Replace block';
  const finished = (state.phase === 'done' || state.phase === 'error') && hasText;

  function actions(): ReactNode {
    const retry =
      state.phase === 'done' || (failure !== null && RETRYABLE.has(failure)) ? (
        <Button
          variant="secondary"
          onClick={controller.retry}
          disabled={state.applying || state.kind === null}
        >
          Try again
        </Button>
      ) : null;
    const replace =
      finished && state.canReplace ? (
        <Button
          ref={replaceFirst ? primary : undefined}
          variant={replaceFirst ? 'primary' : 'secondary'}
          disabled={state.applying}
          onClick={() => {
            controller.accept('replace');
          }}
        >
          {replaceLabel}
        </Button>
      ) : null;
    const insert = finished ? (
      <Button
        ref={replaceFirst ? undefined : primary}
        variant={replaceFirst ? 'secondary' : 'primary'}
        disabled={state.applying}
        onClick={() => {
          controller.accept('insert');
        }}
      >
        Insert below
      </Button>
    ) : null;
    return (
      <div className="flex flex-wrap items-center gap-2 [&>button]:max-w-full [&>button]:whitespace-normal">
        {replaceFirst ? replace : insert}
        {replaceFirst ? insert : replace}
        {retry}
        <Button variant="ghost" onClick={controller.discard}>
          {finished ? 'Discard' : 'Close'}
        </Button>
      </div>
    );
  }

  return (
    // Escape is also heard on the panel itself, for the person whose focus is inside it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={panel}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (streaming) controller.stop();
        else controller.discard();
      }}
      className={[
        'fixed z-30 flex min-w-0 max-w-[calc(100vw-var(--spacing)*4)] flex-col gap-3 overflow-y-auto overscroll-contain rounded-md border border-divider bg-background p-3 shadow-md [&>*]:shrink-0',
        // A phone: the full width above the keyboard, as the mobile toolbar sits.
        // design-token-exempt: the keyboard inset is measured from the runtime visual viewport.
        'max-sm:bottom-[max(calc(var(--keyboard-inset,0%)+var(--spacing)*2),env(safe-area-inset-bottom))] max-sm:max-h-[calc(var(--inline-ai-viewport-height,100dvh)-var(--spacing)*4-env(safe-area-inset-bottom))] max-sm:max-w-none',
      ].join(' ')}
    >
      <Text variant="kicker" tone="muted">
        {title}
      </Text>

      {confirming ? (
        <div className="flex flex-col gap-2" role="group" aria-label="Discard this text?">
          <Text variant="bodySmall">Discard this text? It has not been added to your note.</Text>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              ref={keep}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep it
            </Button>
            <Button variant="secondary" onClick={controller.discard}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <>
          {state.phase === 'choosing' ? (
            <div role="group" aria-label="Writing commands" className="flex flex-col gap-1">
              {INLINE_AI_COMMANDS.map((command) => (
                <Button
                  key={command.id}
                  variant="ghost"
                  className="min-w-0 justify-start whitespace-normal text-left"
                  onClick={() => {
                    controller.start(command.kind);
                  }}
                >
                  {command.label}
                </Button>
              ))}
              <Button variant="ghost" onClick={controller.discard}>
                Close
              </Button>
            </div>
          ) : null}

          {state.phase === 'composing' && kind === 'custom' ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                controller.generate();
              }}
            >
              <Textarea
                autoGrow
                resize="none"
                className="max-h-40"
                aria-label="What should the AI write?"
                placeholder="What should it write or change?"
                maxLength={MAX_INSTRUCTION_CHARS}
                value={state.instruction}
                onChange={(event) => {
                  controller.setInstruction(event.target.value);
                }}
                onKeyDown={(event) => {
                  const touch =
                    typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches;
                  // Touch keyboards keep Enter for new lines; Ctrl/Cmd+Enter sends everywhere.
                  if (
                    event.key === 'Enter' &&
                    !event.nativeEvent.isComposing &&
                    (event.ctrlKey || event.metaKey || (!touch && !event.shiftKey))
                  ) {
                    event.preventDefault();
                    controller.generate();
                  }
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={state.instruction.trim() === ''}>
                  Generate
                </Button>
                <Button variant="ghost" onClick={controller.discard}>
                  Close
                </Button>
              </div>
            </form>
          ) : null}

          {state.phase === 'composing' && kind === 'translate' ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                controller.generate();
              }}
            >
              <Select
                aria-label="Translate into"
                value={languageChoice}
                onChange={(event) => {
                  const choice = event.target.value;
                  setLanguageChoice(choice);
                  controller.setLanguage(choice === 'other' ? '' : choice);
                }}
              >
                <option value="" disabled>
                  Choose a language
                </option>
                {LANGUAGES.map((language) => (
                  <option key={language} value={language}>
                    {language}
                  </option>
                ))}
                <option value="other">Other…</option>
              </Select>
              {languageChoice === 'other' ? (
                <Input
                  aria-label="Language"
                  placeholder="Language name"
                  maxLength={64}
                  value={state.language}
                  onChange={(event) => {
                    controller.setLanguage(event.target.value);
                  }}
                />
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={state.language.trim() === ''}>
                  Translate
                </Button>
                <Button variant="ghost" onClick={controller.discard}>
                  Close
                </Button>
              </div>
            </form>
          ) : null}

          {state.phase === 'streaming' || hasText ? (
            // The live region is the output itself, so a screen reader hears the text arrive.
            <div
              ref={output}
              role="region"
              aria-label="AI writing result"
              aria-live="polite"
              aria-busy={streaming}
              // Focusable so a keyboard user can scroll a long result with the arrow keys.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              onScroll={(event) => {
                const element = event.currentTarget;
                followOutput.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight <= 16;
              }}
              className={`min-w-0 max-h-48 overflow-y-auto overscroll-contain rounded-sm border border-divider p-2 ${focusRing}`}
            >
              <Text variant="bodySmall" className="whitespace-pre-wrap wrap-anywhere">
                {state.text === '' ? 'Writing…' : state.text}
              </Text>
            </div>
          ) : null}

          {streaming ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={controller.stop}>
                Stop
              </Button>
            </div>
          ) : null}

          {state.phase === 'done' && state.stopped ? (
            <Text variant="note" tone="muted" role="status">
              {hasText ? 'Stopped. What arrived is kept.' : 'Stopped before anything arrived.'}
            </Text>
          ) : null}

          {state.phase === 'error' && failure !== null ? (
            <div className="flex flex-col gap-1">
              <Text variant="note" role="alert">
                {failureMessage(failure, hasText)}
              </Text>
              {settingsLink}
            </div>
          ) : null}

          {state.phase === 'done' || state.phase === 'error' ? actions() : null}
        </>
      )}
    </div>
  );
}
