import { Button, Checkbox, Field, Input, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PropertyInput, isKnownPropertyType } from '@nix/web-collections/properties/property-input';
import { resolveConfiguredColumns } from '@nix/web-collections/core/columns';
import { isComputedType } from '@nix/web-collections/core/property-types';
import {
  type EffectiveSchema,
  type PropertyDefinition,
  type PropertyValue,
  type View,
} from '@nix/web-collections/core/container-model';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { resolveLoadState } from '../core/view-chrome';
import type { ViewRendererProps } from '../core/view-kinds';
import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { rememberSubmission, usualValues, type UsualValue } from './form-memory';
import { MemberNames } from '../suggest/member-name';
import { valueText } from '../suggest/value-text';
import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { UsualValueHint, UsualValuesSummary } from './usual-value-hint';
import { FormResults } from './form-results';
import { reportFormValidity } from './form-validity';

/**
 * The form view: schema inputs and formula results, with a choice to save each entry.
 *
 * The intake shape - a daily tracker whose entries are rows, an inventory log fed line by line.
 * Nothing here is new machinery: the fields are `PropertyInput`, the same control the property
 * panel and the list's cells draw, and saving uses the ordinary create every view offers. What
 * the kind adds is the arrangement - entry first, entries elsewhere - switchable beside the list
 * the submissions land in. ADR-0040 records the two decisions this kind rests on: a write surface
 * offered on the view axis, and required-ness as this form's own promise.
 *
 * **This view does not render children, so it takes only `resolveLoadState` from the chrome.**
 * The chrome's empty, filtered and truncated branches are statements about children this view
 * does not draw - an empty container is exactly what a fresh tracker looks like, and the form is
 * how it stops being empty. Loading and error still hold, from the shared module so they cannot
 * drift.
 *
 * **Required-ness is enforced here, and only here.** On create the server deliberately owes no
 * required value - `PropertyValidator.ValidateSupplied`'s own remark: a required property is a
 * statement about a finished item, not about a first keystroke - and ADR-0016 records the
 * consequence that nothing tells anyone an item is incomplete. This form is the first surface
 * that partially closes that gap, as its own submit-time promise rather than a relay of a server
 * rule; the other create paths (the list's quick add, a board's column create) still owe nothing.
 *
 * **Usual values are offered, not filled.** After each successful submit the choice fields' values
 * are remembered for this form in this browser (`form-memory.ts` says why that is the only
 * honest record of "this person's" submissions), and an empty choice field then shows "Your usual:
 * ..." with a button. The field stays empty until that button is pressed.
 */

export function FormView(props: ViewRendererProps): ReactNode {
  const { container, view } = props;

  // Once the container has been ready, a reload must not tear the form down: `create` reloads the
  // children on success, which flips `status` through 'loading' - and unmounting `EntryForm` then
  // would destroy the draft state mid-submit, so the success sentence, the cleared fields and the
  // returned focus would all act on a component that no longer exists. The loading panel is for
  // the first arrival only; after that, the form's own "Adding" line is the latency signal.
  const [hasBeenReady, setHasBeenReady] = useState(false);
  if (!hasBeenReady && container.status === 'ready') {
    setHasBeenReady(true);
  }

  const loadState = resolveLoadState(container, 'this form');
  if (loadState !== null && !(hasBeenReady && container.status === 'loading')) {
    return loadState;
  }

  return <EntryForm container={container} view={view} />;
}

/** How the fields resolve: the shared column rule, with this view's answer for the gaps. */
function resolveFields(
  view: View,
  schema: EffectiveSchema | null,
): { offered: readonly PropertyDefinition[]; unavailable: readonly string[] } {
  const { keys, definitions } = resolveConfiguredColumns(view, schema);

  const offered: PropertyDefinition[] = [];
  const unavailable: string[] = [];

  for (const key of keys) {
    const definition = definitions.get(key);

    // A configured field the schema does not describe, or whose type this build has no control
    // for, cannot be offered as an input - there is nothing to type into. Named rather than
    // silently dropped, so a renamed property is a stated gap instead of a field that vanished.
    if (definition === undefined || !isKnownPropertyType(definition.type)) {
      unavailable.push(key);
      continue;
    }

    // A computed property is skipped rather than named as unavailable, and the difference is the
    // sentence a person reads. "Unavailable" is for a field that was meant to be an input and is
    // not one - a renamed property, a type this build cannot draw. A formula is working exactly as
    // declared and simply is not an input: a form writes children, and nothing writes a computed
    // value. Listing it would report a fault that does not exist.
    if (isComputedType(definition.type)) {
      continue;
    }

    offered.push(definition);
  }

  return { offered, unavailable };
}

function EntryForm({
  container,
  view,
}: {
  readonly container: ContainerData;
  readonly view: View;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [bag, setBag] = useState<Record<string, PropertyValue>>({});
  const [saveChoice, setSaveChoice] = useState<boolean | null>(null);
  const saveResponse = saveChoice ?? view.mode !== 'temporary';
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /** The one sentence about the last submit: saved, blocked by required fields, or refused. */
  const [outcome, setOutcome] = useState<{
    kind: 'saved' | 'temporary' | 'blocked' | 'refused';
    text: string;
  } | null>(null);

  const [sending, setSending] = useState(false);

  /**
   * Counts successful submissions, and does two jobs: as a `key` on the fields it remounts every
   * control clean after a success - a draft a field held but never committed (an unparseable
   * number, a half-typed date) would otherwise survive under the "added" message, looking stored
   * when it was not - and it leaves the required check honest about what was actually sent.
   */
  const [submissions, setSubmissions] = useState(0);

  /** Bumped on a blocked submit, so the focus effect runs again even when the text is identical. */
  const [blockedAt, setBlockedAt] = useState(0);

  const titleRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);

  const { offered, unavailable } = resolveFields(view, container.schema);

  // The remembered habits, read once when the form mounts and again after each submission that
  // added to them - not per keystroke, since they cannot change in between. Without a workspace
  // (nothing to scope the memory to) there are none.
  const workspace = useOptionalWorkspace();
  const viewSuggestions = useViewSuggestionPreference((state) => state.setting);
  // The member list is read once for the whole form, and only when a field holds a person.
  const canName =
    useOptionalApiClient() !== null &&
    workspace !== null &&
    offered.some((definition) => definition.type === 'assignee');
  const [usual, setUsual] = useState<ReadonlyMap<string, UsualValue>>(() =>
    workspace === null || !saveResponse
      ? new Map()
      : usualValues(workspace.workspaceId, view.id, offered),
  );

  // Each field's wrapper, so a usual value that is used can hand focus to the control it filled -
  // the hint's button unmounts the moment it is pressed (WCAG 2.4.3).
  const fieldBoxes = useRef(new Map<string, HTMLDivElement>());
  function focusField(key: string | undefined): void {
    if (key === undefined) {
      return;
    }
    fieldBoxes.current
      .get(key)
      ?.querySelector<HTMLElement>('select, input, textarea, button')
      ?.focus();
  }

  function pendingHabit(key: string): UsualValue | undefined {
    return saveResponse && bag[key] === undefined && viewSuggestions === 'on'
      ? usual.get(key)
      : undefined;
  }

  // Three or more waiting values become one summary line rather than a hint under every field.
  const pending = offered.flatMap((definition) => {
    const habit = pendingHabit(definition.key);
    return habit === undefined ? [] : [{ definition, habit }];
  });
  const summarise = pending.length >= 3;

  // A blocked submit whose sentence has not changed re-renders nothing, so a live region says
  // nothing the second time - focus is the feedback that works on every attempt, and it also
  // answers "which field" in a way the summary sentence deliberately does not.
  useEffect(() => {
    if (blockedAt === 0) {
      return;
    }
    const invalid = fieldsRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    invalid?.focus();
  }, [blockedAt]);

  // Focus returns to the title after the fields have remounted, not before: the success path
  // remounts them (the `submissions` key) to shed uncommitted drafts, so a focus call made inside
  // submit() would land on an input that is about to be unmounted and follow it to the body.
  useEffect(() => {
    if (submissions > 0) {
      titleRef.current?.focus();
    }
  }, [submissions]);

  function setValue(key: string, value: PropertyValue): void {
    setBag((current) => {
      if (value === null) {
        // Absent, not null: the create sends this bag verbatim, and an explicit null is a clear
        // instruction the merge contract acts on - meaningless for an item that does not exist.
        return Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key));
      }
      return { ...current, [key]: value };
    });
    setFieldErrors((current) =>
      key in current
        ? Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key))
        : current,
    );
  }

  async function submit(): Promise<void> {
    if (sending) {
      return;
    }
    if (!reportFormValidity(formRef.current)) return;

    // The form's own required check - see the header for whose rule this is and is not.
    const blockers: Record<string, string> = {};

    if (saveResponse && title.trim().length === 0) {
      blockers.title = 'An entry needs a title.';
    }

    for (const definition of offered) {
      // A checkbox is exempt from the check because unanswered and unchecked are indistinguishable
      // in the control; the bag is completed below instead, so what is sent still carries a value.
      if (!definition.required || definition.type === 'checkbox') {
        continue;
      }
      if (bag[definition.key] === undefined) {
        blockers[definition.key] = saveResponse
          ? 'Required before the entry is added.'
          : 'Required before calculating.';
      }
    }

    if (Object.keys(blockers).length > 0) {
      setFieldErrors(blockers);
      const count = Object.keys(blockers).length;
      setOutcome({
        kind: 'blocked',
        text: !saveResponse
          ? 'Some required inputs are still empty.'
          : count === 1
            ? 'The entry was not added: one field still needs a value.'
            : `The entry was not added: ${String(count)} fields still need values.`,
      });
      setBlockedAt((current) => current + 1);
      return;
    }

    // An untouched checkbox never commits, so its key is absent - but unchecked is a value, not
    // an absence ("true or false, never null" is the control's own contract), so the sent bag
    // says `false` explicitly rather than shipping the incomplete item this form promises not to.
    const sent: Record<string, PropertyValue> = { ...bag };
    for (const definition of offered) {
      if (definition.type === 'checkbox' && sent[definition.key] === undefined) {
        sent[definition.key] = false;
      }
    }

    setFieldErrors({});
    if (!saveResponse) {
      setBag(sent);
      setOutcome({ kind: 'temporary', text: 'Calculated here. No entry was saved.' });
      return;
    }
    setOutcome(null);
    setSending(true);

    try {
      const refusal = await container.create(title.trim(), sent);

      if (refusal !== null) {
        setOutcome({ kind: 'refused', text: refusal });
        return;
      }

      // A clean slate for the next entry, with focus back at the top (via the effect above): the
      // whole point of the shape is the second submission.
      if (workspace !== null) {
        rememberSubmission(workspace.workspaceId, view.id, offered, sent);
        setUsual(usualValues(workspace.workspaceId, view.id, offered));
      }
      setTitle('');
      setBag({});
      setSubmissions((current) => current + 1);
      setOutcome({ kind: 'saved', text: 'Entry added.' });
    } catch {
      setOutcome({
        kind: 'refused',
        text: 'The entry could not be sent. Check the connection and try again.',
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      ref={formRef}
      aria-label={view.name}
      className="flex min-w-0 w-full max-w-xl flex-col gap-4"
      // The form owns its validation - the per-field sentences below - and the design language
      // never shows browser default bubbles. Without this the controls' own `required` attributes
      // would block submission before the handler could say anything.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Checkbox
          label="Save this entry"
          checked={saveResponse}
          disabled={sending}
          onChange={(event) => {
            setSaveChoice(event.target.checked);
            setOutcome(null);
            setFieldErrors({});
          }}
        />
        <Text variant="note" tone="muted" className="wrap-anywhere">
          {saveResponse
            ? 'Adds a child entry to this note.'
            : 'Answers stay in this view. Uploads and history are off.'}
        </Text>
      </div>
      <div ref={fieldsRef} key={submissions} className="flex flex-col gap-4">
        {saveResponse ? (
          <Field label="Title" required error={fieldErrors.title ?? null}>
            {(control) => (
              <Input
                {...control}
                ref={titleRef}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  // Cleared on the keystroke that answers it, the same trigger `setValue` uses for
                  // every other field - one rule, not two.
                  setFieldErrors((current) =>
                    'title' in current
                      ? Object.fromEntries(
                          Object.entries(current).filter(([key]) => key !== 'title'),
                        )
                      : current,
                  );
                }}
              />
            )}
          </Field>
        ) : null}

        {summarise ? (
          <UsualValuesSummary
            fieldLabels={pending.map(({ definition }) => definition.label)}
            onUseAll={() => {
              for (const { definition, habit } of pending) {
                setValue(definition.key, habit.stored);
              }
              // The summary goes as soon as it is used; focus moves to the first field it filled.
              focusField(pending[0]?.definition.key);
            }}
          />
        ) : null}

        <MemberNames enabled={canName}>
          {(memberName) =>
            offered.map((definition) => {
              const habit = summarise ? undefined : pendingHabit(definition.key);
              return (
                <div
                  key={definition.key}
                  ref={(node) => {
                    if (node === null) {
                      fieldBoxes.current.delete(definition.key);
                    } else {
                      fieldBoxes.current.set(definition.key, node);
                    }
                  }}
                  className="flex flex-col gap-1"
                >
                  <PropertyInput
                    item={{ title, properties: bag, parentId: container.itemId }}
                    property={definition}
                    density="panel"
                    error={fieldErrors[definition.key] ?? null}
                    allowInputStorage={saveResponse}
                    onCommit={(value) => {
                      setValue(definition.key, value);
                    }}
                  />
                  {habit === undefined ? null : (
                    <UsualValueHint
                      fieldLabel={definition.label}
                      valueText={valueText(definition, habit.key, memberName)}
                      value={valueText(definition, habit.key, memberName)}
                      onUse={() => {
                        setValue(definition.key, habit.stored);
                        // The hint unmounts with its button; focus goes to the field it just filled.
                        focusField(definition.key);
                      }}
                    />
                  )}
                </div>
              );
            })
          }
        </MemberNames>
      </div>

      <FormResults properties={container.schema?.properties ?? []} values={bag} />

      {offered.length === 0 ? (
        <Text tone="muted">
          {saveResponse
            ? 'This one has no properties yet, so entries carry only a title. Add properties under Properties to build the form out.'
            : 'This form has no editable properties. Add properties under Properties to supply inputs.'}
        </Text>
      ) : null}

      {unavailable.length > 0 ? (
        <Text variant="note" tone="muted">
          {unavailable.length === 1
            ? `The configured field "${unavailable[0] ?? ''}" cannot be offered as an input here.`
            : `Some configured fields cannot be offered as inputs here: ${unavailable.join(', ')}.`}
        </Text>
      ) : null}

      {/* aria-disabled rather than disabled: disabling the focused element throws focus to the
          body, and each outcome decides where focus goes instead. The double-submit guard is the
          early return in submit(). */}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" aria-disabled={sending}>
          {saveResponse ? 'Add entry' : 'Calculate'}
        </Button>
        {!saveResponse ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setBag({});
              setTitle('');
              setFieldErrors({});
              setOutcome(null);
              setSubmissions((current) => current + 1);
            }}
          >
            Clear inputs
          </Button>
        ) : null}
      </div>

      {/* Two always-mounted regions, so an announcement fires the moment a sentence appears. The
          alert interrupts and is reserved for a refusal; saved, blocked and in-flight inform via
          status - the blocked summary informs rather than interrupts because focus (above) is
          what carries the interruption to the field itself. Not one region with a switched role,
          which assistive technology would not re-announce. */}
      <div
        className={
          outcome?.kind === 'refused' || outcome?.kind === 'blocked'
            ? 'rounded-md border border-divider p-3'
            : undefined
        }
      >
        <Text variant="bodySmall" role="alert" as="p">
          {outcome?.kind === 'refused' ? outcome.text : null}
        </Text>
        <Text variant="bodySmall" role="status" as="p">
          {sending ? 'Adding the entry.' : outcome?.kind === 'refused' ? null : outcome?.text}
        </Text>
      </div>
    </form>
  );
}
