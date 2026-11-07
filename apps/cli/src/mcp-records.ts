/**
 * Record, reference, file lifecycle, link and attachment tools for agents. All of them work over
 * stdio and Streamable HTTP: nothing here touches the host's disk. File bytes never pass through the
 * model: `begin_file_upload` hands back a presigned PUT the agent uses itself.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  agentRecords,
  attachments,
  files,
  isNixApiError,
  references,
  structure,
  type PropertyDefinition,
} from '@nix/api-client';
import {
  assertRowsRetrySafe,
  assertTokenSession,
  beginUploadValue,
  completeUploadValue,
  EXPIRY_KEY,
  exportToFileValue,
  lookupByProperty,
  queryWorkspace,
} from './commands/agent-records.ts';
import { identifier, jsonObjectInput, toolResult } from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

const FIXED_VERSION =
  'A file link or pin always serves one fixed version: a newer upload or approval never moves it.';
const page = {
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(512).optional(),
};

const filterRule = z.object({
  property: z.string().min(1),
  operator: z
    .string()
    .min(1)
    .describe(
      'equals, not-equals (also matches records that lack the field), contains, not-contains, ' +
        'greater-than, less-than, is-empty, is-not-empty, on, before, on-or-after, within-next, within-last',
    ),
  value: z.string().optional(),
});

const rowInput = z.object({
  parentId: identifier,
  keyField: z.string().min(1).optional(),
  keyValue: z.string().min(1).optional(),
  itemId: identifier.optional(),
  title: z.string().max(500).optional(),
  properties: jsonObjectInput.optional(),
  type: z.string().min(1).max(40).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const schemaProperty = z.object({
  key: z.string().min(1),
  label: z.string().min(1).optional(),
  type: z.string().min(1),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  expression: z.string().optional(),
  aggregate: z.string().optional(),
  source: z.string().optional(),
});

export function registerRecordTools(server: McpServer, { session }: McpToolDeps): void {
  server.registerTool(
    'find_items_by_property',
    {
      description:
        'Exact lookup of items whose property `key` equals `value`, without a full-text search. A Url value matches ' +
        'after its host is lowercased and its default port and fragment are dropped; the path, query and trailing ' +
        'slash must match exactly. A Text value is trimmed and case-sensitive. Each match says whether the item is ' +
        'trashed. Search is not an authoritative route: it cannot filter on properties.',
      inputSchema: {
        workspaceId: identifier,
        key: z.string().min(1),
        value: z.string(),
        parentId: identifier.optional(),
      },
    },
    (input) => toolResult(async () => lookupByProperty(await session(), input)),
  );

  server.registerTool(
    'query_items',
    {
      description:
        'Filter items by property. Rules are ANDed; this is the authoritative way to list records, for example ' +
        '{property:"status", operator:"not-equals", value:"retired"} returns every record whose status is not ' +
        'retired, including records that have no status. Scope it to a collection with parentId (its whole ' +
        'subtree). Rows carry their properties; read a note body with read_note. `truncated` says rows were cut off. ' +
        'Day operators (on, before, within-next) need `today` as yyyy-MM-dd.',
      inputSchema: {
        workspaceId: identifier,
        parentId: identifier.optional(),
        filters: z.array(filterRule).max(8).optional(),
        sort: z
          .object({ property: z.string().min(1), descending: z.boolean().optional() })
          .optional(),
        limit: z.number().int().min(1).max(500).optional(),
        today: z.iso.date().optional(),
      },
    },
    (input) => toolResult(async () => queryWorkspace(await session(), input)),
  );

  server.registerTool(
    'upsert_record',
    {
      description:
        'Create or update one record in a collection, keyed by a unique field (keyField must be marked unique in ' +
        'the collection schema). Result is created, updated or unchanged, with the stored item; identical values ' +
        'write nothing, and properties merge (a null clears a key). Strict by default: undeclared keys and missing ' +
        'required fields are refused with per-field violations and nothing is written; pass strict:false to opt out. ' +
        'A trashed record with that key is a 409 record.trashed with its id, never recreated. Pass idempotencyKey so a ' +
        'late retry cannot overwrite a newer write. Recording a workflow status such as "sent" is only a property ' +
        'write: it sends nothing and approves nothing.',
      inputSchema: {
        parentId: identifier,
        keyField: z.string().min(1),
        keyValue: z.string().min(1),
        title: z.string().max(500).optional(),
        properties: jsonObjectInput.optional(),
        type: z.string().min(1).max(40).optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
        strict: z.boolean().default(true),
      },
    },
    ({ parentId, ...rest }) =>
      toolResult(async () =>
        (await session()).client.execute(agentRecords.upsertRecord(parentId, rest)),
      ),
  );

  server.registerTool(
    'batch_records',
    {
      description:
        'Write up to 100 records in one call. Each row is an upsert (parentId, keyField, keyValue), an update ' +
        '(itemId) or a create. A create row MUST carry an idempotencyKey so a retry cannot duplicate it. Rows run ' +
        'independently: the call returns per-row {index, status, item | error} plus counts, and good rows persist ' +
        'even when others fail, so check `failed` and each row. Retrying the identical request is safe. A rejected ' +
        'request (over 100 rows, a create with no key) writes nothing. Strict by default.',
      inputSchema: {
        workspaceId: identifier,
        rows: z.array(rowInput).min(1).max(100),
        strict: z.boolean().default(true),
      },
    },
    ({ workspaceId, rows, strict }) =>
      toolResult(async () => {
        assertRowsRetrySafe(rows);
        return (await session()).client.execute(
          agentRecords.batchRecords(workspaceId, rows, strict),
        );
      }),
  );

  server.registerTool(
    'set_item_schema',
    {
      description:
        'Replace the property fields an item declares for its children (this replaces the whole declared set, so ' +
        'include every field you want to keep). Mark a Text or Url field unique:true to make it a record key for the ' +
        "collection's direct children; turning it on is refused with the list of duplicates if any exist.",
      inputSchema: {
        itemId: identifier,
        properties: z.array(schemaProperty).max(200),
        inherit: z.boolean().default(true),
      },
    },
    ({ itemId, properties, inherit }) =>
      toolResult(async () =>
        (await session()).client.execute(
          structure.setItemSchema(itemId, {
            inherit,
            properties: properties.map(
              ({ label, options, required, unique, expression, aggregate, source, ...field }) =>
                ({
                  ...field,
                  label: label ?? field.key,
                  options: options ?? [],
                  required: required ?? false,
                  expression: expression ?? null,
                  aggregate: aggregate ?? null,
                  source: source ?? null,
                  ...(unique === undefined ? {} : { unique }),
                }) satisfies PropertyDefinition,
            ),
          }),
        ),
      ),
  );

  server.registerTool(
    'add_item_reference',
    {
      description:
        'Link a record (the holder) to another item in the same workspace, with a free-text role such as ' +
        '"organisation" or "contact". With targetFileVersionId it pins that exact file version, which must be ' +
        `approved; ${FIXED_VERSION} A pinned file, or any parent of one, cannot be trashed until the pin is removed. ` +
        'A later revoke of the version keeps the pin and shows it as revoked.',
      inputSchema: {
        itemId: identifier,
        targetItemId: identifier,
        targetFileVersionId: identifier.optional(),
        role: z.string().min(1).max(80).optional(),
      },
    },
    ({ itemId, ...rest }) =>
      toolResult(async () =>
        (await session()).client.execute(agentRecords.addReference(itemId, rest)),
      ),
  );

  server.registerTool(
    'remove_item_reference',
    {
      description:
        'Remove a reference or pin from a record by its reference id (see list_item_references).',
      inputSchema: { itemId: identifier, referenceId: identifier },
    },
    ({ itemId, referenceId }) =>
      toolResult(async () => {
        await (await session()).client.execute(agentRecords.removeReference(itemId, referenceId));
        return { id: referenceId, removed: true };
      }),
  );

  server.registerTool(
    'list_item_references',
    {
      description:
        'List what a record references and pins. A trashed target shows targetAvailable:false; a pin shows its ' +
        "version and that version's current state.",
      inputSchema: { itemId: identifier, ...page },
    },
    ({ itemId, limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(agentRecords.listReferences(itemId, limit, cursor)),
      ),
  );

  server.registerTool(
    'list_referenced_by',
    {
      description: 'Reverse lookup: the records that reference or pin this item.',
      inputSchema: { itemId: identifier, ...page },
    },
    ({ itemId, limit, cursor }) =>
      toolResult(async () =>
        (await session()).client.query(agentRecords.listReferencedBy(itemId, limit, cursor)),
      ),
  );

  server.registerTool(
    'list_backlinks',
    {
      description: 'List readable documents whose body links to this item.',
      inputSchema: { itemId: identifier, limit: z.number().int().min(1).max(100).optional() },
    },
    ({ itemId, limit }) =>
      toolResult(async () =>
        (await session()).client.query(references.listBacklinks(itemId, limit)),
      ),
  );

  server.registerTool(
    'set_file_version_state',
    {
      description:
        'Move one file version between draft, in_review, approved and revoked. A new upload is always a draft. ' +
        'Approving or revoking needs the workspace owner to have switched "agents may approve" on and a personal ' +
        'access credential; it is refused on a browser-approved CLI login. Only approved versions can be pinned ' +
        `or linked by default. ${FIXED_VERSION}`,
      inputSchema: {
        itemId: identifier,
        versionId: identifier,
        state: z.enum(['draft', 'in_review', 'approved', 'revoked']),
      },
    },
    ({ itemId, versionId, state }) =>
      toolResult(async () => {
        const current = await session();
        if (state === 'approved' || state === 'revoked')
          assertTokenSession(current, 'Approving or revoking a file version');
        return current.client.execute(attachments.setVersionState(itemId, versionId, state));
      }),
  );

  server.registerTool(
    'export_note_to_file',
    {
      description:
        'Export a note to PDF, DOCX or Markdown as a new version of a file item (a new file under the note, or ' +
        'a version of targetItemId), then wait for it to publish. The version is a draft that records the source ' +
        'note and revision. Returns the file itemId and publishedVersionId.',
      inputSchema: {
        itemId: identifier,
        format: z.enum(['pdf', 'docx', 'md']),
        targetItemId: identifier.optional(),
      },
    },
    (input) => toolResult(async () => exportToFileValue(await session(), input)),
  );

  server.registerTool(
    'begin_file_upload',
    {
      description:
        'Start a file upload and get a presigned PUT url plus the headers to send. The bytes never pass through ' +
        'this tool: PUT the file to uploadUrl yourself with exactly those headers, then call complete_file_upload. ' +
        'Pass targetItemId to add a new draft version to an existing file; the upload is never auto-approved.',
      inputSchema: {
        workspaceId: identifier,
        fileName: z.string().min(1).max(255),
        byteLength: z
          .number()
          .int()
          .min(1)
          .max(100 * 1024 * 1024),
        parentId: identifier.optional(),
        targetItemId: identifier.optional(),
        mediaType: z.string().min(3).max(128).optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    (input) => toolResult(async () => beginUploadValue(await session(), input)),
  );

  server.registerTool(
    'complete_file_upload',
    {
      description:
        'Finish an upload after PUTting the bytes and wait for the publish job. Returns itemId and ' +
        'publishedVersionId, the exact version this upload created.',
      inputSchema: { uploadId: identifier },
    },
    ({ uploadId }) => toolResult(async () => completeUploadValue(await session(), uploadId)),
  );

  server.registerTool(
    'get_file_download_url',
    {
      description:
        'Get a short-lived url to download a file (GET it yourself; the bytes do not pass through this tool). ' +
        'Without versionId you get the latest approved version, else the current upload if it is not revoked, ' +
        'else the newest non-revoked one; the answer says which. A revoked version has no link (it answers revoked). ' +
        'Pass versionId for an exact version. The answer carries mediaType (the Content-Type the url is served ' +
        "with, application/octet-stream for a download), storedMediaType (the file's own type), sha256, byteLength " +
        'and unscanned: true, which means Nix does not malware-scan uploads. The url expires at expiresAt ' +
        '(five minutes by default). Send a non-default User-Agent when you fetch it: the edge in front of some ' +
        'installs blocks Python\'s default Python-urllib agent with "error code: 1010"; python-requests, node, ' +
        'curl and browsers pass.',
      inputSchema: { itemId: identifier, versionId: identifier.optional() },
    },
    ({ itemId, versionId }) =>
      toolResult(async () => {
        try {
          return await (
            await session()
          ).client.query(files.downloadFile(itemId, versionId), {
            forceRefresh: true,
          });
        } catch (error) {
          if (isNixApiError(error) && error.status === 410) {
            throw new Error('This file version was revoked, so it has no download link.');
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    'set_item_expiry',
    {
      description:
        'Set or clear (null) when an item moves to the trash, as a future time with its offset. You are ' +
        'notified 7 days before and at expiry. Protected items and folders holding protected or pinned items are ' +
        'skipped with a notice. Restoring an item clears its date. Trash does not empty itself.',
      inputSchema: {
        itemId: identifier,
        expiresAt: z
          .string()
          .min(1)
          .max(64)
          .nullable()
          .describe('A future time with its offset, such as 2027-04-02T17:00:00Z. Null clears it.'),
      },
    },
    ({ itemId, expiresAt }) =>
      toolResult(async () =>
        (await session()).client.execute(
          structure.setItemProperties(itemId, { [EXPIRY_KEY]: expiresAt }),
        ),
      ),
  );

  server.registerTool(
    'get_public_link',
    {
      description:
        'Read the active public link of a note or file, if any, with the version it serves.',
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) =>
      toolResult(async () => (await session()).client.query(attachments.getPublicLink(itemId))),
  );

  server.registerTool(
    'create_public_link',
    {
      description:
        'Create the one public link of a note or file (anyone with the url can read it). Needs the install flag ' +
        'and the workspace switch "agents may create public links", a personal access credential with admin scope, and ' +
        'confirm:true after the user agrees. A file link serves one fixed version: the named versionId, else the ' +
        'latest approved; with neither it is refused. Draft versions are linked only by naming them. A note link ' +
        'is live and withholds files with no approved version (see withheldFiles). Revoking takes effect within ' +
        '60 seconds for new downloads.',
      inputSchema: {
        itemId: identifier,
        versionId: identifier.optional(),
        confirm: z.literal(true),
      },
    },
    ({ itemId, versionId }) =>
      toolResult(async () => {
        const current = await session();
        assertTokenSession(current, 'Creating a public link');
        return current.client.execute(attachments.createPublicLink(itemId, versionId));
      }),
  );

  server.registerTool(
    'revoke_public_link',
    {
      description:
        'Revoke the public link of an item. No new download can start more than 60 seconds later; a transfer ' +
        'already under way may finish. Trashing the item also ends the link for good.',
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) =>
      toolResult(async () => {
        await (await session()).client.execute(attachments.revokePublicLink(itemId));
        return { itemId, revoked: true };
      }),
  );

  server.registerTool(
    'list_attachments',
    {
      description:
        'List the file items of a workspace with the version each one shows (latest approved, else latest upload) ' +
        'and its state, pin count, expiry and whether it has a public link. Images are hidden unless ' +
        'includeImages. Filter by state, or expiring:true.',
      inputSchema: {
        workspaceId: identifier,
        state: z.enum(['draft', 'in_review', 'approved', 'revoked']).optional(),
        includeImages: z.boolean().optional(),
        expiring: z.boolean().optional(),
        ...page,
      },
    },
    ({ workspaceId, ...filter }) =>
      toolResult(async () =>
        (await session()).client.query(attachments.listAttachments(workspaceId, filter)),
      ),
  );
}
