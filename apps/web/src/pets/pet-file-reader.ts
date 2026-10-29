import { files as fileResources, type NixClient } from '@nix/api-client';
import type { CompanionFiles, FileRead } from '@nix/companion';
import { WorkspaceToolRefusal } from '@nix/companion/tool-args';
import { extractPdfText, renderPdfFirstPage } from '../collections/thumbnails/pdf-first-page';

/** Text the pet gets from one file; the tool result itself is cut at 16,000 characters. */
const MAX_TEXT_CHARS = 14_000;
const MAX_PDF_PAGES = 50;
/** A larger text file is refused rather than downloaded for the first 14,000 characters. */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** The longer side of the picture the model sees. Enough to read a screenshot. */
const IMAGE_MAX_SIDE = 1280;
/** Core and the worker refuse a larger picture. */
export const MAX_IMAGE_URL_CHARS = 1_000_000;

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|csv|x-ndjson)$|image\/svg\+xml$)/;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|log|ini|toml)$/i;
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|bmp|avif)$/;

/**
 * Reads a file item for the pet in this tab, with the owner's own session: Core's download
 * capability applies the same permission and lock checks as opening the file. Text and PDFs come
 * back as text, pictures as a downscaled JPEG, and PDFs with no text layer as a picture of their
 * first page. Anything else is refused with a reason the model can pass on.
 */
export function createFileReader(client: NixClient): CompanionFiles {
  return {
    async read(itemId, signal) {
      const { current } = await client.query(fileResources.fileByItem(itemId), {
        signal,
        forceRefresh: true,
      });
      const { fileName, mediaType, byteLength } = current;
      const base = { fileName, mediaType };
      const kind = IMAGE_TYPES.test(mediaType)
        ? 'image'
        : mediaType === 'application/pdf'
          ? 'pdf'
          : TEXT_TYPES.test(mediaType) ||
              (mediaType === 'application/octet-stream' && TEXT_EXTENSIONS.test(fileName))
            ? 'text'
            : undefined;
      if (kind === undefined)
        throw new WorkspaceToolRefusal(
          `${fileName} is a ${mediaType} file, which cannot be read yet. Text, Markdown, CSV, JSON, PDF and image files can.`,
        );
      if (byteLength > (kind === 'text' ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES))
        throw new WorkspaceToolRefusal(`${fileName} is too large to read.`);
      const { blob } = await fileResources.fetchFileContent(
        client,
        itemId,
        undefined,
        false,
        signal,
      );
      if (kind === 'text') {
        const text = await blob.text();
        return {
          ...base,
          text: text.slice(0, MAX_TEXT_CHARS),
          truncated: text.length > MAX_TEXT_CHARS,
        };
      }
      if (kind === 'image') return { ...base, image: await toJpegUrl(blob), truncated: false };
      return readPdf(blob, base, signal);
    },
  };
}

async function readPdf(
  blob: Blob,
  base: Pick<FileRead, 'fileName' | 'mediaType'>,
  signal: AbortSignal,
): Promise<FileRead> {
  try {
    const { text, truncated } = await extractPdfText(blob, {
      maxChars: MAX_TEXT_CHARS,
      maxPages: MAX_PDF_PAGES,
      signal,
    });
    if (text.trim()) return { ...base, text, truncated };
    // A scanned PDF has no text layer; its first page as a picture is the next best thing.
    const page = await renderPdfFirstPage(blob, { maxSide: IMAGE_MAX_SIDE, signal });
    return { ...base, image: await toJpegUrl(page), truncated: true };
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
    throw new WorkspaceToolRefusal(
      `${base.fileName} could not be read as a PDF (damaged, password-protected or too slow).`,
    );
  }
}

/** The picture at most {@link IMAGE_MAX_SIDE} on its longer side, as a JPEG data URL. */
async function toJpegUrl(blob: Blob): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new WorkspaceToolRefusal('This image could not be decoded.');
  }
  try {
    for (const [side, quality] of [
      [IMAGE_MAX_SIDE, 0.8],
      [896, 0.6],
    ] as const) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (context === null) break;
      // JPEG has no alpha; a transparent screenshot would come out black.
      context.fillStyle = 'white';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      const url = await blobToDataUrl(jpeg);
      if (url.length <= MAX_IMAGE_URL_CHARS) return url;
    }
  } finally {
    bitmap.close();
  }
  throw new WorkspaceToolRefusal('This image is too detailed to send.');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('The image could not be read.'));
    };
    reader.readAsDataURL(blob);
  });
}
