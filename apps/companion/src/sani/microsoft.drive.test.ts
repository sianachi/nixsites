import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createConnectorRouter } from './connector.ts';
import { oneDriveActions } from './microsoft.drive.ts';

const graph = 'https://graph.microsoft.com/v1.0/me/drive/items';
const folderId = 'folder-one';
const token = 'fixture-graph-token';
const file = {
  id: 'file-one',
  name: 'Meeting notes.md',
  size: 12,
  file: { mimeType: 'text/markdown' },
  parentReference: { id: folderId },
  webUrl: 'https://tenant.sharepoint.com/Documents/Notes.md',
};

function urlOf(request: Parameters<typeof fetch>[0] | undefined): string | undefined {
  if (request instanceof Request) return request.url;
  return request instanceof URL ? request.href : request;
}

function harness(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(() => {
    const response = responses.shift();
    return response
      ? Promise.resolve(response)
      : Promise.reject(new Error('Unexpected upstream request.'));
  });
  return {
    fetch,
    run(id: string, args: unknown) {
      const action = oneDriveActions.find((entry) => entry.id === `onedrive.${id}`);
      if (!action) throw new Error('Unknown action fixture.');
      return action.execute({
        executionId: '42f5e7ac-5ea8-4e33-825a-14d562b8f9cc',
        resourceId: folderId,
        accessToken: token,
        args,
        fetch,
        transfer: fetch,
        signal: new AbortController().signal,
      });
    },
  };
}

describe('OneDrive registered actions', () => {
  it('searches paged direct children inside the selected folder', async () => {
    const nextLink = `${graph}/${folderId}/children?$skiptoken=next`;
    const test = harness(
      Response.json({
        value: [{ ...file, id: 'outside', parentReference: { id: 'folder-two' } }],
        '@odata.nextLink': nextLink,
      }),
      Response.json({ value: [file, { ...file, id: 'remote', remoteItem: {} }] }),
    );
    const result = await test.run('find-files', { query: 'notes' });
    expect(result).toEqual({
      files: [
        {
          id: file.id,
          name: file.name,
          size: file.size,
          mimeType: 'text/markdown',
          url: file.webUrl,
        },
      ],
      truncated: false,
    });
    expect(test.fetch).toHaveBeenCalledTimes(2);
    expect(urlOf(test.fetch.mock.calls[1]?.[0])).toBe(nextLink);
  });

  it('rejects a continuation targeting a different folder or origin', async () => {
    for (const url of [
      `${graph}/folder-two/children?$skiptoken=next`,
      'https://evil.example/v1.0/me/drive/items/folder-one/children',
    ]) {
      const test = harness(Response.json({ value: [], '@odata.nextLink': url }));
      await expect(test.run('find-files', {})).rejects.toThrow('invalid folder page');
      expect(test.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses an out-of-folder file before issuing a file or version download', async () => {
    const test = harness(Response.json({ ...file, parentReference: { id: 'folder-two' } }));
    await expect(test.run('read-file', { fileId: file.id, versionId: '1.0' })).rejects.toThrow(
      'directly inside the connected OneDrive folder',
    );
    expect(test.fetch).toHaveBeenCalledTimes(1);
  });

  it('reads a saved version without forwarding the bearer to the signed download URL', async () => {
    const location = 'https://example.files.1drv.com/notes?signature=fixture';
    const test = harness(
      Response.json(file),
      new Response(null, { status: 302, headers: { location } }),
      new Response('Earlier text'),
    );
    const result = await test.run('read-file', { fileId: file.id, versionId: '1.0' });
    expect(result).toMatchObject({ id: file.id, versionId: '1.0', text: 'Earlier text' });
    expect(JSON.stringify(result)).not.toContain('signature');
    expect(urlOf(test.fetch.mock.calls[1]?.[0])).toBe(`${graph}/file-one/versions/1.0/content`);
    expect(new Headers(test.fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${token}`,
    );
    expect(urlOf(test.fetch.mock.calls[2]?.[0])).toBe(location);
    expect(test.fetch.mock.calls[2]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(new Headers(test.fetch.mock.calls[2]?.[1]?.headers).has('authorization')).toBe(false);
  });

  it('bounds the file body and rejects redirects outside OneDrive', async () => {
    const oversized = harness(Response.json(file), new Response('a'.repeat(25 * 1024)));
    await expect(oversized.run('read-file', { fileId: file.id })).rejects.toThrow();
    const redirected = harness(
      Response.json(file),
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/notes' } }),
    );
    await expect(redirected.run('read-file', { fileId: file.id })).rejects.toThrow(
      'invalid transfer URL',
    );
    expect(redirected.fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves OneDrive capability transfers through the registered connector router', async () => {
    const location = 'https://partner.sharepoint.com/_layouts/download?signature=fixture';
    const test = harness(
      Response.json({ ...file, webUrl: 'https://example.files.1drv.com/capability' }),
      new Response(null, { status: 302, headers: { location } }),
      new Response('Read through the router'),
    );
    const run = createConnectorRouter(oneDriveActions, test.fetch);
    const read = {
      action: 'onedrive.read-file',
      resourceId: folderId,
      args: { fileId: file.id },
    };
    const { schemaHash } = z
      .object({ schemaHash: z.string() })
      .parse(await run({ operation: 'prepare', ...read }));
    expect(test.fetch).not.toHaveBeenCalled();
    const result = await run({
      operation: 'execute',
      executionId: '42f5e7ac-5ea8-4e33-825a-14d562b8f9cc',
      ...read,
      schemaHash,
      accessToken: token,
    });
    expect(result).toMatchObject({ result: { id: file.id, text: 'Read through the router' } });
    expect(JSON.stringify(result)).not.toContain('capability');
    expect(test.fetch.mock.calls[1]?.[1]?.redirect).toBe('manual');
    expect(urlOf(test.fetch.mock.calls[2]?.[0])).toBe(location);
    expect(test.fetch.mock.calls[2]?.[1]?.redirect).toBe('error');
    expect(new Headers(test.fetch.mock.calls[2]?.[1]?.headers).has('authorization')).toBe(false);
  });

  it('projects only the bounded version listing', async () => {
    const test = harness(
      Response.json(file),
      Response.json({
        value: [
          {
            id: '1.0',
            lastModifiedDateTime: '2026-11-17T00:00:00Z',
            lastModifiedBy: { user: 'private' },
          },
        ],
        '@odata.nextLink': 'ignored',
      }),
    );
    expect(await test.run('list-versions', { fileId: file.id })).toEqual({
      versions: [{ id: '1.0', modifiedAt: '2026-11-17T00:00:00Z' }],
      truncated: true,
    });
    expect(test.fetch).toHaveBeenCalledTimes(2);
  });

  it('exports the exact reviewed bytes and filename with fail-on-conflict semantics', async () => {
    const uploadUrl = 'https://example.up.1drv.com/upload?signature=fixture';
    const test = harness(
      Response.json({ uploadUrl }),
      Response.json({ ...file, name: 'résumé.md', size: 3 }, { status: 201 }),
    );
    expect(await test.run('export-text', { name: 'résumé.md', text: 'é!' })).toMatchObject({
      name: 'résumé.md',
      size: 3,
    });
    const [createPath, create] = test.fetch.mock.calls[0] ?? [];
    expect(urlOf(createPath)).toBe(
      `${graph}/${folderId}:/r%C3%A9sum%C3%A9.md:/createUploadSession`,
    );
    if (typeof create?.body !== 'string') throw new Error('Expected a JSON upload request.');
    expect(JSON.parse(create.body)).toEqual({
      item: { name: 'résumé.md', '@microsoft.graph.conflictBehavior': 'fail' },
    });
    const [uploadPath, upload] = test.fetch.mock.calls[1] ?? [];
    expect(urlOf(uploadPath)).toBe(uploadUrl);
    expect(upload).toMatchObject({
      method: 'PUT',
      body: 'é!',
      credentials: 'omit',
      redirect: 'error',
    });
    const headers = new Headers(upload?.headers);
    expect(headers.get('content-length')).toBe('3');
    expect(headers.get('content-range')).toBe('bytes 0-2/3');
    expect(headers.has('authorization')).toBe(false);
  });

  it('rejects path traversal, unsafe upload URLs, and unconfirmed exports', async () => {
    const traversal = harness();
    await expect(
      traversal.run('export-text', { name: '../report.md', text: 'report' }),
    ).rejects.toThrow();
    expect(traversal.fetch).not.toHaveBeenCalled();
    const unsafeUrl = harness(Response.json({ uploadUrl: 'https://example.1drv.com.evil/upload' }));
    await expect(
      unsafeUrl.run('export-text', { name: 'report.md', text: 'report' }),
    ).rejects.toThrow('invalid transfer URL');
    expect(unsafeUrl.fetch).toHaveBeenCalledTimes(1);
    const conflict = harness(
      Response.json({ uploadUrl: 'https://example.up.1drv.com/upload' }),
      Response.json({ error: 'nameAlreadyExists' }, { status: 409 }),
    );
    await expect(
      conflict.run('export-text', { name: 'report.md', text: 'report' }),
    ).rejects.toThrow('could not confirm the requested export');
    expect(conflict.fetch).toHaveBeenCalledTimes(2);
  });
});
