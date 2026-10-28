import { Button, Dialog, Listbox, Text, Textarea, useListbox } from '@nix/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type * as Y from 'yjs';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { useNoteLinkSearch } from './markdown-link-search';
import {
  applyMarkdown,
  insertNoteLink,
  snapshotMarkdown,
  watchRemoteChanges,
  type MarkdownSnapshot,
} from './markdown-mode';
import { findTrigger } from './reference-menu';

export interface MarkdownModePanelProps {
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  /** Taken when the person asked for the mode, so the dialog and the textarea agree on the text. */
  readonly snapshot: MarkdownSnapshot;
  readonly onClose: () => void;
}

/**
 * The textarea a note is edited as Markdown in, with the two honesty devices the mode needs: a
 * banner when a colleague changes the note underneath, and a report when the text cannot be read
 * back. Nothing is written until Apply; closing discards the text, and the banner says so.
 *
 * shortcut: a plain textarea with no highlighting; upgrade to a code editor if people ask.
 */
export function MarkdownModePanel({
  doc,
  fragment,
  snapshot,
  onClose,
}: MarkdownModePanelProps): ReactNode {
  const [text, setText] = useState(snapshot.markdown);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Where the caret is; null while a range is selected, which never opens the picker.
  const [caret, setCaret] = useState<number | null>(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  // `[[query` before the caret opens the note-link picker; `@` (people) is not offered here.
  const found = caret === null ? null : findTrigger(text.slice(0, caret));
  const itemTrigger = found?.kind === 'item' ? found : null;
  const trigger = itemTrigger !== null && itemTrigger.start !== dismissed ? itemTrigger : null;
  // Escape dismisses one trigger, not the feature: once it is gone, typing `[[` again reopens.
  if (itemTrigger === null && dismissed !== null) setDismissed(null);

  const { options, emptyMessage } = useNoteLinkSearch(trigger?.query ?? null);
  const listbox = useListbox(options, (option) => {
    if (trigger === null || caret === null) return;
    const next = insertNoteLink(text, caret, trigger.start, {
      id: option.id,
      title: option.label,
    });
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  });

  useEffect(
    () =>
      watchRemoteChanges(fragment, () => {
        setRemoteChanged(true);
      }),
    [fragment],
  );

  function apply(): void {
    const outcome = applyMarkdown(doc, fragment, text, snapshot.markdown);
    if (outcome.kind === 'invalid') {
      setError(outcome.reason);
      return;
    }
    announce(outcome.kind === 'applied' ? 'Markdown applied to the note.' : 'No changes to apply.');
    onClose();
  }

  return (
    <section aria-label="Markdown editing" className="flex min-h-0 flex-1 flex-col gap-3">
      {remoteChanged ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-divider bg-surface px-3 py-2"
        >
          <Text variant="note">
            Someone changed this note while you were editing its Markdown. Applying will replace
            their change with your text.
          </Text>
          <Button
            variant="secondary"
            onClick={() => {
              setText(snapshotMarkdown(fragment).markdown);
              setRemoteChanged(false);
            }}
          >
            Reload their text
          </Button>
        </div>
      ) : null}
      <Text as="p" id={hintId} variant="caption" tone="muted">
        Nothing is saved until you apply. Closing without applying discards this text.
      </Text>
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <Textarea
          ref={textareaRef}
          aria-label="Note as Markdown"
          aria-describedby={hintId}
          aria-controls={trigger === null ? undefined : listbox.id}
          aria-activedescendant={trigger === null ? undefined : listbox.activeOptionId}
          value={text}
          spellCheck={false}
          rows={24}
          resize="vertical"
          className="min-h-0 flex-1 font-mono text-sm"
          onChange={(event) => {
            setText(event.currentTarget.value);
            setCaret(event.currentTarget.selectionStart);
            setError(null);
          }}
          onSelect={(event) => {
            const { selectionStart, selectionEnd } = event.currentTarget;
            // A range selection is not a caret, so it never opens the picker.
            setCaret(selectionStart === selectionEnd ? selectionStart : null);
          }}
          onBlur={() => {
            if (trigger !== null) setDismissed(trigger.start);
          }}
          onKeyDown={(event) => {
            if (trigger !== null) {
              // The innermost open layer takes Escape, so it does not also close the dialog behind.
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setDismissed(trigger.start);
                return;
              }
              listbox.onKeyDown(event);
              if (event.defaultPrevented) return;
            }
            // Tab indents inside the text, the way a Markdown editor is expected to behave.
            if (event.key === 'Tab' && !event.shiftKey) {
              event.preventDefault();
              const target = event.currentTarget;
              const { selectionStart, selectionEnd } = target;
              const next = `${text.slice(0, selectionStart)}  ${text.slice(selectionEnd)}`;
              setText(next);
              requestAnimationFrame(() => {
                target.setSelectionRange(selectionStart + 2, selectionStart + 2);
              });
            }
          }}
        />
        {trigger === null ? null : (
          // shortcut: the list sits under the textarea, not at the caret (textareas have no caret rect); upgrade if users find it far from the cursor
          <div className="flex max-h-64 shrink-0 flex-col overflow-y-auto border border-divider bg-background">
            <Listbox
              label="Items to link to"
              options={options}
              controller={listbox}
              emptyMessage={emptyMessage}
            />
          </div>
        )}
      </div>
      {error === null ? null : (
        <Text as="p" variant="note" role="alert">
          {error}
        </Text>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            if (remoteChanged && text !== snapshot.markdown) setConfirmOverwrite(true);
            else apply();
          }}
        >
          Apply Markdown
        </Button>
      </div>
      {confirmOverwrite ? (
        <Dialog
          open
          title="Replace their change?"
          onClose={() => {
            setConfirmOverwrite(false);
          }}
          actions={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirmOverwrite(false);
                }}
              >
                Keep editing
              </Button>
              <Button
                onClick={() => {
                  setConfirmOverwrite(false);
                  apply();
                }}
              >
                Replace and apply
              </Button>
            </>
          }
        >
          <Text as="p">
            Your Markdown will replace the note as it is now, including what someone else changed
            while you were editing. They can undo their own edits; you can undo this one.
          </Text>
        </Dialog>
      ) : null}
    </section>
  );
}

/** The dialog shown before entering when Markdown cannot carry everything in the note. */
export function MarkdownLossesDialog({
  snapshot,
  onContinue,
  onCancel,
}: {
  readonly snapshot: MarkdownSnapshot;
  readonly onContinue: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <Dialog
      open
      title="Some formatting will not survive"
      onClose={onCancel}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onContinue}>Continue anyway</Button>
        </>
      }
    >
      <Text as="p">
        Markdown cannot carry everything in this note. If you apply the Markdown afterwards, the
        following is dropped or simplified. Cancel keeps the note exactly as it is.
      </Text>
      <ul className="list-disc pl-5">
        {snapshot.losses.map((loss) => (
          <li key={loss.kind}>
            <Text as="span" variant="bodySmall">
              {loss.detail}
            </Text>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
