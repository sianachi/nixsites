import { Input } from '@nix/ui';
import { useId, useState, type ReactNode } from 'react';

import { readPropertyText } from '../../core/container-model';

import { type PropertyInputProps } from './types';
import { ValueShell } from './shell';
import { useDraft } from './drafts';

type TypedKind = 'text' | 'url' | 'number';

export function TypedValue(
  props: PropertyInputProps & {
    readonly kind: TypedKind;
    readonly suggestions?: readonly string[];
    /** Guidance shown under the field while it is focused. */
    readonly hint?: string;
  },
): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel', kind } = props;

  const suggestionsId = useId();
  const stored = readPropertyText(item, property.key);
  const { draft, setDraft, sent, send } = useDraft(stored, onCommit);

  // A `type=number` box reports '' for text it cannot parse ("3e"), which would read as a
  // deliberate clear and null the stored value. The browser's own badInput flag tells them apart.
  const [invalid, setInvalid] = useState<string | null>(null);

  function commit(input: HTMLInputElement): void {
    if (kind === 'number' && input.validity.badInput) {
      setInvalid('Enter a number.');
      return;
    }

    // Past the badInput check the box holds something readable (or nothing), so the old complaint is stale.
    setInvalid(null);

    // A blur that changed nothing is not an edit. Without this, tabbing through the panel would
    // write every property on the way past, and Enter followed by Tab would write twice.
    if (draft === sent) {
      return;
    }

    if (kind === 'number') {
      const trimmed = draft.trim();

      if (trimmed.length === 0) {
        send(draft, null);
        return;
      }

      const parsed = Number(trimmed);

      // Nothing storable. Left on screen to be corrected rather than silently cleared: the person
      // typed something, and turning it into null would discard it without saying so.
      if (!Number.isFinite(parsed)) {
        return;
      }

      send(draft, parsed);
      return;
    }

    send(draft, draft.length === 0 ? null : draft);
  }

  return (
    <ValueShell
      {...props}
      error={props.error ?? invalid}
      {...(props.hint === undefined ? {} : { hint: props.hint })}
    >
      {(control) => (
        <>
          <Input
            {...control}
            tabIndex={props.tabIndex}
            type={kind}
            inputMode={kind === 'number' ? 'decimal' : undefined}
            list={props.suggestions === undefined ? undefined : suggestionsId}
            tone={density === 'cell' ? 'plain' : 'default'}
            value={draft}
            required={property.required}
            disabled={disabled}
            onChange={(event) => {
              setInvalid(null);
              setDraft(event.target.value);
            }}
            onBlur={(event) => {
              commit(event.currentTarget);
            }}
            onKeyDown={(event) => {
              // Escape puts back what was last handed over, as the long-text field does, so the
              // blur that follows has nothing to write.
              if (event.key === 'Escape') {
                setInvalid(null);
                setDraft(sent);
                // An unparseable number leaves the draft at '' so React sees no change; reset the box itself.
                event.currentTarget.value = sent;
              }

              // Enter is the explicit action for somebody who types and does not move on.
              if (event.key === 'Enter') {
                event.preventDefault();
                commit(event.currentTarget);
              }
            }}
          />
          {props.suggestions === undefined ? null : (
            <datalist id={suggestionsId}>
              {props.suggestions.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          )}
        </>
      )}
    </ValueShell>
  );
}
