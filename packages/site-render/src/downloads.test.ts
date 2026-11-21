import { describe, expect, it } from 'vitest';

import {
  MAX_DOWNLOAD_BYTES,
  MAX_VIDEO_BYTES,
  UnsupportedDownload,
  prepareDownload,
  safeFileName,
} from './downloads.js';
import { downloadHeaders } from './serve.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('prepareDownload', () => {
  it('carries a verified digest for the same bytes and hashes changed bytes afresh', () => {
    const original = bytes('%PDF-1.4\noriginal');
    const carried = prepareDownload(original, 'application/pdf', 'a.pdf').sha256;
    expect(prepareDownload(original, 'application/pdf', 'a.pdf', carried).sha256).toBe(carried);
    const changed = prepareDownload(bytes('%PDF-1.4\nchanged'), 'application/pdf', 'a.pdf');
    expect(changed.sha256).not.toBe(carried);
  });

  it('publishes a PDF, a text file and a CSV under fixed types and safe names', () => {
    const pdf = prepareDownload(bytes('%PDF-1.4\n'), 'application/pdf', 'Annual Report (2026).pdf');
    expect(pdf).toMatchObject({
      ext: 'pdf',
      mediaType: 'application/pdf',
      fileName: 'Annual-Report-2026.pdf',
    });
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepareDownload(bytes('a,b\n'), 'text/csv; charset=utf-8', 'data.csv').mediaType).toBe(
      'text/csv',
    );
    expect(prepareDownload(bytes('hi'), 'text/plain', '../../etc/passwd').fileName).toBe(
      'passwd.txt',
    );
  });

  it('accepts an MP4 or WebM by its signature, up to the video cap', () => {
    const mp4 = prepareDownload(
      new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
      'video/mp4',
      'My Clip.mov',
    );
    expect(mp4).toMatchObject({ ext: 'mp4', isVideo: true, fileName: 'My-Clip.mp4' });
    const webm = prepareDownload(
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]),
      'video/webm',
      'a.webm',
    );
    expect(webm.ext).toBe('webm');
    expect(() => prepareDownload(bytes('not a video'), 'video/mp4', 'a')).toThrow(
      UnsupportedDownload,
    );
    expect(() => prepareDownload(bytes('not a video'), 'video/webm', 'a')).toThrow(
      UnsupportedDownload,
    );
    expect(() => prepareDownload(new Uint8Array(MAX_VIDEO_BYTES + 1), 'video/mp4', 'a')).toThrow(
      UnsupportedDownload,
    );
  });

  it('refuses other types, mislabelled files, empty and oversized files', () => {
    for (const [content, type] of [
      [bytes('<html>'), 'text/html'],
      [bytes('<html>'), 'application/pdf'],
      [new Uint8Array([0xff, 0xfe, 0xfd]), 'text/plain'],
      [new Uint8Array(0), 'text/plain'],
      [new Uint8Array(MAX_DOWNLOAD_BYTES + 1), 'text/plain'],
      [bytes('x'), 'constructor'],
    ] as const) {
      expect(() => prepareDownload(content, type, 'f'), type).toThrow(UnsupportedDownload);
    }
  });

  it('never returns an empty or hidden name', () => {
    expect(safeFileName('...', 'pdf')).toBe('download.pdf');
    expect(safeFileName('Résumé.pdf', 'pdf')).toBe('Resume.pdf');
    expect(safeFileName('.env', 'txt')).toBe('env.txt');
  });
});

describe('downloadHeaders', () => {
  const sha = 'a'.repeat(64);

  it('downloads every file, a PDF also sandboxed', () => {
    expect(downloadHeaders(`/_nix/files/${sha}/CV.pdf`)).toEqual({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="CV.pdf"',
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
    });
    expect(downloadHeaders(`/_nix/files/${sha}/notes.csv`)).toMatchObject({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="notes.csv"',
    });
  });

  it('refuses anything that is not a published download path', () => {
    for (const path of [
      `/_nix/files/${sha}/a.html`,
      `/_nix/files/${sha}/a"b.pdf`,
      `/_nix/files/${sha}/.pdf`,
      `/_nix/files/abc/a.pdf`,
      `/files/${sha}/a.pdf`,
    ]) {
      expect(downloadHeaders(path), path).toBeNull();
    }
  });
});
