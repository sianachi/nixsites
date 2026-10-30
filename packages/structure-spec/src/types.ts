/**
 * The structural shapes this package's vocabulary and compiler traffic in.
 *
 * These mirror `packages/web-collections/src/core/container-model.ts`'s `PropertyDefinition`, form types
 * and `View` field for field - same names, same shapes, same optionality - so a value built here
 * is assignable to the web type and a web value is assignable back, without either side importing
 * the other. `apps/web/src/tests/views/structure-spec-contract.test.ts` asserts that mutual
 * assignability at compile time: a renamed or narrowed field on either side fails typecheck there.
 * It is not exact type equality - an optional field added to only one side would still pass - so
 * a field added here still needs a human to notice it belongs on both sides.
 *
 * Deliberately no `readonly` array types (`string[]`, not `readonly string[]`): the web types are
 * `z.infer` results and hold mutable arrays, and a `readonly string[]` here would not be
 * assignable back to that mutable array type, breaking the tie in one direction.
 *
 * This package may depend only on `zod` and `@nix/sheet` (see
 * `docs/adr/0050-companion-structure-tools-compile-declarative-specs.md`), so it cannot import the
 * web's Zod-parsed contract types directly - `container-model.ts` is tied to `@nix/api-client`,
 * and `@nix/structure-spec` must stay outside that dependency graph. This boundary is not checked
 * by the compiler; `package-boundary.test.ts` reads this package's own `package.json` and fails
 * if a runtime dependency other than `zod` or `@nix/sheet` is ever added.
 */

/** A property definition, as `packages/web-collections/src/core/container-model.ts`'s `PropertyDefinition`. */
export interface StructureProperty {
  key: string;
  label: string;
  type: string;
  options: string[];
  choiceSource?: { itemId: string | null; field: string } | null | undefined;
  required: boolean;
  expression?: string | null;
  aggregate?: string | null;
  source?: string | null;
}

/**
 * The schema in force on an item: its effective properties and whether it inherits.
 *
 * Deliberately narrower than `container-model.ts`'s `EffectiveSchema`, which also carries
 * `declared` (the item's own properties before inheritance is merged in): the compiler this
 * package builds (task A.1b onward) only ever needs the effective set and the inherit flag, so
 * `declared` is left out rather than carried unused. `structure-spec-contract.test.ts` ties this
 * type to `Pick<EffectiveSchema, 'properties' | 'inherit'>`, not to the whole of `EffectiveSchema`.
 */
export interface StructureSchema {
  properties: StructureProperty[];
  inherit: boolean;
}

/** One condition gating a form block or page, as `container-model.ts`'s `FormCondition`. */
export interface StructureFormCondition {
  fieldBlockId: string;
  operator: string;
  value: string | null;
}

/** One block of a form page, as `container-model.ts`'s `FormBlock`. */
export interface StructureFormBlock {
  id: string;
  kind: string;
  propertyKey: string | null;
  text: string;
  help: string | null;
  required: boolean;
  identityRole: string | null;
  visibleWhen: StructureFormCondition[];
}

/** One page of a form, as `container-model.ts`'s `FormPage`. */
export interface StructureFormPage {
  id: string;
  title: string;
  description: string | null;
  visibleWhen: StructureFormCondition[];
  blocks: StructureFormBlock[];
}

/** A whole interactive form, as `container-model.ts`'s `InteractiveFormDefinition`. */
export interface StructureForm {
  pages: StructureFormPage[];
  titleMode: string;
  titleFieldBlockId: string | null;
  confirmationTitle: string;
  confirmationMessage: string;
}

/** One habit progress widget embedded in a habit tracker view, as `container-model.ts`'s `View['habitWidgets']`. */
export interface StructureHabitWidget {
  id: string;
  kind: 'completion' | 'quantity' | 'heatmap';
  habitId: string;
  from: string;
  to: string;
}

/** One condition of a query view, as `container-model.ts`'s `ViewFilterCondition`. */
export interface StructureFilter {
  property: string;
  operator: string;
  value: string;
}

/**
 * An "any of" group: matches when at least one of its conditions does. One level only - a group
 * holds plain conditions - and its conditions count toward the eight-filter ceiling
 * (`QueryRules` in `backend/src/Nix.Api/Domain/Views/QueryRules.cs`).
 */
export interface StructureFilterGroup {
  /** Always null: a group has no condition of its own, only `any`. Core omits the three on write. */
  property: null;
  operator: null;
  value: null;
  any: StructureFilter[];
}

/** One entry of a view's filters: a condition, or an "any of" group of conditions. */
export type StructureFilterEntry = StructureFilter | StructureFilterGroup;

/**
 * A chart view's type, time axis, series and window, as Core's `ChartOptionsContract`. Every field
 * is present and nullable, the shape the web's parsed view carries: null draws what a chart with
 * nothing configured draws.
 */
export interface StructureChartOptions {
  kind: string | null;
  period: string | null;
  splitBy: string | null;
  lastPeriods: number | null;
  from: string | null;
  to: string | null;
  cumulative: boolean | null;
  rollingAverage: boolean | null;
  stacked: boolean | null;
}

/**
 * A view, as `packages/web-collections/src/core/container-model.ts`'s `View`.
 *
 * The trailing group of fields is optional there for the same reason it is here: a view built by
 * a wizard recipe, a compiled spec, or a test fixture is not a parse of a server response, and
 * requiring it to carry every wire field would make building one an exercise in filling in nulls.
 */
export interface StructureView {
  id: string;
  name: string;
  kind: string;
  columns: string[];
  groupBy: string | null;
  groupOrder: string[];
  dateProperty: string | null;
  sortBy: string | null;
  sortDescending: boolean;
  mode: string | null;
  coverProperty: string | null;
  endDateProperty: string | null;
  cardSize: string | null;
  layout: string | null;
  filters: StructureFilterEntry[];
  sorts?: { property: string; descending: boolean }[];
  collapsedGroups?: string[];
  groupLimits?: { group: string; limit: number }[];
  aggregates?: { property: string; function: string }[];
  habitWidgets?: StructureHabitWidget[];
  measure?: string | null;
  measureProperty?: string | null;
  chart?: StructureChartOptions | null;
  companionViewId?: string | null;
  companionPlacement?: 'below' | 'beside' | null;
  interactiveForm?: StructureForm | null;
  doneProperty?: string | null;
  rowBy?: string | null;
  open?: string | null;
  /** A custom view's openui-lang program, drawn in the viewer's browser. */
  program?: string | null;
}
