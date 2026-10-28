import { describe, expect, it } from 'vitest';

import { isImageFile, mediaTypeForFile } from '@nix/web-foundation/lib/file-kind';

describe('dropped file classification', () => {
  it('recognizes image extensions when the browser omits a MIME type', () => {
    const file = new File(['image'], 'Whiteboard.PNG', { type: '' });

    expect(isImageFile(file)).toBe(true);
    expect(mediaTypeForFile(file)).toBe('image/png');
  });

  it('corrects a generic browser MIME type when the extension is an image', () => {
    const file = new File(['image'], 'Whiteboard.PNG', { type: 'application/octet-stream' });

    expect(mediaTypeForFile(file)).toBe('image/png');
  });

  it.each([
    ['vector', 'diagram.svg', 'image/svg+xml'],
    ['animated', 'spinner.gif', 'image/gif'],
    ['bitmap', 'legacy.bmp', 'image/bmp'],
    ['icon', 'favicon.ico', 'image/x-icon'],
  ])('keeps %s image formats as ordinary files', (_kind, name, type) => {
    const file = new File(['image'], name, { type });

    expect(isImageFile(file)).toBe(false);
    expect(mediaTypeForFile(file)).toBe(type);
  });

  it('does not infer an unsupported image from its extension when MIME is generic', () => {
    const file = new File(['image'], 'diagram.svg', { type: 'application/octet-stream' });

    expect(isImageFile(file)).toBe(false);
    expect(mediaTypeForFile(file)).toBe('image/svg+xml');
  });

  it('keeps an oversized otherwise-supported image as an ordinary file', () => {
    const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', {
      type: 'image/png',
    });

    expect(isImageFile(file)).toBe(false);
  });

  it('preserves a provided MIME type for non-image attachments', () => {
    const file = new File(['document'], 'brief.pdf', { type: 'application/pdf' });

    expect(isImageFile(file)).toBe(false);
    expect(mediaTypeForFile(file)).toBe('application/pdf');
  });

  it('falls back to a generic attachment type for unknown files', () => {
    const file = new File(['data'], 'archive.bin', { type: '' });

    expect(isImageFile(file)).toBe(false);
    expect(mediaTypeForFile(file)).toBe('application/octet-stream');
  });
});
