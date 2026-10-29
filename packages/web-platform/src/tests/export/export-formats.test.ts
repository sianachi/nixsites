import type { ExportFormat } from '@nix/api-client';
import { describe, expect, it } from 'vitest';

import { formatFor, formatPreamble, preferredFormat } from '../../export/export-formats';

const markdown: ExportFormat = {
  format: 'markdown',
  label: 'Markdown',
  extension: 'md',
  mediaType: 'text/markdown',
  lossless: false,
  declaredLoss: ['Interactive views become text.', 'Comments are omitted.'],
};
const archive: ExportFormat = {
  format: 'nix',
  label: 'Archive',
  extension: 'nix',
  mediaType: 'application/vnd.nix.archive+zip',
  lossless: true,
  declaredLoss: [],
};

describe('advertised export formats', () => {
  it('prefers whichever active format advertises itself as lossless', () => {
    expect(preferredFormat([markdown, archive])).toBe(archive);
  });

  it('uses the first advertised projection when no lossless worker is active', () => {
    expect(preferredFormat([markdown])).toBe(markdown);
    expect(preferredFormat([])).toBeUndefined();
  });

  it('finds formats by their advertised identifier without a hardcoded format union', () => {
    const pluginFormat = { ...markdown, format: 'epub', label: 'EPUB', extension: 'epub' };

    expect(formatFor([archive, pluginFormat], 'epub')).toBe(pluginFormat);
    expect(formatFor([archive], 'epub')).toBeUndefined();
  });

  it('describes a projected export without exposing internal fidelity reporting', () => {
    const preamble = formatPreamble(markdown);

    expect(preamble).toBe('Markdown creates a downloadable document.');
    expect(preamble).not.toMatch(/omitted|loss|report|fidelity/i);
  });

  it('describes the native format without internal implementation details', () => {
    expect(formatPreamble(archive)).toBe('Archive preserves the native workspace format.');
  });
});
