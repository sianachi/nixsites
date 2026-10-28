import { type ReactNode } from 'react';

import { useWorkspaceMembers } from '@nix/web-settings/settings/members/use-workspace-members';
import { PRIORITY_LEVELS, priorityLabel } from '../priority-levels';
import { useSelectFrecency } from '../use-select-frecency';
import { UNSET_LABEL, UNSET_VALUE, readSelectValue } from '../../views/core/container-model';

import { type PropertyInputProps } from './types';
import { ChoiceSelect } from './choice-select';
import { ValueShell } from './shell';

export function SelectValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;

  const current = readSelectValue(item, property.key);
  const frecency = useSelectFrecency(property.key, props.allowInputStorage ?? true);

  // The declared options, plus whatever this item actually holds if the schema has moved on since
  // it was written. Dropping the stored value would make the control report some other option as
  // the current one, which is a lie about the item. The declared order is kept; what this person
  // usually picks is repeated ahead of it (see `use-select-frecency.ts`).
  const options =
    current !== null && !property.options.includes(current)
      ? [current, ...property.options]
      : property.options;
  const recent = frecency.recent(options, (option) => option);
  const choices = (
    <ChoiceGroups
      recent={recent.map((option) => ({ id: option, label: option }))}
      all={options.map((option) => ({ id: option, label: option }))}
    />
  );

  function choose(next: string): void {
    if (next !== UNSET_VALUE) {
      frecency.remember(next);
    }
    onCommit(next === UNSET_VALUE ? null : next);
  }

  return (
    <ValueShell {...props}>
      {(control) => (
        <ChoiceSelect
          density={density}
          control={control}
          tabIndex={props.tabIndex}
          value={current ?? UNSET_VALUE}
          required={property.required}
          disabled={disabled}
          onChange={choose}
        >
          {/* Clearing has to be reachable from the control that set it: a property somebody
                filled in by mistake is otherwise permanent. */}
          <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

          {choices}
        </ChoiceSelect>
      )}
    </ValueShell>
  );
}

/** One assignee option offered by the picker: an identifier, and what to call it. */
interface AssigneeOption {
  readonly id: string;
  readonly label: string;
}

/**
 * A choice list's options: the declared list as it is, preceded - when this person has a history
 * here - by a "Recent" group repeating their usual picks. Two `<option>`s may then share a value;
 * the browser selects the first, which shows the same label.
 */
function ChoiceGroups({
  recent,
  all,
}: {
  readonly recent: readonly AssigneeOption[];
  readonly all: readonly AssigneeOption[];
}): ReactNode {
  const options = all.map((option) => (
    <option key={option.id} value={option.id}>
      {option.label}
    </option>
  ));
  if (recent.length === 0) {
    return options;
  }
  return (
    <>
      <optgroup label="Recent">
        {recent.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="All options">{options}</optgroup>
    </>
  );
}

/**
 * The assignee property: a picker over the workspace's members, storing a principal's identifier
 * rather than a box somebody types one into.
 *
 * **Three states a plain select never has to hold, all told apart in words.** The member list can
 * still be loading, which says so rather than showing an empty list that reads as "nobody is
 * here". Its read can fail, which says that too and keeps showing whatever is stored - a lookup
 * failing is not a reason to also hide the value. And the item can hold an identifier the list does
 * not currently carry, because the person left the workspace or the value predates them: that
 * identifier is offered as its own option and shown as the current selection rather than dropped or
 * quietly reported as somebody else. A control that reassigns an item because a lookup failed is
 * worse than one that admits it does not know the name.
 *
 * The unset option is the same word and the same value SelectValue clears through - one vocabulary
 * for "nothing chosen" rather than a second one invented for people.
 */
export function AssigneeValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;

  const { status, members, error: membersError } = useWorkspaceMembers();
  const current = readSelectValue(item, property.key);

  const known =
    current === null ? null : (members.find((member) => member.subjectId === current) ?? null);

  // The declared members, plus the item's own identifier when the list cannot vouch for it. Same
  // reasoning as `SelectValue`'s stored-but-undeclared option: dropping it would make the control
  // report the item as unassigned, which is a lie about the item rather than a gap in the roster.
  const memberOptions: readonly AssigneeOption[] = members.map((member) => ({
    id: member.subjectId,
    label: member.subjectDisplayName,
  }));

  const frecency = useSelectFrecency(property.key, props.allowInputStorage ?? true);
  const options: readonly AssigneeOption[] =
    current !== null && known === null
      ? [{ id: current, label: current }, ...memberOptions]
      : memberOptions;
  const choices = (
    <ChoiceGroups recent={frecency.recent(options, (option) => option.id)} all={options} />
  );

  function choose(next: string): void {
    if (next !== UNSET_VALUE) {
      frecency.remember(next);
    }
    onCommit(next === UNSET_VALUE ? null : next);
  }

  const hint =
    status === 'loading'
      ? 'Loading the workspace members.'
      : status === 'error'
        ? `${membersError ?? 'The workspace members could not be loaded.'} Showing what is stored.`
        : current !== null && known === null
          ? 'This identifier is not among the workspace members currently loaded.'
          : undefined;

  return (
    <ValueShell {...props} {...(hint === undefined ? {} : { hint })}>
      {(control) => (
        <ChoiceSelect
          density={density}
          control={control}
          tabIndex={props.tabIndex}
          value={current ?? UNSET_VALUE}
          required={property.required}
          disabled={disabled}
          onChange={choose}
        >
          {/* Clearing has to be reachable from the control that set it: a property somebody
                filled in by mistake is otherwise permanent. */}
          <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

          {choices}
        </ChoiceSelect>
      )}
    </ValueShell>
  );
}

/**
 * A priority is a closed four-step scale, so it is chosen, never typed: a free number box would
 * invite the 0 and the 7 the server refuses, and refusal after the fact is a worse control than a
 * list that only offers what is real.
 */
export function PriorityValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;

  const raw: unknown = item.properties[property.key];
  const current =
    typeof raw === 'number' && PRIORITY_LEVELS.some((level) => level.value === raw) ? raw : null;

  return (
    <ValueShell {...props}>
      {(control) => (
        <ChoiceSelect
          density={density}
          control={control}
          tabIndex={props.tabIndex}
          value={current === null ? UNSET_VALUE : String(current)}
          required={property.required}
          disabled={disabled}
          onChange={(next) => {
            onCommit(next === UNSET_VALUE ? null : Number(next));
          }}
        >
          {/* Clearing has to be reachable from the control that set it: a property somebody
                filled in by mistake is otherwise permanent. */}
          <option value={UNSET_VALUE}>{UNSET_LABEL}</option>

          {PRIORITY_LEVELS.map((level) => (
            <option key={level.value} value={String(level.value)}>
              {priorityLabel(level.value)}
            </option>
          ))}
        </ChoiceSelect>
      )}
    </ValueShell>
  );
}
