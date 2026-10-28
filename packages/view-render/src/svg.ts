/**
 * The small amount of SVG this package writes by hand.
 *
 * **No DOM and no library.** These drawings run in a service that has neither, and the output is a
 * string a PDF embeds directly or a rasteriser turns into a picture. A builder abstraction over
 * five shapes would be more code than the shapes.
 *
 * **Everything that comes from a document goes through `escape`.** A title is somebody's text and
 * an unescaped `&` or `<` makes the whole drawing unparseable - which, in a rasteriser, means a
 * blank rectangle where the board was rather than an error anybody sees.
 */

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export interface RectOptions {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill?: string;
  readonly stroke?: string;
  readonly radius?: number;
}

export function rect(options: RectOptions): string {
  const parts = [
    `x="${String(round(options.x))}"`,
    `y="${String(round(options.y))}"`,
    `width="${String(round(Math.max(0, options.width)))}"`,
    `height="${String(round(Math.max(0, options.height)))}"`,
    `fill="${options.fill ?? 'none'}"`,
  ];

  if (options.stroke !== undefined) {
    parts.push(`stroke="${options.stroke}"`, 'stroke-width="1"');
  }

  if (options.radius !== undefined) {
    parts.push(`rx="${String(round(options.radius))}"`);
  }

  return `<rect ${parts.join(' ')}/>`;
}

export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  width = 1,
): string {
  return `<line x1="${String(round(x1))}" y1="${String(round(y1))}" x2="${String(round(x2))}" y2="${String(round(y2))}" stroke="${stroke}" stroke-width="${String(width)}"/>`;
}

export interface TextOptions {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly fill: string;
  readonly bold?: boolean;
  readonly anchor?: 'start' | 'middle' | 'end';
}

/**
 * A run of text.
 *
 * The family is named rather than inherited, because a rasteriser resolves fonts against the system
 * and an unnamed family gives whatever it defaults to - which is how an export ends up in a
 * typeface the product does not use. The fallbacks are there for a machine that does not have it.
 */
export function text(content: string, options: TextOptions): string {
  const anchor = options.anchor ?? 'start';

  return (
    `<text x="${String(round(options.x))}" y="${String(round(options.y))}" ` +
    `font-family="Nunito Sans, system-ui, sans-serif" font-size="${String(round(options.size))}" ` +
    `fill="${options.fill}"${options.bold === true ? ' font-weight="700"' : ''}` +
    `${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}>` +
    `${escape(content)}</text>`
  );
}

/**
 * Text cut to the width it has, with an ellipsis when it did not fit.
 *
 * **Measured by estimate, not by metrics.** Nothing here can measure a glyph - there is no font
 * loaded and no canvas to ask - so the width is approximated from the character count at an average
 * advance. That is why every drawn box is generous rather than tight: the failure mode of an
 * estimate is text that overruns, and the margin is what keeps it inside the box instead.
 */
export function truncate(content: string, size: number, available: number): string {
  const perCharacter = size * 0.55;
  const fits = Math.floor(available / perCharacter);

  if (content.length <= fits) {
    return content;
  }

  return fits <= 1 ? '' : `${content.slice(0, Math.max(1, fits - 1)).trimEnd()}…`;
}

/** The document, wrapped around whatever the view drew. */
export function document(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(round(width))}" height="${String(round(height))}" ` +
    `viewBox="0 0 ${String(round(width))} ${String(round(height))}">${body}</svg>`
  );
}

/**
 * Coordinates at a tenth of a point.
 *
 * Full precision would put fifteen digits of floating-point noise in the markup, which makes two
 * drawings of the same content differ in bytes without differing in appearance - and the test that
 * compares them useless.
 */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
