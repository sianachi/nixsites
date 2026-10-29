import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLastLocation, rememberLocation } from '../../pwa/last-location';
const workspace = 'a1000000-0000-4000-8000-000000000001';
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('reopening Nix', () => {
  it('restores the document address only for its account and an accessible workspace', () => {
    const path = `/w/${workspace}?item=last-note`;
    rememberLocation('alice', workspace, path);
    expect(readLastLocation('alice', [workspace])).toBe(path);
    expect(readLastLocation('bob', [workspace])).toBeNull();
    expect(readLastLocation('alice', [])).toBeNull();
  });
  it('does not restore transient creation flows or external addresses', () => {
    rememberLocation('alice', workspace, 'https://example.com');
    expect(readLastLocation('alice', [workspace])).toBeNull();
    rememberLocation('alice', workspace, `/w/${workspace}/new/table`);
    expect(readLastLocation('alice', [workspace])).toBeNull();
  });
  it('treats malformed storage as no remembered destination', () => {
    localStorage.setItem('nix.last-location:alice', '{');
    expect(readLastLocation('alice', [workspace])).toBeNull();
  });
});
