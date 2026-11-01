import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';
import { files } from '@nix/api-client';
import { downloadFileValue, uploadFileValue } from './commands/files.ts';
import { runImport } from './commands/import.ts';
import {
  cancelDocumentImportFromSession,
  commitDocumentImportFromSession,
  getDocumentImportFromSession,
} from './commands/document-import.ts';
import { identifier, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerDocumentAndFileTools(
  server: McpServer,
  { session, options }: McpToolDeps,
): RegisteredTool[] {
  const importDocument = server.registerTool(
    'import_document',
    {
      description:
        'Import a local PDF, DOCX, UTF-8 TXT, Markdown file, or Markdown folder as editable Nix notes.',
      inputSchema: {
        workspaceId: identifier,
        path: z.string().min(1),
        parentId: identifier.optional(),
        preview: z.boolean().default(false),
        wait: z.boolean().default(true),
      },
    },
    ({ workspaceId, path, parentId, preview, wait }) =>
      toolResult(async () => {
        let result: unknown;
        await runImport(
          options.profileName,
          {
            workspaceId,
            path,
            dryRun: preview,
            noWait: !wait,
            ...(parentId === undefined ? {} : { parentId }),
          },
          { json: true, isTty: false },
          options.sessionDeps ?? {},
          {
            writeResult: (value) => {
              result = value;
            },
            setExitCode: false,
            onDocumentImportStarted: () => undefined,
          },
        );
        return result;
      }),
  );

  server.registerTool(
    'get_document_import',
    {
      description: 'Read durable state for a document import.',
      inputSchema: { importId: identifier },
    },
    ({ importId }) =>
      toolResult(async () => getDocumentImportFromSession(await session(), importId)),
  );

  server.registerTool(
    'commit_document_import',
    {
      description:
        'Commit a preview-ready document import, optionally returning before completion.',
      inputSchema: { importId: identifier, wait: z.boolean().default(true) },
    },
    ({ importId, wait }) =>
      toolResult(async () => commitDocumentImportFromSession(await session(), importId, wait)),
  );

  server.registerTool(
    'cancel_document_import',
    {
      description: 'Cancel a document import after explicit confirmation.',
      inputSchema: { importId: identifier, confirm: z.literal(true) },
    },
    ({ importId }) =>
      toolResult(async () => cancelDocumentImportFromSession(await session(), importId)),
  );

  const uploadFile = server.registerTool(
    'upload_file',
    {
      description:
        'Upload a local file as an opaque child item. Uploaded files are not malware-scanned.',
      inputSchema: {
        workspaceId: identifier,
        path: z.string().min(1),
        parentId: identifier.optional(),
      },
    },
    ({ workspaceId, path, parentId }) =>
      toolResult(() =>
        uploadFileValue(
          options.profileName,
          { workspaceId, path, ...(parentId === undefined ? {} : { parentId }) },
          options.sessionDeps ?? {},
        ),
      ),
  );

  const replaceFile = server.registerTool(
    'replace_file',
    {
      description: 'Upload a new immutable current version for an existing file item.',
      inputSchema: { workspaceId: identifier, itemId: identifier, path: z.string().min(1) },
    },
    ({ workspaceId, itemId, path }) =>
      toolResult(() =>
        uploadFileValue(
          options.profileName,
          { workspaceId, path, targetItemId: itemId },
          options.sessionDeps ?? {},
        ),
      ),
  );

  server.registerTool(
    'list_file_versions',
    {
      description: 'List file metadata and immutable versions for a visible file item.',
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) =>
      toolResult(async () => (await session()).client.query(files.fileByItem(itemId))),
  );

  const downloadFile = server.registerTool(
    'download_file',
    {
      description: 'Download a current or historical file version to a local path.',
      inputSchema: {
        itemId: identifier,
        outputPath: z.string().min(1),
        versionId: identifier.optional(),
      },
    },
    ({ itemId, outputPath, versionId }) =>
      toolResult(() =>
        downloadFileValue(
          options.profileName,
          itemId,
          outputPath,
          versionId,
          options.sessionDeps ?? {},
        ),
      ),
  );

  return [importDocument, uploadFile, replaceFile, downloadFile];
}
