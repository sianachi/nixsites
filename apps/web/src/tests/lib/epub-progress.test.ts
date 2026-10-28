import { describe, expect, it } from 'vitest';
import { EPUB_PROGRESS_LIMIT, readEpubProgress, writeEpubProgress } from '../../lib/epub-progress';
import { memoryStorage } from '../memory-storage';

describe('remembering EPUB chapters', () => {
  it('remembers each book independently and replaces an older position', () => {
    const storage = memoryStorage();
    writeEpubProgress(storage, 'first', { chapter: 1, size: 2 });
    writeEpubProgress(storage, 'second', { chapter: 3, size: 0 });
    writeEpubProgress(storage, 'first', { chapter: 2, size: 1 });
    expect(readEpubProgress(storage, 'first')).toEqual({ chapter: 2, size: 1 });
    expect(readEpubProgress(storage, 'second')).toEqual({ chapter: 3, size: 0 });
  });
  it('forgets the oldest book at the storage limit', () => {
    const storage = memoryStorage();
    for (let i = 0; i <= EPUB_PROGRESS_LIMIT; i += 1)
      writeEpubProgress(storage, String(i), { chapter: i, size: 0 });
    expect(readEpubProgress(storage, '0')).toBeNull();
    expect(readEpubProgress(storage, String(EPUB_PROGRESS_LIMIT))).toEqual({
      chapter: EPUB_PROGRESS_LIMIT,
      size: 0,
    });
  });
  it('tolerates corrupt or unavailable storage', () => {
    const storage = memoryStorage();
    storage.setItem('nix.epub.progress', '{broken');
    expect(readEpubProgress(storage, 'first')).toBeNull();
    expect(readEpubProgress(undefined, 'first')).toBeNull();
    writeEpubProgress(undefined, 'first', { chapter: 0, size: 0 });
  });
});
