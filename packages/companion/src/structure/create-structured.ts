import {
  items,
  views,
  type AppendViewSetupRequestContract,
  type CreateStructuredItemRequestContract,
  type ViewRequestContract,
} from '@nix/api-client';
import {
  compileCreateStructured,
  type CreateStructuredContext,
  type Step,
  type StructuredSpec,
} from '@nix/structure-spec';
import type { StructureProperty, StructureView } from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';

/** Serializes one compiled property to the wire shape `CreateStructuredItemRequest.schema`
 * and `AppendViewSetupRequest.properties` both take - field for field the same as
 * `StructureProperty`, so this is a rename of the type, not a transform of the data. */
export function toPropertyDefinitionRequest(
  property: StructureProperty,
): CreateStructuredItemRequestContract['schema']['properties'][number] {
  return {
    key: property.key,
    label: property.label,
    type: property.type,
    options: property.options,
    required: property.required,
    expression: property.expression ?? null,
    aggregate: property.aggregate ?? null,
    source: property.source ?? null,
    choiceSource: property.choiceSource ?? null,
  };
}

/** Serializes one compiled view to the wire shape both `CreateStructuredItemRequest.views.views`
 * and `AppendViewSetupRequest.views` take. */
export function toViewRequest(view: StructureView): ViewRequestContract {
  return {
    id: view.id,
    name: view.name,
    kind: view.kind,
    columns: view.columns,
    groupBy: view.groupBy,
    groupOrder: view.groupOrder,
    dateProperty: view.dateProperty,
    sortBy: view.sortBy,
    sortDescending: view.sortDescending,
    mode: view.mode,
    coverProperty: view.coverProperty,
    endDateProperty: view.endDateProperty,
    cardSize: view.cardSize,
    filters: view.filters,
    sorts: view.sorts ?? [],
    collapsedGroups: view.collapsedGroups ?? [],
    groupLimits: view.groupLimits ?? [],
    aggregates: view.aggregates ?? [],
    companionViewId: view.companionViewId ?? null,
    companionPlacement: view.companionPlacement ?? null,
    interactiveForm: view.interactiveForm ?? null,
    measure: view.measure ?? null,
    measureProperty: view.measureProperty ?? null,
    chart: view.chart ?? null,
    habitWidgets: view.habitWidgets ?? null,
    layout: view.layout,
    doneProperty: view.doneProperty ?? null,
    rowBy: view.rowBy ?? null,
    open: view.open ?? null,
    program: view.program ?? null,
  };
}

export interface CreateStructuredResult {
  id: string;
  title: string;
  created: true;
}

/** Compiles then executes one `create_structured` call: the plan is always exactly one
 * `createStructuredItem` step (`compileCreateStructured`), so there is nothing to walk here -
 * `execute` still takes the compiled `Step[]` rather than the spec directly, so the card that
 * renders the same array before approval and this executor read the identical plan. */
export function compile(spec: StructuredSpec, context: CreateStructuredContext): Step[] {
  return compileCreateStructured(spec, context);
}

export async function execute(
  ports: CompanionPorts,
  workspaceId: string,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<CreateStructuredResult> {
  const step = steps[0];
  if (steps.length !== 1 || step?.kind !== 'createStructuredItem')
    throw new Error('create_structured compiled to an unexpected plan.');

  const body: CreateStructuredItemRequestContract = {
    type: 'note',
    title: step.title,
    parentId: step.parentId,
    schema: {
      properties: step.schema.properties.map(toPropertyDefinitionRequest),
      inherit: step.schema.inherit,
    },
    views: {
      views: step.views.map(toViewRequest),
      default: step.defaultViewId,
    },
    publishInteractiveFormViewId: null,
  };
  const created = items.createStructuredItem(workspaceId, body);
  const outcome = await ports.core.execute(created, { signal, forceRefresh: true });
  return { id: outcome.item.id, title: outcome.item.title, created: true };
}

/** Runs the single `appendViewSetup` step that add_view and add_fields both compile to. */
export async function appendViewSetup(
  ports: CompanionPorts,
  steps: readonly Step[],
  signal: AbortSignal,
  operation: string,
): Promise<unknown> {
  const step = steps[0];
  if (steps.length !== 1 || step?.kind !== 'appendViewSetup')
    throw new Error(`${operation} compiled to an unexpected plan.`);
  const body: AppendViewSetupRequestContract = {
    properties: step.properties.map(toPropertyDefinitionRequest),
    views: step.views.map(toViewRequest),
    makeDefault: step.makeDefault,
    publishInteractiveFormViewId: null,
  };
  return ports.core.execute(views.appendViewSetup(step.itemId, body), {
    signal,
    forceRefresh: true,
  });
}
