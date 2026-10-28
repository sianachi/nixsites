import { compileAddView, type Step } from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';
import { appendViewSetup } from './create-structured.js';

export const compile = compileAddView;

export function execute(
  ports: CompanionPorts,
  steps: readonly Step[],
  signal: AbortSignal,
): Promise<unknown> {
  return appendViewSetup(ports, steps, signal, 'add_view');
}
