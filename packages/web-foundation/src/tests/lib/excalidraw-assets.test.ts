import { describe, expect, it } from 'vitest';

import { EXCALIDRAW_ASSET_PATH, initializeExcalidrawAssets } from '../../lib/excalidraw-assets';

describe('Excalidraw assets', () => {
  it('points Excalidraw at the Vite-hosted same-origin asset directory', () => {
    const host: { EXCALIDRAW_ASSET_PATH?: string | string[] } = {};

    initializeExcalidrawAssets(host);

    expect(host.EXCALIDRAW_ASSET_PATH).toBe(EXCALIDRAW_ASSET_PATH);
    expect(EXCALIDRAW_ASSET_PATH).toBe('/excalidraw-assets/');
  });
});
