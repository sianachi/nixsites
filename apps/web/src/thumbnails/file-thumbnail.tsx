import { Duotone, Icon, blueprintFrame, cn } from '@nix/ui';
import { BookOpen, File, FileText, Image, Music, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { files, type FileVersion } from '@nix/api-client';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';

import {
  fileThumbnailKind,
  useFileThumbnail,
  type FileThumbnailKind,
  type UseFileThumbnailOptions,
} from './use-file-thumbnail';

const KIND_GLYPH: Record<FileThumbnailKind, LucideIcon> = {
  image: Image,
  audio: Music,
  epub: BookOpen,
  pdf: FileText,
  other: File,
};

/** How far outside the viewport a box may be when its work starts. */
const APPROACH_MARGIN = '400px';

/** The nearest ancestor that scrolls vertically, or null for the window itself. */
function scrollingAncestor(element: Element): Element | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

export interface FileThumbnailProps extends Omit<UseFileThumbnailOptions, 'enabled'> {
  /**
   * The box's size and shape, which the caller owns: `aspect-square w-full` for a tile,
   * `size-8` for a row. The box is drawn in every state so nothing reflows as pictures arrive.
   */
  readonly className: string;
  readonly iconSize?: 'sm' | 'md' | 'lg';
}

/**
 * A file's picture in a fixed box, or a quiet glyph for its kind where there is none.
 *
 * `alt` is empty on purpose: every place this is drawn names the file in text beside it, and a
 * second announcement of the same name is noise. Work waits until the box is on screen or about to be - an
 * `IntersectionObserver` where there is one, at once where there is not - and then stays
 * switched on, so scrolling away and back does not start it again.
 */
export function FileThumbnail({
  className,
  iconSize = 'md',
  ...source
}: FileThumbnailProps): ReactNode {
  const client = useApiClient();
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  // A picture the browser could not decode is a glyph, not a broken-image icon in the box.
  const [broken, setBroken] = useState<string | null>(null);
  const [pdfRecord, setPdfRecord] = useState<{ itemId: string; version: FileVersion } | null>(null);
  const needsPdfRecord =
    fileThumbnailKind(source.fileName, source.mediaType) === 'pdf' &&
    (source.version === null || source.byteLength === undefined);

  useEffect(() => {
    if (!visible || !needsPdfRecord) return;
    const controller = new AbortController();
    void client
      .query(files.fileByItem(source.itemId), { signal: controller.signal, forceRefresh: true })
      .then((record) => {
        if (!controller.signal.aborted)
          setPdfRecord({ itemId: source.itemId, version: record.current });
      })
      .catch(() => {
        /* An unavailable PDF keeps its file glyph. */
      });
    return () => {
      controller.abort();
    };
  }, [client, visible, needsPdfRecord, source.itemId]);

  useEffect(() => {
    const element = box.current;
    if (visible || element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      // A head start of about a row or two, so a picture is usually there by the time its box
      // scrolls in rather than starting its round trips at that moment.
      // The margin grows the root's box, and a pane that scrolls inside the window clips its
      // rows before the window does, so the head start has to be measured from that pane.
      { root: scrollingAncestor(element), rootMargin: APPROACH_MARGIN },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [visible]);

  const knownPdf = pdfRecord?.itemId === source.itemId ? pdfRecord.version : null;
  const thumbnail = useFileThumbnail({
    ...source,
    ...(needsPdfRecord && knownPdf
      ? { version: knownPdf.id, byteLength: knownPdf.byteLength }
      : {}),
    enabled: visible,
  });
  const Glyph = KIND_GLYPH[fileThumbnailKind(source.fileName, source.mediaType)];
  const showPicture =
    thumbnail.status === 'ready' && thumbnail.url !== null && broken !== thumbnail.url;

  return (
    <div
      ref={box}
      className={cn(
        blueprintFrame,
        'relative flex shrink-0 items-center justify-center overflow-hidden bg-surface text-muted',
        className,
      )}
    >
      {showPicture ? (
        <Duotone
          src={thumbnail.url}
          alt=""
          className={cn(
            'absolute inset-0 size-full',
            fileThumbnailKind(source.fileName, source.mediaType) === 'pdf'
              ? 'object-contain'
              : 'object-cover',
          )}
          onError={() => {
            setBroken(thumbnail.url);
          }}
        />
      ) : (
        <Icon icon={Glyph} size={iconSize} />
      )}
    </div>
  );
}
