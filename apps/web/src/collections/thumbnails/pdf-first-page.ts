import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker, RenderTask } from 'pdfjs-dist';

/**
 * A PDF's first page as a JPEG, drawn in this tab.
 *
 * It is drawn here and not on the server because a PDF is a program-shaped file from a stranger -
 * fonts, filters, embedded images, scripts - and the owner does not want a native renderer parsing
 * those on Core's side of the line. In the browser the parser runs in a worker with no access to
 * the page, under the page's own Content-Security-Policy, and a hostile file costs one tab a
 * thumbnail and nothing else.
 *
 * pdf.js and its worker are imported on first use, so none of it is in the entry bundle: a user who
 * never opens a gallery of PDFs never downloads a PDF engine. The worker is one of this app's own
 * files (`?worker`), which is what `default-src 'self'` permits; a CDN or `blob:` worker would not
 * be allowed, and the policy is not ours to loosen.
 *
 * Everything a stranger controls is bounded: bytes in, pixels out, and time.
 */

/** Refused before a single byte is parsed; a thumbnail is not worth reading a larger file for. */
export const PDF_THUMBNAIL_MAX_BYTES = 100 * 1024 * 1024;

/** Whatever a caller asks for, the canvas is never larger than this on either side. */
export const PDF_THUMBNAIL_MAX_SIDE_LIMIT = 4096;

/** Wall-clock budget for one render, parsing included. Past it the work is abandoned. */
export const PDF_THUMBNAIL_TIMEOUT_MS = 15_000;

const JPEG_QUALITY = 0.82;

/**
 * Decoded pixels in any one embedded image. A few kilobytes of compressed data can claim a
 * hundred-thousand-pixel-square bitmap; the default is no limit at all.
 */
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

/**
 * Why no thumbnail came back, in terms a caller can act on: `too-large` and `unreadable` are
 * properties of the file and will not change on a retry; `timeout` and `failed` might.
 */
export type PdfThumbnailFailure = 'too-large' | 'unreadable' | 'timeout' | 'failed';

export class PdfThumbnailError extends Error {
  readonly reason: PdfThumbnailFailure;

  constructor(reason: PdfThumbnailFailure) {
    // The message names the reason and nothing from the file: what a stranger's PDF says about
    // itself does not belong in a log.
    super(`No PDF thumbnail: ${reason}`);
    this.name = 'PdfThumbnailError';
    this.reason = reason;
  }
}

export interface RenderPdfFirstPageOptions {
  /** The longer side of the result, in pixels; capped at {@link PDF_THUMBNAIL_MAX_SIDE_LIMIT}. */
  readonly maxSide: number;
  readonly signal?: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException('The PDF thumbnail was cancelled.', 'AbortError');
}

/** The engine, loaded once. Both halves are separate files in the build and neither is eager. */
async function loadEngine() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?worker'),
  ]);
  return { pdfjs, createWorker: () => new worker.default() };
}

interface Surface {
  readonly context: CanvasRenderingContext2D;
  readonly encode: () => Promise<Blob | null>;
}

/** Never attached to the document: nothing a PDF draws is ever visible except as the JPEG. */
function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new PdfThumbnailError('failed');
    return {
      // pdf.js is typed for the DOM context; the offscreen one has the same drawing surface.
      context: context as unknown as CanvasRenderingContext2D,
      encode: () => canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY }),
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new PdfThumbnailError('failed');
  return {
    context,
    encode: () =>
      new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
      }),
  };
}

export async function renderPdfFirstPage(
  bytes: ArrayBuffer | Blob,
  options: RenderPdfFirstPageOptions,
): Promise<Blob> {
  if (!Number.isFinite(options.maxSide) || options.maxSide < 1) {
    throw new RangeError('maxSide must be a positive number of pixels.');
  }
  const maxSide = Math.min(Math.floor(options.maxSide), PDF_THUMBNAIL_MAX_SIDE_LIMIT);
  return withPdf(bytes, options.signal, async (pdf, stop) => {
    const page = await pdf.getPage(1);
    stop.throwIfAborted();
    const natural = page.getViewport({ scale: 1 });
    const longer = Math.max(natural.width, natural.height);
    if (!(longer > 0)) throw new PdfThumbnailError('unreadable');
    // The pixel count follows from the longer side: at most maxSide squared, and never more than
    // the cap on either side.
    const viewport = page.getViewport({ scale: maxSide / longer });
    const width = Math.max(1, Math.min(maxSide, Math.round(viewport.width)));
    const height = Math.max(1, Math.min(maxSide, Math.round(viewport.height)));

    const surface = createSurface(width, height);
    // JPEG has no alpha, and a page with no background of its own would come out black. White
    // paper whatever the theme, so this is the CSS keyword and not a theme token.
    surface.context.fillStyle = 'white';
    surface.context.fillRect(0, 0, width, height);
    const render: RenderTask = page.render({
      canvas: null,
      canvasContext: surface.context,
      viewport,
    });
    stop.addEventListener(
      'abort',
      () => {
        render.cancel();
      },
      { once: true },
    );
    await render.promise;
    stop.throwIfAborted();

    const blob = await surface.encode();
    if (blob === null) throw new PdfThumbnailError('failed');
    return blob;
  });
}

/** The text of a PDF's pages, in order, cut at `maxChars`; `truncated` says whether anything
 * was left out. Same engine, limits and teardown as the thumbnail. */
export async function extractPdfText(
  bytes: ArrayBuffer | Blob,
  options: { readonly maxChars: number; readonly maxPages: number; readonly signal?: AbortSignal },
): Promise<{ text: string; pages: number; truncated: boolean }> {
  return withPdf(bytes, options.signal, async (pdf, stop) => {
    let text = '';
    const pages = Math.min(pdf.numPages, options.maxPages);
    for (let number = 1; number <= pages && text.length < options.maxChars; number++) {
      const page = await pdf.getPage(number);
      stop.throwIfAborted();
      const content = await page.getTextContent();
      stop.throwIfAborted();
      const line = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('');
      text += `${text ? '\n\n' : ''}${line.trim()}`;
    }
    return {
      text: text.slice(0, options.maxChars),
      pages: pdf.numPages,
      truncated: text.length > options.maxChars || pdf.numPages > pages,
    };
  });
}

/** Opens `bytes` in a worker of its own, hands the document to `read`, and tears everything down
 * on every exit. `read` must stop at `stop` aborting: the deadline or the caller's cancellation. */
async function withPdf<T>(
  bytes: ArrayBuffer | Blob,
  signal: AbortSignal | undefined,
  read: (pdf: PDFDocumentProxy, stop: AbortSignal) => Promise<T>,
): Promise<T> {
  const byteLength = bytes instanceof Blob ? bytes.size : bytes.byteLength;
  if (byteLength > PDF_THUMBNAIL_MAX_BYTES) throw new PdfThumbnailError('too-large');
  if (byteLength === 0) throw new PdfThumbnailError('unreadable');
  if (signal?.aborted === true) throw abortError();

  // One signal for the caller's cancellation and our own deadline, so there is one place that
  // decides the work is over.
  const stop = new AbortController();
  const onCallerAbort = () => {
    stop.abort(abortError());
  };
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    stop.abort(new PdfThumbnailError('timeout'));
  }, PDF_THUMBNAIL_TIMEOUT_MS);

  let worker: PDFWorker | undefined;
  let task: PDFDocumentLoadingTask | undefined;

  const abandoned = new Promise<never>((_, reject) => {
    stop.signal.addEventListener(
      'abort',
      () => {
        reject(stop.signal.reason as Error);
      },
      { once: true },
    );
  });
  // `abandoned` is only ever raced; a rejection nobody is racing yet is not an unhandled one.
  abandoned.catch(() => undefined);

  const open = async (): Promise<T> => {
    const { pdfjs, createWorker } = await loadEngine();
    stop.signal.throwIfAborted();
    // The data is copied into a view over its own buffer for the worker; for an ArrayBuffer the
    // caller passed, that buffer is handed to the worker and must not be reused afterwards.
    const data = new Uint8Array(bytes instanceof Blob ? await bytes.arrayBuffer() : bytes);
    stop.signal.throwIfAborted();

    // A worker of our own per file, destroyed with it: nothing one file did in a worker survives
    // to the next.
    worker = new pdfjs.PDFWorker({
      // The published types give `port` as null-only; the implementation takes a Worker.
      port: createWorker() as unknown as null,
    });
    task = pdfjs.getDocument({
      data,
      worker,
      // There is no `isEvalSupported` to turn off: pdf.js 6 no longer compiles glyph programs with
      // `eval` or `new Function`, and this app's policy has no `unsafe-eval` for it to want.
      // Nothing is read ahead and nothing is streamed; the whole file is already in memory.
      disableAutoFetch: true,
      disableStream: true,
      // Glyphs are drawn as paths. The alternative loads fonts through `FontFace` from data or
      // blob URLs, which `font-src 'self'` blocks, and parses font programs in the browser's own
      // font stack. The cost is slightly softer text, invisible at thumbnail size.
      disableFontFace: true,
      enableXfa: false,
      // A page that does not parse is no thumbnail; a half-drawn one would be a wrong one.
      stopAtErrors: true,
      maxImageSize: MAX_IMAGE_PIXELS,
      // The wasm decoders (JPEG 2000 and the like) would need a URL to load from and
      // `wasm-unsafe-eval` to compile; neither is available, so do not try.
      useWasm: false,
      // These published support files ship with this app; document URLs cannot replace them.
      // Font bytes become glyph paths in the worker without relaxing font-src or script-src.
      standardFontDataUrl: new URL('/pdf-assets/fonts/', window.location.origin).href,
      cMapUrl: new URL('/pdf-assets/cmaps/', window.location.origin).href,
      cMapPacked: true,
    });
    const pdf: PDFDocumentProxy = await task.promise;
    stop.signal.throwIfAborted();
    return read(pdf, stop.signal);
  };

  const working = open();
  // If the deadline wins the race, `working` is left to fail on its own once its resources are
  // destroyed below; that failure is expected and not worth an unhandled rejection.
  working.catch(() => undefined);

  try {
    return await Promise.race([working, abandoned]);
  } catch (error) {
    if (error instanceof PdfThumbnailError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // Anything else came out of the parser or the renderer: a password, a damaged file, a feature
    // it does not support. All of them mean this file cannot be read.
    throw new PdfThumbnailError('unreadable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
    // Every exit path, abort included. Destroying the worker terminates its thread outright, so
    // none of this waits on a parser that may be stuck.
    stop.abort(abortError());
    void task?.destroy().catch(() => undefined);
    worker?.destroy();
  }
}
