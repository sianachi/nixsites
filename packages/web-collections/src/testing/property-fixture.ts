import type { PropertyDefinition } from '../core/container-model';

export function propertyOf(
  overrides: Partial<PropertyDefinition> & { key: string },
): PropertyDefinition {
  return { label: overrides.key, type: 'text', options: [], required: false, ...overrides };
}
