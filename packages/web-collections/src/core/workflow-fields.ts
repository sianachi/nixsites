import type { PropertyDefinition } from './container-model';
import type { ContainerData } from './use-container';

/** Adds workflow fields through Core's append command, leaving other schema and views intact. */
export async function ensureWorkflowFields(
  container: Pick<ContainerData, 'schema' | 'appendViewSetup'>,
  fields: readonly PropertyDefinition[],
): Promise<string | null> {
  if (container.schema === null) return 'The fields could not be loaded. Try again.';
  const missing = [];
  for (const field of fields) {
    const existing = container.schema.properties.find((property) => property.key === field.key);
    if (existing === undefined) missing.push(field);
    else if (
      existing.type !== field.type ||
      field.options.some((option) => !existing.options.includes(option))
    )
      return `The ${field.label} field has an incompatible configuration.`;
  }
  return missing.length === 0 ? null : container.appendViewSetup(missing, [], false);
}
