import type { Editor } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../../api/api-client-provider';
import { announce } from '@nix/web-foundation/a11y/announcer';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import {
  anchorRange,
  applyInlineResult,
  type ApplyMode,
  type RangeAnchor,
} from './inline-ai-apply';
import { contextFor, gatherMaterial, type InlineMaterial } from './inline-ai-material';
import {
  InlineAiError,
  MAX_INSTRUCTION_CHARS,
  utf8Length,
  streamInline,
  type InlineKind,
} from './inline-ai-stream';
import { useInlineAiAvailable } from './use-inline-ai-available';

/**
 * The inline writing panel's state machine.
 *
 * `idle` (nothing open) -> `choosing` (the selection menu's list) or `composing` (a command that
 * needs the person's words or a language) -> `streaming` -> `done`, or `error` from the last two.
 * Nothing here writes to the note until `accept` is called: a result is the panel's to show and the
 * person's to take.
 *
 * One request at a time per editor. Starting anything aborts the one in flight - the abort is what
 * reaches the server as a cancel - and a late event from an aborted request is ignored by run
 * number rather than trusted to arrive in order.
 */

export type InlinePhase = 'idle' | 'choosing' | 'composing' | 'streaming' | 'done' | 'error';

/** Why the panel is showing a failure, in the panel's own vocabulary rather than the wire's. */
export type InlineFailure =
  | 'empty'
  | 'selection_too_long'
  | 'disabled'
  | 'locked'
  | 'unavailable'
  | 'busy'
  | 'timeout'
  | 'too_long'
  | 'refused'
  | 'provider_failed'
  | 'offline'
  | 'interrupted'
  | 'not_found'
  | 'invalid'
  | 'not_added';

export interface InlinePanelState {
  readonly phase: InlinePhase;
  readonly kind: InlineKind | null;
  readonly instruction: string;
  readonly language: string;
  /** What has arrived. Plain Markdown, shown as text until it is accepted. */
  readonly text: string;
  /** The person stopped it; what arrived is kept. */
  readonly stopped: boolean;
  readonly failure: InlineFailure | null;
  /** Whether Replace is offered: there was a span to replace. */
  readonly canReplace: boolean;
  /** Whether the person had text selected, which makes Replace the primary action. */
  readonly hadSelection: boolean;
  /** A write to the note is in progress. */
  readonly applying: boolean;
}

const IDLE: InlinePanelState = {
  phase: 'idle',
  kind: null,
  instruction: '',
  language: '',
  text: '',
  stopped: false,
  failure: null,
  canReplace: false,
  hadSelection: false,
  applying: false,
};

const FAILURE_BY_CODE: Readonly<Record<string, InlineFailure>> = {
  'pets.inline_disabled': 'disabled',
  'pets.inline_item_locked': 'locked',
  'pets.unavailable': 'unavailable',
  'pets.inline_busy': 'busy',
  'pets.not_found': 'not_found',
  'pets.invalid_request': 'invalid',
  'inline.timeout': 'timeout',
  'inline.too_long': 'too_long',
  'inline.refused': 'refused',
  'inline.provider_failed': 'provider_failed',
  'inline.offline': 'offline',
  'inline.interrupted': 'interrupted',
};

/** Failures where asking again can plausibly work. */
export const RETRYABLE: ReadonlySet<InlineFailure> = new Set([
  'busy',
  'timeout',
  'provider_failed',
  'offline',
  'interrupted',
]);

interface Session {
  readonly kind: InlineKind;
  readonly material: InlineMaterial;
  readonly anchor: RangeAnchor;
}

export interface InlineAiController {
  readonly state: InlinePanelState;
  /** Whether the entry points are on offer at all: pets enabled and inline writing switched on. */
  readonly available: boolean;
  /** `null` opens the list of commands; a kind runs or composes that command. */
  readonly start: (kind: InlineKind | null) => void;
  readonly setInstruction: (value: string) => void;
  readonly setLanguage: (value: string) => void;
  /** Sends the request for the open command with what has been entered. */
  readonly generate: () => void;
  readonly stop: () => void;
  readonly retry: () => void;
  readonly accept: (mode: ApplyMode) => void;
  /** Throws the panel and its text away and returns focus to the note. */
  readonly discard: () => void;
  /** The text the panel is anchored to, in viewport coordinates; null when it cannot be read. */
  readonly anchorRect: () => { left: number; top: number; bottom: number } | null;
}

export function useInlineAi({
  editor,
  itemId,
  workspaceId,
}: {
  readonly editor: Editor;
  readonly itemId: string;
  readonly workspaceId: string | undefined;
}): InlineAiController {
  const client = useApiClient();
  const available = useInlineAiAvailable() && workspaceId !== undefined;
  const [state, setState] = useState<InlinePanelState>(IDLE);

  const session = useRef<Session | null>(null);
  const abort = useRef<AbortController | null>(null);
  // Incremented by every request and every teardown; a callback that finds it moved is stale.
  const run = useRef(0);
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });

  const teardown = useCallback(() => {
    run.current += 1;
    abort.current?.abort();
    abort.current = null;
    session.current?.anchor.dispose();
    session.current = null;
  }, []);

  // A panel never outlives its editor: leaving the note cancels the request.
  useEffect(() => teardown, [teardown]);

  const generate = useCallback(() => {
    const current = session.current;
    const panel = latest.current;
    if (current === null || workspaceId === undefined || panel.kind === null) return;

    const instruction = panel.instruction.trim();
    const language = panel.language.trim();
    if (
      current.kind === 'custom' &&
      (instruction === '' || utf8Length(instruction) > MAX_INSTRUCTION_CHARS)
    ) {
      return;
    }
    if (current.kind === 'translate' && language === '') return;

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    run.current += 1;
    const mine = run.current;
    const stale = (): boolean => mine !== run.current;

    setState((previous) => ({
      ...previous,
      phase: 'streaming',
      text: '',
      stopped: false,
      failure: null,
    }));

    streamInline(
      client,
      {
        workspaceId,
        itemId,
        requestId: crypto.randomUUID(),
        kind: current.kind,
        ...(current.kind === 'custom' ? { instruction } : {}),
        selection: current.material.text,
        context: contextFor(editor),
        ...(current.kind === 'translate' ? { language } : {}),
      },
      {
        signal: controller.signal,
        onDelta: (piece) => {
          if (stale()) return;
          setState((previous) => ({ ...previous, text: previous.text + piece }));
        },
      },
    ).then(
      ({ text }) => {
        if (stale()) return;
        setState((previous) => ({ ...previous, phase: 'done', text }));
        announce('Result ready.');
      },
      (cause: unknown) => {
        if (stale()) return;
        // The person's own Stop: what arrived stands.
        if (controller.signal.aborted) return;
        const code = cause instanceof InlineAiError ? cause.code : 'inline.provider_failed';
        // The server's own cancel is a stop too, not a failure.
        if (code === 'inline.cancelled') {
          setState((previous) => ({ ...previous, phase: 'done', stopped: true }));
          return;
        }
        const failure = FAILURE_BY_CODE[code] ?? 'provider_failed';
        setState((previous) => ({
          ...previous,
          phase: 'error',
          failure,
          // A refusal's text is the refusal, not something to keep; a broken or over-long stream
          // keeps what arrived, so it can still be accepted.
          text: failure === 'refused' ? '' : previous.text,
        }));
      },
    );
  }, [client, editor, itemId, workspaceId]);

  const start = useCallback(
    (kind: InlineKind | null) => {
      if (!available || editor.isDestroyed || !editor.isEditable) return;
      teardown();

      if (kind === null) {
        setState({ ...IDLE, phase: 'choosing' });
        return;
      }

      const material = gatherMaterial(editor, kind);
      const from = material.range?.from ?? material.end;
      const to = material.range?.to ?? material.end;
      session.current = { kind, material, anchor: anchorRange(editor, from, to) };
      const base: InlinePanelState = {
        ...IDLE,
        kind,
        canReplace: material.range !== null,
        hadSelection: material.hadSelection,
      };

      if (material.problem !== null) {
        setState({
          ...base,
          phase: 'error',
          failure: material.problem === 'empty' ? 'empty' : 'selection_too_long',
        });
        return;
      }
      if (kind === 'custom' || kind === 'translate') {
        setState({ ...base, phase: 'composing' });
        return;
      }
      setState({ ...base, phase: 'composing' });
      // Run from the state just set, which the effect above has not yet published to `latest`.
      latest.current = { ...base, phase: 'composing' };
      generate();
    },
    [available, editor, generate, teardown],
  );

  const stop = useCallback(() => {
    if (latest.current.phase !== 'streaming') return;
    run.current += 1;
    abort.current?.abort();
    abort.current = null;
    setState((previous) => ({ ...previous, phase: 'done', stopped: true }));
  }, []);

  const discard = useCallback(() => {
    teardown();
    setState(IDLE);
    if (!editor.isDestroyed) editor.commands.focus();
  }, [editor, teardown]);

  const accept = useCallback(
    (mode: ApplyMode) => {
      const current = session.current;
      const panel = latest.current;
      if (current === null || panel.applying || panel.text === '') return;
      setState((previous) => ({ ...previous, applying: true }));

      void applyInlineResult(
        editor,
        panel.text,
        {
          anchor: current.anchor,
          replace:
            current.material.range === null ? null : { rangeText: current.material.rangeText },
          end: current.material.end,
        },
        mode,
      ).then((outcome) => {
        if (session.current !== current) return;
        if (outcome.kind === 'failed') {
          setState((previous) => ({
            ...previous,
            applying: false,
            phase: 'error',
            failure: 'not_added',
          }));
          return;
        }
        if (outcome.kind === 'inserted' && outcome.fellBack) {
          publishNotice({
            key: 'inline-ai-fallback',
            message: 'The note changed around that text, so the result was inserted below it.',
          });
        }
        teardown();
        setState(IDLE);
        if (!editor.isDestroyed) editor.commands.focus();
      });
    },
    [editor, teardown],
  );

  const anchorRect = useCallback((): { left: number; top: number; bottom: number } | null => {
    if (editor.isDestroyed) return null;
    const size = editor.state.doc.content.size;
    const span = session.current?.anchor.resolve() ?? {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    try {
      const start = editor.view.coordsAtPos(Math.min(span.from, size));
      const end = editor.view.coordsAtPos(Math.min(span.to, size));
      return { left: start.left, top: start.top, bottom: end.bottom };
    } catch {
      // A position the view cannot draw (mid-update): the panel keeps where it was.
      return null;
    }
  }, [editor]);

  return {
    state,
    available,
    start,
    setInstruction: (value) => {
      setState((previous) => ({ ...previous, instruction: value }));
    },
    setLanguage: (value) => {
      setState((previous) => ({ ...previous, language: value }));
    },
    generate,
    stop,
    retry: generate,
    accept,
    discard,
    anchorRect,
  };
}
