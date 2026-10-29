import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { findBuiltInFileViewer } from '../../plugins/built-in-file-viewers';
import { CsvViewer, parseDelimited } from '../../plugins/csv-viewer';
import { MarkdownViewer } from '../../plugins/markdown-viewer';
import { mediaKind } from '../../plugins/media-viewer';
import { TextViewer, isTextFile } from '../../plugins/text-viewer';

/**
 * The built-in viewers: which file each one claims, and what it draws.
 *
 * Claiming is tested through the shipped registry rather than plugin by plugin, because the order
 * is the contract: a `.csv` is text and must not land in the text viewer.
 */

describe('which viewer claims a file', () => {
  it.each([
    ['README.md', 'application/octet-stream', 'nix.markdown.viewer'],
    ['notes.markdown', 'text/markdown', 'nix.markdown.viewer'],
    ['export.csv', 'text/csv', 'nix.csv.viewer'],
    ['export.csv', 'application/octet-stream', 'nix.csv.viewer'],
    ['data.tsv', 'text/tab-separated-values', 'nix.csv.viewer'],
    ['diagram.mmd', 'application/octet-stream', 'nix.mermaid-js.viewer'],
    ['talk.mp3', 'audio/mpeg', 'nix.audio.viewer'],
    ['demo.mp4', 'application/octet-stream', 'nix.media.viewer'],
    ['main.go', 'application/octet-stream', 'nix.text.viewer'],
    ['config.yaml', 'application/x-yaml', 'nix.text.viewer'],
    ['schema.json', 'application/json', 'nix.text.viewer'],
    ['notes.txt', 'text/plain; charset=utf-8', 'nix.text.viewer'],
    ['Dockerfile', 'application/octet-stream', 'nix.text.viewer'],
  ])('%s (%s) goes to %s', (fileName, mediaType, id) => {
    expect(findBuiltInFileViewer({ fileName, mediaType })?.id).toBe(id);
  });

  it.each([
    ['photo.png', 'image/png'],
    ['report.pdf', 'application/pdf'],
    ['archive.zip', 'application/zip'],
    ['binary', 'application/octet-stream'],
  ])('leaves %s to the host', (fileName, mediaType) => {
    expect(findBuiltInFileViewer({ fileName, mediaType })).toBeNull();
  });

  it('does not mistake a binary for text on its media type alone', () => {
    expect(isTextFile('firmware.bin', 'application/octet-stream')).toBe(false);
    expect(mediaKind('firmware.bin', 'application/octet-stream')).toBeNull();
  });
});

describe('the delimited parser', () => {
  it('honours quotes, doubled quotes and newlines inside a field', () => {
    const rows = parseDelimited('a,b\n"x, y","say ""hi""\nthere"\n', ',');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ]);
  });

  it('accepts Windows line endings and a tab delimiter', () => {
    expect(parseDelimited('a\tb\r\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('what the viewers draw', () => {
  it('draws a CSV as a table with the first row as the header', () => {
    render(<CsvViewer fileName="export.csv" source={'name,size\nalpha,1\nbeta,2\n'} />);

    const table = screen.getByRole('table', { name: 'export.csv' });
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'name',
      'size',
    ]);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('numbers the lines of a source listing', () => {
    render(<TextViewer fileName="main.go" source={'package main\n\nfunc main() {}'} />);

    const listing = screen.getByLabelText('main.go');
    expect(listing.tagName).toBe('PRE');
    expect(listing.textContent).toContain('package main');
    expect(listing.textContent).toContain('3');
  });

  it('renders Markdown as a document rather than as its source', async () => {
    render(<MarkdownViewer fileName="README.md" source={'# Title\n\nA paragraph.'} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Title' })).toBeVisible();
    expect(screen.getByText('A paragraph.')).toBeVisible();
    expect(screen.queryByText('# Title')).not.toBeInTheDocument();
  });
});
