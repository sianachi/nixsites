import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_LAUNCH_FILES, receiveLaunchFiles } from '../../launch/launch-files';

afterEach(() => {
  delete (globalThis as { launchQueue?: unknown }).launchQueue;
});

function handle(name: string, text: string) {
  return { kind: 'file', getFile: () => Promise.resolve(new File([text], name)) };
}

describe('files the app was opened with', () => {
  it('reads the Markdown files the operating system handed over, titled by name', async () => {
    (globalThis as { launchQueue?: unknown }).launchQueue = {
      setConsumer: (consumer: (params: unknown) => void) => {
        consumer({ files: [handle('Plan.md', '# Plan'), handle('photo.png', 'x')] });
      },
    };

    expect(await receiveLaunchFiles()).toEqual({
      files: [{ title: 'Plan', markdown: '# Plan' }],
      skipped: { overLimit: 0, notMarkdown: 1, tooLarge: 0 },
    });
  });

  it('counts the files past the limit rather than dropping them silently', async () => {
    (globalThis as { launchQueue?: unknown }).launchQueue = {
      setConsumer: (consumer: (params: unknown) => void) => {
        consumer({
          files: Array.from({ length: MAX_LAUNCH_FILES + 3 }, (_unused, index) =>
            handle(`Note ${String(index)}.md`, 'x'),
          ),
        });
      },
    };

    const received = await receiveLaunchFiles();
    expect(received?.files).toHaveLength(MAX_LAUNCH_FILES);
    expect(received?.skipped.overLimit).toBe(3);
  });

  it('says there is no launch queue in a browser without one', async () => {
    expect(await receiveLaunchFiles()).toBeNull();
  });

  it('gives up with no files when the launch never delivers any', async () => {
    vi.useFakeTimers();
    (globalThis as { launchQueue?: unknown }).launchQueue = { setConsumer: vi.fn() };
    const received = receiveLaunchFiles(1_000);
    vi.advanceTimersByTime(1_000);

    expect((await received)?.files).toEqual([]);
    vi.useRealTimers();
  });
});
