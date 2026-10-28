import {
  SUGGESTION_THRESHOLDS,
  suggestValue,
  trainValueModel,
  type SuggestionEvidence,
  type ValueModel,
} from '@nix/web-foundation/lib/suggest/naive-bayes';
import { tokens } from '@nix/web-foundation/lib/suggest/tokenize';
import type { Item, PropertyDefinition, PropertyValue } from '../core/container-model';

/**
 * Which property values a new item probably wants, learned from its siblings' titles.
 *
 * The container-shaped half of the property-value suggester: `lib/suggest/naive-bayes.ts` knows
 * how to learn "words to a label" and nothing about items, and this file knows which properties
 * are categorical enough to learn, how their values are stored, and what a suggestion has to be
 * before it may be written back.
 *
 * **Three property types are learned, because only these are categories.** A select and a
 * multi-select draw from a declared list, and an assignee from the workspace's members - so the
 * same few values recur across siblings and a title's words can say something about which one
 * applies. A text property's values are as varied as its titles; a date, a number or a checkbox has
 * no category for a word to point at. Anything else is skipped.
 *
 * **A select value is only suggested if the schema still declares it.** A sibling may hold a value
 * from before an option was renamed; suggesting it would offer a write the server refuses. The
 * assignee has no declared list - its values are principals - so it is learned as stored.
 */

/** The property types a title can be learned against. */
const LEARNABLE_TYPES: ReadonlySet<string> = new Set(['select', 'multi_select', 'assignee']);

/** One property's trained model. */
export interface PropertyModel {
  readonly property: PropertyDefinition;
  readonly model: ValueModel;
}

/** A value offered for a new item, with what to say about why. */
export interface PropertySuggestion {
  readonly property: PropertyDefinition;

  /** The value as the person reads it - an option, or a principal's identifier for an assignee. */
  readonly value: string;

  /** What to send to store it: the option, a one-option list, or the identifier. */
  readonly stored: PropertyValue;

  readonly posterior: number;
  readonly evidence: SuggestionEvidence;
}

function valuesOf(item: Item, property: PropertyDefinition): readonly string[] {
  const raw: unknown = item.properties[property.key];
  const values =
    typeof raw === 'string'
      ? [raw]
      : Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === 'string')
        : [];
  // A select learns only from declared values, for the same reason it only suggests them.
  return property.type === 'assignee'
    ? values
    : values.filter((value) => property.options.includes(value));
}

/**
 * Trains one model per learnable property over `children`.
 *
 * Properties with too few labelled children are still returned: the threshold belongs to the
 * prediction, so a caller can tell "nothing to learn from yet" from "learned, and not sure".
 */
export function trainPropertyModels(
  children: readonly Item[],
  schema: readonly PropertyDefinition[],
): readonly PropertyModel[] {
  const learnable = schema.filter((property) => LEARNABLE_TYPES.has(property.type));
  if (learnable.length === 0) {
    return [];
  }
  const titles = children.map((child) => tokens(child.title));
  return learnable.map((property) => ({
    property,
    model: trainValueModel(
      children.map((child, index) => ({
        tokens: titles[index] ?? [],
        values: valuesOf(child, property),
      })),
    ),
  }));
}

/**
 * The confident suggestions for `title`, one per property at most, in schema order.
 *
 * `skip` names properties the caller is already setting - a board column's own property, a value
 * the person has already accepted - which are never second-guessed.
 */
export function suggestProperties(
  models: readonly PropertyModel[],
  title: string,
  skip: ReadonlySet<string>,
): readonly PropertySuggestion[] {
  const words = tokens(title);
  if (words.length === 0) {
    return [];
  }
  const suggestions: PropertySuggestion[] = [];
  for (const { property, model } of models) {
    if (skip.has(property.key)) {
      continue;
    }
    const suggestion = suggestValue(model, words, SUGGESTION_THRESHOLDS);
    if (suggestion === null) {
      continue;
    }
    suggestions.push({
      property,
      value: suggestion.value,
      stored: property.type === 'multi_select' ? [suggestion.value] : suggestion.value,
      posterior: suggestion.posterior,
      evidence: suggestion.evidence,
    });
  }
  return suggestions;
}
