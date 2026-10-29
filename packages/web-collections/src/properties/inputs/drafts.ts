import { useState } from 'react';

import { type PropertyValue } from '../../core/container-model';

interface Draft {
  /** What is on screen, which is what somebody is part-way through typing. */
  readonly draft: string;
  readonly setDraft: (text: string) => void;

  /** The text this field is known to have handed over, or the text it was given. */
  readonly sent: string;

  /** Hands a value over and remembers the text it was, so the same edit is never written twice. */
  readonly send: (text: string, value: PropertyValue) => void;
}

/**
 * A field's draft, and the value it last handed over.
 *
 * An unsent edit survives a refreshed stored value. The refreshed value becomes the baseline for
 * committing or cancelling the edit; a field with no unsent changes follows the stored value.
 */
export function useDraft(stored: string, onCommit: (value: PropertyValue) => void): Draft {
  const [draft, setDraft] = useState(stored);
  const [sent, setSent] = useState(stored);
  const [seen, setSeen] = useState(stored);

  if (stored !== seen) {
    setSeen(stored);
    if (draft === sent) setDraft(stored);
    setSent(stored);
  }

  return {
    draft,
    setDraft,
    sent,
    send: (text, value) => {
      setSent(text);
      onCommit(value);
    },
  };
}

interface MultiSelectDraft {
  /** What is checked on screen, which is every choice made so far, sent or not. */
  readonly selection: readonly string[];

  /** Applies one checkbox's change to the selection and sends the whole thing. */
  readonly toggle: (option: string, checked: boolean) => void;
}

/** Whether two option lists hold the same entries, order aside. */
function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/**
 * A multi-select's draft: every box checked so far, kept apart from what the item last reported.
 *
 * **The bug this replaces.** Each checkbox used to build its next list from the item's own value -
 * "as last saved" - rather than from what was on screen. Two taps close together both read that
 * same stale value before either write returned, so the second tap's request carried only its own
 * box and silently dropped the first. Keeping the selection here, updated the instant a box is
 * tapped, means the second tap builds on the first's choice rather than on the server's last
 * answer - the same fix `useDraft` above makes for typed fields, for the same shape of race.
 *
 * **Sends one write per tap rather than debouncing**, each carrying the whole selection as it
 * stands at that moment. However the two responses land, the last request sent is the one with
 * every choice, so the item ends up holding what is on screen rather than whichever tap's request
 * happened to answer last.
 */
export function useMultiSelectDraft(
  stored: readonly string[],
  onCommit: (value: PropertyValue) => void,
): MultiSelectDraft {
  const [selection, setSelection] = useState<readonly string[]>(stored);
  const [seen, setSeen] = useState<readonly string[]>(stored);

  if (!sameOptions(stored, seen)) {
    setSeen(stored);
    setSelection(stored);
  }

  return {
    selection,
    toggle: (option, checked) => {
      const next = checked ? [...selection, option] : selection.filter((value) => value !== option);
      setSelection(next);

      // An empty list clears the property rather than storing an empty array: "nothing selected"
      // and "no value" are the same fact, and the contract already has a way to say it.
      onCommit(next.length === 0 ? null : next);
    },
  };
}

/** A complete calendar date, which is the only thing worth sending. */
export const COMPLETE_DATE = /^\d{4}-\d{2}-\d{2}$/;
