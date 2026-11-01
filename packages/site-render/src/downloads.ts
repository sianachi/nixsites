import { createHash } from 'node:crypto';

/**
 * Attached files a site publishes as downloads: a PDF, a plain-text file or a CSV, referenced from
 * a body (a linked file block or an inline reference) or a `nix-file:` property.
 *
 * Only these types; a document is at most {@link MAX_DOWNLOAD_BYTES} and a video (MP4 or WebM, shown
 * in a player) at most {@link MAX_VIDEO_BYTES}. Core's eligibility query holds the same list and
 * caps. A PDF, MP4 or WebM is checked for its signature and a text file for valid UTF-8, so a file
 * mislabelled as one of them is not served under that type. A video is not transcoded or
 * inspected further, so its metadata (location, device) is published as stored.
 *
 * **Bytes are published as stored.** Unlike an image, a PDF's document metadata (author, producer,
 * dates, XMP) is not stripped: rewriting a PDF safely needs a full parser. A publisher who does not
 * want that metadata public removes it before attaching the file.
 */

// shortcut: MP4 and WebM are published as stored, so location and device metadata stay in the file; strip it or warn the publisher at publish time (#177).
export const MAX_DOWNLOAD_BYTES = 20 << 20;
export const MAX_VIDEO_BYTES = 50 << 20;

const EXTENSIONS = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
} as const;

export type DownloadMediaType = keyof typeof EXTENSIONS;

export class UnsupportedDownload extends Error {
  override readonly name = 'UnsupportedDownload';
}

export interface PublishedDownload {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly ext: (typeof EXTENSIONS)[DownloadMediaType];
  readonly mediaType: DownloadMediaType;
  readonly isVideo: boolean;
  /** A file name safe in a URL segment and a `Content-Disposition` header, with its extension. */
  readonly fileName: string;
}

/** The media type without parameters, when it is one a site publishes as a download. */
export function downloadType(mediaType: string): DownloadMediaType | null {
  const bare = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  return Object.hasOwn(EXTENSIONS, bare) ? (bare as DownloadMediaType) : null;
}

/** `Annual Report (2026).pdf` becomes `Annual-Report-2026.pdf`; never empty, never a path. */
export function safeFileName(name: string, ext: string): string {
  const last = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = last.lastIndexOf('.');
  const base = (dot > 0 ? last.slice(0, dot) : last)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80)
    .replace(/[-_]+$/, '');
  return `${base.length === 0 ? 'download' : base}.${ext}`;
}

export function prepareDownload(
  bytes: Uint8Array,
  mediaType: string,
  fileName: string,
): PublishedDownload {
  const type = downloadType(mediaType);
  if (type === null) {
    throw new UnsupportedDownload(`Files of type ${mediaType} cannot be published.`);
  }
  const isVideo = type.startsWith('video/');
  if (bytes.length === 0 || bytes.length > (isVideo ? MAX_VIDEO_BYTES : MAX_DOWNLOAD_BYTES)) {
    throw new UnsupportedDownload('A file is empty or larger than a site publishes.');
  }
  if (type === 'application/pdf') {
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
      throw new UnsupportedDownload('A file labelled as a PDF is not one.');
    }
  } else if (type === 'video/mp4') {
    if (String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') {
      throw new UnsupportedDownload('A file labelled as an MP4 video is not one.');
    }
  } else if (type === 'video/webm') {
    // EBML header magic.
    if (
      bytes.length < 4 ||
      bytes[0] !== 0x1a ||
      bytes[1] !== 0x45 ||
      bytes[2] !== 0xdf ||
      bytes[3] !== 0xa3
    ) {
      throw new UnsupportedDownload('A file labelled as a WebM video is not one.');
    }
  } else {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new UnsupportedDownload('A text file is not valid UTF-8.');
    }
  }
  const ext = EXTENSIONS[type];
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ext,
    mediaType: type,
    isVideo,
    fileName: safeFileName(fileName, ext),
  };
}
