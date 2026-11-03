import {
  createWebkitSqliteDriver,
  fileDelete,
  fileDownload,
  fileGet,
  openSqliteMirror,
  usage,
  windowNixStorePost,
  wipe,
  type NixStorePost,
  type SqliteMirrorStore,
} from '@nix/sync-sqlite';
import { z } from 'zod';

import { inNativeShell } from '../pwa/install-nix';

/**
 * The iOS shell's offline mirror for this server: which account it holds, whether it may be read,
 * and the one place it is wiped. Everything here is inert outside the shell (`getNativeMirror`
 * returns null), so the browser and the home-screen app never reach it.
 */

/** Dispatched on window when an offline launch has reached the server again. */
export const BACK_ONLINE_EVENT = 'nix:back-online';

const POINTER_KEY = 'nix.offline.account';
const SESSION_KEY = 'offline.session';
const FILES_KEY = 'offline.files';

const pointerSchema = z.object({
  origin: z.string(),
  tenantId: z.string().min(1),
  principalId: z.string().min(1),
});
const sessionSchema = z.object({
  profile: z.object({
    subject: z.string().min(1),
    name: z.string().min(1),
    email: z.string().nullable(),
  }),
});
export type StoredSession = z.infer<typeof sessionSchema>;
const fileIndexSchema = z.record(z.string(), z.string());

export interface MirrorAccount {
  readonly tenantId: string;
  readonly principalId: string;
}

export interface NativeMirrorDeps {
  readonly origin: string;
  readonly post: NixStorePost;
  /** Holds only which account the mirror belongs to, never content. Null when unavailable. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

export class NativeMirror {
  private store: SqliteMirrorStore | null = null;
  private account: MirrorAccount | null = null;
  /** False from the moment a wipe starts until it has succeeded: nothing is read meanwhile. */
  private admitted = true;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: NativeMirrorDeps) {}

  /** The open mirror, or null while admission is closed. */
  /** The principal the open mirror belongs to, or null. */
  principalId(): string | null {
    return this.account?.principalId ?? null;
  }

  current(): SqliteMirrorStore | null {
    return this.admitted ? this.store : null;
  }

  /** Opens this account's mirror; a copy that belongs to another account is wiped first. */
  open(account: MirrorAccount): Promise<SqliteMirrorStore> {
    return this.serial(async () => {
      if (!this.admitted && !(await this.wipeNow()))
        throw new Error('The previous offline copy could not be removed.');
      if (
        this.store !== null &&
        this.account?.tenantId === account.tenantId &&
        this.account.principalId === account.principalId
      )
        return this.store;
      await this.store?.close();
      this.store = null;
      const scope = { serverOrigin: this.deps.origin, ...account };
      const driver = createWebkitSqliteDriver(this.deps.post);
      let store: SqliteMirrorStore;
      try {
        store = await openSqliteMirror({ driver, scope });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('another account')) throw error;
        // Account switch: the earlier person's copy goes before this one is admitted.
        await this.deps.post({ op: 'wipe' });
        store = await openSqliteMirror({ driver, scope });
      }
      this.store = store;
      this.account = account;
      this.deps.storage?.setItem(
        POINTER_KEY,
        JSON.stringify({ origin: this.deps.origin, ...account }),
      );
      return store;
    });
  }

  /** Reopens the mirror last used on this device, for a launch with no network. */
  async openStored(): Promise<SqliteMirrorStore | null> {
    try {
      const raw = this.deps.storage?.getItem(POINTER_KEY);
      if (raw === null || raw === undefined) return null;
      const pointer = pointerSchema.safeParse(JSON.parse(raw));
      if (!pointer.success || pointer.data.origin !== this.deps.origin) return null;
      return await this.open(pointer.data);
    } catch {
      return null;
    }
  }

  async session(): Promise<StoredSession | null> {
    const store = this.current();
    if (store === null) return null;
    try {
      const raw = await store.getSetting(SESSION_KEY);
      const parsed = raw === null ? null : sessionSchema.safeParse(JSON.parse(raw));
      return parsed?.success === true ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async saveSession(session: StoredSession): Promise<void> {
    await this.current()?.setSetting(SESSION_KEY, JSON.stringify(session));
  }

  /**
   * Closes admission, then deletes the database and every file. Resolves false when deletion
   * failed; admission then stays closed until a later attempt succeeds.
   */
  wipe(): Promise<boolean> {
    // Closed before queueing, so a read in flight behind another operation is already refused.
    this.admitted = false;
    return this.serial(() => this.wipeNow());
  }

  private async wipeNow(): Promise<boolean> {
    this.admitted = false;
    try {
      this.deps.storage?.removeItem(POINTER_KEY);
      if (this.store !== null) await this.store.wipe();
      else await wipe(this.deps.post);
      this.store = null;
      this.account = null;
      this.admitted = true;
      return true;
    } catch {
      return false;
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pending.then(work, work);
    this.pending = run.catch(() => undefined);
    return run;
  }

  // Files sit beside the database and are keyed by item and version.

  async fileIndex(): Promise<Record<string, string>> {
    const raw = await this.current()?.getSetting(FILES_KEY);
    if (raw === null || raw === undefined) return {};
    const parsed = fileIndexSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  }

  async setFileIndex(index: Record<string, string>): Promise<void> {
    await this.current()?.setSetting(FILES_KEY, JSON.stringify(index));
  }

  /**
   * Null when admission closed or the account changed before or during the download: a file that
   * landed after a sign-out is deleted, never kept.
   */
  async fileDownload(
    itemId: string,
    versionId: string,
    url: string,
  ): Promise<{ bytes: number; sha256: string } | null> {
    const account = this.account;
    if (!this.admitted || account === null) return null;
    try {
      const stored = await fileDownload(fileKey(itemId, versionId), url, this.deps.post);
      if (this.holds(account)) return stored;
    } catch (error) {
      if (this.holds(account)) throw error;
    }
    await this.fileDelete(itemId, versionId).catch(() => undefined);
    return null;
  }

  /** Re-read after an await: admission and the account can change while a download runs. */
  private holds(account: MirrorAccount): boolean {
    return this.admitted && this.account === account;
  }

  fileGet(itemId: string, versionId: string): Promise<Uint8Array | null> {
    return this.admitted
      ? fileGet(fileKey(itemId, versionId), this.deps.post)
      : Promise.resolve(null);
  }

  fileDelete(itemId: string, versionId: string): Promise<void> {
    return fileDelete(fileKey(itemId, versionId), this.deps.post);
  }

  usage(): Promise<{ databaseBytes: number; fileBytes: number }> {
    return usage(this.deps.post);
  }

  /** While true, the shell keeps the app running for the short time iOS allows once it leaves the screen. */
  async keepAwake(running: boolean): Promise<void> {
    // An older shell build does not know the op; the pass runs as before.
    await this.deps.post({ op: 'keepAwake', running }).catch(() => undefined);
  }

  /** A notification while the app is off screen; with no message it only asks for permission. */
  async notify(message?: { title: string; body: string }): Promise<void> {
    await this.deps.post({ op: 'notify', ...message }).catch(() => undefined);
  }
}

export const fileKey = (itemId: string, versionId: string): string => `${itemId}:${versionId}`;

let instance: NativeMirror | null | undefined;

/** The shell's mirror, or null in a browser, the home-screen app, or a shell without the store. */
export function getNativeMirror(): NativeMirror | null {
  if (instance !== undefined) return instance;
  try {
    instance = inNativeShell
      ? new NativeMirror({
          origin: globalThis.location.origin,
          post: windowNixStorePost(),
          storage: globalThis.localStorage,
        })
      : null;
  } catch {
    instance = null;
  }
  return instance;
}

/** Test seam: replaces the shell's mirror. */
export function setNativeMirror(mirror: NativeMirror | null): void {
  instance = mirror;
}

/** The profile the mirror was last signed in with, or null when this device has no usable copy. */
export async function nativeBootSession(): Promise<StoredSession | null> {
  const mirror = getNativeMirror();
  return mirror === null || (await mirror.openStored()) === null ? null : mirror.session();
}

/**
 * Sign-out, account switch or a definitive refusal: closes admission and wipes. True when there
 * was nothing to wipe (not the shell) or the wipe finished.
 */
export async function discardNativeMirror(): Promise<boolean> {
  return (await getNativeMirror()?.wipe()) ?? true;
}
