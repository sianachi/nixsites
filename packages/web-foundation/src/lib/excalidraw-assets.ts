export const EXCALIDRAW_ASSET_PATH = `${import.meta.env.BASE_URL}excalidraw-assets/`;

interface ExcalidrawAssetHost {
  EXCALIDRAW_ASSET_PATH?: string | string[];
}

/** Point Excalidraw's lazy-loaded fonts at the same-origin assets emitted by Vite. */
export function initializeExcalidrawAssets(
  host: ExcalidrawAssetHost = window as Window & ExcalidrawAssetHost,
): void {
  host.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
}
