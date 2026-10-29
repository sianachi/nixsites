import type {
  FormBlock,
  FormCondition,
  InteractiveFormDefinition,
  PropertyDefinition,
} from '../../collections/core/container-model';
import { isComputedType } from '../../collections/core/property-types';

const CONDITION_OPERATORS = new Set(['equals', 'not_equals', 'contains', 'checked', 'not_checked']);

/** Removes references made invalid by deleting or moving a form field. */
export function normalizeInteractiveForm(
  form: InteractiveFormDefinition,
  schema: readonly PropertyDefinition[],
): InteractiveFormDefinition {
  const properties = new Map(schema.map((property) => [property.key, property]));
  const earlier = new Set<string>();
  const fields = new Set<string>();
  const identityRoles = new Set<string>();
  const pages = form.pages.map((page) => {
    const visibleWhen = validEarlierConditions(page.visibleWhen, earlier);
    const blocks = page.blocks.map((block): FormBlock => {
      const normalized: FormBlock = {
        ...block,
        visibleWhen: validEarlierConditions(block.visibleWhen, earlier),
      };
      if (block.kind !== 'field') {
        return { ...normalized, propertyKey: null, required: false, identityRole: null };
      }

      fields.add(block.id);
      earlier.add(block.id);
      const property = block.propertyKey === null ? undefined : properties.get(block.propertyKey);

      // A form is a write surface (ADR-0040) and a computed property is never written, so a field
      // bound to one is a question with no answer: no control renders for it, and Core refuses the
      // key outright. Unbound here rather than only filtered out of the picker, because a property
      // can become computed after the form was built - and a `required` block in that state can
      // never be submitted, on a link that may already be public.
      if (property !== undefined && isComputedType(property.type)) {
        return { ...normalized, propertyKey: null, required: false, identityRole: null };
      }
      const role = block.identityRole;
      if (
        role === null ||
        property?.type !== 'text' ||
        (role !== 'name' && role !== 'email') ||
        identityRoles.has(role)
      ) {
        return { ...normalized, identityRole: null };
      }
      identityRoles.add(role);
      return normalized;
    });
    return { ...page, visibleWhen, blocks };
  });

  const titleFieldBlockId =
    form.titleMode === 'field' &&
    form.titleFieldBlockId !== null &&
    fields.has(form.titleFieldBlockId)
      ? form.titleFieldBlockId
      : null;
  return {
    ...form,
    pages,
    titleMode: titleFieldBlockId === null ? 'generated' : 'field',
    titleFieldBlockId,
  };
}

/** Returns an actionable reason the complete form cannot be stored, or null. */
export function validateInteractiveForm(
  form: InteractiveFormDefinition,
  schema: readonly PropertyDefinition[],
): string | null {
  if (form.pages.length === 0) return 'An interactive form needs at least one page.';
  const properties = new Map(schema.map((property) => [property.key, property]));
  const pageIds = new Set<string>();
  const blockIds = new Set<string>();
  const fieldIds = new Set<string>();
  const earlier = new Set<string>();
  const identityRoles = new Set<string>();

  for (const page of form.pages) {
    if (page.id.length === 0 || pageIds.has(page.id))
      return 'Every form page needs a distinct identifier.';
    pageIds.add(page.id);
    if (page.title.trim().length === 0) return 'Every form page needs a title.';
    if (page.blocks.length === 0) return `“${page.title}” needs at least one block.`;
    if (!conditionsAreValid(page.visibleWhen, earlier))
      return `“${page.title}” has a condition that no longer refers to an earlier field.`;

    for (const block of page.blocks) {
      if (block.id.length === 0 || blockIds.has(block.id))
        return 'Every form block needs a distinct identifier.';
      blockIds.add(block.id);
      if (block.text.trim().length === 0) return 'Every form block needs a prompt or text.';
      if (!conditionsAreValid(block.visibleWhen, earlier))
        return `“${block.text}” has a condition that no longer refers to an earlier field.`;
      if (block.kind !== 'field') continue;
      if (block.propertyKey === null || !properties.has(block.propertyKey))
        return `“${block.text}” must use one of this item’s fields.`;
      fieldIds.add(block.id);
      earlier.add(block.id);
      if (block.identityRole !== null) {
        if (properties.get(block.propertyKey)?.type !== 'text')
          return `“${block.text}” must use a text field before it can identify a respondent.`;
        if (identityRoles.has(block.identityRole))
          return `Only one field can collect the respondent’s ${block.identityRole}.`;
        identityRoles.add(block.identityRole);
      }
    }
  }

  if (
    form.titleMode === 'field' &&
    (form.titleFieldBlockId === null || !fieldIds.has(form.titleFieldBlockId))
  )
    return 'Choose an existing form field for response titles.';
  if (form.titleMode !== 'generated' && form.titleMode !== 'field')
    return 'Choose how submitted responses are titled.';
  if (form.confirmationTitle.trim().length === 0) return 'Add a confirmation heading.';
  if (form.confirmationMessage.trim().length === 0) return 'Add a confirmation message.';
  return null;
}

function validEarlierConditions(
  conditions: readonly FormCondition[],
  earlier: ReadonlySet<string>,
): FormCondition[] {
  return conditions.filter(
    (condition) =>
      earlier.has(condition.fieldBlockId) && CONDITION_OPERATORS.has(condition.operator),
  );
}

function conditionsAreValid(
  conditions: readonly FormCondition[],
  earlier: ReadonlySet<string>,
): boolean {
  return conditions.every(
    (condition) =>
      earlier.has(condition.fieldBlockId) && CONDITION_OPERATORS.has(condition.operator),
  );
}
