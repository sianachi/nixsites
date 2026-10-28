import { useMemo, useState, type ReactNode } from 'react';

import { useOptionalApiClient } from '../../api/api-client-provider';
import { useOptionalWorkspace } from '../../workspaces/workspace-context';
import type { PropertyDefinition, PropertyValue } from '../core/container-model';
import { DuplicateNotice } from './duplicate-notice';
import { SuggestionAction, SuggestionHint } from './suggestion-hint';
import { unnamedMember, WithMemberNames, type MemberNameOf } from './member-name';
import { PropertySuggestionLine } from './property-suggestion-line';
import {
  suggestProperties,
  trainPropertyModels,
  type PropertySuggestion,
} from './property-suggestions';
import type { CreateSuggestSource } from './suggest-source';
import { useSettledValue, useSimilarItems, SIMILAR_DEBOUNCE_MS } from './use-similar-items';

export interface CreateSuggestionsProps {
  /** The title as typed so far. */
  readonly title: string;
  readonly source: CreateSuggestSource;

  /** Properties the control already sets (a board column's value), never second-guessed. */
  readonly fixed: Readonly<Record<string, unknown>> | undefined;

  /** Values the person has accepted for the item about to be made. */
  readonly accepted: Readonly<Record<string, PropertyValue>>;
  readonly onAccept: (key: string, value: PropertyValue) => void;
  readonly onUndo: (key: string) => void;

  /**
   * Puts focus back where typing continues - the create field - after a button here was pressed.
   * Every button in this region unmounts the moment it is used (Use becomes an accepted line, Undo
   * removes its line, "more" disappears once expanded), and focus left on a removed node falls to
   * the document body (WCAG 2.4.3).
   */
  readonly returnFocus: () => void;
}

/** The most property suggestions shown before the rest are folded behind "more". */
const VISIBLE_SUGGESTIONS = 2;

/**
 * The suggestions under a create field: likely property values, and a similar item that may already
 * exist.
 *
 * **Accepting writes nothing.** A new item does not exist yet, so an accepted value joins the
 * properties the create sends - the same create path, with the same validation, as a column's own
 * value - and an un-accepted one is never sent. Undo is available until the item is made. Both
 * behaviours keep the rule every suggestion here follows: nothing lands in durable data unless the
 * person chose it, and choosing it goes through the write the view already makes.
 *
 * **Everything waits for the title to settle** ({@link SIMILAR_DEBOUNCE_MS}), so the lines do not
 * flicker through every partial word. **What is announced is the count, not the lines**: an
 * `sr-only` polite sentence ("2 suggestions for this item.") whose text changes only when the
 * number does, so a screen reader hears that suggestions arrived once rather than every line each
 * time one redraws; the lines themselves are ordinary buttons and text, found by reading on.
 *
 * Default-exported for `React.lazy`: the create control loads this module only once somebody opens
 * a create field, so the classifier stays out of every view's entry chunk.
 */
export default function CreateSuggestions(props: CreateSuggestionsProps): ReactNode {
  const { title, source, fixed, accepted } = props;
  const [expanded, setExpanded] = useState(false);
  const workspace = useOptionalWorkspace();
  const client = useOptionalApiClient();

  // Memoised for a profiled cost, not for identity: training walks every child's title and every
  // learnable property - measured at 14-22ms warm (52ms cold) in Node for 4,000 children and three
  // learnable properties - which would otherwise be paid on every keystroke in the create field.
  const models = useMemo(
    () => trainPropertyModels(source.children, source.schema),
    [source.children, source.schema],
  );

  const settled = useSettledValue(title.trim(), SIMILAR_DEBOUNCE_MS);
  const similar = useSimilarItems(
    title,
    source.children,
    workspace?.workspaceId ?? source.children[0]?.workspaceId ?? null,
  );

  const skip = new Set([...Object.keys(fixed ?? {}), ...Object.keys(accepted)]);
  // Strongest first, and only the first few unless asked: a create row in a narrow board column
  // that grew a line per property would push the next card off screen for a guess.
  const offered: readonly PropertySuggestion[] = (
    settled === null ? [] : suggestProperties(models, settled, skip)
  )
    .slice()
    .sort((a, b) => b.posterior - a.posterior);
  const shown = expanded ? offered : offered.slice(0, VISIBLE_SUGGESTIONS);
  const folded = offered.length - shown.length;

  const acceptedLines = Object.entries(accepted).flatMap(([key, value]) => {
    const property = source.schema.find((candidate) => candidate.key === key);
    return property === undefined ? [] : [{ property, value }];
  });

  const duplicate = similar.local[0] ?? similar.elsewhere?.[0] ?? null;
  const duplicateHere = similar.local[0] !== undefined;
  const count = (duplicate === null ? 0 : 1) + offered.length;

  // A person is named from the member list, which needs a client and a workspace to read; without
  // them (a story, a unit test) the line says "a workspace member" rather than an identifier. The
  // list is read once for this field, and only when the schema has a person to name at all.
  const canName =
    client !== null &&
    workspace !== null &&
    source.schema.some((property) => property.type === 'assignee');

  const lines = (memberName: MemberNameOf): ReactNode =>
    renderLines(memberName, {
      ...props,
      duplicate,
      duplicateHere,
      acceptedLines,
      shown,
      folded,
      expand: () => {
        setExpanded(true);
      },
    });

  return (
    <div className="flex flex-col gap-0.5">
      <p className="sr-only" aria-live="polite">
        {count === 0
          ? ''
          : `${String(count)} ${count === 1 ? 'suggestion' : 'suggestions'} for this item.`}
      </p>
      {canName ? <WithMemberNames>{lines}</WithMemberNames> : lines(unnamedMember)}
    </div>
  );
}

interface LinesInput extends CreateSuggestionsProps {
  readonly duplicate: { readonly id: string; readonly title: string } | null;
  readonly duplicateHere: boolean;
  readonly acceptedLines: readonly {
    readonly property: PropertyDefinition;
    readonly value: PropertyValue;
  }[];
  readonly shown: readonly PropertySuggestion[];
  readonly folded: number;
  readonly expand: () => void;
}

/** The suggestion lines, given how to name a person. */
function renderLines(memberName: MemberNameOf, input: LinesInput): ReactNode {
  const {
    source,
    onAccept,
    onUndo,
    returnFocus,
    duplicate,
    duplicateHere,
    acceptedLines,
    shown,
    folded,
    expand,
  } = input;

  function nameOf(property: PropertyDefinition, value: string): ReactNode {
    return property.type === 'assignee' ? memberName(value) : value;
  }

  return (
    <>
      {/* First, because it may mean the item should not be made at all. */}
      {duplicate === null ? null : (
        <DuplicateNotice
          title={duplicate.title}
          where={duplicateHere ? 'here' : 'workspace'}
          onOpen={() => {
            source.onOpen(duplicate.id);
          }}
        />
      )}

      {acceptedLines.map(({ property, value }) => (
        <PropertySuggestionLine
          key={`accepted:${property.key}`}
          state="accepted"
          propertyLabel={property.label}
          value={Array.isArray(value) ? value.join(', ') : String(value)}
          valueLabel={typeof value === 'string' ? nameOf(property, value) : undefined}
          isPerson={property.type === 'assignee'}
          onUndo={() => {
            onUndo(property.key);
            returnFocus();
          }}
        />
      ))}

      {shown.map((suggestion) => (
        <PropertySuggestionLine
          key={`offered:${suggestion.property.key}`}
          state="offered"
          propertyLabel={suggestion.property.label}
          value={suggestion.value}
          valueLabel={nameOf(suggestion.property, suggestion.value)}
          isPerson={suggestion.property.type === 'assignee'}
          evidence={suggestion.evidence}
          onAccept={() => {
            onAccept(suggestion.property.key, suggestion.stored);
            returnFocus();
          }}
        />
      ))}

      {folded === 0 ? null : (
        <SuggestionHint
          actions={
            <SuggestionAction
              label={`Show ${String(folded)} more ${folded === 1 ? 'suggestion' : 'suggestions'}`}
              onClick={() => {
                expand();
                returnFocus();
              }}
            >
              Show them
            </SuggestionAction>
          }
        >
          and {String(folded)} more {folded === 1 ? 'suggestion' : 'suggestions'}
        </SuggestionHint>
      )}
    </>
  );
}
