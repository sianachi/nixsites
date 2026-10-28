import { items, type NixClient } from '@nix/api-client';

import { writeImportedBody } from '../import/note-body-writer';
import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';

export type CreatedNote =
  | { readonly ok: true; readonly itemId: string; readonly bodyError: string | null }
  | { readonly ok: false; readonly error: string };

/**
 * Creates one note at the workspace root, with a body when there is one.
 *
 * The same two steps a Markdown import takes for each file - create the item through Core, then
 * write its body to the collaboration service as a single update, which is safe only because the
 * item is moments old - so a shared page or an opened file becomes exactly the note an import of
 * the same text would have made. A body that cannot be written still leaves the note, and says so.
 */
export async function createNote(request: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly title: string;
  /** Markdown the person chose to open, or a document already built from untrusted text. */
  readonly body?: { readonly markdown: string } | { readonly doc: unknown };
  readonly getAccessToken: () => Promise<string | null>;
}): Promise<CreatedNote> {
  const { client, workspaceId, title, body, getAccessToken } = request;
  let itemId: string;
  try {
    const item = await client.execute(items.createItem(workspaceId, { type: 'note', title }));
    itemId = item.id;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The note could not be created.',
    };
  }
  notifyItemChildrenChanged(workspaceId, null);

  if (body === undefined) return { ok: true, itemId, bodyError: null };
  let doc: unknown;
  if ('doc' in body) {
    doc = body.doc;
  } else {
    if (body.markdown.trim() === '') return { ok: true, itemId, bodyError: null };
    const { markdownToDocument } = await import('@nix/markdown/from-markdown');
    const parsed = markdownToDocument(body.markdown);
    if (!parsed.ok) return { ok: true, itemId, bodyError: parsed.reason };
    doc = parsed.doc;
  }
  const token = await getAccessToken().catch(() => null);
  if (token === null) {
    return { ok: true, itemId, bodyError: 'Your session could not be read to write the text.' };
  }
  const written = await writeImportedBody({ itemId, doc, token });
  return { ok: true, itemId, bodyError: written.ok ? null : written.error };
}
