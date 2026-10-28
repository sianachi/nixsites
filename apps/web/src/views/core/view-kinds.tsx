import {
  ChartColumnBig,
  ClipboardList,
  Code2,
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
import type { LucideIcon } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';

import { Text } from '@nix/ui';
import { useWorkspace } from '../../workspaces/workspace-context';
import { ChatView } from '../chat/chat-view';
import { BoardView } from '../board/board-view';
import { normalizeChartView } from '../chart/chart-options';
import { ChartView } from '../chart/chart-view';
import { ChecklistView } from '../checklist/checklist-view';
import { MatrixView } from '../matrix/matrix-view';
import { OutlineView } from '../outline/outline-view';
import { CalendarView } from '../calendar/calendar-view';
import type { PropertyDefinition, View } from './container-model';
import {
  canChartBy,
  canGroupBy,
  canSectionBy,
  isDateShaped,
  TYPE_GROUP_KEY,
  valueShapeOf,
} from './property-types';
import { CARD_SIZES, DEFAULT_CARD_SIZE, GalleryView, type CardSize } from '../gallery/gallery-view';
import {
  DEFAULT_DRIVE_LAYOUT,
  DRIVE_LAYOUTS,
  DriveView,
  type DriveLayout,
} from '../drive/drive-view';
import { FormView } from '../form/form-view';
import { InteractiveFormView } from '../form/interactive-form-view';
import { ListView } from '../list/list-view';
import { QueryView } from '../query/query-view';
import { SpreadsheetView } from '../spreadsheet/spreadsheet-view';
import { TimelineView } from '../timeline/timeline-view';
import { HabitTrackerView } from '../habit-tracker/habit-tracker-view';
import { FinanceView } from '../finance/finance-view';
import type { ContainerData } from './use-container';

// The OpenUI renderer is its own chunk, loaded only when a custom view is opened.
const CustomView = lazy(() => import('../../openui/custom-view'));

/**
 * Every kind of view this build can draw, and everything it knows about each one.
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
 * What every renderer is handed.
 *
 * The three renderers were structurally similar and had no shared type, so nothing checked that a
 * fourth would fit. `view` is non-nullable here: the unconfigured case is not a kind and is handled
 * once, by the caller, rather than by every renderer accepting a null it mostly ignores.
 */
export interface ViewRendererProps {
  readonly container: ContainerData;
  readonly view: View;
  readonly onOpen: (itemId: string) => void;
}

/**
 * One property a kind can be configured from, and which properties will serve.
 *
 * A list needs none - with no columns configured it falls back to the effective schema, and with no
 * schema at all it still has titles to show - which is why a kind's list of these may be empty
 * rather than every kind carrying a vacuous one.
 */
export interface ViewConfiguration {
  /** The field on the view that names the property. */
  readonly field:
    | 'groupBy'
    | 'dateProperty'
    | 'coverProperty'
    | 'endDateProperty'
    | 'measureProperty'
    | 'doneProperty'
    | 'rowBy';

  readonly label: string;

  /** Said when the schema offers nothing this kind can use. */
  readonly emptyHint: string;

  /** Said when it does. */
  readonly hint: string;

  /**
   * What the "nothing chosen" option is called.
   *
   * **The copy itself, not a flag that picks between two spellings of it.** This began as
   * `optional?: boolean`, which was three states - true, false, absent - standing in for a
   * two-state decision, forced the editor to test `=== true`, and made a test assert the *absence
   * of a key* rather than a piece of wording. Holding the label removes the branch, removes the
   * defensiveness, and puts this kind's copy in the registry beside the rest of its copy.
   *
   * The distinction it carries: "Choose a property" for something the view is waiting on, "None"
   * for something the view is complete without. A gallery offered "Choose a property" would read as
   * unfinished, and somebody would go looking for what was broken.
   *
   * It says nothing about validation. The server decides what is storable and each renderer decides
   * what it can draw; a third opinion here could only disagree with one of them.
   */
  readonly emptyChoice: string;

  /** Which declared properties may be chosen. */
  readonly accepts: (property: PropertyDefinition) => boolean;

  /**
   * Fields that stop meaning anything when the chosen property changes.
   *
   * A board's column order belonged to the old property; carried across, it would filter the new
   * one down to values it does not have.
   */
  readonly clears?: Partial<View>;

  /**
   * Choices offered after the properties that are not properties themselves - a list's sections by
   * body kind, stored under the reserved `$type` key. Empty or absent for every kind whose
   * configuration is only ever a property.
   */
  readonly extraChoices?: readonly { readonly value: string; readonly label: string }[];

  /**
   * Brings the rest of the view back in line once the property is chosen, for a kind whose other
   * settings depend on what kind of property it is - a chart grouped by a date needs a period, and
   * one grouped by a select must not keep one. Applied after `clears`.
   */
  readonly normalize?: (view: View, fields: readonly PropertyDefinition[]) => View;
}

/**
 * One closed-set choice a kind offers, and the tokens it may take.
 *
 * The sibling of {@link ViewConfiguration} for the fields that are not properties: a card size is
 * not a key into the schema, so a property `<Select>` filtered by `accepts` has nothing to offer
 * it. The set is closed and small - which is `<Segmented>`'s territory - and the server refuses a
 * token outside it, so the options here are the contract's words and not a suggestion.
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

type ChoiceField = keyof ChoiceTokens;

interface ViewChoiceOf<TField extends ChoiceField, TToken extends string> {
  /** The field on the view that stores the chosen token. */
  readonly field: TField;

  readonly label: string;

  /** Guidance under the control, said in terms of what changes on screen. */
  readonly hint: string;

  /** The tokens, in the order offered, each with the word a person sees. */
  readonly options: readonly { readonly value: TToken; readonly label: string }[];

  /**
   * The token a null field draws as, shown as current until somebody chooses.
   *
   * Null and this token render identically, so the control marking it current is the truth rather
   * than a claim about what is stored: choosing it explicitly changes nothing anybody can see.
   */
  readonly fallback: TToken;
}

type ViewChoice = {
  [TField in ChoiceField]: ViewChoiceOf<TField, ChoiceTokens[TField]>;
}[ChoiceField];

export interface ViewKindDescriptor {
  /** The name this kind is stored and published under. */
  readonly kind: string;

  /** What a person sees in the switcher and the editor. */
  readonly label: string;

  readonly icon: LucideIcon;

  readonly render: (props: ViewRendererProps) => ReactNode;

  /**
   * Every property this kind can be configured from, in the order the editor should offer them.
   *
   * **An array from the start, not a single slot that grows one later.** This was `ViewConfiguration
   * | null`, which was true of the three kinds that existed and was a shape rather than a rule: the
   * table's whole stated purpose is that adding a kind is one entry, and a shape that forces a type
   * change on the next kind fails that purpose whether or not the kind that trips it has landed yet.
   *
   * **What this actually buys, stated honestly, because the overclaim is tempting.** It makes the
   * editor's configuration block per-*property* rather than per-*kind*, so a kind needing two
   * properties - the timeline, with a start and an end - costs no change here and no second copy of
   * that block. It does *not* make a kind that needs a brand-new field cheap, and the timeline is
   * the receipt: `endDateProperty` had to be threaded through the `field` union below, the Zod
   * schema, the view record and its two contracts, the stored-JSON reader and writer, the OpenAPI
   * document, the generated client and every fixture. That threading is the cost of the flat view
   * record, which `ViewDefinition.cs` justifies on its own terms; changing it is an ADR, not a
   * refactor.
   *
   * Empty for a list, which needs nothing configured to draw.
   */
  readonly configures: readonly ViewConfiguration[];

  /**
   * The closed-set choices this kind offers, in the order the editor should offer them.
   *
   * Empty for every kind whose look is not adjustable, which keeps "adding a kind is one entry"
   * true for this axis the same way `configures` keeps it true for properties.
   */
  readonly chooses: readonly ViewChoice[];

  /**
   * Whether the editor offers this kind the filter-rules block.
   *
   * A capability flag rather than a `kind === 'query'` check in the editor, so "adding a kind is
   * one entry" survives the first kind whose configuration is neither a property slot nor a
   * closed token. The block itself lives with the query feature; the registry only says who gets
   * it.
   */
  readonly editsFilters?: true;

  /**
   * Whether this kind applies the filters saved on it to its own children (ADR-0054), and so
   * whether the editor offers them. A kind whose renderer ignores them - a chart's bars are counted
   * on the server without them - must not offer rules that would change nothing on screen.
   */
  readonly appliesSavedFilters?: true;
}

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

export const VIEW_KINDS: readonly ViewKindDescriptor[] = [
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
      },
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
      },
    ],
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
      },
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
  {
    // A program stored in the view and drawn by the browser (ADR-0066). Its own editing lives in
    // the view editor, and exports and published sites fall back to a list: they never run it.
    kind: 'custom',
    label: 'Custom',
    icon: Code2,
    render: (props) => (
      <Suspense fallback={<Text role="status">Loading the view…</Text>}>
        <CustomView key={`${props.container.itemId ?? 'root'}:${props.view.id}`} {...props} />
      </Suspense>
    ),
    configures: [],
    chooses: [],
  },
];

/**
 * What this build knows about a kind, or nothing at all.
 *
 * Returning null rather than a fallback is the whole fail-closed behaviour: a view written by a
 * newer build is reported as undrawable and left untouched, never quietly rendered as something
 * else. The `default` case this replaces did exactly that.
 */
export function findViewKind(kind: string): ViewKindDescriptor | null {
  return VIEW_KINDS.find((descriptor) => descriptor.kind === kind) ?? null;
}

/** Whether this build can draw a kind. */
export function isKnownViewKind(kind: string): boolean {
  return findViewKind(kind) !== null;
}
