export const APP_PLATFORMS = ['iOS', 'Android', 'macOS', 'Windows', 'Linux'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/**
 * Where each native app is downloaded from. A null link means the app is not out yet, and the
 * landing page shows a disabled "Coming soon" button for it.
 */
export const APP_DOWNLOADS: Readonly<Record<AppPlatform, string | null>> = {
  iOS: null,
  Android: null,
  macOS: null,
  Windows: null,
  Linux: null,
};
