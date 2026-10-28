/**
 * `nixctl item protect`: an item's protections against deletion and against new children.
 *
 * A protected item cannot be trashed, and neither can anything that holds it; an item that
 * refuses children accepts nothing created under it or moved into it. Anybody who may edit the
 * item may set either. The deletion protection of a linked calendar's container and events is the
 * system's, and is lifted with `nixctl calsync unlink`, not here.
 */

import { items } from '@nix/api-client';
import { parseUuid, resolveSession, type SessionDeps } from './shared.ts';
import { printResult, type OutputOptions } from '../output.ts';
import type { Session } from '../session.ts';

export interface ProtectionOptions {
  /** `on` or `off`; absent leaves the deletion protection as it is. */
  readonly delete?: string;
  /** `on` or `off`; absent leaves the new-children protection as it is. */
  readonly children?: string;
  /** `on` or `off`; off means one editor at a time. Absent leaves it as it is. */
  readonly collaboration?: string;
}

export interface ProtectionResult {
  readonly id: string;
  readonly title: string;
  readonly noDelete: boolean;
  readonly noChildren: boolean;
  readonly collaboration: boolean;
  readonly managedBy: string | null;
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

/** Sets the protections named, leaving the other as it is. */
export async function executeProtect(
  session: Session,
  itemId: string,
  options: ProtectionOptions,
): Promise<ProtectionResult> {
  const noDelete = parseSwitch(options.delete, '--delete');
  const noChildren = parseSwitch(options.children, '--children');
  const collaboration = parseSwitch(options.collaboration, '--collaboration');

  // The workspace only names a cache entry to drop, and a one-shot command has no cache to keep.
  const item = await session.client.execute(
    items.setItemProtection('', itemId, {
      ...(noDelete === undefined ? {} : { noDelete }),
      ...(noChildren === undefined ? {} : { noChildren }),
      ...(collaboration === undefined ? {} : { collaboration }),
    }),
  );
  return {
    id: item.id,
    title: item.title,
    noDelete: item.noDelete,
    noChildren: item.noChildren,
    collaboration: item.collaboration,
    managedBy: item.managedBy,
  };
}

export async function protect(
  profileName: string | undefined,
  itemId: string,
  options: ProtectionOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  parseUuid(itemId, 'The item');
  parseSwitch(options.delete, '--delete');
  parseSwitch(options.children, '--children');
  const session = await resolveSession(profileName, deps);
  printResult(await executeProtect(session, itemId, options), output);
}
