export const DRIVE_LAYOUTS = ['list', 'grid'] as const;
export type DriveLayout = (typeof DRIVE_LAYOUTS)[number];
export const DEFAULT_DRIVE_LAYOUT: DriveLayout = 'list';

/** Which layout to draw, given what the view stores. Unrecognised and absent both mean list. */
export function resolveLayout(stored: string | null | undefined): DriveLayout {
  return DRIVE_LAYOUTS.find((candidate) => candidate === stored) ?? DEFAULT_DRIVE_LAYOUT;
}
