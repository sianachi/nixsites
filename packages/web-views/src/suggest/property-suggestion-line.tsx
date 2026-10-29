import type { ReactNode } from 'react';

import type { SuggestionEvidence } from '@nix/web-foundation/lib/suggest/naive-bayes';
import { SuggestionAction, SuggestionHint } from './suggestion-hint';

/**
 * One property value offered for a new item, or one the person has already taken.
 *
 * **The reason is part of the suggestion.** "Suggested Category: Bills - 8 of the 10 items with
 * 'invoice' in the title and a Category set use Bills" can be checked against the list the person
 * is looking at, and says exactly which items were counted; a bare "Bills?" can only be trusted or
 * not. The model only offers a reason that supports the value (at least half the counted items). The counts are the model's own evidence for its strongest word (see
 * `naive-bayes.ts`), never a confidence percentage, because "86%" invites a precision the
 * arithmetic does not have.
 */

export type PropertySuggestionLineProps =
  | {
      readonly state: 'offered';
      readonly propertyLabel: string;
      readonly value: string;

      /** How to show the value when it is not its own name - an assignee's identifier, say. */
      readonly valueLabel?: ReactNode;
      readonly isPerson?: boolean;
      readonly evidence: SuggestionEvidence;
      readonly onAccept: () => void;
    }
  | {
      readonly state: 'accepted';
      readonly propertyLabel: string;
      readonly value: string;
      readonly valueLabel?: ReactNode;
      readonly isPerson?: boolean;
      readonly onUndo: () => void;
    };

export function PropertySuggestionLine(props: PropertySuggestionLineProps): ReactNode {
  const shown = props.valueLabel ?? props.value;

  if (props.state === 'accepted') {
    return (
      <SuggestionHint
        actions={
          <SuggestionAction
            label={`Do not set ${props.propertyLabel} to ${props.isPerson === true ? 'the suggested person' : props.value}`}
            onClick={props.onUndo}
          >
            Undo
          </SuggestionAction>
        }
      >
        {props.propertyLabel} will be set to <span className="font-semibold">{shown}</span>.
      </SuggestionHint>
    );
  }

  const { evidence } = props;
  // `withValue` is at least two by the model's own floor, so the counts are always plural.
  const article = /^[aeiou]/i.test(props.propertyLabel) ? 'an' : 'a';
  const counted = `the ${String(evidence.withWord)} items with '${evidence.word}' in the title and ${article} ${props.propertyLabel} set`;
  const verb = props.isPerson === true ? 'are assigned to' : 'use';

  return (
    <SuggestionHint
      actions={
        <SuggestionAction
          // A person's value is an identifier, which is no name for a button.
          label={`Use ${props.isPerson === true ? 'the suggested person' : props.value} for ${props.propertyLabel}`}
          onClick={props.onAccept}
        >
          Use
        </SuggestionAction>
      }
    >
      Suggested {props.propertyLabel}: <span className="font-semibold">{shown}</span> -{' '}
      {String(evidence.withValue)} of {counted} {verb} {shown}.
    </SuggestionHint>
  );
}
