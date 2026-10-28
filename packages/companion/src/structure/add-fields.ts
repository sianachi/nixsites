import { compileAddFields, type Step } from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';
import { appendViewSetup } from './create-structured.js';

export const compile = compileAddFields;

export function execute(
  ports: CompanionPorts,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<unknown> {
  return appendViewSetup(ports, steps, signal, 'add_fields');
}
