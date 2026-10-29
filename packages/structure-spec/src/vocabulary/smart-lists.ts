import type { StructureFilter, StructureView } from '../types.js';

/**
 * The shipped smart-list starting points - a registry in the `templates.ts` shape (ADR-0014):
 * presets this build offers, not user-saved artifacts. Applying one creates an item of type
 * `query` and stores a single query view on it; from there it is an ordinary item whose filters
 * are edited like any view configuration.
 *
 * **The property keys are reserved, not conventions.** Goal 3.1 (ADR-0042) ships task semantics
 * as first-class property types whose key always equals the type's stored name: the due date is
 * always keyed `due_date`, completion is always `completion`. That is exactly what lets a
 * cross-workspace smart list compile one statement over every readable workspace - there is one
 * key to name, not each workspace's own convention. A workspace whose schema does not yet carry
 * the matching task type edits the filters after applying; the preset is a starting point, not a
 * schema.
 *
 * **Assigned to me names the literal token `me`, never a resolved identifier.** Goal 3.5 adds
 * `assignee`, a principal-typed property; the server resolves `me` to the calling principal when
 * the query runs. Resolving it client-side and saving a concrete identifier instead would make a
 * saved smart list mean "assigned to whoever saved it" for every person who later opens it - a
 * different feature, and a bug, not a convenience.
 *
 * `applySmartList` (which needs a `NixClient` to store the view) stays in
 * `packages/web-views/src/query/smart-lists.ts`, which re-exports everything here and adds it.
 */

export interface SmartListPreset {
  readonly id: string;
  readonly label: string;

  /** What the preset is for, shown beside the label wherever it is offered. */
  readonly detail: string;

  /** The item's own title once created. */
  readonly title: string;

  readonly filters: readonly StructureFilter[];
}

export const SMART_LISTS: readonly SmartListPreset[] = [
  {
    id: 'today',
    label: 'Today',
    detail: 'Everything due today, wherever it lives.',
    title: 'Today',
    filters: [{ property: 'due_date', operator: 'on', value: 'today' }],
  },
  {
    id: 'next-seven-days',
    label: 'Next 7 days',
    detail: 'Everything due within a week, today included.',
    title: 'Next 7 days',
    filters: [{ property: 'due_date', operator: 'within-next', value: '7' }],
  },
  {
    id: 'overdue',
    label: 'Overdue',
    detail: 'Everything past due and not done.',
    title: 'Overdue',
    filters: [
      { property: 'due_date', operator: 'before', value: 'today' },
      { property: 'completion', operator: 'not-equals', value: 'true' },
    ],
  },
  {
    id: 'assigned-to-me',
    label: 'Assigned to me',
    detail: 'Everything assigned to you, wherever it lives.',
    title: 'Assigned to me',
    filters: [
      // 'me' is a token the server resolves to the calling principal when the query runs - never
      // resolve it here and never send a concrete identifier. Doing so would bake in whichever
      // person applied the preset, so everyone else who opens the resulting smart list would see
      // that person's work instead of their own.
      { property: 'assignee', operator: 'equals', value: 'me' },
    ],
  },
];

export function findSmartList(id: string): SmartListPreset | null {
  return SMART_LISTS.find((preset) => preset.id === id) ?? null;
}

/** The one query view a preset stores, with the view opening by default. */
export function smartListView(preset: SmartListPreset): StructureView {
  return {
    id: 'query',
    name: preset.label,
    kind: 'query',
    columns: [],
    groupBy: null,
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [...preset.filters],
  };
}
