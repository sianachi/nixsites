/**
 * What every export format implements, and what the host that runs one may assume.
 *
 * **A converter reaches for nothing.** No filesystem, no network, no clock - `exportedAt` arrives on
 * {@link Branding} rather than being read - so a converter is a function from a bundle stream to
 * bytes. That is not tidiness: MVP-9's E0 turns this seam into the plugin platform's import/export
 * extension point, where a converter runs inside a sandbox that has none of those things. Building
 * it that way now means E0 changes only *where* `register` is called.
 *
 * What a converter genuinely cannot do itself, it is *given* rather than importing - see
 * {@link HostCapabilities}. Declared and optional, so a host without one produces a converter that
 * states what it could not do instead of one that fails.
 *
 * The other reason is testability. A converter with no I/O is tested by feeding it a fixture and
 * reading its output, with no server, no temp directory and no network stub.
 */

import type { LossKind } from './loss.js';
import type { ArchiveManifest, ItemBundle } from './manifest.js';

/**
 * The formats this build can produce.
 *
 * Closed, because a format is a contract with whoever opens the file - ADR-0017 makes that argument
 * for `.nix` and it holds for the lossy ones too, which owe a stated list of what they drop.
 *
 * **`nix` is in this list but is never a converter.** It is produced by `writeArchive`, which
 * streams the bundles straight through without visiting a single node, and it is served by the
 * collaboration service rather than by a converter worker.
 *
 * `nix` is the lossless archive; `pdf` and `docx` and `md` are the lossy render formats a Go worker
 * converts, each owing a stated list of what it drops.
 */
export const EXPORT_FORMATS = ['nix', 'pdf', 'docx', 'md'] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Something a format cannot carry, known before any particular document is read.
 *
 * **A function of the format, never of a body.** That is what makes it sayable in time to be honest
 * about: response headers are written before the first node is visited, and the interface has to
 * tell somebody what they are about to lose *before* they press the button, not after the download
 * finishes. What a specific document actually lost is the other surface - a `LossReport`, gathered
 * while converting and written into the file itself, because the file outlives the response.
 */
export interface LossNotice {
  readonly kind: LossKind;

  /** One sentence, addressed to the person about to export. Not a log line. */
  readonly detail: string;
}

/**
 * The colours a converter draws with.
 *
 * The shape is declared here and the values live in `@nix/design-tokens`, so the seam owns what a
 * palette *is* and the token package stays the single place a colour is decided. A converter never
 * writes a colour of its own.
 */
export interface PrintPalette {
  readonly ink: string;
  readonly muted: string;
  readonly accentText: string;
  readonly accentFill: string;
  readonly surface: string;
  readonly divider: string;
  readonly calloutFill: string;
  readonly codeFill: string;
  readonly highlight: string;
}

export interface Branding {
  /** What to call the document on its first page. Usually the root item's title. */
  readonly title: string;

  /** Injected rather than read, so a converter has no clock and two runs are comparable. */
  readonly exportedAt: Date;

  readonly palette: PrintPalette;
}

/**
 * Something a converter needs and cannot do itself.
 *
 * **The one thing a pure converter genuinely cannot be.** A Word document embeds pictures as raster
 * bytes, so drawing a view into one means turning SVG into a PNG - which needs a native rasteriser,
 * exactly the kind of thing a converter must not carry if it is to stay sandboxable when MVP-9's
 * plugin seam arrives. So the host supplies it, the converter asks, and a host that cannot supply
 * one gets a converter that says the view could not be drawn rather than one that crashes.
 *
 * This is the shape E0's capability API takes for this seam: a converter declares what it needs and
 * receives it, rather than importing it.
 */
export interface HostCapabilities {
  /** Turns an SVG document into PNG bytes at the given pixel width. */
  readonly rasterise?: (svg: string, width: number) => Promise<Uint8Array>;
}

export interface ConvertRequest {
  readonly manifest: ArchiveManifest;

  /**
   * The items, in the manifest's order.
   *
   * Async because the producer reads one document body at a time and releases it before the next -
   * the property that keeps an export's memory bounded by one item rather than by the whole tree.
   */
  readonly bundles: AsyncIterable<ItemBundle>;

  readonly branding: Branding;

  /** What the host can do for the converter. Absent capabilities degrade, never throw. */
  readonly host?: HostCapabilities;
}

export interface DocumentConverter {
  readonly format: ExportFormat;
  readonly mediaType: string;

  /** No leading dot. Used for the file name and nothing else. */
  readonly extension: string;

  /** See {@link LossNotice}. Static per format; never reads the request. */
  declaredLoss(): readonly LossNotice[];

  /**
   * The bytes of the exported file.
   *
   * A converter may consume bundles in full before emitting bytes. Callers enforce input limits;
   * the async signature alone does not promise constant memory.
   */
  convert(request: ConvertRequest): AsyncGenerator<Uint8Array>;
}
