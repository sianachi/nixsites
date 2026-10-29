import type {
  EffectiveSchema,
  PropertyDefinition,
  View,
} from '../../collections/core/container-model';
import {
  STRUCTURED_RECIPES,
  viewForRecipe,
  type StructuredRecipeId,
} from '../../views/wizard/structured-recipes';
import type { TemplateItem } from '../template-api';

export function templateDraftDocumentPath(
  templateId: string,
  operationId: string,
  sourceId: string,
): string {
  return `/collab/templates/${templateId}/drafts/${operationId}/items/${sourceId}/ws`;
}

export interface TemplateItemEdit {
  readonly title: string;
  readonly schema: EffectiveSchema | null;
  readonly views: TemplateItem['views'];
}

export type TemplateItemEdits = Readonly<Record<string, TemplateItemEdit>>;

export interface FlatTemplateItem {
  readonly item: TemplateItem;
  readonly depth: number;
}

export function flatten(root: TemplateItem, depth = 0): readonly FlatTemplateItem[] {
  return [{ item: root, depth }, ...root.children.flatMap((child) => flatten(child, depth + 1))];
}

export function currentItem(item: TemplateItem, edits: TemplateItemEdits): TemplateItemEdit {
  return (
    edits[item.sourceId] ?? {
      title: item.title,
      schema: item.schema,
      views: item.views,
    }
  );
}

export function declaredFields(edit: TemplateItemEdit): readonly PropertyDefinition[] {
  return edit.schema?.declared ?? [];
}

export function replaceDeclaredFields(
  edit: TemplateItemEdit,
  fields: readonly PropertyDefinition[],
): TemplateItemEdit {
  const schema = edit.schema ?? { properties: [], declared: [], inherit: true };
  const originalDeclared = new Set(schema.declared.map((field) => field.key));
  const inherited = schema.properties.filter((field) => !originalDeclared.has(field.key));
  return {
    ...edit,
    schema: { ...schema, declared: [...fields], properties: [...inherited, ...fields] },
  };
}

export function move<T>(entries: readonly T[], index: number, by: number): readonly T[] {
  const next = [...entries];
  const target = index + by;
  const entry = next[index];
  const displaced = next[target];
  if (entry === undefined || displaced === undefined) return entries;
  next[index] = displaced;
  next[target] = entry;
  return next;
}

export function uniqueFieldKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${String(suffix)}`)) suffix += 1;
  return `${base}_${String(suffix)}`;
}

export function prepareNewView(
  edit: TemplateItemEdit,
  kind: StructuredRecipeId,
): { readonly edit: TemplateItemEdit; readonly view: View } {
  const recipe = STRUCTURED_RECIPES.find((candidate) => candidate.id === kind);
  if (recipe === undefined) throw new Error(`The ${kind} view recipe is required.`);
  const effective = [...(edit.schema?.properties ?? [])];
  const declared = [...declaredFields(edit)];
  const taken = new Set(effective.map((field) => field.key));
  const recipeFields = recipe.properties.map((property) => {
    const reusable = effective.find(
      (candidate) => candidate.key === property.key && candidate.type === property.type,
    );
    if (reusable !== undefined) return reusable;
    const created = {
      ...property,
      key: uniqueFieldKey(property.key, taken),
      options: [...property.options],
    };
    taken.add(created.key);
    effective.push(created);
    declared.push(created);
    return created;
  });
  const nextEdit = replaceDeclaredFields(edit, declared);
  return {
    edit: nextEdit,
    view: { ...viewForRecipe(recipe, recipeFields), id: globalThis.crypto.randomUUID() },
  };
}
