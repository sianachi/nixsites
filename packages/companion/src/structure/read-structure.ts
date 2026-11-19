import {
  items,
  structure,
  views,
  viewConfigurationSchema,
  type ViewConfiguration,
} from '@nix/api-client';
import { isComputedType, LIMITS } from '@nix/structure-spec';
import { checkItem, isPetItemWithheld } from '../guards.js';
import type { CompanionPorts } from '../ports.js';

export interface ReadStructureField {
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  inherited: boolean;
  computed: boolean;
  expression: string | null;
  aggregate: string | null;
  source: string | null;
  choiceSource?: { itemId: string | null; field: string } | null;
}

export interface ReadStructureFormPage {
  title: string;
  questions: string[];
}

export interface ReadStructureView extends ViewConfiguration {
  canRender: boolean;
  isDefault: boolean;
  /** Core currently reports unrenderable identities, rather than detailed reasons. */
  problems: string[];
  form?: { pages: ReadStructureFormPage[] };
}

export interface ReadStructureResult {
  item: { id: string; title: string; type: string };
  fields: ReadStructureField[];
  views: ReadStructureView[];
  viewCapacity: { limit: number; current: number; remaining: number };
  defaultView: string;
  hideDocument: boolean;
  inheritsFields: boolean;
  childCount: number | 'many';
}

/** Carries the stored shape and Core's renderability decision without guessing a reason Core
 * did not return. The compatibility form outline supplements the full conditional form. */
export function describeView(
  raw: unknown,
  container: { unrenderable: string[]; default: string },
  labelByKey: ReadonlyMap<string, string> = new Map(),
): ReadStructureView {
  const view = viewConfigurationSchema.parse(raw);
  const canRender = !container.unrenderable.includes(view.id);
  const form =
    view.interactiveForm === null
      ? undefined
      : {
          pages: view.interactiveForm.pages.map((page) => ({
            title: page.title,
            questions: page.blocks
              .filter((block) => block.kind === 'field' && block.propertyKey !== null)
              .map((block) => labelByKey.get(block.propertyKey ?? '') ?? block.propertyKey ?? ''),
          })),
        };
  return {
    ...view,
    canRender,
    isDefault: container.default === view.id,
    problems: canRender
      ? []
      : [
          'Core marks this view as unrenderable. The read contract does not supply the specific reason; inspect its configured fields and their types.',
        ],
    ...(form === undefined ? {} : { form }),
  };
}

/** Bounds the child-count check to at most two requests of one row each: the first row proves a
 * child exists, a second proves there is more than one, and neither walks the rest of the
 * container the way `client.paginate` run to completion would. */
async function boundedChildCount(
  ports: CompanionPorts,
  workspaceId: string,
  parentId: string,
  signal: AbortSignal,
): Promise<number | 'many'> {
  let count = 0;
  for await (const row of ports.core.paginate(
    items.listItems(workspaceId, { parentId, pageSize: 1 }),
    { signal, forceRefresh: true, maxPages: 2 },
  )) {
    if (isPetItemWithheld(row)) continue;
    count += 1;
    if (count >= 2) return 'many';
  }
  return count;
}

/** `read_structure`: the fields, views and a bounded child count of one item, in plain enough
 * shape for the model to decide what a container already has before proposing more. */
export async function readStructure(
  ports: CompanionPorts,
  workspaceId: string,
  itemId: string,
  signal: AbortSignal,
): Promise<ReadStructureResult> {
  const requestOptions = { signal, forceRefresh: true };
  const item = await checkItem(ports, workspaceId, itemId, signal);
  const [schema, containerViews, childCount] = await Promise.all([
    ports.core.query(structure.effectiveSchema(itemId), requestOptions),
    ports.core.query(views.containerViewConfigurations(itemId), requestOptions),
    boundedChildCount(ports, workspaceId, itemId, signal),
  ]);

  const declaredKeys = new Set(schema.declared.map((property) => property.key));
  const labelByKey = new Map(schema.properties.map((property) => [property.key, property.label]));

  const fields: ReadStructureField[] = schema.properties.map((property) => ({
    key: property.key,
    label: property.label,
    type: property.type,
    options: property.options,
    required: property.required,
    inherited: !declaredKeys.has(property.key),
    computed: isComputedType(property.type),
    expression: property.expression ?? null,
    aggregate: property.aggregate ?? null,
    source: property.source ?? null,
    ...(property.choiceSource ? { choiceSource: property.choiceSource } : {}),
  }));

  const viewList = containerViews.views.map((raw) => describeView(raw, containerViews, labelByKey));

  return {
    item: { id: item.id, title: item.title, type: item.type },
    fields,
    views: viewList,
    viewCapacity: {
      limit: LIMITS.viewsPerContainer,
      current: viewList.length,
      remaining: Math.max(0, LIMITS.viewsPerContainer - viewList.length),
    },
    defaultView: containerViews.default,
    hideDocument: containerViews.hideDocument,
    inheritsFields: schema.inherit,
    childCount,
  };
}
