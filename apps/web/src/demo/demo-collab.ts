import { nixSchema } from '@nix/editor-schema';
import { markdownToDocument } from '@nix/markdown';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { updateYFragment } from 'y-prosemirror';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import type { ProviderSocket } from '@nix/web-editor/editor/collab-sync';

const MESSAGE_SYNC = 0;
const MESSAGE_PERSISTENCE_BARRIER = 3;
/** The Yjs fragment a note's prose binds to; must match the collaboration service's own. */
const FRAGMENT = 'default';

/** A note body written from Markdown, as an import would write it. */
function seeded(markdown: string): Y.Doc {
  const document = new Y.Doc();
  const parsed = markdownToDocument(markdown);
  if (!parsed.ok) return document;
  const node = nixSchema.nodeFromJSON(parsed.doc);
  document.transact(() => {
    updateYFragment(document, document.getXmlFragment(FRAGMENT), node, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
  return document;
}

/** A note body as the single Yjs update the companion's body reader expects, base64-encoded. */
export function seededUpdate(markdown: string): string {
  const bytes = Y.encodeStateAsUpdate(seeded(markdown));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The collaboration service for the server-free demo: note bodies sync with documents held in this
 * tab, one per note, so edits survive closing and reopening a note until the tab reloads. Installed
 * as the page's WebSocket for `/collab` addresses only; any other socket (the dev server's reload
 * channel) is the browser's own. `notes` gives some notes a body to open with, by item id.
 */
export function installDemoCollab(notes: Readonly<Record<string, string>>): void {
  const Native = globalThis.WebSocket;
  const documents = new Map<string, Y.Doc>();

  class DemoCollabSocket implements ProviderSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly document: Y.Doc;
    private readonly forward = (update: Uint8Array, origin: unknown): void => {
      if (origin === this) return;
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, MESSAGE_SYNC);
      syncProtocol.writeUpdate(message, update);
      this.receive(encoding.toUint8Array(message));
    };

    constructor(private readonly path: string) {
      const existing = documents.get(path);
      const markdown = Object.entries(notes).find(([itemId]) => path.includes(itemId))?.[1];
      this.document = existing ?? (markdown === undefined ? new Y.Doc() : seeded(markdown));
      if (existing === undefined) documents.set(path, this.document);
      this.document.on('update', this.forward);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.();
      });
    }

    private receive(data: unknown): void {
      queueMicrotask(() => {
        if (this.readyState === 1) this.onmessage?.({ data });
      });
    }

    send(data: string | Uint8Array): void {
      if (this.readyState !== 1) return;
      if (typeof data === 'string') {
        this.receive(JSON.stringify({ type: 'ready', mode: 'write', docId: this.path }));
        return;
      }
      const decoder = decoding.createDecoder(data);
      const kind = decoding.readVarUint(decoder);
      const reply = encoding.createEncoder();
      if (kind === MESSAGE_SYNC) {
        encoding.writeVarUint(reply, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, reply, this.document, this);
        if (encoding.length(reply) > 1) this.receive(encoding.toUint8Array(reply));
      } else if (kind === MESSAGE_PERSISTENCE_BARRIER) {
        encoding.writeVarUint(reply, MESSAGE_PERSISTENCE_BARRIER);
        encoding.writeVarString(reply, decoding.readVarString(decoder));
        this.receive(encoding.toUint8Array(reply));
      }
    }

    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.document.off('update', this.forward);
      queueMicrotask(() => this.onclose?.({ code: 1000 }));
    }
  }

  const DemoWebSocket = function (url: string | URL, protocols?: string | string[]) {
    const address = new URL(url, globalThis.location.href);
    return address.pathname.startsWith('/collab/')
      ? new DemoCollabSocket(address.pathname)
      : new Native(url, protocols);
  };
  Object.assign(DemoWebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    prototype: Native.prototype,
  });
  globalThis.WebSocket = DemoWebSocket as unknown as typeof WebSocket;
}
