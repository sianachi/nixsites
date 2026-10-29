import { Button, Text, cn, focusRing } from '@nix/ui';
import { useEffect, useRef, type ReactNode } from 'react';

import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { formatCalendarDay } from '@nix/web-foundation/lib/date-format';
import type { InferredFilters, InferredRule } from '@nix/web-foundation/lib/suggest/infer-filters';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { PropertyDefinition, ViewFilterRule } from '../core/container-model';
import { SuggestionHint } from '../suggest/suggestion-hint';
import { MemberNames, unnamedMember, type MemberNameOf } from '../suggest/member-name';
import { valueText } from '../suggest/value-text';
import { FilterRulesEditor } from '../core/filter-rules-editor';

/**
 * Query by example's review step: what the examples share, proposed as rules, in the ordinary
 * filter editor, waiting for the person to save or discard them.
 *
 * **The proposal goes into the editor, not into the view.** Inferred rules are appended to the
 * rules the smart list already has and handed to `FilterRulesEditor` as a draft - the same editor
 * the setup studio uses, so every rule can be read, changed or removed before anything is stored.
 * Saving is the ordinary view write; discarding leaves the smart list exactly as it was. Nothing
 * here ever runs a query with rules the person has not saved.
 *
 * **Each rule says how much it narrows, and over what.** The counts are over the rows this smart
 * list is showing right now - a server-limited, possibly truncated set - so the sentence names
 * that set rather than claiming a number for the whole workspace. Saving runs the real query.
 */

export interface QueryByExamplePanelProps {
  /** How many items were marked as examples. */
  readonly examples: number;

  /** What the inducer proposed, over the rows on screen. */
  readonly inferred: InferredFilters;

  /** Whether the rows on screen are only part of what the list matches. */
  readonly truncated: boolean;

  /** The draft: the list's existing rules followed by the proposed ones, as edited so far. */
  readonly draft: readonly ViewFilterRule[];
  readonly schema: readonly PropertyDefinition[];
  readonly onDraftChange: (rules: readonly ViewFilterRule[]) => void;

  readonly saving: boolean;

  /** Why the last save was refused, or null. */
  readonly error: string | null;

  readonly onSave: () => void;
  readonly onDiscard: () => void;
}

const OPERATOR_WORDS: Record<InferredRule['operator'], string> = {
  equals: 'is',
  'not-equals': 'is not',
  on: 'is on',
  before: 'is before',
  'on-or-after': 'is on or after',
};

/**
 * How one proposed rule reads, with what it leaves: the property by its schema label and the value
 * the way a suggestion elsewhere would say it (`value-text.ts`), falling back to the stored key and
 * value for a property the schema does not declare.
 */
export function describeInferredRule(
  rule: InferredRule,
  considered: number,
  schema: readonly PropertyDefinition[],
  memberName: MemberNameOf = unnamedMember,
): string {
  const definition = schema.find((candidate) => candidate.key === rule.property);
  const label = definition?.label ?? rule.property;
  // The date operators compare calendar days, so their value is one: said in the reader's format.
  const value =
    definition?.type === 'date' ||
    rule.operator === 'on' ||
    rule.operator === 'before' ||
    rule.operator === 'on-or-after'
      ? (formatCalendarDay(rule.value) ?? rule.value)
      : valueText(definition, rule.value, memberName);
  return `${label} ${OPERATOR_WORDS[rule.operator]} ${value} - ${String(rule.remaining)} of ${String(considered)} remain`;
}

/**
 * Default-exported for `React.lazy`: the smart list loads this panel only once somebody asks for
 * suggested filters.
 *
 * **Focus moves to the panel when it appears**, because it appears in answer to a button press and
 * holds the next thing to read: landing there announces its name and puts the editor and the save
 * button next in the tab order, rather than leaving focus on a button above content that silently
 * changed.
 */
export default function QueryByExamplePanel(props: QueryByExamplePanelProps): ReactNode {
  const {
    examples,
    inferred,
    truncated,
    draft,
    schema,
    onDraftChange,
    saving,
    error,
    onSave,
    onDiscard,
  } = props;

  const over = truncated ? 'the items shown (more match than are shown)' : 'the items shown';
  // The member list is read once for the panel, and only when a proposed rule names a person.
  const client = useOptionalApiClient();
  const workspace = useOptionalWorkspace();
  const canName =
    client !== null &&
    workspace !== null &&
    inferred.rules.some(
      (rule) => schema.find((definition) => definition.key === rule.property)?.type === 'assignee',
    );
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-label="Filters suggested from examples"
      className={cn('flex min-w-0 flex-col gap-3 bg-surface p-3', focusRing)}
    >
      {inferred.rules.length === 0 ? (
        <SuggestionHint>
          Nothing the {examples === 1 ? 'example has' : `${String(examples)} examples share`}{' '}
          narrows
          {` ${over}`} any further, so there is no filter to suggest. Try marking fewer, or more
          alike, examples.
        </SuggestionHint>
      ) : (
        <>
          <SuggestionHint>
            {inferred.rules.length === 1
              ? 'One rule is'
              : `${String(inferred.rules.length)} rules are`}{' '}
            true of {examples === 1 ? 'the example' : `all ${String(examples)} examples`} and narrow{' '}
            {over} from {String(inferred.considered)} to {String(inferred.matching)}. They have been
            added below for you to check; nothing changes until you save.
          </SuggestionHint>
          <MemberNames enabled={canName}>
            {(memberName) => (
              <ul className="flex flex-col gap-0.5 pl-6">
                {inferred.rules.map((rule) => (
                  <li key={`${rule.property}:${rule.operator}`}>
                    <Text variant="caption" tone="muted" as="span">
                      {describeInferredRule(rule, inferred.considered, schema, memberName)}
                    </Text>
                  </li>
                ))}
              </ul>
            )}
          </MemberNames>
        </>
      )}

      <FilterRulesEditor rules={draft} schema={schema} onChange={onDraftChange} />

      {error === null ? null : (
        <Text variant="note" as="p" role="alert">
          {error}
        </Text>
      )}

      <div className="flex flex-wrap gap-2">
        <Button aria-disabled={saving} onClick={onSave}>
          {saving ? 'Saving filters' : 'Save filters'}
        </Button>
        <Button variant="secondary" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </section>
  );
}
