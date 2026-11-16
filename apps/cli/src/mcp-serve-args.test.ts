import { describe, expect, it } from 'vitest';

import { mcpServeRequest } from './mcp-serve-args.ts';

describe('mcpServeRequest', () => {
  it('recognises the service command, from flags or the environment', () => {
    expect(
      mcpServeRequest(['mcp', '--listen', '0.0.0.0:8500'], {
        NIX_API_URL: 'http://nix-api:8080',
        NIX_COLLAB_URL: 'http://nix-node:8100',
        NIX_MCP_PUBLIC_URL: 'https://nix.example/mcp',
      }),
    ).toEqual({
      listen: '0.0.0.0:8500',
      apiUrl: 'http://nix-api:8080',
      collabUrl: 'http://nix-node:8100',
      publicOrigin: 'https://nix.example',
    });
    expect(
      mcpServeRequest(['mcp', '--api-url=http://core', '--listen=:9'], { NIX_API_URL: 'ignored' }),
    ).toEqual({
      listen: ':9',
      apiUrl: 'http://core',
      collabUrl: undefined,
      publicOrigin: undefined,
    });
    expect(mcpServeRequest(['mcp'], { NIX_MCP_LISTEN: ':9', NIX_API_URL: 'http://core' })).toEqual({
      listen: ':9',
      apiUrl: 'http://core',
      collabUrl: undefined,
      publicOrigin: undefined,
    });
  });

  it('leaves everything else to the CLI', () => {
    const env = { NIX_API_URL: 'http://core' };
    for (const args of [
      [],
      ['item', 'get'],
      ['mcp'],
      ['mcp', '--help'],
      ['--profile', 'home', 'mcp', '--listen', ':9'],
      ['mcp', '--listen'],
      ['mcp', '--listen', ':9', '--listen', ':10'],
      ['mcp', '--listen', ':9', '--public-url', 'not a url'],
      ['mcp', '--listen', ':9', 'extra'],
    ])
      expect(mcpServeRequest(args, env)).toBeNull();
    // HTTP mode without an API address is the CLI's error to report.
    expect(mcpServeRequest(['mcp', '--listen', ':9'], {})).toBeNull();
  });
});
