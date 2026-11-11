import { X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Button } from './Button';
import { Icon } from '../primitives/Icon';
import { Text } from '../primitives/Text';

/**
 * Undo history shared by every screen. An action calls `push(label, undo)` the moment it happens;
 * `undo` must reverse only that action from the *current* state (re-read it, do not restore a
 * snapshot), so later edits survive - the contract `useUndoRemove` already follows. Several steps
 * deep (newest first); Ctrl/Cmd+Z undoes the latest unless focus is in a text field.
 * Without a provider (a unit test, a story) `push` is a no-op.
 */
export interface UndoApi {
  /** Record an action just taken. `label` is past tense and names the thing: "Removed Q3 roadmap". */
  readonly push: (label: string, undo: () => void | Promise<void>) => void;
  /** Undo the newest entry; resolves once it has run. Nothing happens when history is empty. */
  readonly undoLatest: () => Promise<void>;
  /** Steps available. */
  readonly depth: number;
}

interface Entry {
  readonly id: number;
  readonly label: string;
  readonly undo: () => void | Promise<void>;
}

interface UndoState {
  readonly api: UndoApi;
  /** What the bar says: the newest action, or "Undid ..." right after an undo. */
  readonly message: { readonly id: number; readonly text: string } | null;
}

const MAX_DEPTH = 20;
const idle: UndoState = {
  api: { push: () => undefined, undoLatest: () => Promise.resolve(), depth: 0 },
  message: null,
};
const UndoContext = createContext<UndoState>(idle);

function inTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function UndoProvider({ children }: { readonly children: ReactNode }): ReactNode {
  // The ref is the source of truth (callbacks and the key handler read it); `depth` mirrors it.
  const entriesRef = useRef<readonly Entry[]>([]);
  const [depth, setDepth] = useState(0);
  const [message, setMessage] = useState<UndoState['message']>(null);
  const counter = useRef(0);

  const push = useCallback((label: string, undo: Entry['undo']) => {
    const id = ++counter.current;
    entriesRef.current = [{ id, label, undo }, ...entriesRef.current].slice(0, MAX_DEPTH);
    setDepth(entriesRef.current.length);
    setMessage({ id, text: label });
  }, []);

  const undoLatest = useCallback(async () => {
    const [latest] = entriesRef.current;
    if (latest === undefined) {
      return;
    }
    // Pop first so a repeat press (or a throwing undo) cannot run the same entry twice.
    entriesRef.current = entriesRef.current.slice(1);
    setDepth(entriesRef.current.length);
    setMessage({ id: ++counter.current, text: `Undid: ${latest.label}` });
    await latest.undo();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (
        event.key.toLowerCase() === 'z' &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.defaultPrevented &&
        !inTextField(event.target) &&
        entriesRef.current.length > 0
      ) {
        event.preventDefault();
        void undoLatest();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [undoLatest]);

  const value = useMemo<UndoState>(
    () => ({ api: { push, undoLatest, depth }, message }),
    [push, undoLatest, depth, message],
  );
  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

export function useUndo(): UndoApi {
  return useContext(UndoContext).api;
}

/** How long the undo bar stays; shared with `useUndoRemove`'s notice so both feel the same. */
export const UNDO_VISIBLE_MS = 5000;

/**
 * The visible face of the history: a polite `role="status"` notice saying what happened, with an
 * Undo button and a Dismiss button. It goes away on its own after a few seconds, unless a mouse is
 * over it or the keyboard is on it; the history stays, so Ctrl/Cmd+Z keeps working and the next action or undo
 * brings the bar back. Mount once, inside the fixed toast stack (`ShellToasts`), so it sits with
 * the other notices and above the mobile nav.
 */
export function UndoBar(): ReactNode {
  const { api, message } = useContext(UndoContext);
  const [expiredId, setExpiredId] = useState<number | undefined>(undefined);
  const barRef = useRef<HTMLDivElement>(null);
  const mouseOverRef = useRef(false);
  const messageId = message?.id;

  useEffect(() => {
    if (messageId === undefined) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    function expire(): void {
      // Asked at expiry rather than tracked: focus left by a mouse click or a touch must not hold it.
      if (mouseOverRef.current || barRef.current?.querySelector(':focus-visible')) {
        timer = setTimeout(expire, UNDO_VISIBLE_MS);
        return;
      }
      setExpiredId(messageId);
    }
    timer = setTimeout(expire, UNDO_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [messageId]);

  // The live region stays mounted so a later message is announced rather than appearing with it.
  return (
    <div role="status" className="contents">
      {message === null || expiredId === message.id ? null : (
        <div
          ref={barRef}
          data-enter=""
          onPointerEnter={(event) => {
            // Touch has no hover: a tap would otherwise count as a mouse that never left.
            mouseOverRef.current = event.pointerType === 'mouse';
          }}
          onPointerLeave={() => {
            mouseOverRef.current = false;
          }}
          className="flex items-center gap-3 rounded-md border border-divider bg-background px-3 py-1 shadow-md"
        >
          <Text variant="bodySmall" as="p" className="min-w-0 flex-1">
            {message.text}
          </Text>
          {api.depth === 0 ? null : (
            <Button
              variant="ghost"
              onClick={() => {
                void api.undoLatest();
              }}
            >
              {api.depth > 1 ? `Undo (${String(api.depth)})` : 'Undo'}
            </Button>
          )}
          <Button
            variant="icon"
            aria-label="Dismiss"
            onClick={() => {
              setExpiredId(message.id);
            }}
          >
            <Icon icon={X} size="sm" />
          </Button>
        </div>
      )}
    </div>
  );
}
