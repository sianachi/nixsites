import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyItemLink, itemLink } from '../../lib/item-link';

describe('itemLink', () => {
  it('builds the workspace item address', () => {
    expect(itemLink('https://nix.example', 'w1', 'i1')).toBe('https://nix.example/w/w1?item=i1');
  });

  it('percent-encodes ids', () => {
    expect(itemLink('https://nix.example', 'a/b', 'c?d e')).toBe(
      'https://nix.example/w/a%2Fb?item=c%3Fd%20e',
    );
  });
});

describe('copyItemLink', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes the link and resolves true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyItemLink('w1', 'i1')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(`${globalThis.location.origin}/w/w1?item=i1`);
  });

  it('resolves false when the clipboard rejects', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
    });
    await expect(copyItemLink('w1', 'i1')).resolves.toBe(false);
  });
});
