import { describe, expect, it } from 'vitest';

import { readConfig, validServiceOrigin } from './config.ts';

const base = {
  NIX_COMPANION_DATA_DIR: '/data',
  NIX_COMPANION_INTERNAL_SECRET: 's',
  NIX_COMPANION_API_URL: 'http://nix-api:5014',
};

describe('configuration', () => {
  it('reads defaults', () => {
    const config = readConfig(base);
    expect(config).toMatchObject({
      binary: 'codex',
      chatEffort: 'low',
      trace: false,
      idleSeconds: 300,
      address: { host: '0.0.0.0', port: 8302 },
    });
  });

  it('fails fast on a missing or invalid setting', () => {
    expect(() => readConfig({})).toThrow('NIX_COMPANION_DATA_DIR is required');
    expect(() => readConfig({ ...base, NIX_COMPANION_DATA_DIR: 'relative' })).toThrow('absolute');
    expect(() => readConfig({ ...base, NIX_COMPANION_INTERNAL_SECRET: ' ' })).toThrow(
      'NIX_COMPANION_INTERNAL_SECRET is required',
    );
    expect(() => readConfig({ ...base, NIX_COMPANION_API_URL: 'http://core.example.com' })).toThrow(
      'service origin',
    );
    expect(() => readConfig({ ...base, NIX_COMPANION_IDLE_SECONDS: '0' })).toThrow('IDLE');
    expect(() => readConfig({ ...base, NIX_COMPANION_ADDRESS: 'nope' })).toThrow('host:port');
  });

  it('reads the optional settings', () => {
    const config = readConfig({
      ...base,
      NIX_COMPANION_TRACE: '1',
      NIX_COMPANION_IDLE_SECONDS: '60',
      NIX_COMPANION_ADDRESS: '127.0.0.1:9000',
      NIX_RELEASE_VERSION: '1.2.3',
      NIX_RELEASE_COMMIT: 'abc',
    });
    expect(config).toMatchObject({
      trace: true,
      idleSeconds: 60,
      address: { host: '127.0.0.1', port: 9000 },
      release: { version: '1.2.3', commit: 'abc' },
    });
  });

  it('validates the Core origin like the Go service did', () => {
    for (const ok of [
      'https://nix.example.com',
      'http://nix-api:5014',
      'http://127.0.0.1:5014',
      'http://[::1]:5014',
      'https://a.b/',
    ]) {
      expect(validServiceOrigin(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://nix.example.com',
      'ftp://x',
      'https://u:p@x',
      'https://x/path',
      'https://x?q=1',
      'https://x#f',
      '',
    ]) {
      expect(validServiceOrigin(bad), bad).toBe(false);
    }
  });
});
