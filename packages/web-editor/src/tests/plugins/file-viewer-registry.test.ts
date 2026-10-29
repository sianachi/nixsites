import { describe, expect, it } from 'vitest';

import { createFileViewerRegistry } from '../../plugins/file-viewer-registry';
import { isMermaidFile, mermaidJsViewerPlugin } from '../../plugins/mermaid-js-viewer';

describe('file viewer plugins', () => {
  it('selects the first matching plugin and leaves unknown files to the host', () => {
    const other = {
      id: 'test.other',
      matches: ({ mediaType }: { readonly mediaType: string }) => mediaType === 'text/plain',
      Component: () => null,
    };
    const find = createFileViewerRegistry([other, mermaidJsViewerPlugin]);

    expect(find({ fileName: 'notes.txt', mediaType: 'text/plain' })?.id).toBe('test.other');
    expect(find({ fileName: 'diagram.mmd', mediaType: 'application/octet-stream' })?.id).toBe(
      'nix.mermaid-js.viewer',
    );
    expect(find({ fileName: 'notes.txt', mediaType: 'application/octet-stream' })).toBeNull();
  });

  it.each([
    ['diagram.mmd', 'application/octet-stream'],
    ['architecture.mermaid', 'text/plain; charset=utf-8'],
    ['diagram.txt', 'text/vnd.mermaid'],
  ])('recognizes Mermaid file %s', (fileName, mediaType) => {
    expect(isMermaidFile(fileName, mediaType)).toBe(true);
  });

  it('does not claim ordinary text files', () => {
    expect(isMermaidFile('notes.txt', 'text/plain')).toBe(false);
  });
});
