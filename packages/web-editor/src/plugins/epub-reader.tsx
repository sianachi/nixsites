import { Button, Icon, Popover, Text, cn } from '@nix/ui';
import { AArrowDown, AArrowUp, ChevronLeft, ChevronRight, List } from 'lucide-react';
import {
  useMemo,
  useState,
  useSyncExternalStore,
  useEffect,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

import { EpubRefusal, parseEpub, type EpubBook } from '@nix/web-foundation/lib/epub-archive';
import { buildEpubChapterDocument, readEpubPalette } from '@nix/web-foundation/lib/epub-chapter';
import { readEpubProgress, writeEpubProgress } from '@nix/web-foundation/lib/epub-progress';
import { browserStorage } from '@nix/web-foundation/lib/browser-storage';

/**
 * An EPUB, read in place.
 *
 * The parent owns everything that can be interactive - the title, the contents, the chapter and
 * size controls - and the book owns only a sandboxed frame it cannot get out of. That split is the
 * design: a frame with no scripts cannot report a click or a keypress to anyone, so every control
 * lives out here, and the frame is only ever a rendering of one chapter.
 *
 * `lib/epub-archive.ts` opens the book and `lib/epub-chapter.ts` makes a chapter safe to show;
 * read the second before changing anything about what goes into the frame.
 */

/** The base font size, as percentages. The second is the browser's default and the starting point. */
const FONT_SCALES = [85, 100, 120, 145] as const;
const DEFAULT_SIZE_STEP = 1;

/** Static class names, so Tailwind sees them: contents entries indent to three levels. */
const INDENT = ['pl-2', 'pl-6', 'pl-10', 'pl-14'] as const;

type Opening =
  | { readonly status: 'opening' }
  | { readonly status: 'refused'; readonly message: string }
  | { readonly status: 'ready'; readonly book: EpubBook };

/**
 * The application's colours as one string that changes when the theme does.
 *
 * Read from the page, because the chapter lives in a frame that inherits nothing. The theme is the
 * `data-theme` attribute or, absent that, the machine's own setting, so both are watched.
 */
function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  });
  const media = globalThis.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media.removeEventListener('change', onChange);
  };
}

function themeSnapshot(): string {
  return JSON.stringify(readEpubPalette(document.documentElement));
}

export function EpubReader({
  fileName,
  blob,
  itemId,
}: {
  readonly fileName: string;
  /** The authorised bytes. A blob and not a URL: the application's policy does not let it fetch a blob URL. */
  readonly blob: Blob | undefined;
  readonly itemId: string | undefined;
}): ReactElement {
  const [opened, setOpening] = useState<Opening>({ status: 'opening' });
  const opening: Opening =
    blob === undefined ? { status: 'refused', message: 'The book could not be loaded.' } : opened;
  const [saved] = useState(() =>
    itemId === undefined ? null : readEpubProgress(browserStorage(), itemId),
  );
  const [target, setTarget] = useState<{
    readonly index: number;
    readonly fragment: string | null;
  }>({ index: saved?.chapter ?? 0, fragment: null });
  const [sizeStep, setSizeStep] = useState(
    Math.min(saved?.size ?? DEFAULT_SIZE_STEP, FONT_SCALES.length - 1),
  );
  const themeKey = useSyncExternalStore(subscribeToTheme, themeSnapshot);

  useEffect(() => {
    if (blob === undefined) return;
    let current = true;
    void blob
      .arrayBuffer()
      .then((buffer) => {
        if (current) setOpening({ status: 'ready', book: parseEpub(new Uint8Array(buffer)) });
      })
      .catch((reason: unknown) => {
        if (current)
          setOpening({
            status: 'refused',
            message:
              reason instanceof EpubRefusal ? reason.message : 'This book could not be opened.',
          });
      });
    return () => {
      current = false;
    };
  }, [blob]);

  const book = opening.status === 'ready' ? opening.book : null;
  const chapterCount = book?.spine.length ?? 0;
  const chapter = Math.max(0, Math.min(target.index, chapterCount - 1));

  useEffect(() => {
    if (itemId === undefined || chapterCount === 0) return;
    writeEpubProgress(browserStorage(), itemId, { chapter, size: sizeStep });
  }, [itemId, chapterCount, chapter, sizeStep]);

  // Memoised for identity, not cost: the frame reloads whenever its `srcDoc` string is a different
  // string, so an unrelated re-render must hand it the very same one. The theme key is a
  // dependency because the palette is read from the page when the chapter is built.
  const frame = useMemo(() => {
    if (book === null || chapterCount === 0) return null;
    try {
      return {
        document: buildEpubChapterDocument(book, chapter, {
          palette: readEpubPalette(document.documentElement),
          fontScale: FONT_SCALES[sizeStep] ?? 100,
          fragment: target.fragment,
        }),
      };
    } catch {
      return { error: 'This chapter could not be shown.' };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- themeKey stands for the palette read inside.
  }, [book, chapter, chapterCount, sizeStep, target.fragment, themeKey]);

  if (opening.status === 'opening') {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-2 sm:p-8">
        <Text variant="note" tone="muted" role="status">
          Opening the book…
        </Text>
      </div>
    );
  }
  if (opening.status === 'refused') {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 p-2 text-center sm:p-8">
        <Text variant="note" role="alert">
          {opening.message}
        </Text>
        <Text variant="note" tone="muted" as="p">
          The Download button above still saves the file.
        </Text>
      </div>
    );
  }
  if (chapterCount === 0 || book === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-2 sm:p-8">
        <Text variant="note" tone="muted" role="status">
          This book has no chapters to show.
        </Text>
      </div>
    );
  }

  const title = book.title ?? fileName;
  const goTo = (index: number, fragment: string | null = null): void => {
    setTarget({ index: Math.max(0, Math.min(index, chapterCount - 1)), fragment });
  };

  // Keys move between chapters only while focus is on these controls. The chapter is a sandboxed
  // frame with no scripts, so it can neither receive a key press on the reader's behalf nor tell
  // anyone about one; a person reading with focus inside it uses the buttons or clicks out.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== null) return;
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      goTo(chapter - 1);
    } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      goTo(chapter + 1);
    }
  };

  return (
    <section aria-label={`Book: ${title}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label="Reader controls"
        onKeyDown={onKeyDown}
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider px-2 py-1.5 sm:px-8"
      >
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <Text as="p" variant="bodySmall" className="truncate font-semibold">
            {title}
          </Text>
          {book.author === null ? null : (
            <Text as="p" variant="caption" tone="muted" className="truncate">
              {book.author}
            </Text>
          )}
        </div>
        <Popover
          label="Contents"
          className="w-64 max-w-full sm:w-80"
          trigger={(trigger) => (
            <Button variant="ghost" className="px-2 py-1 text-xs" {...trigger}>
              <Icon icon={List} size="sm" />
              Contents
            </Button>
          )}
        >
          {({ close }) =>
            book.toc.length === 0 ? (
              <Text variant="note" tone="muted" as="p">
                This book has no table of contents. Use the chapter buttons.
              </Text>
            ) : (
              <nav aria-label="Table of contents" className="max-h-96 overflow-y-auto">
                <ul>
                  {book.toc.map((entry, position) => (
                    <li key={`${String(position)}:${String(entry.spineIndex)}`}>
                      <Button
                        variant="ghost"
                        aria-current={
                          entry.spineIndex === chapter && entry.fragment === target.fragment
                            ? 'location'
                            : undefined
                        }
                        className={cn(
                          'w-full justify-start text-left',
                          INDENT[Math.min(entry.depth, INDENT.length - 1)],
                        )}
                        onClick={() => {
                          goTo(entry.spineIndex, entry.fragment);
                          close();
                        }}
                      >
                        <span className="truncate">{entry.label}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              </nav>
            )
          }
        </Popover>
        <Button
          variant="icon"
          aria-label="Previous chapter"
          disabled={chapter === 0}
          onClick={() => {
            goTo(chapter - 1);
          }}
        >
          <Icon icon={ChevronLeft} size="sm" />
        </Button>
        <Text as="span" variant="caption" tone="muted" className="whitespace-nowrap" role="status">
          Chapter {chapter + 1} of {chapterCount}
        </Text>
        <Button
          variant="icon"
          aria-label="Next chapter"
          disabled={chapter === chapterCount - 1}
          onClick={() => {
            goTo(chapter + 1);
          }}
        >
          <Icon icon={ChevronRight} size="sm" />
        </Button>
        <Button
          variant="icon"
          aria-label="Smaller text"
          disabled={sizeStep === 0}
          onClick={() => {
            setSizeStep(sizeStep - 1);
          }}
        >
          <Icon icon={AArrowDown} size="sm" />
        </Button>
        <Button
          variant="icon"
          aria-label="Larger text"
          disabled={sizeStep === FONT_SCALES.length - 1}
          onClick={() => {
            setSizeStep(sizeStep + 1);
          }}
        >
          <Icon icon={AArrowUp} size="sm" />
        </Button>
      </div>

      {frame === null || 'error' in frame ? (
        <div className="flex min-w-0 flex-1 items-center justify-center p-2 sm:p-8">
          <Text variant="note" role="alert">
            {frame === null ? 'This book has no chapters to show.' : frame.error}
          </Text>
        </div>
      ) : (
        // No `allow-*` token at all: no scripts, no same-origin, no forms, no popups, no
        // navigation of the application. The chapter is also given no referrer.
        <iframe
          title={`${title}, chapter ${String(chapter + 1)}`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={frame.document}
          className="min-h-0 min-w-0 w-full max-w-full flex-1 border-0"
        />
      )}
    </section>
  );
}
