/**
 * How a file's numbers are said.
 *
 * Shared by the file page's toolbar and its details drawer so the two never disagree about what
 * a kibibyte is.
 */

export function formatBytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * The short word for what a file is: "PDF", "PNG", "CSV".
 *
 * The extension, upper-cased, because that is the word people use; the media type's subtype
 * when there is no extension, because it is better than nothing. Never the full media type,
 * which is what the details drawer is for.
 */
export function fileKindLabel(fileName: string, mediaType: string): string {
  const extension = /\.([^./\\]+)$/u.exec(fileName)?.[1];
  if (extension !== undefined && extension.length <= 8) {
    return extension.toUpperCase();
  }
  const subtype = mediaType.split(';', 1)[0]?.split('/')[1]?.trim();
  if (subtype !== undefined && subtype.length > 0) {
    return subtype.replace(/^(x-|vnd\.)/u, '').toUpperCase();
  }
  return 'File';
}

/** A date as a person would say it, in their own locale; an unparseable one is shown as given. */
export function formatWhen(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(time),
  );
}
