/**
 * `nixctl item settings`: the optional features one item switches on for itself.
 *
 * Comments, suggesting, file review states and full width are all off until switched on. Anybody
 * who may edit the item may change them, and Core enforces them for every client.
 */

import { items, type ItemSettingsInput } from '@nix/api-client';
import { parseUuid, resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';

export interface ItemSettingsOptions {
  /** `on` or `off`; absent leaves each switch as it is. */
  readonly comments?: string;
  readonly suggesting?: string;
  readonly reviewStates?: string;
  readonly fullWidth?: string;
}

function parseSwitch(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'on' && value !== 'off') {
    throw new Error(`${flag} must be 'on' or 'off' - got '${value}'.`);
  }
  return value === 'on';
}

function parseSettings(options: ItemSettingsOptions): ItemSettingsInput {
  const comments = parseSwitch(options.comments, '--comments');
  const suggesting = parseSwitch(options.suggesting, '--suggesting');
  const reviewStates = parseSwitch(options.reviewStates, '--review-states');
  const fullWidth = parseSwitch(options.fullWidth, '--full-width');
  return {
    ...(comments === undefined ? {} : { comments }),
    ...(suggesting === undefined ? {} : { suggesting }),
    ...(reviewStates === undefined ? {} : { reviewStates }),
    ...(fullWidth === undefined ? {} : { fullWidth }),
  };
}

/** Sets the switches named, leaving the others as they are. */
export async function executeItemSettings(
  session: Session,
  itemId: string,
  options: ItemSettingsOptions,
): Promise<{ readonly id: string; readonly title: string; readonly settings: unknown }> {
  // The workspace only names a cache entry to drop, and a one-shot command has no cache to keep.
  const item = await session.client.execute(
    items.setItemSettings('', itemId, parseSettings(options)),
  );
  return { id: item.id, title: item.title, settings: item.settings };
}

export async function itemSettings(
  profileName: string | undefined,
  itemId: string,
  options: ItemSettingsOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(itemId, 'The item');
  parseSettings(options);
  const session = await resolveSession(profileName, deps);
  printResult(await executeItemSettings(session, itemId, options), output);
}
