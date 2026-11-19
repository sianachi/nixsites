export const APP_PLATFORMS = ['iOS', 'Android', 'macOS', 'Windows', 'Linux'] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/**
 * Where each native app is downloaded from. A null link means there is no download yet.
 * Desktop builds from v0.7 are early and built from source; iOS and Android stay "Coming soon".
 */
export const APP_DOWNLOADS: Readonly<Record<AppPlatform, string | null>> = {
  iOS: null,
  Android: null,
  macOS: null,
  Windows: null,
  Linux: null,
};

/** Unsigned desktop builds with no auto-update. Windows and Linux are untested. */
export const EARLY_SOURCE_BUILDS: readonly AppPlatform[] = ['macOS', 'Windows', 'Linux'];
