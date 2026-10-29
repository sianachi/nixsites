import type { NixClient } from '@nix/api-client';
import { WorkspaceToolRefusal } from '@nix/companion/tool-args';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileReader } from '../../pets/pet-file-reader';

const itemId = '22222222-2222-4222-8222-222222222222';

function client(fileName: string, mediaType: string, bytes: string, byteLength = bytes.length) {
  const query = vi.fn((endpoint: { operation: string }) =>
    Promise.resolve(
      endpoint.operation === 'files.get'
        ? { current: { fileName, mediaType, byteLength } }
        : {
            url: 'https://files.example/object',
            fileName,
            mediaType,
            byteLength,
          },
    ),
  );
  const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
  vi.stubGlobal('fetch', fetch);
  return { reader: createFileReader({ query } as unknown as NixClient), fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the pet file reader', () => {
  it('reads a CSV as text', async () => {
    const { reader } = client('costs.csv', 'text/csv', 'item,cost\ntea,3');
    await expect(reader.read(itemId, new AbortController().signal)).resolves.toEqual({
      fileName: 'costs.csv',
      mediaType: 'text/csv',
      text: 'item,cost\ntea,3',
      truncated: false,
    });
  });

  it('reads a Markdown file stored without a type by its extension', async () => {
    const { reader } = client('notes.md', 'application/octet-stream', '# Notes');
    const read = await reader.read(itemId, new AbortController().signal);
    expect(read.text).toBe('# Notes');
  });

  it('cuts long text and says so', async () => {
    const { reader } = client('log.txt', 'text/plain', 'a'.repeat(20_000));
    const read = await reader.read(itemId, new AbortController().signal);
    expect(read.text).toHaveLength(14_000);
    expect(read.truncated).toBe(true);
  });

  it('refuses a type it cannot read without downloading it', async () => {
    const { reader, fetch } = client('deck.pptx', 'application/vnd.ms-powerpoint', 'x');
    await expect(reader.read(itemId, new AbortController().signal)).rejects.toThrow(
      WorkspaceToolRefusal,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a text file too large to read without downloading it', async () => {
    const { reader, fetch } = client('huge.csv', 'text/csv', 'x', 6 * 1024 * 1024);
    await expect(reader.read(itemId, new AbortController().signal)).rejects.toThrow('too large');
    expect(fetch).not.toHaveBeenCalled();
  });
});
