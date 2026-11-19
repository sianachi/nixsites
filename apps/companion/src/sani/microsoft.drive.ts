import { z } from 'zod';

import { oneDriveTransferAllowed, type ConnectorAction } from './connector.ts';
import {
  graphId,
  graphJson,
  graphPageSize,
  graphResponse,
  graphSegment,
  graphText,
  type GraphInput,
} from './microsoft.shared.ts';
import { assertScreened } from './vendor/screen.ts';

const drive = '/me/drive/items';
const fileFields = 'id,name,size,webUrl,file,parentReference,remoteItem,lastModifiedDateTime';
// shortcut: UTF-8 text only, use shared file extraction and capability transfers for binary documents.
const maxTextBytes = 24 * 1024;

const fileRow = z.object({
  id: graphId,
  name: z.string().min(1).max(255),
  file: z.object({ mimeType: z.string().max(160).optional() }).nullish(),
  parentReference: z.object({ id: graphId.optional() }).nullish(),
  remoteItem: z.unknown().optional(),
  size: z.number().int().nonnegative().optional(),
  lastModifiedDateTime: z.string().max(40).optional(),
  webUrl: z.string().max(2048).optional(),
  '@microsoft.graph.downloadUrl': z.string().max(4096).optional(),
});

const listFiles = z.strictObject({
  query: z.string().trim().min(1).max(160).optional(),
  limit: graphPageSize,
});
const selectFile = z.strictObject({ fileId: graphId });
const readFile = selectFile.extend({ versionId: graphId.optional() });
const exportFile = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .refine(
      (name) =>
        name === name.trim() && !name.endsWith('.') && !/[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(name),
      'Use a filename without path separators or trailing spaces or periods.',
    ),
  text: z
    .string()
    .min(1)
    .max(maxTextBytes)
    .refine((value) => Buffer.byteLength(value) <= maxTextBytes && !/[\uD800-\uDFFF]/u.test(value)),
});

function transferUrl(value: string): URL {
  const url = URL.parse(value);
  if (url === null || !oneDriveTransferAllowed(url)) {
    throw new Error('OneDrive returned an invalid transfer URL.');
  }
  return url;
}

function itemLink(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = transferUrl(value);
    const documentHost =
      url.hostname === 'onedrive.live.com' ||
      url.hostname.endsWith('.sharepoint.com') ||
      url.hostname.endsWith('.sharepointonline.com');
    if (
      documentHost &&
      !url.search &&
      url.pathname !== '/' &&
      !/(?:%3a|:|\/_layouts\/)/i.test(url.pathname)
    )
      return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

function projectFile(row: z.infer<typeof fileRow>) {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    modifiedAt: row.lastModifiedDateTime,
    mimeType: row.file?.mimeType,
    url: itemLink(row.webUrl),
  };
}

async function scopedFile(input: GraphInput, fileId: string, includeDownload = false) {
  const path = `${drive}/${graphSegment(fileId)}`;
  const fields = includeDownload ? `${fileFields},@microsoft.graph.downloadUrl` : fileFields;
  const row = fileRow.parse(await graphJson(input, `${path}?$select=${fields}`));
  if (
    row.id !== fileId ||
    row.parentReference?.id !== input.resourceId ||
    row.file == null ||
    row.remoteItem != null
  ) {
    throw new Error('Choose a file directly inside the connected OneDrive folder.');
  }
  return { row, path };
}

async function downloadFile(input: GraphInput, location: string): Promise<Response> {
  if (!input.transfer) throw new Error('OneDrive transfers are not available.');
  const url = transferUrl(location);
  assertScreened(url.href, [input.accessToken]);
  return input.transfer(url, { signal: input.signal, redirect: 'error', credentials: 'omit' });
}

const listResponse = z.object({
  value: z.array(fileRow).max(25),
  '@odata.nextLink': z.string().optional(),
});

export const oneDriveActions: readonly ConnectorAction[] = [
  {
    id: 'onedrive.find-files',
    kind: 'read',
    resourceKind: 'folder',
    description: 'Find files by name in the connected OneDrive folder.',
    args: listFiles,
    async execute(input: GraphInput): Promise<unknown> {
      const { query, limit = 10 } = listFiles.parse(input.args);
      const folder = graphSegment(input.resourceId);
      const path = `${drive}/${folder}/children`;
      const expectedPath = `/v1.0${path}`;
      let pagePath = `${path}?$top=25&$select=${fileFields}`;
      const matches: ReturnType<typeof projectFile>[] = [];
      const term = query?.toLowerCase();
      let truncated = false;
      for (let page = 0; page < 4; page += 1) {
        const response = listResponse.parse(await graphJson(input, pagePath));
        for (const row of response.value) {
          if (
            row.parentReference?.id === input.resourceId &&
            row.file != null &&
            row.remoteItem == null &&
            (term === undefined || row.name.toLowerCase().includes(term))
          ) {
            matches.push(projectFile(row));
          }
        }
        const nextLink = response['@odata.nextLink'];
        truncated = nextLink !== undefined;
        if (nextLink === undefined || matches.length >= limit) break;
        const next = new URL(nextLink);
        if (
          next.origin !== 'https://graph.microsoft.com' ||
          next.pathname !== expectedPath ||
          next.username ||
          next.password ||
          next.hash ||
          nextLink.length > 4096
        ) {
          throw new Error('OneDrive returned an invalid folder page.');
        }
        pagePath = `${path}${next.search}`;
      }
      return { files: matches.slice(0, limit), truncated: truncated || matches.length > limit };
    },
  },
  {
    id: 'onedrive.read-file',
    kind: 'read',
    resourceKind: 'folder',
    description: 'Read a small UTF-8 file or version in the connected OneDrive folder.',
    args: readFile,
    async execute(input: GraphInput): Promise<unknown> {
      const { fileId, versionId } = readFile.parse(input.args);
      const { row, path } = await scopedFile(input, fileId, versionId === undefined);
      const mime = row.file?.mimeType ?? '';
      if (
        !/^(text\/[\w.+-]+|application\/(json|xml|[\w.+-]+\+json))$/i.test(mime) &&
        !/\.(txt|md|csv|tsv|json|xml|log)$/i.test(row.name)
      ) {
        throw new Error('Choose a UTF-8 text file for OneDrive content extraction.');
      }
      const version = versionId === undefined ? '' : `/versions/${graphSegment(versionId)}`;
      const location = versionId === undefined ? row['@microsoft.graph.downloadUrl'] : undefined;
      let response =
        location === undefined
          ? await graphResponse(input, `${path}${version}/content`, {}, true)
          : await downloadFile(input, location);
      if (response.status === 302) {
        const redirectedLocation = response.headers.get('location');
        await response.body?.cancel();
        if (redirectedLocation === null)
          throw new Error('OneDrive did not provide a download URL.');
        response = await downloadFile(input, redirectedLocation);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('OneDrive refused the file download.');
      }
      const text = await graphText(response, maxTextBytes);
      if (text.includes('\0')) {
        throw new Error('OneDrive returned invalid UTF-8 text.');
      }
      return { ...projectFile(row), versionId, text };
    },
  },
  {
    id: 'onedrive.list-versions',
    kind: 'read',
    resourceKind: 'folder',
    description: 'List saved versions of a file in the connected OneDrive folder.',
    args: selectFile,
    async execute(input: GraphInput): Promise<unknown> {
      const { fileId } = selectFile.parse(input.args);
      const { path } = await scopedFile(input, fileId);
      const response = z
        .object({
          value: z.array(
            z.object({
              id: graphId,
              size: z.number().int().nonnegative().optional(),
              lastModifiedDateTime: z.string().max(40).optional(),
            }),
          ),
          '@odata.nextLink': z.string().optional(),
        })
        .parse(await graphJson(input, `${path}/versions`));
      return {
        versions: response.value.slice(0, 25).map(({ id, size, lastModifiedDateTime }) => ({
          id,
          size,
          modifiedAt: lastModifiedDateTime,
        })),
        truncated: response['@odata.nextLink'] !== undefined || response.value.length > 25,
      };
    },
  },
  {
    id: 'onedrive.export-text',
    kind: 'write',
    resourceKind: 'folder',
    description: 'Export the reviewed text to a new file in the connected OneDrive folder.',
    args: exportFile,
    async execute(input: GraphInput): Promise<unknown> {
      const { name, text } = exportFile.parse(input.args);
      if (!input.transfer) throw new Error('OneDrive transfers are not available.');
      const folder = graphSegment(input.resourceId);
      const session = z.object({ uploadUrl: z.string() }).parse(
        await graphJson(
          input,
          `${drive}/${folder}:/${encodeURIComponent(name)}:/createUploadSession`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ item: { name, '@microsoft.graph.conflictBehavior': 'fail' } }),
          },
        ),
      );
      const size = Buffer.byteLength(text);
      const url = transferUrl(session.uploadUrl);
      assertScreened(url.href, [input.accessToken]);
      const response = await input.transfer(url, {
        method: 'PUT',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(size),
          'content-range': `bytes 0-${String(size - 1)}/${String(size)}`,
        },
        body: text,
        redirect: 'error',
        credentials: 'omit',
        signal: input.signal,
      });
      if (response.status !== 201 && response.status !== 200) {
        await response.body?.cancel();
        throw new Error('OneDrive could not confirm the requested export.');
      }
      const data: unknown = JSON.parse(await graphText(response, 16 * 1024));
      const row = fileRow.parse(data);
      if (row.parentReference?.id !== input.resourceId || row.name !== name || row.size !== size) {
        throw new Error('OneDrive could not confirm the requested export.');
      }
      return projectFile(row);
    },
  },
];
