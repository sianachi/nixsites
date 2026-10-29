import {
  ChartColumnBig,
  ClipboardList,
  ListChecks,
  Grid2x2,
  ListTree,
  Columns3,
  HardDrive,
  LayoutGrid,
  LayoutList,
  CalendarDays,
  ChartGantt,
  ListFilter,
  MousePointerClick,
  MessagesSquare,
  Table2,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Text } from '@nix/ui';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { ChatView } from './chat/chat-view';
import { BoardView } from './board/board-view';
import { normalizeChartView } from './chart/chart-options';
import { ChartOptionsEditor } from './chart/chart-options-editor';
import { ChartView } from './chart/chart-view';
import { ChecklistDetailChoice, ChecklistView } from './checklist/checklist-view';
import { MatrixView } from './matrix/matrix-view';
import { OutlineView } from './outline/outline-view';
import { CalendarView } from './calendar/calendar-view';
import {
  canChartBy,
  canGroupBy,
  canSectionBy,
  isDateShaped,
  TYPE_GROUP_KEY,
  valueShapeOf,
} from './core/property-types';
import {
  registerViewKinds,
  type ChoiceField,
  type ViewChoiceOf,
  type ViewKindDescriptor,
  type ViewRendererProps,
} from './core/view-kinds';
import { CARD_SIZES, DEFAULT_CARD_SIZE, type CardSize } from './gallery/card-size';
import { GalleryView } from './gallery/gallery-view';
import { DEFAULT_DRIVE_LAYOUT, DRIVE_LAYOUTS, type DriveLayout } from './drive/drive-layout';
import { DriveView } from './drive/drive-view';
import { FormView } from './form/form-view';
import { InteractiveFormEditor } from './form/interactive-form-editor';
import { InteractiveFormView } from './form/interactive-form-view';
import { ListView } from './list/list-view';
import { QueryView } from './query/query-view';
import { SpreadsheetView } from './spreadsheet/spreadsheet-view';
import { TimelineView } from './timeline/timeline-view';
import { HabitTrackerView } from './habit-tracker/habit-tracker-view';
import { FinanceView } from './finance/finance-view';

/**
 * Every kind of view under `views/`, and everything this build knows about each one. The custom
 * kind is declared beside its renderer in `openui/` and registered after these.
 *
 * **Adding a view kind is one entry in this table.** It used to be four edits that could not be
 * type-checked against each other - the kind list, an icon record, the editor's dropdown with its
 * hand-written configuration block, and a dispatch switch whose `default` case silently caught
 * anything new and drew it as a list. A kind added to three of those four compiled and shipped
 * looking like a list.
 *
 * The backend has the matching table in `backend/src/Nix.Api/Domain/Views/ViewDefinition.cs`. The
 * two are deliberately separate: the server decides what is *storable* (a board must name a
 * property to group by) and this decides what is *drawable*. They agree on the stored names and
 * nothing else, which is why an older build meeting a newer build's view says it cannot draw it
 * rather than crashing.
 *
 * There is a third per-kind table the promise does not reach: `packages/view-render/src/render.ts`
 * draws views inside exports, and a kind it has no renderer for falls back to a list with a note
 * naming the kind - honest, so a kind added to the two tables here ships without touching it. But
 * "adding a kind is one entry" is a per-table promise, not a repo-wide one; a kind that should
 * export as itself is a third entry there.
 */

/**
 * Which tokens each choosable field may take, named by the renderer that draws them.
 *
 * This is the join that used to be missing. `value` and `fallback` were plain `string`, so the
 * editor's options and the gallery's classes were two lists nothing compared - a fourth size added
 * here compiled, shipped, and drew as medium. Keying the tokens off the field makes the descriptor
 * below refuse a word the renderer has no classes for.
 */
interface ChoiceTokens {
  readonly cardSize: CardSize;
  readonly measure: ChartMeasure;
  readonly layout: DriveLayout;
}

/** A choice whose tokens are the renderer's own, so a word it has no classes for fails to compile. */
type TypedChoice<TField extends ChoiceField> = ViewChoiceOf<TField, ChoiceTokens[TField]>;

/**
 * The word a person sees for each card size.
 *
 * A `Record<CardSize, ...>` rather than a capitalisation of the stored token: the copy stays
 * written out, and a size added to `CARD_SIZES` fails to compile here until somebody says what it
 * is called. Deriving the label would have shipped a size named after its wire word instead.
 */
const CARD_SIZE_LABELS: Record<CardSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

/**
 * What a chart's bars measure.
 *
 * Two, and both always have an answer: counting needs nothing configured and totalling needs a
 * numeric property. The server's `ChartMeasures` is the authority on the tokens; this is what a
 * person chooses from, and the `ChoiceTokens` join above is what stops the two lists drifting.
 */
const CHART_MEASURES = ['count', 'sum'] as const;
type ChartMeasure = (typeof CHART_MEASURES)[number];
const DEFAULT_CHART_MEASURE: ChartMeasure = 'count';

const CHART_MEASURE_LABELS: Record<ChartMeasure, string> = {
  count: 'How many items',
  sum: 'Total of a property',
};

/** The word a person sees for each drive layout. */
const DRIVE_LAYOUT_LABELS: Record<DriveLayout, string> = {
  list: 'List',
  grid: 'Grid',
};

function ChatRenderer({ container }: ViewRendererProps): ReactNode {
  const { workspaceId } = useWorkspace();
  return container.itemId === null ? (
    <Text role="status">Create a chat note to start a conversation.</Text>
  ) : (
    <ChatView
      key={`${workspaceId}:${container.itemId}`}
      itemId={container.itemId}
      workspaceId={workspaceId}
    />
  );
}

const BUILTIN_VIEW_KINDS: readonly ViewKindDescriptor[] = [
  {
    kind: 'chat',
    label: 'Chat',
    icon: MessagesSquare,
    render: (props) => <ChatRenderer {...props} />,
    configures: [],
    chooses: [],
  },
  {
    kind: 'list',
    label: 'List',
    icon: LayoutList,
    render: (props) => <ListView {...props} />,
    renderUnconfigured: (props) => <ListView {...props} view={null} />,
    // Optional, under the board's own field name: a list switched to a board keeps its grouping
    // when it was a select, and a list with none is the plain list it always was.
    configures: [
      {
        field: 'groupBy',
        label: 'Sections',
        emptyHint:
          "There is no select or checkbox property yet. Sections can still follow each item's kind.",
        hint: 'Rows are gathered under a heading for each value, with a count, and each heading folds away.',
        emptyChoice: 'None',
        accepts: (property) => canSectionBy(property.type),
        clears: { groupOrder: [], collapsedGroups: [] },
        extraChoices: [{ value: TYPE_GROUP_KEY, label: 'Kind of item' }],
      },
    ],
    chooses: [],
    appliesSavedFilters: true,
  },
  {
    kind: 'board',
    label: 'Board',
    icon: Columns3,
    render: (props) => <BoardView {...props} />,
    configures: [
      {
        field: 'groupBy',
        label: 'Group by',
        emptyHint: 'There is no select property yet. Add one under Properties first.',
        hint: 'Only a select property can become columns.',
        emptyChoice: 'Choose a property',
        accepts: (property) => canGroupBy(property.type),
        clears: { groupOrder: [] },
      },
    ],
    chooses: [],
    appliesSavedFilters: true,
  },
  {
    kind: 'calendar',
    label: 'Calendar',
    icon: CalendarDays,
    render: (props) => <CalendarView {...props} />,
    configures: [
      {
        field: 'dateProperty',
        label: 'Place by',
        emptyHint: 'There is no date property yet. Add one under Properties first.',
        hint: 'Items appear on the day this property names.',
        emptyChoice: 'Choose a property',
        // Both, because a calendar places by either. A date is an all-day thing that must not
        // shift for a reader in another zone; a timestamp is a moment that must.
        accepts: (property) => isDateShaped(property.type),
      },
      {
        field: 'endDateProperty',
        // "End" rather than the timeline's "Ends on": the calendar's own field is "Place by", not
        // "Starts on", so the paired label has to read against that one, not the timeline's.
        label: 'End',
        // Same filtering as the timeline's own pair below: a date property distinct from the
        // start. Nothing here refuses picking the same property for both; that would need the
        // shared editor to know the view's current `dateProperty`, which is a change to
        // `structured-view-configuration.tsx`, not to this registry.
        emptyHint:
          'There is no second date property yet. Without one every item is drawn as a point rather than a span.',
        hint: 'An item with this property runs to the day or time it names, instead of appearing as a point.',
        // Not "Choose a property": a calendar of points is complete.
        emptyChoice: 'None',
        accepts: (property) => isDateShaped(property.type),
      },
    ],
    chooses: [],
    appliesSavedFilters: true,
  },
  {
    kind: 'gallery',
    label: 'Gallery',
    icon: LayoutGrid,
    render: (props) => <GalleryView {...props} />,
    configures: [
      {
        field: 'coverProperty',
        label: 'Cover',
        // Both hints say the gallery works either way, because it does. A hint telling somebody to
        // go and add a property first would be describing a board.
        //
        // "Picture" rather than "image": that is what the Properties panel calls the type, and a
        // hint naming the wire word sends somebody looking for a choice that is not in the list.
        emptyHint:
          'There is no picture property yet. Add one under Properties to give these cards covers; without one they show titles.',
        // Not "cards whose items have no picture show their title" - every card shows its title,
        // always. What a card without a value shows *as well* is a frame saying so, and promising
        // otherwise would have somebody read a grid of "No cover" frames as a fault.
        hint: 'Each card shows this picture. A card whose item has none says so.',
        // Not "Choose a property": the gallery is complete without one.
        emptyChoice: 'None',
        accepts: (property) => property.type === 'image',
      },
    ],
    chooses: [
      {
        field: 'cardSize',
        label: 'Card size',
        // In terms of what changes on screen, not in terms of the stored token: columns and cover
        // room are the two things the size actually moves.
        hint: 'Small fits more cards in a row; large gives each cover more room.',
        // The renderer's own tuple, in its own order, rather than a second list of the same words:
        // the gallery is what has classes for these tokens, so it is what says which exist.
        options: CARD_SIZES.map((value) => ({ value, label: CARD_SIZE_LABELS[value] })),
        // What a gallery that has never been asked already draws as, so the control marking it
        // current is a description rather than a change waiting to be saved. The renderer resolves
        // null to this same constant.
        fallback: DEFAULT_CARD_SIZE,
      } satisfies TypedChoice<'cardSize'>,
    ],
    appliesSavedFilters: true,
  },
  {
    kind: 'timeline',
    label: 'Timeline',
    icon: ChartGantt,
    render: (props) => <TimelineView {...props} />,
    // The first kind configured from two properties, which is what the array shape above exists
    // for. **No `clears` on either.** The start is the calendar's own `dateProperty` under the
    // calendar's own name, so switching a view between the two kinds has to carry it across
    // untouched; and the `week`/`month` grains the two share overlap on purpose, so clearing the
    // mode would throw away a choice that still means something.
    configures: [
      {
        field: 'dateProperty',
        // "Starts on" rather than the calendar's "Place by": a bar has two ends, and the pair has
        // to read as a pair in the form that sets them.
        label: 'Starts on',
        emptyHint: 'There is no date property yet. Add one under Properties first.',
        hint: 'Each bar begins on the day this property names.',
        // The view is genuinely waiting on this one: with no start there is no position, and the
        // timeline says so instead of drawing.
        emptyChoice: 'Choose a property',
        // Both, exactly as the calendar accepts both, and the server's requirement is the
        // calendar's verbatim. A date is an all-day thing that must not shift for a reader in
        // another zone; a timestamp is a moment that must.
        accepts: (property) => isDateShaped(property.type),
      },
      {
        field: 'endDateProperty',
        label: 'Ends on',
        // Neither hint sends somebody to add a property first, because the view does not need one.
        emptyHint:
          'There is no second date property yet. Without one every item is drawn as a milestone on its start day.',
        hint: 'Each bar runs to the day this property names. An item without one is a milestone.',
        // Not "Choose a property": a timeline of milestones is complete, and calling it unfinished
        // would send somebody looking for what was broken.
        emptyChoice: 'None',
        accepts: (property) => isDateShaped(property.type),
      },
    ],
    chooses: [],
    appliesSavedFilters: true,
  },
  {
    // Stored as "sheet", labelled "Spreadsheet". The body kind `item.type === 'spreadsheet'`
    // (sidebar label "Sheet") is the other axis; the stored words differ only so the wire values
    // cannot collide - the vocabulary genuinely overlaps, so mind the axis when reading a grep
    // hit. The icon is not the body's Grid3x3 for the same reason: one glyph must not mean two
    // different things in one product. Like the list, this kind needs nothing configured: columns
    // fall back to the effective schema, and titles exist with no schema at all.
    kind: 'sheet',
    label: 'Spreadsheet',
    icon: Table2,
    render: (props) => <SpreadsheetView {...props} />,
    configures: [],
    chooses: [],
    appliesSavedFilters: true,
  },
  {
    // The intake shape: the schema as fields, each submission a new child. Requirement-free by
    // the list's own fallback argument - with no columns configured the form offers the effective
    // schema, and with no schema at all it still takes a title.
    kind: 'form',
    label: 'Form',
    icon: ClipboardList,
    render: (props) => <FormView {...props} />,
    configures: [],
    chooses: [],
  },
  {
    // Stored as "query" (the contract word - Item.cs reserved the item type, and the goal text
    // says "items whose view is a query"); "Smart list" is copy. Its data is not the container's
    // children: the renderer runs the view's stored filters through the server and ignores
    // `container.children` entirely. Requirement-free because the requirement mechanism reads a
    // single string field and this kind's configuration is the filters array - policed by the
    // server on write, edited through the block `editsFilters` grants.
    kind: 'query',
    label: 'Smart list',
    icon: ListFilter,
    render: (props) => <QueryView {...props} />,
    configures: [],
    chooses: [],
    editsFilters: true,
  },
  {
    kind: 'interactive_form',
    label: 'Interactive form',
    icon: MousePointerClick,
    render: (props) => <InteractiveFormView {...props} />,
    configures: [],
    chooses: [],
    configurationEditor: ({ view, fields, onChange }) =>
      view.interactiveForm == null ? null : (
        <InteractiveFormEditor
          form={view.interactiveForm}
          schema={fields}
          itemId={null}
          viewId={view.id}
          showPublishing={false}
          onChange={(interactiveForm) => {
            onChange({ ...view, interactiveForm });
          }}
        />
      ),
  },
  {
    // The third kind whose data is not the loaded children: its buckets come from the server,
    // computed over every child, because a chart tallied from a loaded page of a large container
    // would be a picture of the first page presented as a picture of the whole.
    //
    // It groups by the property a board groups by, under the board's own field name - which is
    // what makes switching a view between the two lossless, exactly as the calendar and the
    // timeline share their date property.
    kind: 'chart',
    label: 'Chart',
    icon: ChartColumnBig,
    render: (props) => <ChartView {...props} />,
    configures: [
      {
        field: 'groupBy',
        label: 'Group by',
        emptyHint: 'There is no select or date property yet. Add one under Properties first.',
        hint: 'Each value of a select becomes a bar; a date puts the chart on a time axis.',
        // The view is genuinely waiting on this one: with nothing to group by there are no bars,
        // and the server refuses to draw rather than answering with none.
        emptyChoice: 'Choose a property',
        accepts: (property) => canChartBy(property.type),
        // A date needs a period and a select must not keep one; the chart's own settings follow
        // whichever was chosen.
        normalize: normalizeChartView,
      },
      {
        field: 'measureProperty',
        label: 'Total',
        // Neither hint sends somebody to add a property first: a chart that counts is complete.
        emptyHint:
          'There is no number property yet. Without one this chart counts items rather than totalling anything.',
        hint: 'Each bar adds up this property across the items in it.',
        emptyChoice: 'None',
        accepts: (property) =>
          property.type === 'number' ||
          property.type === 'estimate' ||
          property.type === 'priority',
      },
    ],
    chooses: [
      {
        field: 'measure',
        label: 'Bars show',
        hint: 'Counting needs nothing else chosen; totalling needs a number property to add up.',
        options: CHART_MEASURES.map((value) => ({ value, label: CHART_MEASURE_LABELS[value] })),
        // What a chart that has never been asked already draws, so the control marking it current
        // is a description rather than a change waiting to be saved.
        fallback: DEFAULT_CHART_MEASURE,
      } satisfies TypedChoice<'measure'>,
    ],
    configurationEditor: (props) => <ChartOptionsEditor {...props} />,
  },
  {
    kind: 'habit_tracker',
    label: 'Habit tracker',
    icon: ClipboardList,
    render: (props) => (
      <HabitTrackerView key={`${props.container.itemId ?? 'root'}:${props.view.id}`} {...props} />
    ),
    configures: [],
    chooses: [],
  },
  {
    // Personal finances live under one root item whose children are the accounts, budget lines
    // and transactions; the view reads Core's derived figures rather than the container's rows.
    // Requirement-free like the habit tracker: the root carries no schema and the view configures
    // itself through the finance endpoints.
    kind: 'finance',
    label: 'Finances',
    icon: Wallet,
    render: (props) => (
      <FinanceView key={`${props.container.itemId ?? 'root'}:${props.view.id}`} {...props} />
    ),
    configures: [],
    chooses: [],
  },
  {
    // Issue #54: a drive is a *view* over any container's children, not a folder kind an item can
    // be created as - the same lesson `board`/`gallery`/`chart` already teach, applied to the file
    // manager shape. Requirement-free like a list: with no schema and no configuration, a drive
    // still has titles, kinds and dates to draw. Not given a renderer in
    // `packages/view-render/src/render.ts` - that table's fallback (a list with a note naming the
    // kind) is the honest answer for an export today, and wiring a real one is separate work the
    // header comment above already calls out.
    kind: 'drive',
    label: 'Drive',
    icon: HardDrive,
    render: (props) => <DriveView {...props} />,
    configures: [],
    chooses: [
      {
        field: 'layout',
        label: 'Layout',
        hint: 'List shows a sortable table of columns; grid shows large tiles.',
        options: DRIVE_LAYOUTS.map((value) => ({ value, label: DRIVE_LAYOUT_LABELS[value] })),
        fallback: DEFAULT_DRIVE_LAYOUT,
      } satisfies TypedChoice<'layout'>,
    ],
  },
  {
    // One line per child with a box to tick (plan 3.4). Requirement-free like a list: named
    // nothing, it ticks a checkbox keyed `done` or the task completion, and with neither it says
    // so rather than drawing boxes that write nowhere. The one property shown beside each title is
    // the view's first column, chosen in the editor's own block.
    kind: 'checklist',
    label: 'Checklist',
    icon: ListChecks,
    render: (props) => <ChecklistView {...props} />,
    configures: [
      {
        field: 'doneProperty',
        label: 'Box ticks',
        emptyHint:
          'There is no checkbox property yet. Add one under Properties, or call one "done" to use it automatically.',
        hint: 'Each box ticks this property. Left on automatic, a checkbox called "done" or the task completion is used.',
        emptyChoice: 'Automatic',
        accepts: (property) => valueShapeOf(property.type) === 'checkbox',
      },
    ],
    chooses: [],
    configurationEditor: (props) => <ChecklistDetailChoice {...props} />,
    appliesSavedFilters: true,
  },
  {
    // Cards in a grid of cells (plan 3.5). Its columns are the board's own `groupBy`, so a board
    // switched to a matrix keeps them; its rows are `rowBy`. Both take a select or a checkbox.
    kind: 'matrix',
    label: 'Matrix',
    icon: Grid2x2,
    render: (props) => <MatrixView {...props} />,
    configures: [
      {
        field: 'rowBy',
        label: 'Rows',
        emptyHint: 'There is no select or checkbox property yet. Add one under Properties first.',
        hint: 'Each value of this property becomes a row.',
        emptyChoice: 'Choose a property',
        accepts: (property) => canSectionBy(property.type),
      },
      {
        field: 'groupBy',
        label: 'Columns',
        emptyHint: 'There is no select or checkbox property yet. Add one under Properties first.',
        hint: 'Each value of this property becomes a column. Choose a different one from the rows.',
        emptyChoice: 'Choose a property',
        accepts: (property) => canSectionBy(property.type),
        clears: { groupOrder: [] },
      },
    ],
    chooses: [],
    appliesSavedFilters: true,
  },
  {
    // The subtree as a tree of titles (plan 3.8), the one kind that edits structure. It reads its
    // own children level by level as rows open, so a saved filter or sort - which would hide or
    // reorder the very siblings a move is placed among - is not offered.
    kind: 'outline',
    label: 'Outline',
    icon: ListTree,
    render: (props) => (
      <OutlineView key={`${props.container.itemId ?? 'root'}:${props.view.id}`} {...props} />
    ),
    configures: [],
    chooses: [],
  },
];

/** Registers every kind that lives under `views/`, in the order the view picker offers them. */
export function registerBuiltinViews(): void {
  registerViewKinds(...BUILTIN_VIEW_KINDS);
}
