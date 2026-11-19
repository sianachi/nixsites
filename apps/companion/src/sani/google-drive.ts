import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { ConnectorAction } from './connector.ts';
import {
  decodePageToken,
  encodePageToken,
  googleId,
  googleJson,
  googlePageToken,
  googlePageCursor,
  googleRequest,
  googleText,
  type GoogleCall,
} from './google-http.ts';

const drive = 'https://www.googleapis.com/drive/v3/';
const selectedFolder = 'drive-folder';
const folderMime = 'application/vnd.google-apps.folder';
const fileFields = 'id,name,mimeType,parents,trashed,version,modifiedTime';
const revisionFields = 'id,modifiedTime,keepForever';
const nativeExports = new Map([
  ['application/vnd.google-apps.document', 'text/markdown'],
  ['application/vnd.google-apps.spreadsheet', 'text/csv'],
  ['application/vnd.google-apps.presentation', 'text/plain'],
]);
const textMime = z.enum([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
]);
const file = z.object({
  id: googleId,
  name: z.string().max(1024),
  mimeType: z.string().max(256),
  parents: z.array(googleId).max(16).default([]),
  trashed: z.boolean(),
  version: z.string().regex(/^\d{1,25}$/u),
  modifiedTime: z.iso.datetime({ offset: true }).optional(),
});
const revision = z.object({
  id: googleId,
  modifiedTime: z.iso.datetime({ offset: true }).optional(),
  keepForever: z.boolean().optional(),
});
const fileTarget = z.strictObject({ fileId: googleId });
const revisionTarget = fileTarget.extend({ revisionId: googleId });
const page = z.strictObject({
  pageToken: googlePageCursor.optional(),
  pageSize: z.number().int().min(1).max(50).default(25),
});
const listFiles = page.extend({
  nameContains: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\P{Cc}+$/u)
    .optional(),
});
const listRevisions = page.extend(fileTarget.shape);
const exportFile = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(250)
    .regex(/^[^/\\\p{Cc}]+$/u)
    .refine((name) => name.trim() === name),
  mimeType: textMime,
  content: z.string().max(16_000),
});

function fileUrl(fileId: string): URL {
  const url = new URL(`files/${fileId}`, drive);
  url.searchParams.set('supportsAllDrives', 'true');
  return url;
}

function inFolder(value: z.infer<typeof file>, folderId: string): boolean {
  return !value.trashed && value.parents.includes(folderId);
}

async function metadata(call: GoogleCall, fileId: string) {
  const url = fileUrl(fileId);
  url.searchParams.set('fields', fileFields);
  const value = await googleJson(call, url, file);
  if (value.id !== fileId) throw new Error('Drive returned a different file.');
  return value;
}

async function selectedFile(call: GoogleCall, fileId: string) {
  const value = await metadata(call, fileId);
  if (!inFolder(value, googleId.parse(call.resourceId))) {
    throw new Error('The Drive file is outside the connected folder.');
  }
  return value;
}

function quoted(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

async function readContent(
  call: GoogleCall,
  metadataBefore: z.infer<typeof file>,
  url: URL,
  mimeType: string,
) {
  const text = await googleText(await googleRequest(call, url));
  const metadataAfter = await selectedFile(call, metadataBefore.id);
  if (metadataAfter.version !== metadataBefore.version) {
    throw new Error('The Drive file changed during the read.');
  }
  return {
    ...metadataAfter,
    contentType: mimeType,
    content: text.slice(0, 16_000),
    truncated: text.length > 16_000,
  };
}

export const googleDriveActions: readonly ConnectorAction[] = [
  {
    id: 'google-drive.list-files',
    kind: 'read',
    resourceKind: selectedFolder,
    description: 'Find direct children of the connected Google Drive folder.',
    args: listFiles,
    async execute(call: GoogleCall): Promise<unknown> {
      const { pageToken, pageSize, nameContains } = listFiles.parse(call.args);
      const folderId = googleId.parse(call.resourceId);
      const selector = ['files', pageSize, nameContains];
      const cursor = decodePageToken(call, selector, pageToken);
      const predicate = [`${quoted(folderId)} in parents`, 'trashed = false'];
      if (nameContains !== undefined) predicate.push(`name contains ${quoted(nameContains)}`);
      const url = new URL('files', drive);
      url.searchParams.set('q', predicate.join(' and '));
      url.searchParams.set('pageSize', String(pageSize));
      url.searchParams.set('fields', `nextPageToken,files(${fileFields})`);
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      if (cursor !== undefined) url.searchParams.set('pageToken', cursor);
      const result = await googleJson(
        call,
        url,
        z.object({
          files: z.array(file).max(50).default([]),
          nextPageToken: googlePageToken.optional(),
        }),
      );
      return {
        files: result.files.filter((value) => inFolder(value, folderId)),
        nextPageToken: encodePageToken(call, selector, result.nextPageToken),
      };
    },
  },
  {
    id: 'google-drive.read-file',
    kind: 'read',
    resourceKind: selectedFolder,
    description: 'Read a selected Drive file and extract bounded text when the format supports it.',
    args: fileTarget,
    async execute(call: GoogleCall): Promise<unknown> {
      const { fileId } = fileTarget.parse(call.args);
      const value = await selectedFile(call, fileId);
      const nativeMime = nativeExports.get(value.mimeType);
      if (nativeMime !== undefined) {
        const url = new URL(`files/${fileId}/export`, drive);
        url.searchParams.set('mimeType', nativeMime);
        return readContent(call, value, url, nativeMime);
      }
      if (textMime.safeParse(value.mimeType).success) {
        const url = fileUrl(fileId);
        url.searchParams.set('alt', 'media');
        return readContent(call, value, url, value.mimeType);
      }
      // shortcut: binary files return metadata until the connector supports approved file capabilities.
      return { ...value, content: null };
    },
  },
  {
    id: 'google-drive.list-revisions',
    kind: 'read',
    resourceKind: selectedFolder,
    description: 'List available versions of a selected Drive file.',
    args: listRevisions,
    async execute(call: GoogleCall): Promise<unknown> {
      const { fileId, pageSize, pageToken } = listRevisions.parse(call.args);
      const selector = ['revisions', fileId, pageSize];
      const cursor = decodePageToken(call, selector, pageToken);
      await selectedFile(call, fileId);
      const url = new URL(`files/${fileId}/revisions`, drive);
      url.searchParams.set('fields', `nextPageToken,revisions(${revisionFields})`);
      url.searchParams.set('pageSize', String(pageSize));
      if (cursor !== undefined) url.searchParams.set('pageToken', cursor);
      const result = await googleJson(
        call,
        url,
        z.object({
          revisions: z.array(revision).max(50).default([]),
          nextPageToken: googlePageToken.optional(),
        }),
      );
      await selectedFile(call, fileId);
      return { ...result, nextPageToken: encodePageToken(call, selector, result.nextPageToken) };
    },
  },
  {
    id: 'google-drive.read-revision',
    kind: 'read',
    resourceKind: selectedFolder,
    description: 'Read a pinned revision of a supported text file in the connected Drive folder.',
    args: revisionTarget,
    async execute(call: GoogleCall): Promise<unknown> {
      const { fileId, revisionId } = revisionTarget.parse(call.args);
      const value = await selectedFile(call, fileId);
      const url = new URL(`files/${fileId}/revisions/${revisionId}`, drive);
      url.searchParams.set('fields', revisionFields);
      const saved = await googleJson(call, url, revision);
      if (saved.id !== revisionId) throw new Error('Drive returned a different revision.');
      if (saved.keepForever !== true || !textMime.safeParse(value.mimeType).success) {
        // shortcut: native document revisions need provider export links in a separate origin policy.
        await selectedFile(call, fileId);
        return { revision: saved, fileId, content: null };
      }
      url.searchParams.delete('fields');
      url.searchParams.set('alt', 'media');
      return { ...(await readContent(call, value, url, value.mimeType)), revision: saved };
    },
  },
  {
    id: 'google-drive.export-file',
    kind: 'write',
    resourceKind: selectedFolder,
    description: 'Upload the approved text, name, and format to the connected Drive folder.',
    args: exportFile,
    async execute(call: GoogleCall): Promise<unknown> {
      const { name, mimeType, content } = exportFile.parse(call.args);
      const folderId = googleId.parse(call.resourceId);
      const folder = await metadata(call, folderId);
      if (folder.trashed || folder.mimeType !== folderMime) {
        throw new Error('The connected Drive destination is no longer an active folder.');
      }
      const boundary = `nix-${randomUUID()}`;
      const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name, mimeType, parents: [folderId] }),
        `--${boundary}`,
        `Content-Type: ${mimeType}; charset=UTF-8`,
        '',
        content,
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const url = new URL('https://www.googleapis.com/upload/drive/v3/files');
      url.searchParams.set('uploadType', 'multipart');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('fields', fileFields);
      const created = await googleJson(call, url, file, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!inFolder(created, folderId) || created.name !== name || created.mimeType !== mimeType) {
        throw new Error('Drive returned an unexpected export receipt.');
      }
      return created;
    },
  },
];
