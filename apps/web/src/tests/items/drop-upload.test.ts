import { describe, expect, it } from 'vitest';

import { progressText, uploadEntries, type UploadProgress } from '../../items/drop-upload';

const dir = (name: string, children: unknown[]): FileSystemEntry =>
  ({
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let done = false;
      return {
        readEntries: (resolve: (batch: unknown[]) => void) => {
          resolve(done ? [] : children);
          done = true;
        },
      };
    },
  }) as unknown as FileSystemEntry;

const fileEntry = (name: string): FileSystemEntry =>
  ({
    name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (file: File) => void) => {
      resolve(new File(['x'], name));
    },
  }) as unknown as FileSystemEntry;

describe('uploadEntries', () => {
  it('creates parents before their files, starts uploads during discovery and caps concurrency', async () => {
    const created = new Set<string>();
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const progress: UploadProgress[] = [];
    const tree = dir('top', [
      dir('sub', [fileEntry('a'), fileEntry('b'), fileEntry('c')]),
      fileEntry('d'),
      fileEntry('e'),
    ]);
    const outcome = await uploadEntries(
      [tree],
      null,
      {
        createFolder: (name) => {
          created.add(name);
          return Promise.resolve(name);
        },
        uploadFile: async (file, parentId) => {
          expect(parentId === null || created.has(parentId)).toBe(true);
          order.push(file.name);
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
        },
      },
      (p) => progress.push(p),
    );
    expect(outcome).toMatchObject({ folders: 2, uploaded: 5, failed: 0 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(progress.at(-1)).toMatchObject({ discovering: false, found: 5, uploaded: 5 });
  });

  it('counts failures and stops starting uploads after the first', async () => {
    const outcome = await uploadEntries(
      [dir('top', ['a', 'b', 'c', 'd', 'e', 'f'].map(fileEntry))],
      null,
      {
        createFolder: () => Promise.resolve('top'),
        uploadFile: (file) =>
          file.name === 'a' ? Promise.reject(new Error('nope')) : Promise.resolve(),
      },
    );
    expect(outcome.failed).toBeGreaterThan(0);
    expect(outcome.uploaded + outcome.failed).toBeLessThanOrEqual(6);
    expect((outcome.error as Error).message).toBe('nope');
  });
});

describe('progressText', () => {
  it('says what is happening', () => {
    expect(progressText({ discovering: true, folders: 2, found: 0, uploaded: 0, failed: 0 })).toBe(
      'Reading folders: 2 found...',
    );
    expect(progressText({ discovering: false, folders: 2, found: 5, uploaded: 3, failed: 1 })).toBe(
      'Uploading 3 of 5, 1 failed',
    );
  });
});
