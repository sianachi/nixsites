import { afterEach, describe, expect, it, vi } from 'vitest';

import { isNativeShell, shareLink, syncStatusBar, tap } from './native-shell';

function stub(plugins: Record<string, Record<string, unknown>>, native = true): void {
  vi.stubGlobal('Capacitor', { isNativePlatform: () => native, Plugins: plugins });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('native shell helpers', () => {
  it('is inert without Capacitor', async () => {
    expect(isNativeShell()).toBe(false);
    expect(() => {
      tap();
      syncStatusBar('dark');
    }).not.toThrow();
    expect(await shareLink({ title: 't', url: 'https://x.test' })).toBe(false);
  });

  it('taps through Haptics only when native', () => {
    const impact = vi.fn().mockResolvedValue(undefined);
    const selectionChanged = vi.fn().mockResolvedValue(undefined);
    stub({ Haptics: { impact, selectionChanged } });
    tap('medium');
    tap('selection');
    expect(impact).toHaveBeenCalledWith({ style: 'MEDIUM' });
    expect(selectionChanged).toHaveBeenCalledOnce();

    stub({ Haptics: { impact } }, false);
    tap();
    expect(impact).toHaveBeenCalledOnce();
  });

  it('sets the status bar text for the ground', () => {
    const setStyle = vi.fn().mockResolvedValue(undefined);
    stub({ StatusBar: { setStyle } });
    syncStatusBar('dark');
    syncStatusBar('light');
    expect(setStyle).toHaveBeenNthCalledWith(1, { style: 'DARK' });
    expect(setStyle).toHaveBeenNthCalledWith(2, { style: 'LIGHT' });
  });

  it('shares natively, then via navigator.share, else false', async () => {
    const share = vi.fn().mockResolvedValue({});
    stub({ Share: { share } });
    expect(await shareLink({ title: 't', url: 'u' })).toBe(true);
    expect(share).toHaveBeenCalledWith({ title: 't', url: 'u' });

    vi.unstubAllGlobals();
    const web = vi.fn().mockRejectedValue(new Error('cancelled'));
    vi.stubGlobal('navigator', { share: web });
    expect(await shareLink({ title: 't', url: 'u' })).toBe(false);
    expect(web).toHaveBeenCalled();
  });
});
