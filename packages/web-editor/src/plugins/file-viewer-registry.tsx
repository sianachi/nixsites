import type { ComponentType } from 'react';

export interface FileViewerPluginInput {
  readonly fileName: string;
  readonly mediaType: string;
  readonly source: string;
}

/**
 * What a viewer wants handed to it.
 *
 * `text` viewers receive the file's decoded text and draw it themselves. `url` viewers receive an
 * object URL for the authorised bytes, for the elements that can only take a URL - `<audio>`,
 * `<video>` - and for anything too large to hold as a string. `stream` viewers are handed nothing
 * to read: the host downloads no bytes for them, and they ask for their own authorised address
 * (by `itemId`) so the browser can stream with range requests - audio, which can run to the
 * upload limit and must start playing before it has arrived.
 */
export type FileViewerSourceKind = 'text' | 'url' | 'stream';

/** What the host gives a viewer. `source` is empty for a `stream` viewer. */
export interface FileViewerProps extends Pick<FileViewerPluginInput, 'fileName' | 'source'> {
  readonly itemId: string;
  /**
   * The authorised bytes, held by the host for a `url` viewer. For a viewer that has to read the
   * file rather than hand a URL to an element: the application's policy lets it fetch from its
   * own origin and the object store, but not from an object URL.
   */
  readonly blob?: Blob;
  /** The file page's own download, for a viewer that has to say it cannot show the file. */
  readonly onDownload: () => void;
}

export interface FileViewerPlugin {
  readonly id: string;
  readonly matches: (file: Pick<FileViewerPluginInput, 'fileName' | 'mediaType'>) => boolean;
  /** Defaults to `text`. */
  readonly source?: FileViewerSourceKind;
  readonly Component: ComponentType<FileViewerProps>;
}

/** The host owns this registry so file viewers remain plugins rather than conditionals in FileViewer. */
export function createFileViewerRegistry(
  plugins: readonly FileViewerPlugin[],
): (file: Pick<FileViewerPluginInput, 'fileName' | 'mediaType'>) => FileViewerPlugin | null {
  return (file) => plugins.find((plugin) => plugin.matches(file)) ?? null;
}

/** The media type without its parameters, lower-cased: `text/plain; charset=utf-8` is `text/plain`. */
export function bareMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** The file's extension, lower-cased and without the dot, or an empty string. */
export function fileExtension(fileName: string): string {
  const match = /\.([^./\\]+)$/u.exec(fileName);
  return match?.[1]?.toLowerCase() ?? '';
}
