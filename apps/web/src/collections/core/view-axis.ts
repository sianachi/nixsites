import {
  readSelectValue,
  type Item,
  type PropertyDefinition,
  type PropertyValue,
} from './container-model';
import { canSectionBy, propertyTypeWord, TYPE_GROUP_KEY } from './property-types';

/**
 * One way of sorting a container's children into a small, closed set of groups: the sections of a
 * grouped list, and each of a matrix's two axes.
 *
 * The board resolves its columns with its own `resolveGrouping`, which is select-only by design
 * until it can draw the other shapes (ADR-0054). A section heading and a matrix cell can already
 * draw a checkbox's two values and a body kind honestly, so this is the wider of the two and
 * leaves the board's rule alone rather than widening it underneath it.
 *
 * **A group is named by a string, and the empty string is "no value".** That is the convention a
 * view's stored `collapsedGroups` already uses (ADR-0054), so a section folded here and a section
 * folded by any other build agree on what they name.
 */
export interface ViewAxis {
  /** The grouping key the view stores: a property key, or {@link TYPE_GROUP_KEY}. */
  readonly key: string;

  /** What the axis is called in a sentence: the property's label, or "Kind". */
  readonly label: string;

  /** The property behind the axis, or null for the body-kind axis, which names none. */
  readonly property: PropertyDefinition | null;

  /** The group an item belongs to. Never absent: an item with no value is in the "" group. */
  readonly groupOf: (item: Item) => string;

  /** What a group is called on screen. */
  readonly labelOf: (group: string) => string;

  /** The groups this axis knows before looking at any item, in their declared order. */
  readonly declared: readonly string[];

  /**
   * The property value that puts an item in a group, or undefined when the axis is not a property
   * and so cannot be written - an item's body kind is not changed by dragging it.
   */
  readonly valueFor: ((group: string) => PropertyValue) | undefined;
}

/** Why an axis could not be resolved, as data so the sentence can name the actual problem. */
export type ViewAxisResolution =
  | { readonly kind: 'ready'; readonly axis: ViewAxis }
  | { readonly kind: 'unset' }
  | { readonly kind: 'missing'; readonly key: string }
  | { readonly kind: 'wrongType'; readonly property: PropertyDefinition };

/** The group for "no value" - the convention `collapsedGroups` already stores. */
const NO_VALUE_GROUP = '';

const CHECKED = 'true';
const UNCHECKED = 'false';

/**
 * Resolves a stored grouping key against the schema in force.
 *
 * `allowType` decides whether {@link TYPE_GROUP_KEY} is accepted: a list may section by body kind,
 * but a matrix moves cards by writing both axes, and a body kind is not something a drag can write.
 */
export function resolveViewAxis(
  properties: readonly PropertyDefinition[],
  key: string | null | undefined,
  options: { readonly allowType: boolean },
): ViewAxisResolution {
  if (key === null || key === undefined || key.length === 0) {
    return { kind: 'unset' };
  }

  if (key === TYPE_GROUP_KEY) {
    return options.allowType ? { kind: 'ready', axis: typeAxis() } : { kind: 'missing', key };
  }

  const property = properties.find((candidate) => candidate.key === key);
  if (property === undefined) {
    return { kind: 'missing', key };
  }
  if (!canSectionBy(property.type)) {
    return { kind: 'wrongType', property };
  }

  return {
    kind: 'ready',
    axis: property.type === 'select' ? selectAxis(property) : checkboxAxis(property),
  };
}

function selectAxis(property: PropertyDefinition): ViewAxis {
  return {
    key: property.key,
    label: property.label,
    property,
    groupOf: (item) => readSelectValue(item, property.key) ?? NO_VALUE_GROUP,
    labelOf: (group) => (group === NO_VALUE_GROUP ? `No ${property.label.toLowerCase()}` : group),
    declared: property.options,
    valueFor: (group) => (group === NO_VALUE_GROUP ? null : group),
  };
}

/**
 * A checkbox (or a task's completion) as two groups. Unchecked and never set are one group, not
 * two: a checkbox nobody has ticked is unticked, and a third "no value" heading would split one
 * fact across two places.
 */
function checkboxAxis(property: PropertyDefinition): ViewAxis {
  return {
    key: property.key,
    label: property.label,
    property,
    groupOf: (item) => (item.properties[property.key] === true ? CHECKED : UNCHECKED),
    labelOf: (group) =>
      group === CHECKED ? property.label : `Not ${property.label.toLowerCase()}`,
    declared: [UNCHECKED, CHECKED],
    valueFor: (group) => group === CHECKED,
  };
}

function typeAxis(): ViewAxis {
  return {
    key: TYPE_GROUP_KEY,
    label: 'Kind',
    property: null,
    groupOf: (item) => item.type,
    labelOf: driveBodyKindLabel,
    declared: [],
    valueFor: undefined,
  };
}

/** One group of items, ready to draw. */
export interface AxisGroup {
  readonly group: string;
  readonly label: string;
  readonly items: readonly Item[];
}

/**
 * The groups an axis puts items into, in order: the view's own order when it names one, the
 * axis's declared order otherwise, then any value the items carry that neither names (in the order
 * first met), and the "no value" group last.
 *
 * **Every item lands somewhere.** A board hides a card whose value is not one of its chosen columns
 * and says so; a list or a matrix has no reason to, because a section for an unexpected value costs
 * nothing and an item missing from a list is the most alarming thing a list can do.
 *
 * `keepEmpty` keeps the declared groups that hold nothing - a matrix's "show empty" - and is off for
 * a list, where a heading over nothing is noise.
 */
export function groupItems(
  axis: ViewAxis,
  items: readonly Item[],
  order: readonly string[] = [],
  keepEmpty = false,
): readonly AxisGroup[] {
  const buckets = new Map<string, Item[]>();
  for (const item of items) {
    const group = axis.groupOf(item);
    const bucket = buckets.get(group);
    if (bucket === undefined) {
      buckets.set(group, [item]);
    } else {
      bucket.push(item);
    }
  }

  const chosen = order.length > 0 ? order : axis.declared;
  const sequence = [
    ...new Set([
      ...chosen.filter((group) => group !== NO_VALUE_GROUP),
      ...[...buckets.keys()].filter((group) => group !== NO_VALUE_GROUP),
      NO_VALUE_GROUP,
    ]),
  ];

  return sequence.flatMap((group) => {
    const groupItems = buckets.get(group) ?? [];
    const declared = chosen.includes(group);
    if (groupItems.length === 0 && !(keepEmpty && (declared || group === NO_VALUE_GROUP))) {
      return [];
    }
    return [{ group, label: axis.labelOf(group), items: groupItems }];
  });
}

/** The sentence a view says when its configured axis cannot be used. */
export function describeAxisProblem(
  resolution: Exclude<ViewAxisResolution, { kind: 'ready' }>,
  role: string,
): string {
  switch (resolution.kind) {
    case 'unset':
      return `Choose a property for its ${role} in this view's settings.`;
    case 'missing':
      return `Its ${role} came from a property that is no longer here. Choose another in this view's settings.`;
    case 'wrongType':
      return `Its ${role} come from "${resolution.property.label}", a ${propertyTypeWord(resolution.property.type)} property; only a select or a checkbox can make ${role}.`;
  }
}

/**
 * The word a person sees in a body kind's own name.
 *
 * Not used for files, which name themselves after their extension instead (see `drive-file-info`) -
 * "kind" for a file means what is inside it, and an item's body kind ("file") says nothing about
 * that.
 */
export function driveBodyKindLabel(type: string): string {
  switch (type) {
    case 'note':
      return 'Note';
    case 'canvas':
      return 'Canvas';
    case 'spreadsheet':
      return 'Spreadsheet';
    case 'artifact':
      return 'Artifact';
    case 'file':
      return 'File';
    default:
      return type.length === 0 ? 'Item' : type.slice(0, 1).toUpperCase() + type.slice(1);
  }
}
