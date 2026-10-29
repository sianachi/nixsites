import type { ReactNode } from 'react';

import { SuggestionAction, SuggestionHint } from '../suggest/suggestion-hint';

/**
 * "Your usual: Bills", under an empty form field, with a button to use it.
 *
 * The value comes from this person's own earlier submissions to the same form (`form-memory.ts`).
 * It is offered, never pre-filled: a form that arrived with last time's answers already in it is
 * one Enter away from a submission nobody actually chose.
 */
export interface UsualValueHintProps {
  readonly fieldLabel: string;

  /** The value as the person reads it. */
  readonly value: ReactNode;

  /** The value as plain text, for the button's accessible name. */
  readonly valueText: string;
  readonly onUse: () => void;
}

export function UsualValueHint(props: UsualValueHintProps): ReactNode {
  const { fieldLabel, value, valueText, onUse } = props;

  return (
    <SuggestionHint
      actions={
        <SuggestionAction label={`Use ${valueText} for ${fieldLabel}`} onClick={onUse}>
          Use
        </SuggestionAction>
      }
    >
      Your usual {fieldLabel}: <span className="font-semibold">{value}</span>
    </SuggestionHint>
  );
}

export interface UsualValuesSummaryProps {
  /** The fields that have a usual value waiting, by label, in form order. */
  readonly fieldLabels: readonly string[];
  readonly onUseAll: () => void;
}

/**
 * One line instead of many, when three or more empty fields have a usual value: a form whose every
 * field grew its own hint reads as a form filled with suggestions rather than with fields. "Use
 * all" takes every one of them at once; the fields then show the values, and can still be changed.
 */
export function UsualValuesSummary(props: UsualValuesSummaryProps): ReactNode {
  const { fieldLabels, onUseAll } = props;
  const named =
    fieldLabels.length <= 1
      ? (fieldLabels[0] ?? '')
      : `${fieldLabels.slice(0, -1).join(', ')} and ${fieldLabels[fieldLabels.length - 1] ?? ''}`;

  return (
    <SuggestionHint
      actions={
        <SuggestionAction label={`Use your usual values for ${named}`} onClick={onUseAll}>
          Use all
        </SuggestionAction>
      }
    >
      Your usual values are ready for {named}.
    </SuggestionHint>
  );
}
