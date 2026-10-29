/**
 * What each view kind lets a person do to the items it shows (requirement 12).
 *
 * One table rather than a judgment per menu: the context menu, the selection bar and the
 * capability matrix in the docs all read it, so a kind added here gains or loses an action in every
 * surface at once. `drag` names what a drop changes so the view can say it before it happens.
 */
export type DragEffect = 'parent-order' | 'parent' | 'group-value' | 'row-col-values' | 'date';

export interface ViewCapabilities {
  readonly select: boolean;
  readonly move: boolean;
  readonly rename: boolean;
  readonly delete: boolean;
  readonly drag: DragEffect | null;
}

const ACTIONS: ViewCapabilities = {
  select: true,
  move: true,
  rename: true,
  delete: true,
  drag: null,
};
const NONE: ViewCapabilities = {
  select: false,
  move: false,
  rename: false,
  delete: false,
  drag: null,
};

export const VIEW_CAPABILITIES: Readonly<Record<string, ViewCapabilities>> = {
  chat: NONE,
  list: { ...ACTIONS, drag: 'parent' },
  gallery: ACTIONS,
  checklist: ACTIONS,
  board: { ...ACTIONS, drag: 'group-value' },
  matrix: { ...ACTIONS, drag: 'row-col-values' },
  calendar: { ...ACTIONS, drag: 'date' },
  timeline: ACTIONS,
  outline: { ...ACTIONS, drag: 'parent-order' },
  drive: { ...ACTIONS, rename: false },
  // Query rows are other containers' items shown in place; they keep their own location.
  query: { ...ACTIONS, select: false, move: false },
  habit_tracker: ACTIONS,
  sheet: ACTIONS,
  // These kinds draw aggregates or forms, not rows a person acts on.
  chart: NONE,
  form: NONE,
  interactive_form: NONE,
  finance: NONE,
  // A program draws its own parts; the view offers no row actions around them.
  custom: NONE,
};

export const DRAG_EFFECT_COPY: Readonly<Record<DragEffect, string>> = {
  'parent-order': 'Dropping moves the item under the target and changes its order.',
  parent: 'Drag a row onto another to put it inside.',
  'group-value': 'Dropping changes the grouping property, not the order.',
  'row-col-values': 'Dropping sets both the row and the column property.',
  date: 'Dropping changes the date property.',
};

export function capabilitiesOf(kind: string | null | undefined): ViewCapabilities {
  return (kind !== null && kind !== undefined ? VIEW_CAPABILITIES[kind] : undefined) ?? ACTIONS;
}
