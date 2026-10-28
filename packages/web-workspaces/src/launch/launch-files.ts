/**
 * Files the operating system handed the installed app - "Open with Nix" on a Markdown file - as
 * the manifest's `file_handlers` entry promises. The browser queues them on `window.launchQueue`
 * until a consumer is set, so the launch page can set one whenever it mounts and still receive
 * what launched it.
 */

interface LaunchParams {
  readonly files?: readonly { readonly kind?: string; getFile?: () => Promise<File> }[];
}

interface LaunchQueue {
  setConsumer: (consumer: (params: LaunchParams) => void) => void;
}

/** Only Markdown is claimed in the manifest; anything else that arrives is not read. */
const MARKDOWN = /\.(?:md|markdown)$/iu;
/** One launch may carry many files; beyond this they are reported rather than all created. */
export const MAX_LAUNCH_FILES = 20;
/** The same per-document ceiling the rest of the client keeps; a larger file is reported. */
export const MAX_LAUNCH_FILE_BYTES = 8 * 1024 * 1024;

export interface LaunchedFile {
  readonly title: string;
  readonly markdown: string;
}

export interface LaunchedFiles {
  readonly files: readonly LaunchedFile[];
  /** Files that arrived and were not read, by reason, so the page can say so. */
  readonly skipped: {
    readonly overLimit: number;
    readonly notMarkdown: number;
    readonly tooLarge: number;
  };
}

const NOTHING: LaunchedFiles = {
  files: [],
  skipped: { overLimit: 0, notMarkdown: 0, tooLarge: 0 },
};

/**
 * Resolves with the Markdown files the app was launched with, or `null` when this browser has no
 * launch queue (the page was reached some other way). Waits for at most `timeoutMs` for the queue
 * to deliver, since a launch without files - a stale bookmark to this address - never will.
 */
export function receiveLaunchFiles(timeoutMs = 3_000): Promise<LaunchedFiles | null> {
  const queue = (globalThis as { launchQueue?: LaunchQueue }).launchQueue;
  if (queue === undefined) return Promise.resolve(null);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(NOTHING);
    }, timeoutMs);
    queue.setConsumer((params) => {
      clearTimeout(timer);
      const handles = (params.files ?? []).filter(
        (handle) => handle.kind !== 'directory' && typeof handle.getFile === 'function',
      );
      void Promise.all(
        handles
          .slice(0, MAX_LAUNCH_FILES)
          .map(async (handle): Promise<LaunchedFile | 'not-markdown' | 'too-large'> => {
            const file = await handle.getFile?.();
            if (file === undefined || !MARKDOWN.test(file.name)) return 'not-markdown';
            if (file.size > MAX_LAUNCH_FILE_BYTES) return 'too-large';
            return {
              title: file.name.replace(MARKDOWN, '') || 'Untitled note',
              markdown: await file.text(),
            };
          }),
      )
        .then((outcomes) => {
          resolve({
            files: outcomes.filter(
              (outcome): outcome is LaunchedFile => typeof outcome !== 'string',
            ),
            skipped: {
              overLimit: Math.max(0, handles.length - MAX_LAUNCH_FILES),
              notMarkdown: outcomes.filter((outcome) => outcome === 'not-markdown').length,
              tooLarge: outcomes.filter((outcome) => outcome === 'too-large').length,
            },
          });
        })
        .catch(() => {
          resolve(NOTHING);
        });
    });
  });
}
