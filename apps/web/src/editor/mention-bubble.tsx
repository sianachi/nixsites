import { Button, placeFloatingMenu, readViewportBounds, Text } from '@nix/ui';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { LINK_MENTION_SHORTCUT } from '@nix/web-foundation/keyboard/shortcut-registry';
import { formatShortcut, isApplePlatform } from '@nix/web-foundation/lib/shortcuts';
import {
  activeMention,
  dismissMention,
  linkMention,
  type ActiveMention,
} from './unlinked-mentions';

/**
 * The offer an underlined mention makes: "Link to <title>", beside the phrase once the caret has
 * been moved into it.
 *
 * **Only when the caret was moved there.** Typing through or up to a title is writing, not asking:
 * a bubble that sprang up mid-sentence would cover the line being written. So it appears when the
 * caret arrives by a selection change alone - a click, an arrow key - and stays away after an
 * edit until the caret is moved again.
 *
 * **Reached three ways, none of them by focusing the underline.** Decorations cannot take focus,
 * and making the text itself a control would break typing through it. So: the pointer clicks into
 * the phrase and then this button; the keyboard presses Alt+Enter (Option+Return on a Mac) without
 * leaving the text; and Tab from the text reaches this button, because it is rendered after the
 * editor - the same arrangement as the formatting bubble.
 *
 * **Escape hides it for that mention**, and "Don't suggest this" stops the item being underlined in
 * this workspace on this browser (`dismissMention`).
 *
 * **Said once, not on every keystroke.** Entering a mention announces what it is and the shortcut
 * through the shared live region; moving within the same mention says nothing more.
 *
 * Shown only while the editor (or this bubble) has focus and the note can be edited.
 */

function sameMention(a: ActiveMention | null, b: ActiveMention | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.from === b.from &&
      a.to === b.to &&
      a.itemId === b.itemId &&
      a.title === b.title)
  );
}

function mentionKey(mention: ActiveMention): string {
  return `${String(mention.from)}:${String(mention.to)}:${mention.itemId}`;
}

/** The caret's box, or a zero box where there is no layout to measure (tests, a hidden pane). */
function caretBox(editor: Editor, pos: number): { left: number; top: number; bottom: number } {
  try {
    const coords = editor.view.coordsAtPos(pos);
    return { left: coords.left, top: coords.top, bottom: coords.bottom };
  } catch {
    return { left: 0, top: 0, bottom: 0 };
  }
}

/** The shortcut as it is spoken: words, not the glyphs a Mac keycap shows. */
function spokenShortcut(): string {
  return isApplePlatform() ? 'Option+Return' : 'Alt+Enter';
}

export interface MentionBubbleViewProps {
  readonly title: string;
  readonly position: { readonly left: number; readonly top: number; readonly maxWidth: number };
  /** Drawn above the caret rather than below it, where there is no room underneath. */
  readonly above: boolean;
  readonly onLink: () => void;
  readonly onDismiss: () => void;
  readonly onEscape?: () => void;
  readonly onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  readonly ref?: Ref<HTMLDivElement>;
}

/** The bubble itself, positioned by its caller. Separate so stories can show every state. */
export function MentionBubbleView({
  title,
  position,
  above,
  onLink,
  onDismiss,
  onEscape,
  onBlur,
  ref,
}: MentionBubbleViewProps): ReactNode {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onEscape?.();
    }
  }
  return (
    <div
      ref={ref}
      onBlur={onBlur}
      // Beside the phrase in viewport coordinates, like the pickers.
      style={position} // design-token-exempt: a caret's position is a runtime measurement, not a scale step.
      className={[
        'fixed z-20 flex items-center gap-2 rounded-md bg-surface p-1 shadow-md',
        above ? '-mb-1 -translate-y-full' : 'mt-1',
      ].join(' ')}
    >
      <Button
        variant="ghost"
        // Pressing must not move focus out of the note first: the link is inserted at the caret.
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onKeyDown={onKeyDown}
        onClick={onLink}
      >
        Link to {title}
      </Button>
      <Text as="span" variant="caption" tone="muted" aria-hidden="true">
        {formatShortcut(LINK_MENTION_SHORTCUT)}
      </Text>
      <Button
        variant="ghost"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onKeyDown={onKeyDown}
        onClick={onDismiss}
        aria-label={`Don’t suggest linking ${title}`}
      >
        Don’t suggest linking
      </Button>
    </div>
  );
}

export function MentionBubble({ editor }: { readonly editor: Editor }): ReactNode {
  const mention = useEditorState({
    editor,
    selector: ({ editor: current }) => activeMention(current.state),
    equalityFn: sameMention,
  });
  const [focused, setFocused] = useState(() => editor.isFocused);
  /** Whether the caret's last move was a selection change alone, not an edit. */
  const [navigated, setNavigated] = useState(false);
  /** The mention Escape hid, by position and item. */
  const [hidden, setHidden] = useState<string | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  /** Which mention the bubble is showing right now, for the Escape listener to compare against. */
  const shownKey = useRef<string | null>(null);

  useEffect(() => {
    function onFocus(): void {
      setFocused(true);
    }
    function onBlur({ event }: { event: globalThis.FocusEvent }): void {
      const next = event.relatedTarget;
      // Tabbing from the text to this bubble keeps it open; anywhere else closes it.
      if (!(next instanceof Node && bubble.current?.contains(next) === true)) {
        setFocused(false);
      }
    }
    function onTransaction({
      transaction,
    }: {
      transaction: { docChanged: boolean; selectionSet: boolean };
    }): void {
      if (transaction.docChanged) {
        setNavigated(false);
      } else if (transaction.selectionSet) {
        setNavigated(true);
      }
    }
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      const current = activeMention(editor.state);
      if (current === null) return;
      const key = mentionKey(current);
      // While the bubble is up, Escape is its answer and nothing else's: a dialog or panel behind
      // the note must not close on the same keypress. When it is not shown, Escape passes through.
      if (shownKey.current === key) event.stopPropagation();
      setHidden(key);
    }
    const dom = editor.view.dom;
    editor.on('focus', onFocus);
    editor.on('blur', onBlur);
    editor.on('transaction', onTransaction);
    // Capture, so Escape is seen even when an inner handler (a phrase suggestion) consumes it.
    dom.addEventListener('keydown', onKeyDown, true);
    return () => {
      editor.off('focus', onFocus);
      editor.off('blur', onBlur);
      editor.off('transaction', onTransaction);
      dom.removeEventListener('keydown', onKeyDown, true);
    };
  }, [editor]);

  const shown =
    mention !== null && navigated && focused && editor.isEditable && hidden !== mentionKey(mention);

  useEffect(() => {
    shownKey.current = shown ? mentionKey(mention) : null;
  });
  const announcement = shown
    ? `${mention.title} names an item this note does not link to yet. Press ${spokenShortcut()} to link it.`
    : null;

  useEffect(() => {
    if (announcement !== null) {
      announce(announcement);
    }
  }, [announcement]);

  if (!shown) {
    return null;
  }

  function onBubbleBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    if (!(
      next instanceof Node &&
      (event.currentTarget.contains(next) || editor.view.dom.contains(next))
    )) {
      setFocused(false);
    }
  }

  const placement = placeFloatingMenu(caretBox(editor, mention.to), 360, readViewportBounds());

  return (
    <MentionBubbleView
      ref={bubble}
      title={mention.title}
      position={{ left: placement.left, top: placement.top, maxWidth: placement.maxWidth }}
      above={placement.above}
      onBlur={onBubbleBlur}
      onLink={() => {
        linkMention(editor, mention);
      }}
      onDismiss={() => {
        dismissMention(editor, mention);
        editor.commands.focus();
      }}
      onEscape={() => {
        setHidden(mentionKey(mention));
        editor.commands.focus();
      }}
    />
  );
}
