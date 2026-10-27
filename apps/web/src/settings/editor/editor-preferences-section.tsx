import { useGhostTextPreference } from '../../editor/ghost-text-preference';
import { useMentionPreference } from '../../editor/mention-preference';
import { useMobileToolbarPreference } from '../../editor/mobile-toolbar-preference';
import { usePageGuidePreference } from '../../editor/page-guide-preference';
import { Button, Field, Select, Text } from '@nix/ui';
import { useState, type ChangeEvent, type ReactElement, type ReactNode } from 'react';

import { announce } from '../../a11y/announcer';
import { PreferenceToggle } from '../shared/preference-toggle';
import { SettingsSection } from '../shared/settings-section';
import { KeyboardModeSchema, useKeyboardModeStore } from '../../editor/keyboard-mode-store';
import { LINK_MENTION_SHORTCUT } from '../../keyboard/shortcut-registry';
import { formatShortcut } from '../../lib/shortcuts';
import { clearSuggestionDismissals } from '../../lib/suggestion-dismissals';
import { useChoiceOrderPreference, useViewSuggestionPreference } from './suggestion-preferences';

const modeHint = {
  standard: 'The editor and platform shortcuts shown throughout Nix',
  vim: 'Modal editing with Normal, Insert and Visual modes',
  emacs: 'Emacs chords to move, kill and yank',
} as const;

/** Full key reference, kept behind "More" so the field itself stays one line. */
const modeGuidance = {
  vim: 'Normal, Insert, Visual (v) and Visual Line (V) modes; each paragraph, heading or list item is a line, and an empty one is a blank line. Motions: h/l by character, j/k by line, w/b/e by word, 0/^/$ within the line, f/t/F/T to a character with ; and , to repeat, {/} by paragraph, gg/G across the document, all with counts. Operators d, c and y take a motion, a text object (iw/aw, quotes, brackets, ip/ap) or double for whole lines (dd, cc, yy); > and < indent list items; x, X, D, C, s, S and Y are shorthands; r replaces, ~ toggles case and J joins lines; p/P paste; o/O open a line; i/a/I/A enter Insert; . repeats the last change; u and Ctrl+R undo and redo your own edits. Search with / and ? (JavaScript patterns, case-insensitive unless the pattern has a capital) and n/N. Marks m and ` or \'; registers "a-"z, "0, "_ and "+ for the clipboard; macros q and @. Commands :<line>, :s and :%s (and over Visual lines), :undo and :redo; notes save as you type, so :w only says so. Not included: Visual Block, uppercase marks, appending to a register, p over a Visual selection, * and #, search highlighting and other : commands.',
  emacs:
    'Ctrl+F/B and Alt+F/B move by character and word; Ctrl+A/E to the start or end of the paragraph and Alt+M to its indentation; Ctrl+N/P by displayed line; Alt+{ and Alt+} by paragraph; Alt+< and Alt+> to either end of the note. Ctrl+Space sets the mark, Ctrl+U Ctrl+Space returns to earlier marks, Ctrl+X Ctrl+X swaps caret and mark, Ctrl+X H marks the whole note and Ctrl+G quits. Ctrl+D deletes a character; Ctrl+K, Alt+D, Alt+Backspace, Ctrl+W and Alt+Z kill, Alt+W copies, and Ctrl+Y and Alt+Y yank from the kill ring. Alt+U/L/C change the case of a word and Ctrl+X Ctrl+U/L of the region; Ctrl+T and Alt+T transpose; Alt+\\ and Alt+Space close up blanks; Ctrl+O opens a line and Alt+^ joins one. Ctrl+U and Alt+<digits> give a numeric argument, and Ctrl+X Z repeats the last command. Ctrl+S and Ctrl+R search as you type, Alt+% replaces with a question at each match, and Alt+G G goes to a line. Ctrl+X R S/I copy to and insert from a register, Ctrl+X R Space/J save and return to a place; Ctrl+X ( and ) record a keyboard macro and Ctrl+X E (or F3 and F4) runs it. Ctrl+/ undoes and Ctrl+? redoes your own edits; notes save as you type, so Ctrl+X Ctrl+S only says so. These chords replace the editor and browser shortcuts they share a key with, such as save, reload and find; on Windows and Linux the browser keeps Ctrl+N, Ctrl+T and Ctrl+W. Not included: Alt+X commands, rectangles, regular-expression search and replace, and windows or buffers.',
} as const;

export function EditorPreferencesSection(): ReactElement {
  const toolbarVisibility = useMobileToolbarPreference((state) => state.visibility);
  const toolbarSaved = useMobileToolbarPreference((state) => state.saved);
  const setToolbarVisibility = useMobileToolbarPreference((state) => state.setVisibility);
  const pageGuideVisibility = usePageGuidePreference((state) => state.visibility);
  const pageGuideSaved = usePageGuidePreference((state) => state.saved);
  const setPageGuideVisibility = usePageGuidePreference((state) => state.setVisibility);
  const phraseSetting = useGhostTextPreference((state) => state.setting);
  const phraseSaved = useGhostTextPreference((state) => state.saved);
  const setPhraseSetting = useGhostTextPreference((state) => state.setSetting);
  const mentionSetting = useMentionPreference((state) => state.setting);
  const mentionSaved = useMentionPreference((state) => state.saved);
  const setMentionSetting = useMentionPreference((state) => state.setSetting);
  const viewSetting = useViewSuggestionPreference((state) => state.setting);
  const viewSaved = useViewSuggestionPreference((state) => state.saved);
  const setViewSetting = useViewSuggestionPreference((state) => state.setSetting);
  const choiceSetting = useChoiceOrderPreference((state) => state.setting);
  const choiceSaved = useChoiceOrderPreference((state) => state.saved);
  const setChoiceSetting = useChoiceOrderPreference((state) => state.setSetting);
  const mode = useKeyboardModeStore((state) => state.mode);
  const persistence = useKeyboardModeStore((state) => state.persistence);
  const keyboardModeSelected = useKeyboardModeStore((state) => state.keyboardModeSelected);

  function onModeChange(event: ChangeEvent<HTMLSelectElement>): void {
    const parsed = KeyboardModeSchema.safeParse(event.currentTarget.value);
    if (!parsed.success) {
      console.warn('Ignoring an unrecognised editor keyboard mode selection.');
      return;
    }
    keyboardModeSelected(parsed.data);
  }

  return (
    <SettingsSection title="Editor" summary="How writing in a note behaves for you">
      <Text
        variant="note"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={persistence === 'stored' ? 'sr-only' : ''}
      >
        {persistence === 'session-only'
          ? mode === 'standard'
            ? 'Browser storage is unavailable. Standard remains the default; another choice may reset when this page reloads.'
            : `Browser storage is unavailable. ${mode === 'vim' ? 'Vim basics' : 'Emacs basics'} may reset when this page reloads.`
          : ''}
      </Text>

      <Field label="Keyboard mode" hint={modeHint[mode]} className="max-w-lg">
        {(control) => (
          <Select {...control} value={mode} onChange={onModeChange}>
            <option value="standard">Standard</option>
            <option value="vim">Vim basics</option>
            <option value="emacs">Emacs basics</option>
          </Select>
        )}
      </Field>
      {mode === 'standard' ? null : <More about="keyboard mode">{modeGuidance[mode]}</More>}
      <Text variant="h5" as="h3">
        Writing aids
      </Text>
      <PreferenceToggle
        label="Show page guides"
        checked={pageGuideVisibility === 'shown'}
        onChange={(checked) => {
          setPageGuideVisibility(checked ? 'shown' : 'hidden');
        }}
        description="Marks where PDF and Word exports start a new page"
        unsaved={
          pageGuideSaved
            ? null
            : 'The page guide preference applies to this session; browser storage is unavailable.'
        }
        more={
          <>
            The position is an estimate from the A4 export’s margins and type size; the exact break
            can move by a line.
          </>
        }
      />
      <PreferenceToggle
        label="Suggest phrase completions"
        checked={phraseSetting === 'on'}
        onChange={(checked) => {
          setPhraseSetting(checked ? 'on' : 'off');
        }}
        description="Shows a faded ending when you pause; needs a keyboard"
        unsaved={
          phraseSaved
            ? null
            : 'The phrase suggestion preference applies to this session; browser storage is unavailable.'
        }
        more={
          <>
            After a pause at the end of a line, press Right Arrow to accept the faded text or Escape
            to dismiss it; it is not part of the note until you accept it. Needs a keyboard. Learned
            on this device, in memory only, from notes in the same workspace that this browser
            already keeps.
          </>
        }
      />
      <PreferenceToggle
        label="Underline item names that are not linked"
        checked={mentionSetting === 'on'}
        onChange={(checked) => {
          setMentionSetting(checked ? 'on' : 'off');
        }}
        description="Dotted underline on workspace item titles that have no link"
        unsaved={
          mentionSaved
            ? null
            : 'The underline preference applies to this session; browser storage is unavailable.'
        }
        more={
          <>
            Put the caret in one and press {formatShortcut(LINK_MENTION_SHORTCUT)}, or choose Link
            to, to turn it into a link. Nothing changes in the note until you do.
          </>
        }
      />
      <Text variant="h5" as="h3">
        Suggestions
      </Text>
      <PreferenceToggle
        label="Suggestions in views"
        checked={viewSetting === 'on'}
        onChange={(checked) => {
          setViewSetting(checked ? 'on' : 'off');
        }}
        description="Hints that views offer on their own"
        unsaved={
          viewSaved
            ? null
            : 'The view suggestion preference applies to this session; browser storage is unavailable.'
        }
        more={
          <>
            Likely values when you create an item, a note on cards that have not moved in a while,
            the spreadsheet’s fill-series offer, a free time when rescheduling, and a form field’s
            usual value. Nothing is written until you choose one.
          </>
        }
      />
      <PreferenceToggle
        label="Order choices by what I pick most"
        checked={choiceSetting === 'on'}
        onChange={(checked) => {
          setChoiceSetting(checked ? 'on' : 'off');
        }}
        description="Lists your usual picks first in menus and selects"
        unsaved={
          choiceSaved
            ? null
            : 'The choice order preference applies to this session; browser storage is unavailable.'
        }
        more={
          <>
            Remembers what you pick on this device: a select property offers your usual values again
            in a Recent group above its options, and the slash menu and link picker list what you
            use most first. Off, nothing new is remembered and nothing is reordered by what you have
            picked.
          </>
        }
      />
      <ClearDismissedSuggestions />
      <Text variant="h5" as="h3">
        This device
      </Text>
      <PreferenceToggle
        label="Hide mobile tools while writing"
        deviceOnly
        checked={toolbarVisibility === 'while-writing'}
        onChange={(checked) => {
          setToolbarVisibility(checked ? 'while-writing' : 'always');
        }}
        description="On a phone, formatting tools collapse while you type"
        unsaved={
          toolbarSaved
            ? null
            : 'The mobile toolbar preference applies to this session; browser storage is unavailable.'
        }
      />
    </SettingsSection>
  );
}

/** A native disclosure for the detail behind a row's one-line hint. */
function More(props: { readonly about: string; readonly children: ReactNode }): ReactElement {
  return (
    <details>
      <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
        More<span className="sr-only"> about {props.about}</span>
      </summary>
      <Text variant="note" tone="muted">
        {props.children}
      </Text>
    </details>
  );
}

/**
 * Brings back every suggestion waved away on this browser - mentions marked "Don't suggest this",
 * dismissed stale-card notes - which is what the dismissal announcement points to.
 */
const CLEARED = 'Dismissed suggestions cleared.';

function ClearDismissedSuggestions(): ReactElement {
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        onClick={() => {
          const message = clearSuggestionDismissals()
            ? CLEARED
            : 'Browser storage could not clear dismissed suggestions. Try again.';
          setResult(message);
          announce(message);
        }}
      >
        Clear dismissed suggestions
      </Button>
      {result !== null ? (
        <Text as="p" variant="note" tone="muted">
          {result}
        </Text>
      ) : null}
    </div>
  );
}
