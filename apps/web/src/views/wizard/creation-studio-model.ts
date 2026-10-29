import { z } from 'zod';

import { browserSessionStorage } from '@nix/web-foundation/lib/browser-storage';
import {
  PropertyDefinitionSchema,
  ViewSchema,
  type PropertyDefinition,
  type View,
} from '@nix/web-collections/core/container-model';
import { isDateShaped } from '@nix/web-collections/core/property-types';
import { validateInteractiveForm } from '../form/interactive-form-rules';
import {
  findStructuredRecipe,
  viewForRecipe,
  type StructuredRecipe,
  type StructuredRecipeId,
} from './structured-recipes';

export interface StudioDraft {
  readonly title: string;
  readonly properties: readonly PropertyDefinition[];
  readonly view: View;
  readonly companionKind: string | null;
  readonly companionView: View | null;
  readonly companionViewId: string;
  readonly companionPlacement: 'below' | 'beside';
  readonly publish: boolean;
}

export type StudioIntent = 'create' | 'add' | 'edit';

export const STEPS = [
  { id: 'basics', label: 'Basics', detail: 'Name and fields' },
  { id: 'options', label: 'Options', detail: 'View, companion and sharing' },
] as const;

const StudioDraftSchema = z.object({
  title: z.string(),
  properties: z.array(PropertyDefinitionSchema),
  view: ViewSchema,
  companionKind: z.string().nullable(),
  companionView: ViewSchema.nullable().default(null),
  companionViewId: z.string(),
  companionPlacement: z.enum(['below', 'beside']),
  publish: z.boolean(),
});

function requireStructuredRecipe(id: StructuredRecipeId): StructuredRecipe {
  const recipe = findStructuredRecipe(id);
  if (recipe === null) {
    throw new Error(`The ${id} creation recipe is required.`);
  }
  return recipe;
}

export const FALLBACK_RECIPE: StructuredRecipe = requireStructuredRecipe('board');

export function draftFor(recipe: StructuredRecipe): StudioDraft {
  const properties = recipe.properties.map((property) => ({
    ...property,
    options: [...property.options],
  }));
  const view = viewForRecipe(recipe, properties);
  const companionViewId = `${view.id}-companion`;
  const companionKind = recipe.viewKind === 'interactive_form' ? 'list' : null;
  return {
    title: recipe.defaultTitle,
    properties,
    view,
    companionKind,
    companionView: null,
    companionViewId,
    companionPlacement: 'below',
    publish: false,
  };
}

export function draftKey(recipe: StructuredRecipe, parentId: string | null): string {
  return `nix:create:${recipe.id}:${parentId ?? 'root'}`;
}

export function readDraft(recipe: StructuredRecipe, parentId: string | null): StudioDraft {
  const fallback = draftFor(recipe);
  const raw = browserSessionStorage()?.getItem(draftKey(recipe, parentId));
  if (raw === null || raw === undefined) return fallback;
  try {
    const parsed = StudioDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

function createCompanionView(
  kind: string,
  id: string,
  properties: readonly PropertyDefinition[],
): View {
  const firstSelect = properties.find((property) => property.type === 'select');
  const firstDate = properties.find((property) => isDateShaped(property.type));
  const firstImage = properties.find((property) => property.type === 'image');
  return {
    id,
    name: kind === 'sheet' ? 'Responses' : 'Companion',
    kind,
    columns: ['title', ...properties.map((property) => property.key)],
    groupBy: kind === 'board' ? (firstSelect?.key ?? null) : null,
    groupOrder: kind === 'board' ? [...(firstSelect?.options ?? [])] : [],
    dateProperty: kind === 'calendar' || kind === 'timeline' ? (firstDate?.key ?? null) : null,
    sortBy: null,
    sortDescending: false,
    mode: kind === 'calendar' ? 'week' : kind === 'timeline' ? 'month' : null,
    coverProperty: kind === 'gallery' ? (firstImage?.key ?? null) : null,
    endDateProperty: null,
    cardSize: kind === 'gallery' ? 'medium' : null,
    layout: kind === 'drive' ? 'list' : null,
    filters: [],
    companionViewId: null,
    companionPlacement: null,
    interactiveForm: null,
  };
}

export function companionView(draft: StudioDraft): View | null {
  if (draft.companionKind === null) return null;
  if (draft.companionView?.kind === draft.companionKind) return draft.companionView;
  return createCompanionView(draft.companionKind, draft.companionViewId, draft.properties);
}

export function compiledViews(draft: StudioDraft): readonly View[] {
  const companion = companionView(draft);
  const primary = {
    ...draft.view,
    companionViewId: companion?.id ?? null,
    companionPlacement: companion === null ? null : draft.companionPlacement,
  };
  return companion === null ? [primary] : [primary, companion];
}

export function refreshViewProperties(view: View, properties: readonly PropertyDefinition[]): View {
  const select = properties.find((property) => property.type === 'select');
  const dates = properties.filter((property) => isDateShaped(property.type));
  const image = properties.find((property) => property.type === 'image');
  return {
    ...view,
    // A checklist's columns are the one property shown beside each line, chosen on purpose rather
    // than refreshed to every field the draft now has.
    columns:
      view.kind === 'checklist'
        ? view.columns
        : ['title', ...properties.map((property) => property.key)],
    groupBy: view.kind === 'board' ? (select?.key ?? null) : view.groupBy,
    groupOrder: view.kind === 'board' ? [...(select?.options ?? [])] : view.groupOrder,
    dateProperty:
      view.kind === 'calendar' || view.kind === 'timeline'
        ? (dates[0]?.key ?? null)
        : view.dateProperty,
    endDateProperty: view.kind === 'timeline' ? (dates[1]?.key ?? null) : view.endDateProperty,
    coverProperty: view.kind === 'gallery' ? (image?.key ?? null) : view.coverProperty,
  };
}

export function validateStep(
  step: number,
  draft: StudioDraft,
  existingProperties: readonly PropertyDefinition[] = [],
): string | null {
  return step === 0 ? validateFields(draft) : validateDraft(draft, existingProperties);
}

function validateFields(draft: StudioDraft): string | null {
  if (draft.title.trim().length === 0) return 'Enter a name.';
  const keys = new Set<string>();
  for (const property of draft.properties) {
    if (property.key.length === 0 || property.label.trim().length === 0)
      return 'Every field needs a name.';
    if (keys.has(property.key))
      return `More than one field uses “${property.label}”. Give each field a distinct name.`;
    keys.add(property.key);
    if (
      (property.type === 'select' || property.type === 'multi_select') &&
      property.options.length === 0
    )
      return `${property.label} needs at least one option.`;
  }
  if (draft.view.kind === 'board' && draft.view.groupBy === null)
    return 'A board needs a select field for its columns.';
  if (
    draft.view.kind === 'matrix' &&
    (draft.view.groupBy === null || (draft.view.rowBy ?? null) === null)
  )
    return 'A matrix needs a select or checkbox field for its rows and another for its columns.';
  if (
    (draft.view.kind === 'calendar' || draft.view.kind === 'timeline') &&
    draft.view.dateProperty === null
  )
    return `${draft.view.name} needs a date field.`;
  return null;
}

export function validateDraft(
  draft: StudioDraft,
  existingProperties: readonly PropertyDefinition[] = [],
): string | null {
  const fieldsRefusal = validateFields(draft);
  if (fieldsRefusal !== null) return fieldsRefusal;
  if (draft.view.kind === 'interactive_form') {
    if (draft.view.interactiveForm === null || draft.view.interactiveForm === undefined)
      return 'An interactive form needs a form definition.';
    const formRefusal = validateInteractiveForm(draft.view.interactiveForm, [
      ...existingProperties,
      ...draft.properties,
    ]);
    if (formRefusal !== null) return formRefusal;
  }
  const companion = companionView(draft);
  if (companion?.kind === 'board' && companion.groupBy === null)
    return 'Add a select field before using a Board companion.';
  if (companion?.kind === 'calendar' && companion.dateProperty === null)
    return 'Add a date field before using a Calendar companion.';
  return null;
}
