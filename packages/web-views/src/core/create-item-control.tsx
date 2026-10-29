import { Icon, Input, Text } from '@nix/ui';
import { Plus } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';

import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import type { CreateSuggestSource } from '../suggest/suggest-source';
import type { PropertyValue } from '@nix/web-collections/core/container-model';

/**
 * Loaded on first use, not with the view: the classifier and the similarity search are only worth
 * their bytes once somebody opens a create field, and most visits to a view never do.
 */
const CreateSuggestions = lazy(() => import('../suggest/create-suggestions'));

/**
 * Making a child from inside a view.
 *
 * One control, three placements: under a list, at the foot of a board column, inside a day on a
 * calendar. Each supplies the property that puts the new item where it was asked for, so creating
 * something *in* a column is one gesture rather than a create followed by a drag followed by an
 * edit.
 *
 * **It is a button and a field, and nothing else.** No landmark, no region, no status. The three
 * view suites assert exact role inventories - the board compares the full list of regions, the list
 * compares its row headers and expects a single cell, the calendar expects one status and one alert
 * - so an affordance that introduced any of those would break assertions that are about the view
 * rather than about this. The only role it adds is a button, and an alert when a write is refused.
 *
 * **Closed until asked for.** A text field in every column and every day would be forty input
 * fields on a month, all reachable by tab, none of them wanted. The button opens one.
 *
 * **Suggestions, when the view supplies something to learn from.** Given `suggest`, the open field
 * offers likely property values for the title being typed and says when a similar item already
 * exists (`suggest/create-suggestions.tsx`), unless "Suggestions in views" is switched off. Those
 * lines add buttons and one `sr-only` polite count, never a landmark, region or status, so the
 * inventory promise above still holds. Until the suggestion code has loaded nothing is drawn in
 * their place: they are an aid, and the field works without them. An accepted value
 * rides along with the create's own properties; nothing is written for a suggestion nobody took.
 */

export interface CreateItemControlProps {
  /**
   * What the control says, and what a screen reader hears.
   *
   * Named after where the item lands - "Add an item to Doing" - because a bare "Add" repeated
   * thirty-one times down a calendar cannot be told apart by anybody navigating by name.
   */
  readonly label: string;

  /** Values the new item is created with, putting it where the control implies. */
  readonly properties?: Record<string, unknown>;

  /** Creates the item. Returns the reason it was refused, or null when it was made. */
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;

  /** Layout only. Not a way to restyle the control. */
  readonly className?: string;

  /** Renders as an icon-only button, for somewhere too tight for a word. */
  readonly compact?: boolean;

  /**
   * What the view knows that lets the field suggest property values and spot a duplicate. Absent,
   * the control is exactly the plain button and field it always was.
   */
  readonly suggest?: CreateSuggestSource;
}

export function CreateItemControl(props: CreateItemControlProps): ReactNode {
  const { label, properties, onCreate, className, compact = false, suggest } = props;

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const viewSuggestions = useViewSuggestionPreference((state) => state.setting);

  // Values the person took from a suggestion for the item about to be made. Local to the open field
  // and gone with it: a suggestion accepted for one title is not a decision about the next one.
  const [accepted, setAccepted] = useState<Readonly<Record<string, PropertyValue>>>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(false);

  // Focus goes back to what opened the field, and it has to wait: the button does not exist while
  // the field is open, so focusing it inside the handler would find nothing. This runs after the
  // render that puts it back.
  useEffect(() => {
    if (!open && returnFocus.current) {
      returnFocus.current = false;
      buttonRef.current?.focus();
      return;
    }

    // Focused here rather than with `autoFocus`, which the accessibility rules forbid and are
    // right to: a field that seizes focus when a page loads takes it from somebody who was going
    // somewhere else. This one appears because it was asked for, and leaving focus behind would
    // mean opening it and then having to find it.
    if (open) {
      fieldRef.current?.focus();
    }
  }, [open]);

  function close(): void {
    returnFocus.current = true;
    setOpen(false);
    setTitle('');
    setRefusal(null);
    setAccepted({});
  }

  async function submit(event: { preventDefault: () => void }): Promise<void> {
    event.preventDefault();

    const named = title.trim();
    if (named.length === 0) {
      return;
    }

    setSaving(true);
    setRefusal(null);

    // The placement's own values win over an accepted suggestion for the same key, which cannot
    // happen in practice - suggestions skip every key the placement sets - but is stated so the
    // column a card was created in can never be overruled by a guess.
    const reason = await onCreate(
      named,
      Object.keys(accepted).length === 0 ? properties : { ...accepted, ...properties },
    );

    setSaving(false);

    if (reason !== null) {
      // Kept open with the text still in it. Closing on a refusal would throw away what somebody
      // typed and leave them to work out what happened from an empty screen.
      setRefusal(reason);
      return;
    }

    // Emptied but left open, because the reason to add one thing is usually to add another.
    setTitle('');
    setAccepted({});
  }

  if (!open) {
    return (
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        onClick={() => {
          setOpen(true);
        }}
        className={[
          // relative + before: the drawn chip is ~22px tall (text-xs at py-1), under WCAG 2.5.8's
          // 24px floor; the pseudo-element widens the hit target past it without changing what is
          // drawn, the same technique as @nix/ui's PaneDivider and the calendar's all-day chips.
          'relative before:absolute before:-inset-y-0.5 before:inset-x-0',
          'flex min-w-0 max-w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs text-muted',
          'hover:bg-foreground/7 hover:text-foreground',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          className ?? '',
        ].join(' ')}
      >
        <Icon icon={Plus} size="sm" className="shrink-0" />
        {compact ? null : <span className="min-w-0 wrap-anywhere">{label}</span>}
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className={['flex flex-col gap-1 px-1 py-1', className ?? ''].join(' ')}
    >
      <Input
        ref={fieldRef}
        aria-label={label}
        placeholder="Name it"
        value={title}
        disabled={saving}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        onKeyDown={(event) => {
          // Escape leaves without creating anything, which is what somebody who opened this by
          // accident reaches for first.
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
        onBlur={() => {
          // Nothing typed and focus gone means it was opened by mistake. Something typed stays put,
          // because closing over an unsaved name is how work disappears.
          if (title.trim().length === 0 && refusal === null) {
            setOpen(false);
          }
        }}
        className="text-sm"
      />

      {suggest === undefined || viewSuggestions === 'off' ? null : (
        <Suspense fallback={null}>
          <CreateSuggestions
            title={title}
            source={suggest}
            fixed={properties}
            accepted={accepted}
            onAccept={(key, value) => {
              setAccepted((current) => ({ ...current, [key]: value }));
            }}
            onUndo={(key) => {
              setAccepted((current) =>
                Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key)),
              );
            }}
            returnFocus={() => {
              fieldRef.current?.focus();
            }}
          />
        </Suspense>
      )}

      {refusal === null ? null : (
        <Text variant="caption" as="p" role="alert" className="px-1">
          {refusal}
        </Text>
      )}
    </form>
  );
}
