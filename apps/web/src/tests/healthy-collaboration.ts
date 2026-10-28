import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { vi } from 'vitest';

import type { ProviderSocket } from '@nix/web-editor/editor/collab-sync';

const MESSAGE_SYNC = 0;
const MESSAGE_PERSISTENCE_BARRIER = 3;

/** Integration tests outside collaboration assume a healthy, empty document service. */
export function stubHealthyCollaboration(): void {
  class HealthySocket implements ProviderSocket {
    binaryType = 'arraybuffer';
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly document = new Y.Doc();

    constructor(private readonly url: string) {
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
        this.receive(JSON.stringify({ type: 'ready', mode: 'write', docId: this.url }));
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
      this.document.destroy();
    }
  }

  vi.stubGlobal('WebSocket', HealthySocket);
}
