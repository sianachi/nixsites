import { views } from '@nix/api-client';
import { compileEditForm, type Step } from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';
import { toPropertyDefinitionRequest, toViewRequest } from './create-structured.js';

export const compile = compileEditForm;

export async function execute(
  ports: CompanionPorts,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<unknown> {
  const step = steps[0];
  if (steps.length !== 1 || step?.kind !== 'replaceViewSetup') {
    throw new Error('edit_form compiled to an unexpected plan.');
  }
  if (step.originalPropertyKeys.length !== 0) {
    throw new Error('edit_form attempted to replace existing properties.');
  }

  const body: Parameters<typeof views.replaceViewSetup>[2] = {
    schema: {
      properties: step.schema.properties.map(toPropertyDefinitionRequest),
      inherit: step.schema.inherit,
    },
    originalPropertyKeys: [],
    views: step.views.map(toViewRequest),
    publishInteractiveFormViewId: null,
  };
  return ports.core.execute(views.replaceViewSetup(step.itemId, step.viewId, body), {
    signal,
    forceRefresh: true,
  });
}
