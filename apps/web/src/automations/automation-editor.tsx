import { KNOWN_ITEM_TYPES, type PropertyDefinition } from '@nix/api-client';
import { Button, Checkbox, Field, Input, Select, Text, Textarea } from '@nix/ui';
import { useId, useRef, type ReactNode } from 'react';

import {
  MAX_ACTIONS,
  MAX_CONDITIONS,
  WEEKDAYS,
  emptyAction,
  emptyCondition,
  emptyValue,
  valueTypeFor,
  type ActionDraft,
  type AutomationDraft,
  type ConditionDraft,
  type DraftErrors,
  type MatchDraft,
  type TriggerKind,
  type ValueDraft,
} from './automation-draft';

/**
 * The form for one automation rule: its trigger, up to five conditions and one to five actions.
 *
 * **Controlled, not self-contained.** The page owns the draft, because the page is what knows the
 * scope's schema, the saved revision and the server's refusals; this component draws them and
 * reports each edit. That is also what lets a story render any state without a server.
 *
 * **Only what Core runs today.** `create_from_template` is refused by Core until its worker lane
 * ships (ADR-0051 Amendment 4), so it is not offered here - not even as a disabled "coming soon",
 * which would be an option nobody can choose.
 */

export interface ItemPickerProps {
  readonly label: string;
  readonly hint?: string;
  readonly value: string | null;
  readonly onChange: (itemId: string | null) => void;
}

export interface AutomationEditorProps {
  readonly draft: AutomationDraft;
  readonly onChange: (next: AutomationDraft) => void;
  /** Field path (Core's spelling) to the reason, from local checks and the server alike. */
  readonly errors: DraftErrors;
  /** The scope's properties, or null when there is no scope or its schema could not be read. */
  readonly properties: readonly PropertyDefinition[] | null;
  readonly propertiesLoading?: boolean;
  /** Draws an item chooser: the real one searches the workspace, a story passes a stand-in. */
  readonly renderItemPicker: (props: ItemPickerProps) => ReactNode;
  readonly busy: boolean;
  readonly submitLabel: string;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

const TRIGGER_OPTIONS: readonly { readonly value: TriggerKind; readonly label: string }[] = [
  { value: 'schedule', label: 'On a schedule' },
  { value: 'date_arrives', label: 'When a date arrives' },
  { value: 'property_changed', label: 'When a property changes' },
];

const ACTION_OPTIONS: readonly { readonly value: ActionDraft['kind']; readonly label: string }[] = [
  { value: 'notify', label: 'Send me a notification' },
  { value: 'set_property', label: 'Set a property' },
  { value: 'create_item', label: 'Create an item' },
];

const DATE_TYPES = new Set(['date', 'due_date', 'start_date', 'timestamp', 'datetime', 'reminder']);

const TEMPLATE_HINT =
  'Use {date} for the date it runs and {item.title} for the title of the item that set it off.';

function withIndex<T>(list: readonly T[], index: number, next: T): readonly T[] {
  return list.map((entry, position) => (position === index ? next : entry));
}

function withoutIndex<T>(list: readonly T[], index: number): readonly T[] {
  return list.filter((_, position) => position !== index);
}

export function AutomationEditor(props: AutomationEditorProps): ReactNode {
  const { draft, onChange, errors, busy, submitLabel, onSubmit, onCancel } = props;
  const isSchedule = draft.triggerKind === 'schedule';

  return (
    <form
      noValidate
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">About this automation</legend>
        <Field label="Name" error={errors.name ?? null} className="max-w-xl">
          {(control) => (
            <Input
              {...control}
              value={draft.name}
              maxLength={200}
              onChange={(event) => {
                onChange({ ...draft, name: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Checkbox
          label="Turned on"
          checked={draft.enabled}
          onChange={(event) => {
            onChange({ ...draft, enabled: event.currentTarget.checked });
          }}
        />
        <div className="max-w-xl">
          {props.renderItemPicker({
            label: 'Scope',
            hint: 'The item whose contents this automation watches and may add to. Leave it empty to use the whole workspace.',
            value: draft.scopeItemId,
            onChange: (scopeItemId) => {
              onChange({ ...draft, scopeItemId });
            },
          })}
          {errors.scopeItemId === undefined ? null : (
            <Text variant="note" role="alert">
              {errors.scopeItemId}
            </Text>
          )}
        </div>
      </fieldset>

      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
        <legend>
          <Text as="span" variant="h6">
            When
          </Text>
        </legend>
        <Field label="Trigger" className="max-w-sm">
          {(control) => (
            <Select
              {...control}
              value={draft.triggerKind}
              onChange={(event) => {
                onChange({ ...draft, triggerKind: event.currentTarget.value as TriggerKind });
              }}
            >
              {TRIGGER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {draft.triggerKind === 'schedule' ? <ScheduleFields {...props} /> : null}
        {draft.triggerKind === 'date_arrives' ? <DateFields {...props} /> : null}
        {draft.triggerKind === 'property_changed' ? <PropertyChangeFields {...props} /> : null}
      </fieldset>

      {isSchedule ? null : <ConditionFields {...props} />}
      {isSchedule && errors.conditions !== undefined ? (
        <Text variant="note" role="alert">
          {errors.conditions}
        </Text>
      ) : null}

      <ActionFields {...props} />

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ScheduleFields({ draft, onChange, errors }: AutomationEditorProps): ReactNode {
  const { schedule } = draft;
  const unit = { daily: 'days', weekly: 'weeks', monthly: 'months' }[schedule.freq];
  const set = (next: Partial<AutomationDraft['schedule']>): void => {
    onChange({ ...draft, schedule: { ...schedule, ...next } });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-4">
        <Field label="Repeats" className="max-w-xs">
          {(control) => (
            <Select
              {...control}
              value={schedule.freq}
              onChange={(event) => {
                set({ freq: event.currentTarget.value as AutomationDraft['schedule']['freq'] });
              }}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          )}
        </Field>
        <Field
          label={`Every how many ${unit}`}
          error={errors['trigger.interval'] ?? null}
          className="max-w-xs"
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              inputMode="numeric"
              min={1}
              max={366}
              value={schedule.interval}
              onChange={(event) => {
                set({ interval: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label="At" error={errors['trigger.time'] ?? null} className="max-w-xs">
          {(control) => (
            <Input
              {...control}
              type="time"
              value={schedule.time}
              onChange={(event) => {
                set({ time: event.currentTarget.value });
              }}
            />
          )}
        </Field>
      </div>
      {schedule.freq === 'weekly' ? (
        <fieldset className="flex flex-col gap-2">
          <legend>
            <Text as="span" variant="caption">
              On these days
            </Text>
          </legend>
          <div className="flex flex-wrap gap-3">
            {WEEKDAYS.map((day) => (
              <Checkbox
                key={day.value}
                label={day.label}
                checked={schedule.weekdays.includes(day.value)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  set({
                    weekdays: checked
                      ? [...schedule.weekdays, day.value]
                      : schedule.weekdays.filter((value) => value !== day.value),
                  });
                }}
              />
            ))}
          </div>
          {errors['trigger.weekdays'] === undefined ? null : (
            <Text variant="note" role="alert">
              {errors['trigger.weekdays']}
            </Text>
          )}
        </fieldset>
      ) : null}
      <Field
        label="Time zone"
        hint="An IANA name such as Europe/London. Leave it empty to use the time zone in your notification settings."
        error={errors['trigger.timeZone'] ?? null}
        className="max-w-sm"
      >
        {(control) => (
          <Input
            {...control}
            value={schedule.timeZone}
            onChange={(event) => {
              set({ timeZone: event.currentTarget.value });
            }}
          />
        )}
      </Field>
    </div>
  );
}

function DateFields(props: AutomationEditorProps): ReactNode {
  const { draft, onChange, errors, properties } = props;
  const { date } = draft;
  const set = (next: Partial<AutomationDraft['date']>): void => {
    onChange({ ...draft, date: { ...date, ...next } });
  };
  const dateProperties = properties?.filter((property) => DATE_TYPES.has(property.type)) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PropertyKeyField
        label="Date property"
        value={date.key}
        properties={dateProperties}
        loading={props.propertiesLoading === true}
        error={errors['trigger.key'] ?? null}
        onChange={(key) => {
          set({ key });
        }}
      />
      <div className="flex flex-wrap gap-4">
        <Field label="Offset" error={errors['trigger.offsetMinutes'] ?? null} className="max-w-32">
          {(control) => (
            <Input
              {...control}
              type="number"
              inputMode="numeric"
              min={0}
              value={date.amount}
              onChange={(event) => {
                set({ amount: event.currentTarget.value });
              }}
            />
          )}
        </Field>
        <Field label="Unit" className="max-w-40">
          {(control) => (
            <Select
              {...control}
              value={date.unit}
              onChange={(event) => {
                set({ unit: event.currentTarget.value as AutomationDraft['date']['unit'] });
              }}
            >
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </Select>
          )}
        </Field>
        <Field label="Before or after" className="max-w-40">
          {(control) => (
            <Select
              {...control}
              value={date.direction}
              onChange={(event) => {
                set({ direction: event.currentTarget.value as 'before' | 'after' });
              }}
            >
              <option value="before">Before</option>
              <option value="after">After</option>
            </Select>
          )}
        </Field>
      </div>
      <Field
        label="Time for dates without a time"
        hint="A date on its own fires at this time in your time zone."
        error={errors['trigger.time'] ?? null}
        className="max-w-xs"
      >
        {(control) => (
          <Input
            {...control}
            type="time"
            value={date.time}
            onChange={(event) => {
              set({ time: event.currentTarget.value });
            }}
          />
        )}
      </Field>
    </div>
  );
}

function PropertyChangeFields(props: AutomationEditorProps): ReactNode {
  const { draft, onChange, errors, properties } = props;
  const { property } = draft;
  const definition = properties?.find((entry) => entry.key === property.key);
  const valueType = definition === undefined ? null : valueTypeFor(definition.type);

  return (
    <div className="flex flex-col gap-4">
      <PropertyKeyField
        label="Property"
        value={property.key}
        properties={properties}
        loading={props.propertiesLoading === true}
        error={errors['trigger.key'] ?? null}
        onChange={(key) => {
          const type = valueTypeFor(properties?.find((entry) => entry.key === key)?.type);
          onChange({
            ...draft,
            property: {
              key,
              from: { ...property.from, value: emptyValue(type) },
              to: { ...property.to, value: emptyValue(type) },
            },
          });
        }}
      />
      <div className="flex flex-wrap gap-4">
        <MatchField
          label="Changes from"
          match={property.from}
          valueType={valueType}
          definition={definition}
          error={errors['trigger.from'] ?? null}
          onChange={(from) => {
            onChange({ ...draft, property: { ...property, from } });
          }}
        />
        <MatchField
          label="Changes to"
          match={property.to}
          valueType={valueType}
          definition={definition}
          error={errors['trigger.to'] ?? null}
          onChange={(to) => {
            onChange({ ...draft, property: { ...property, to } });
          }}
        />
      </div>
    </div>
  );
}

function MatchField({
  label,
  match,
  valueType,
  definition,
  error,
  onChange,
}: {
  readonly label: string;
  readonly match: MatchDraft;
  readonly valueType: ValueDraft['type'] | null;
  readonly definition: PropertyDefinition | undefined;
  readonly error: string | null;
  readonly onChange: (next: MatchDraft) => void;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Field label={label} className="max-w-xs">
        {(control) => (
          <Select
            {...control}
            value={match.mode}
            onChange={(event) => {
              onChange({ ...match, mode: event.currentTarget.value as MatchDraft['mode'] });
            }}
          >
            <option value="any">Any value</option>
            <option value="value">A particular value</option>
            <option value="empty">No value</option>
          </Select>
        )}
      </Field>
      {match.mode === 'value' ? (
        <ValueField
          label={`${label}, value`}
          value={valueType === null ? match.value : { ...match.value, type: valueType }}
          definition={definition}
          error={error}
          onChange={(value) => {
            onChange({ ...match, value });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Chooses a property key from the scope's schema when there is one, and falls back to typing the
 * key when there is not - no scope, a schema that could not be read, or a key the schema does not
 * declare. Typing is never taken away: a rule may watch a key that only some items carry.
 */
function PropertyKeyField({
  label,
  value,
  properties,
  loading,
  error,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly properties: readonly PropertyDefinition[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onChange: (key: string) => void;
}): ReactNode {
  const listId = useId();
  const choices = properties ?? [];
  return (
    <Field
      label={label}
      hint={
        loading
          ? 'Loading the scope’s properties…'
          : choices.length > 0
            ? 'Pick a property from the list, or type its key.'
            : 'Type the key the property is stored under, such as due_date or status. Choose a scope to pick from its properties instead.'
      }
      error={error}
      className="max-w-sm"
    >
      {(control) => (
        <>
          <Input
            {...control}
            list={choices.length > 0 ? listId : undefined}
            autoComplete="off"
            value={value}
            onChange={(event) => {
              onChange(event.currentTarget.value);
            }}
          />
          {choices.length > 0 ? (
            <datalist id={listId}>
              {choices.map((property) => (
                <option key={property.key} value={property.key}>
                  {property.label}
                </option>
              ))}
            </datalist>
          ) : null}
        </>
      )}
    </Field>
  );
}

function ValueField({
  label,
  value,
  definition,
  error,
  onChange,
}: {
  readonly label: string;
  readonly value: ValueDraft;
  readonly definition: PropertyDefinition | undefined;
  readonly error: string | null;
  readonly onChange: (next: ValueDraft) => void;
}): ReactNode {
  if (value.type === 'boolean') {
    return (
      <Field label={label} error={error} className="max-w-xs">
        {(control) => (
          <Select
            {...control}
            value={value.text === 'true' ? 'true' : 'false'}
            onChange={(event) => {
              onChange({ ...value, text: event.currentTarget.value });
            }}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </Select>
        )}
      </Field>
    );
  }

  if (definition?.type === 'long_text') {
    return (
      <Field label={label} error={error}>
        {(control) => (
          <Textarea
            {...control}
            value={value.text}
            maxLength={8000}
            rows={3}
            onChange={(event) => {
              onChange({ ...value, text: event.currentTarget.value });
            }}
          />
        )}
      </Field>
    );
  }

  const options = definition?.type === 'select' ? definition.options : [];
  if (options.length > 0) {
    return (
      <Field label={label} error={error} className="max-w-xs">
        {(control) => (
          <Select
            {...control}
            value={value.text}
            onChange={(event) => {
              onChange({ ...value, text: event.currentTarget.value });
            }}
          >
            <option value="">Choose a value</option>
            {(options.includes(value.text) || value.text === ''
              ? options
              : [value.text, ...options]
            ).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }

  return (
    <Field
      label={label}
      {...(value.type === 'list' ? { hint: 'Separate values with commas.' } : {})}
      error={error}
      className="max-w-xs"
    >
      {(control) => (
        <Input
          {...control}
          type={value.type === 'number' ? 'number' : 'text'}
          inputMode={value.type === 'number' ? 'decimal' : undefined}
          value={value.text}
          onChange={(event) => {
            onChange({ ...value, text: event.currentTarget.value });
          }}
        />
      )}
    </Field>
  );
}

function ConditionFields({
  draft,
  onChange,
  errors,
  properties,
}: AutomationEditorProps): ReactNode {
  const { conditions } = draft;
  const addConditionRef = useRef<HTMLButtonElement>(null);
  const set = (next: readonly ConditionDraft[]): void => {
    onChange({ ...draft, conditions: next });
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend>
        <Text as="span" variant="h6">
          Only if
        </Text>
      </legend>
      <Text variant="note" tone="muted">
        Checked on the item that set the automation off. Every condition must hold. Up to five.
      </Text>
      {conditions.length === 0 ? (
        <Text variant="note" tone="muted">
          No conditions. It runs every time the trigger fires.
        </Text>
      ) : null}
      {conditions.map((condition, index) => {
        const path = `conditions[${String(index)}]`;
        const definition = properties?.find((entry) => entry.key === condition.key);
        const number = String(index + 1);
        return (
          <div
            key={index}
            role="group"
            aria-label={`Condition ${number}`}
            className="flex flex-col gap-2 rounded-md border border-divider p-3"
          >
            <div className="flex flex-wrap items-end gap-3">
              <PropertyKeyField
                label={`Condition ${number} property`}
                value={condition.key}
                properties={properties}
                loading={false}
                error={errors[`${path}.key`] ?? null}
                onChange={(key) => {
                  const type = valueTypeFor(properties?.find((entry) => entry.key === key)?.type);
                  set(withIndex(conditions, index, { ...condition, key, value: emptyValue(type) }));
                }}
              />
              <Field label={`Condition ${number} test`} className="max-w-xs">
                {(control) => (
                  <Select
                    {...control}
                    value={condition.op}
                    onChange={(event) => {
                      set(
                        withIndex(conditions, index, {
                          ...condition,
                          op: event.currentTarget.value as ConditionDraft['op'],
                        }),
                      );
                    }}
                  >
                    <option value="equals">Is</option>
                    <option value="not_equals">Is not</option>
                    <option value="is_empty">Is empty</option>
                    <option value="is_not_empty">Is not empty</option>
                  </Select>
                )}
              </Field>
              {condition.op === 'equals' || condition.op === 'not_equals' ? (
                <ValueField
                  label={`Condition ${number} value`}
                  value={
                    definition === undefined
                      ? condition.value
                      : { ...condition.value, type: valueTypeFor(definition.type) }
                  }
                  definition={definition}
                  error={errors[`${path}.value`] ?? null}
                  onChange={(value) => {
                    set(withIndex(conditions, index, { ...condition, value }));
                  }}
                />
              ) : null}
            </div>
            <div>
              <Button
                type="button"
                variant="subtle"
                onClick={() => {
                  set(withoutIndex(conditions, index));
                  // The button just pressed is gone; keep focus in the section.
                  addConditionRef.current?.focus();
                }}
              >
                Remove condition {number}
              </Button>
            </div>
          </div>
        );
      })}
      {errors.conditions === undefined ? null : (
        <Text variant="note" role="alert">
          {errors.conditions}
        </Text>
      )}
      <div>
        <Button
          ref={addConditionRef}
          type="button"
          variant="secondary"
          disabled={conditions.length >= MAX_CONDITIONS}
          onClick={() => {
            set([...conditions, emptyCondition()]);
          }}
        >
          Add a condition
        </Button>
      </div>
    </fieldset>
  );
}

function ActionFields(props: AutomationEditorProps): ReactNode {
  const { draft, onChange, errors } = props;
  const { actions } = draft;
  const addActionRef = useRef<HTMLButtonElement>(null);
  const set = (next: readonly ActionDraft[]): void => {
    onChange({ ...draft, actions: next });
  };

  return (
    <fieldset disabled={props.busy} className="flex min-w-0 flex-col gap-4">
      <legend>
        <Text as="span" variant="h6">
          Then
        </Text>
      </legend>
      <Text variant="note" tone="muted">
        One to five actions, run in order. If one fails, none of them take effect.
      </Text>
      {actions.map((action, index) => {
        const number = String(index + 1);
        return (
          <div
            key={index}
            role="group"
            aria-label={`Action ${number}`}
            className="flex flex-col gap-3 rounded-md border border-divider p-3"
          >
            <Field label={`Action ${number} does`} className="max-w-sm">
              {(control) => (
                <Select
                  {...control}
                  value={action.kind}
                  onChange={(event) => {
                    set(
                      withIndex(
                        actions,
                        index,
                        emptyAction(
                          event.currentTarget.value as ActionDraft['kind'],
                          draft.scopeItemId !== null,
                        ),
                      ),
                    );
                  }}
                >
                  {ACTION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <ActionBody
              {...props}
              action={action}
              index={index}
              onAction={(next) => {
                set(withIndex(actions, index, next));
              }}
            />
            <div>
              <Button
                type="button"
                variant="subtle"
                disabled={actions.length <= 1}
                onClick={() => {
                  set(withoutIndex(actions, index));
                  addActionRef.current?.focus();
                }}
              >
                Remove action {number}
              </Button>
            </div>
          </div>
        );
      })}
      {errors.actions === undefined ? null : (
        <Text variant="note" role="alert">
          {errors.actions}
        </Text>
      )}
      <div>
        <Button
          ref={addActionRef}
          type="button"
          variant="secondary"
          disabled={actions.length >= MAX_ACTIONS}
          onClick={() => {
            set([...actions, emptyAction('notify', draft.scopeItemId !== null)]);
          }}
        >
          Add an action
        </Button>
      </div>
    </fieldset>
  );
}

function ActionBody(
  props: AutomationEditorProps & {
    readonly action: ActionDraft;
    readonly index: number;
    readonly onAction: (next: ActionDraft) => void;
  },
): ReactNode {
  const { action, index, onAction, errors, properties, draft, renderItemPicker } = props;
  const path = `actions[${String(index)}]`;
  const number = String(index + 1);
  const isSchedule = draft.triggerKind === 'schedule';

  switch (action.kind) {
    case 'notify':
      return (
        <div className="flex flex-col gap-3">
          <Field
            label={`Action ${number} title`}
            hint={TEMPLATE_HINT}
            error={errors[`${path}.title`] ?? null}
            className="max-w-xl"
          >
            {(control) => (
              <Input
                {...control}
                maxLength={200}
                value={action.title}
                onChange={(event) => {
                  onAction({ ...action, title: event.currentTarget.value });
                }}
              />
            )}
          </Field>
          <Field
            label={`Action ${number} message`}
            error={errors[`${path}.body`] ?? null}
            className="max-w-xl"
          >
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                maxLength={1000}
                value={action.body}
                onChange={(event) => {
                  onAction({ ...action, body: event.currentTarget.value });
                }}
              />
            )}
          </Field>
        </div>
      );

    case 'set_property': {
      const definition = properties?.find((entry) => entry.key === action.key);
      return (
        <div className="flex flex-col gap-3">
          <Field
            label={`Action ${number} item`}
            error={errors[`${path}.target`] ?? null}
            className="max-w-sm"
          >
            {(control) => (
              <Select
                {...control}
                value={action.target}
                onChange={(event) => {
                  onAction({
                    ...action,
                    target: event.currentTarget.value as 'triggering_item' | 'item',
                  });
                }}
              >
                {isSchedule && action.target !== 'triggering_item' ? null : (
                  <option value="triggering_item">The item that set it off</option>
                )}
                <option value="item">A particular item</option>
              </Select>
            )}
          </Field>
          {action.target === 'item' ? (
            <div className="max-w-xl">
              {renderItemPicker({
                label: `Action ${number} item to update`,
                value: action.targetItemId,
                onChange: (targetItemId) => {
                  onAction({ ...action, targetItemId });
                },
              })}
            </div>
          ) : null}
          <PropertyKeyField
            label={`Action ${number} property`}
            value={action.key}
            properties={properties}
            loading={false}
            error={errors[`${path}.key`] ?? null}
            onChange={(key) => {
              const type = valueTypeFor(properties?.find((entry) => entry.key === key)?.type);
              onAction({ ...action, key, value: emptyValue(type) });
            }}
          />
          <Checkbox
            label="Clear the property instead"
            aria-label={`Action ${number}: clear the property instead`}
            checked={action.clear}
            onChange={(event) => {
              onAction({ ...action, clear: event.currentTarget.checked });
            }}
          />
          {action.clear ? null : (
            <ValueField
              label={`Action ${number} new value`}
              value={
                definition === undefined
                  ? action.value
                  : { ...action.value, type: valueTypeFor(definition.type) }
              }
              definition={definition}
              error={errors[`${path}.value`] ?? null}
              onChange={(value) => {
                onAction({ ...action, value });
              }}
            />
          )}
        </div>
      );
    }

    case 'create_item':
      return (
        <div className="flex flex-col gap-3">
          <Field
            label={`Action ${number} create it in`}
            error={errors[`${path}.parent`] ?? null}
            className="max-w-sm"
          >
            {(control) => (
              <Select
                {...control}
                value={action.parent}
                onChange={(event) => {
                  onAction({
                    ...action,
                    parent: event.currentTarget.value as typeof action.parent,
                  });
                }}
              >
                {isSchedule && action.parent !== 'triggering_item' ? null : (
                  <option value="triggering_item">The item that set it off</option>
                )}
                <option value="scope">The scope</option>
                <option value="item">A particular item</option>
              </Select>
            )}
          </Field>
          {action.parent === 'item' ? (
            <div className="max-w-xl">
              {renderItemPicker({
                label: `Action ${number} parent item`,
                value: action.parentItemId,
                onChange: (parentItemId) => {
                  onAction({ ...action, parentItemId });
                },
              })}
            </div>
          ) : null}
          <Field
            label={`Action ${number} kind of item`}
            error={errors[`${path}.itemType`] ?? null}
            className="max-w-xs"
          >
            {(control) => (
              <Select
                {...control}
                value={action.itemType}
                onChange={(event) => {
                  onAction({ ...action, itemType: event.currentTarget.value });
                }}
              >
                {(KNOWN_ITEM_TYPES as readonly string[]).includes(action.itemType) ? null : (
                  <option value={action.itemType}>{action.itemType}</option>
                )}
                <option value="note">Note</option>
                <option value="canvas">Canvas</option>
                <option value="spreadsheet">Spreadsheet</option>
              </Select>
            )}
          </Field>
          <Field
            label={`Action ${number} title`}
            hint={TEMPLATE_HINT}
            error={errors[`${path}.title`] ?? null}
            className="max-w-xl"
          >
            {(control) => (
              <Input
                {...control}
                maxLength={500}
                value={action.title}
                onChange={(event) => {
                  onAction({ ...action, title: event.currentTarget.value });
                }}
              />
            )}
          </Field>
          {action.properties === null ? null : (
            <Text variant="note" tone="muted">
              This action also sets {Object.keys(action.properties).length} properties on the new
              item. They are kept as they are.
            </Text>
          )}
        </div>
      );
  }
}
