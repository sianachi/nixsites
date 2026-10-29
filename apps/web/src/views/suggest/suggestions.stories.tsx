import { useState, type ReactElement } from 'react';

import type { ViewFilterRule } from '../../collections/core/container-model';
import QueryByExamplePanel from '../query/query-by-example';
import { DuplicateNotice } from './duplicate-notice';
import { FillSeriesOffer } from '../spreadsheet/fill-series-offer';
import { FreeSlotHint } from '../calendar/free-slot-hint';
import { PropertySuggestionLine } from './property-suggestion-line';
import { StaleCardHint } from '../board/stale-card-hint';
import { UsualValueHint } from '../form/usual-value-hint';

/**
 * Every suggestion the views offer, in each of its states, so axe sees them on both grounds.
 *
 * The components are presentational on purpose - the learning, the search and the writes live in
 * their callers - so each story is the component with plain props and no providers.
 */

export default { title: 'Nix/Suggestions', parameters: { layout: 'padded' } };

const noop = (): void => undefined;
const DAY = 24 * 60 * 60 * 1000;

/** A property value offered for a new item, with the word that explains it. */
export function PropertyValueOffered(): ReactElement {
  return (
    <div className="max-w-sm">
      <PropertySuggestionLine
        state="offered"
        propertyLabel="Category"
        value="Bills"
        evidence={{ word: 'invoice', withValue: 8, withWord: 10 }}
        onAccept={noop}
      />
    </div>
  );
}

/** The same value once accepted: it will travel with the create, and can still be taken back. */
export function PropertyValueAccepted(): ReactElement {
  return (
    <div className="max-w-sm">
      <PropertySuggestionLine
        state="accepted"
        propertyLabel="Category"
        value="Bills"
        onUndo={noop}
      />
    </div>
  );
}

/** A similar item among the siblings, and one elsewhere in the workspace. */
export function SimilarItemExists(): ReactElement {
  return (
    <div className="flex max-w-sm flex-col gap-1">
      <DuplicateNotice title="Pay electricity bill" where="here" onOpen={noop} />
      <DuplicateNotice title="Renew passport" where="workspace" onOpen={noop} />
    </div>
  );
}

/** The spreadsheet's offer to continue a numbered label down the selection. */
export function FillSeries(): ReactElement {
  return (
    <FillSeriesOffer
      columnLabel="Week"
      describe="+1"
      preview={['Week 3', 'Week 4', 'Week 5', 'Week 6']}
      rows={4}
      otherColumns={1}
      shortcut="Ctrl/Cmd+Shift+D"
      onFill={noop}
      onDismiss={noop}
    />
  );
}

/** A board card untouched far longer than its column's usual. */
export function StaleCard(): ReactElement {
  return (
    <div className="max-w-xs bg-background p-3">
      <StaleCardHint
        title="Draft the brief"
        columnLabel="Doing"
        ageMs={24 * DAY}
        medianMs={3 * DAY}
        onDismiss={noop}
      />
    </div>
  );
}

/** A form field's usual value, offered and not filled in. */
export function UsualFormValue(): ReactElement {
  return (
    <div className="max-w-sm">
      <UsualValueHint fieldLabel="Category" value="Bills" valueText="Bills" onUse={noop} />
    </div>
  );
}

/** The reschedule dialog's next free slot. */
export function FreeSlot(): ReactElement {
  return (
    <div className="max-w-sm">
      <FreeSlotHint label="Thu 1 Oct, 14:00 to 15:00" onUse={noop} />
    </div>
  );
}

function ProposalHarness(props: {
  readonly empty?: boolean;
  readonly error?: string | null;
}): ReactElement {
  const [draft, setDraft] = useState<readonly ViewFilterRule[]>(
    props.empty === true ? [] : [{ property: 'category', operator: 'equals', value: 'Bills' }],
  );
  return (
    <QueryByExamplePanel
      examples={props.empty === true ? 4 : 2}
      inferred={
        props.empty === true
          ? { rules: [], matching: 4, considered: 4 }
          : {
              rules: [{ property: 'category', operator: 'equals', value: 'Bills', remaining: 2 }],
              matching: 2,
              considered: 4,
            }
      }
      truncated={false}
      draft={draft}
      schema={[]}
      onDraftChange={setDraft}
      saving={false}
      error={props.error ?? null}
      onSave={noop}
      onDiscard={noop}
    />
  );
}

/** Query by example: the proposal under review in the filter editor. */
export function QueryByExampleProposal(): ReactElement {
  return <ProposalHarness />;
}

/** Query by example when the examples share nothing that narrows the list. */
export function QueryByExampleNothingToSuggest(): ReactElement {
  return <ProposalHarness empty />;
}

/** Query by example after the save was refused. */
export function QueryByExampleRefused(): ReactElement {
  return <ProposalHarness error="A stored filter no longer validates." />;
}
