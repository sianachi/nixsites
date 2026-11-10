import type { StructureFilter, StructureForm, StructureProperty, StructureView } from '../types.js';
import { SMART_LISTS } from './smart-lists.js';

export type StructuredRecipeId =
  | 'board'
  | 'calendar'
  | 'timeline'
  | 'gallery'
  | 'sheet'
  | 'form'
  | 'interactive-form'
  | 'query'
  | 'chart'
  | 'list'
  | 'drive'
  | 'habit-tracker'
  | 'checklist'
  | 'matrix'
  | 'outline';

export type RecipeGroup = 'Organise' | 'Track' | 'Collect' | 'Analyse' | 'Life';

/** The New menu's headings, in display order. */
export const RECIPE_GROUPS: readonly RecipeGroup[] = [
  'Organise',
  'Track',
  'Collect',
  'Analyse',
  'Life',
];

export interface StructuredRecipe {
  readonly id: StructuredRecipeId;
  readonly label: string;
  readonly detail: string;
  readonly menu: 'structured' | 'view';
  /** The heading the New menu lists the recipe under. */
  readonly group: RecipeGroup;
  readonly viewKind: string;
  readonly defaultTitle: string;
  readonly defaultViewName: string;
  readonly properties: readonly StructureProperty[];
  readonly filters?: readonly StructureFilter[];
}

const STATUS: StructureProperty = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['To do', 'Doing', 'Done'],
  required: false,
};

const STARTS: StructureProperty = {
  key: 'starts',
  label: 'Starts',
  type: 'timestamp',
  options: [],
  required: false,
};

export const STRUCTURED_RECIPES: readonly StructuredRecipe[] = [
  {
    id: 'board',
    label: 'Board',
    detail: 'Arrange items in columns defined by a select field.',
    menu: 'structured',
    group: 'Organise',
    viewKind: 'board',
    defaultTitle: 'Untitled board',
    defaultViewName: 'Board',
    properties: [STATUS],
  },
  {
    id: 'timeline',
    label: 'Timeline',
    detail: 'Plan work across start and optional end dates.',
    menu: 'structured',
    group: 'Track',
    viewKind: 'timeline',
    defaultTitle: 'Untitled timeline',
    defaultViewName: 'Timeline',
    properties: [
      STARTS,
      { key: 'ends', label: 'Ends', type: 'timestamp', options: [], required: false },
    ],
  },
  {
    id: 'gallery',
    label: 'Gallery',
    detail: 'Show child items as visual cards with optional covers.',
    menu: 'structured',
    group: 'Collect',
    viewKind: 'gallery',
    defaultTitle: 'Untitled gallery',
    defaultViewName: 'Gallery',
    properties: [{ key: 'cover', label: 'Cover', type: 'image', options: [], required: false }],
  },
  {
    id: 'sheet',
    label: 'Spreadsheet view',
    detail: 'Edit child items in a property-backed grid.',
    menu: 'structured',
    group: 'Collect',
    viewKind: 'sheet',
    defaultTitle: 'Untitled table',
    defaultViewName: 'Spreadsheet',
    properties: [
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: ['Open', 'Done'],
        required: false,
      },
      { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
    ],
  },
  {
    id: 'form',
    label: 'Quick form',
    detail: 'Collect authenticated responses in one straightforward page.',
    menu: 'structured',
    group: 'Collect',
    viewKind: 'form',
    defaultTitle: 'Untitled quick form',
    defaultViewName: 'Form',
    properties: [{ key: 'response', label: 'Response', type: 'text', options: [], required: true }],
  },
  {
    id: 'interactive-form',
    label: 'Interactive form',
    detail: 'Build a multi-page form with branching and an optional public link.',
    menu: 'structured',
    group: 'Collect',
    viewKind: 'interactive_form',
    defaultTitle: 'Untitled interactive form',
    defaultViewName: 'Form',
    properties: [
      { key: 'response', label: 'Response', type: 'text', options: [], required: false },
    ],
  },
  {
    id: 'query',
    label: 'Smart list',
    detail: 'Find matching items across the workspace with reusable rules.',
    menu: 'structured',
    group: 'Analyse',
    viewKind: 'query',
    defaultTitle: 'Untitled smart list',
    defaultViewName: 'Results',
    properties: [],
  },
  {
    id: 'chart',
    label: 'Chart',
    detail: 'Count or total items by a field, as bars, columns, a pie or a line over time.',
    menu: 'structured',
    group: 'Analyse',
    viewKind: 'chart',
    defaultTitle: 'Untitled chart',
    defaultViewName: 'Chart',
    properties: [STATUS],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    detail: 'Place child items on a day, week, or month calendar.',
    menu: 'view',
    group: 'Track',
    viewKind: 'calendar',
    defaultTitle: 'Untitled calendar',
    defaultViewName: 'Calendar',
    properties: [STARTS],
  },
  {
    id: 'list',
    label: 'List',
    detail: 'Show child items and their fields in an ordered list.',
    menu: 'view',
    group: 'Organise',
    viewKind: 'list',
    defaultTitle: 'Untitled list',
    defaultViewName: 'All',
    properties: [
      { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
      { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
    ],
  },
  {
    id: 'checklist',
    label: 'Checklist',
    detail: 'Tick child items off one line at a time, with progress.',
    menu: 'view',
    group: 'Organise',
    viewKind: 'checklist',
    defaultTitle: 'Untitled checklist',
    defaultViewName: 'Checklist',
    properties: [{ key: 'done', label: 'Done', type: 'checkbox', options: [], required: false }],
  },
  {
    id: 'matrix',
    label: 'Matrix',
    detail: 'Place cards in a grid by two select fields, such as urgency and importance.',
    menu: 'view',
    group: 'Organise',
    viewKind: 'matrix',
    defaultTitle: 'Untitled matrix',
    defaultViewName: 'Matrix',
    properties: [
      {
        key: 'urgency',
        label: 'Urgency',
        type: 'select',
        options: ['Urgent', 'Not urgent'],
        required: false,
      },
      {
        key: 'importance',
        label: 'Importance',
        type: 'select',
        options: ['Important', 'Not important'],
        required: false,
      },
    ],
  },
  {
    id: 'outline',
    label: 'Outline',
    detail: 'Shape the items inside as a tree of titles: add, indent and reorder by keyboard.',
    menu: 'view',
    group: 'Organise',
    viewKind: 'outline',
    defaultTitle: 'Untitled outline',
    defaultViewName: 'Outline',
    properties: [],
  },
  {
    id: 'drive',
    label: 'Drive',
    detail: 'Files and pages inside this item as a sortable list or a grid, with bulk actions.',
    // In the sidebar's "New" menu as well as the Views pane: a drive is a thing a team makes
    // on purpose, the way it makes a board, not only a way of looking at something it has.
    menu: 'structured',
    group: 'Collect',
    viewKind: 'drive',
    defaultTitle: 'Untitled drive',
    defaultViewName: 'Drive',
    // No properties: a drive reads what an item already is - its kind, size and date - and
    // asks nothing of its schema, which is what lets it sit on a folder of plain files.
    properties: [],
  },
  {
    id: 'habit-tracker',
    label: 'Habit tracker',
    detail: 'Track daily or weekday habits with a simple weekly check-in grid.',
    menu: 'structured',
    group: 'Life',
    viewKind: 'habit_tracker',
    defaultTitle: 'Untitled habit tracker',
    defaultViewName: 'Habits',
    properties: [],
  },
];

export function findStructuredRecipe(id: string | undefined): StructuredRecipe | null {
  return STRUCTURED_RECIPES.find((recipe) => recipe.id === id) ?? null;
}

export function keyForProperty(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'field'
  );
}

export function defaultInteractiveForm(
  property: StructureProperty = {
    key: 'response',
    label: 'Response',
    type: 'text',
    options: [],
    required: false,
  },
): StructureForm {
  return {
    pages: [
      {
        id: 'page-1',
        title: 'Your response',
        description: null,
        visibleWhen: [],
        blocks: [
          {
            id: 'field-response',
            kind: 'field',
            propertyKey: property.key,
            text: property.label,
            help: null,
            required: property.required,
            identityRole: null,
            visibleWhen: [],
          },
        ],
      },
    ],
    titleMode: 'generated',
    titleFieldBlockId: null,
    confirmationTitle: 'Response received',
    confirmationMessage: 'Your response has been added.',
  };
}

export function viewForRecipe(
  recipe: StructuredRecipe,
  properties: readonly StructureProperty[],
): StructureView {
  const first = properties[0];
  const second = properties[1];
  const id = recipe.viewKind === 'interactive_form' ? 'form' : recipe.viewKind;
  return {
    id,
    name: recipe.defaultViewName,
    kind: recipe.viewKind,
    // A checklist shows one property beside each title, and starts with none rather than all.
    columns:
      recipe.viewKind === 'checklist'
        ? []
        : ['title', ...properties.map((property) => property.key)],
    // A matrix's columns are the board's field, so both seed it from the first property.
    // A chart buckets by its first property the way a board columns by it.
    groupBy:
      recipe.viewKind === 'board' || recipe.viewKind === 'matrix' || recipe.viewKind === 'chart'
        ? (first?.key ?? null)
        : null,
    groupOrder:
      recipe.viewKind === 'board' || recipe.viewKind === 'matrix'
        ? [...(first?.options ?? [])]
        : [],
    dateProperty:
      recipe.viewKind === 'calendar' || recipe.viewKind === 'timeline'
        ? (first?.key ?? null)
        : null,
    sortBy: null,
    sortDescending: false,
    mode: recipe.viewKind === 'calendar' ? 'week' : recipe.viewKind === 'timeline' ? 'month' : null,
    coverProperty: recipe.viewKind === 'gallery' ? (first?.key ?? null) : null,
    endDateProperty: recipe.viewKind === 'timeline' ? (second?.key ?? null) : null,
    cardSize: recipe.viewKind === 'gallery' ? 'medium' : null,
    layout: recipe.viewKind === 'drive' ? 'list' : null,
    filters: [...(recipe.filters ?? [])],
    companionViewId: null,
    companionPlacement: null,
    interactiveForm: recipe.viewKind === 'interactive_form' ? defaultInteractiveForm(first) : null,
    doneProperty: recipe.viewKind === 'checklist' ? (first?.key ?? null) : null,
    rowBy: recipe.viewKind === 'matrix' ? (second?.key ?? null) : null,
  };
}

/**
 * The Smart list wizard's date/assignment shortcuts, reusing the shipped presets in
 * `smart-lists.ts` rather than restating their rules - the wizard's shortcut and the "apply to an
 * existing item" preset must name the same reserved keys (ADR-0042), so one registry is the
 * source and the other re-exports it instead of drifting a second copy.
 */
export const SMART_LIST_STARTERS: readonly {
  readonly id: string;
  readonly label: string;
  readonly filters: readonly StructureFilter[];
}[] = SMART_LISTS;
