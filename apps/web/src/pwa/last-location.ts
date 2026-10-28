import { z } from 'zod';
import { writeStored } from '../editor/stored-setting';
import { browserStorage } from '../lib/browser-storage';

const savedLocation = z.object({ workspaceId: z.uuid(), path: z.string().max(4096) });
const key = (subject: string): string => `nix.last-location:${subject}`;
export function rememberLocation(subject: string, workspaceId: string, path: string): void {
  if (!isRestorable(workspaceId, path)) return;
  // Navigation works without storage.
  writeStored(key(subject), JSON.stringify({ workspaceId, path }));
}
function isRestorable(workspaceId: string, path: string): boolean {
  const pathname = path.split(/[?#]/u)[0];
  return (
    pathname === `/w/${workspaceId}` ||
    pathname === `/w/${workspaceId}/calendar` ||
    pathname === `/w/${workspaceId}/bookmarks` ||
    pathname === `/w/${workspaceId}/graph` ||
    pathname === `/w/${workspaceId}/daily`
  );
}
export function readLastLocation(subject: string, accessibleIds: readonly string[]): string | null {
  try {
    const parsed = savedLocation.safeParse(
      JSON.parse(browserStorage()?.getItem(key(subject)) ?? 'null'),
    );
    if (
      !parsed.success ||
      !accessibleIds.includes(parsed.data.workspaceId) ||
      !isRestorable(parsed.data.workspaceId, parsed.data.path)
    )
      return null;
    return parsed.data.path;
  } catch {
    return null;
  }
}
