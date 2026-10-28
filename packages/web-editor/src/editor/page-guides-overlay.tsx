import { Text } from '@nix/ui';
import type { Editor } from '@tiptap/react';
import { useEffect, useState, type ReactNode } from 'react';

import {
  estimatedPageHeight,
  planPageGuides,
  type BlockKind,
  type MeasuredBlock,
  type PageGuide,
} from './page-guides';

/**
 * The page guides, drawn over the editing surface.
 *
 * **An overlay, not a decoration.** A ProseMirror decoration lives at a document position and
 * takes part in layout; a page boundary is a pixel height that falls wherever the text happens
 * to wrap, most often in the middle of a paragraph, and drawing it must move nothing. So this is
 * a sibling of the editor, absolutely positioned inside the same box, that measures the
 * editor's blocks and draws lines at the heights `page-guides.ts` works out. It is hidden from
 * assistive technology - a line every few hundred pixels is noise to a screen reader - and the
 * one fact it carries, the page count, is given to them as a sentence instead.
 *
 * **When it measures.** On every document change, whenever the editor's box changes size (a
 * pane resized, an image finished loading) and once the web fonts are in, since a fallback face
 * wraps differently. Reads are coalesced to one per frame: a burst of keystrokes is one layout
 * pass, not one each. Measurement is `getBoundingClientRect` against the host's own rectangle,
 * which is the one coordinate space that survives the pane scrolling.
 */

/** Blocks the exporters never cut: they move whole onto the next page, and so do these. */
const ATOMIC_BLOCKS: ReadonlySet<string> = new Set(['image', 'horizontalRule', 'itemBlock']);

function kindOf(name: string, isAtom: boolean): BlockKind {
  if (name === 'pageBreak') {
    return 'pageBreak';
  }
  return isAtom || ATOMIC_BLOCKS.has(name) ? 'atomic' : 'text';
}

/** A computed line height in pixels, or the size-derived fallback when it is `normal`. */
function lineHeightOf(style: CSSStyleDeclaration, fontSize: number): number {
  const parsed = Number.parseFloat(style.lineHeight);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fontSize * 1.5;
}

interface Layout {
  /** The editing column's offset and width inside the host, so the guides span the measure. */
  readonly left: number;
  readonly width: number;
  /**
   * Whether the label fits in the margin to the right of the column. There it covers nothing;
   * inside the column, on a narrow pane, it sits on the line's right end over the last word.
   */
  readonly labelInMargin: boolean;
  readonly guides: readonly PageGuide[];
}

/** The room a "Page 12" label needs beside the column. */
const LABEL_ROOM = 72;

/** Every guide for the editor as it is laid out now, or none when it has no layout yet. */
export function measurePageGuides(editor: Editor, host: HTMLElement): Layout | null {
  const dom = editor.view.dom;
  const hostRect = host.getBoundingClientRect();
  const domRect = dom.getBoundingClientRect();
  const style = getComputedStyle(dom);
  const fontSize = Number.parseFloat(style.fontSize);

  const pageHeight = estimatedPageHeight({
    width: domRect.width,
    fontSize,
    lineHeight: lineHeightOf(style, fontSize),
  });
  if (pageHeight === null) {
    return null;
  }

  const blocks: MeasuredBlock[] = [];
  editor.state.doc.forEach((node, offset) => {
    const element = editor.view.nodeDOM(offset);
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const blockStyle = getComputedStyle(element);
    blocks.push({
      kind: kindOf(node.type.name, node.isAtom),
      top: rect.top - hostRect.top,
      height: rect.height,
      lineHeight: lineHeightOf(blockStyle, Number.parseFloat(blockStyle.fontSize) || fontSize),
    });
  });

  return {
    left: domRect.left - hostRect.left,
    width: domRect.width,
    labelInMargin: hostRect.right - domRect.right >= LABEL_ROOM,
    guides: planPageGuides(blocks, pageHeight),
  };
}

export function PageGuides({
  editor,
  host,
}: {
  readonly editor: Editor;
  /** The positioned box the editor sits in; the guides are placed in its coordinates. */
  readonly host: HTMLElement | null;
}): ReactNode {
  const [layout, setLayout] = useState<Layout | null>(null);

  useEffect(() => {
    if (host === null) {
      return;
    }

    let frame: number | null = null;

    function measure(): void {
      if (editor.isDestroyed || host === null) {
        setLayout(null);
        return;
      }
      setLayout(measurePageGuides(editor, host));
    }

    function schedule(): void {
      if (frame !== null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    }

    schedule();
    editor.on('update', schedule);
    window.addEventListener('resize', schedule);

    // Not every environment has one, and jsdom is one that does not.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            schedule();
          });
    observer?.observe(editor.view.dom);

    // `document.fonts` is likewise optional - jsdom has none, whatever the DOM types say - and
    // where it exists, a late web font re-wraps the text.
    const fonts: unknown = Reflect.get(document, 'fonts');
    if (typeof FontFaceSet !== 'undefined' && fonts instanceof FontFaceSet) {
      void fonts.ready.then(schedule, () => undefined);
    }

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      editor.off('update', schedule);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [editor, host]);

  if (layout === null || layout.guides.length === 0) {
    return null;
  }

  const pages = layout.guides[layout.guides.length - 1]?.page ?? 1;

  return (
    <>
      <Text variant="note" as="p" className="sr-only">
        About {String(pages)} pages when exported.
      </Text>
      <div
        aria-hidden="true"
        data-testid="page-guides"
        className="pointer-events-none absolute top-0"
        style={{ left: layout.left, width: layout.width }} // design-token-exempt: the editing column's measured box, not a scale step.
      >
        {layout.guides.map((guide) => (
          <div
            key={guide.page}
            data-page={guide.page}
            className="absolute inset-x-0 flex -translate-y-1/2 items-center gap-2"
            style={{ top: guide.top }} // design-token-exempt: where the page falls is a runtime measurement.
          >
            <span className="flex-1 border-t border-dashed border-accent-500" />
            <Text
              as="span"
              variant="kicker"
              tone="muted"
              className={[
                'rounded-sm border border-divider bg-background px-1.5 py-0.5 whitespace-nowrap',
                layout.labelInMargin ? 'absolute left-full ml-2' : '',
              ].join(' ')}
            >
              Page {guide.page}
            </Text>
          </div>
        ))}
      </div>
    </>
  );
}
