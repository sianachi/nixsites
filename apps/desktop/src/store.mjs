import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { lookup } from 'node:dns/promises';
import { readFile, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { isLocalHost, isPrivateAddress } from './shell-rules.mjs';
import { DATABASE_SUFFIXES, SqlStores, StoreError, databasePath, storeId } from './sql-store.mjs';

// The desktop port of apps/mobile/ios/NixStore: the `nixStore` protocol packages/sync-sqlite's
// webkit driver speaks. The caller has already bound `origin` to the frame that sent the request.
// Files are handled here; SQL goes to `sql`, which in the app lives in its own process.

const MAX_REDIRECTS = 10;

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

const systemResolve = async (host) =>
  (await lookup(host, { all: true })).map(({ address }) => address);

/** One origin's files. */
class Files {
  #downloads = new Map();
  #wiping = false;
  #origin;
  #dir;
  #fetch;
  #resolveHost;

  constructor(origin, { baseDir, fetch, resolveHost }) {
    this.#origin = origin;
    this.#dir = join(baseDir, `${storeId(origin)}-files`);
    this.#fetch = fetch;
    this.#resolveHost = resolveHost;
  }

  #path(key) {
    return join(this.#dir, sha256Hex(key));
  }

  async get(key) {
    return readFile(this.#path(key)).catch(() => null);
  }

  async delete(key) {
    await rm(this.#path(key), { force: true });
  }

  /** Plain https, or plain http between a server on this machine and its own local object store. */
  #mayDownload(url) {
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        isLocalHost(url.hostname) &&
        isLocalHost(new URL(this.#origin).hostname))
    );
  }

  /**
   * The download comes back to the page, so it must not read what only this computer can reach (an
   * intranet service, a port on localhost) for a server out on the internet. A server that is on a
   * private network itself may keep its object store there. A rebinding host can still slip past.
   */
  async #assertReachable(url) {
    const resolve = async (hostname) => {
      const host = hostname.replace(/^\[|\]$/g, '');
      return isIP(host) === 0 ? this.#resolveHost(host) : [host];
    };
    const [target, own] = await Promise.all([
      resolve(url.hostname),
      resolve(new URL(this.#origin).hostname).catch(() => []),
    ]);
    if (target.some(isPrivateAddress) && !own.some(isPrivateAddress))
      throw new StoreError('Downloads cannot reach private addresses.');
  }

  /**
   * GET an object-store capability URL: no cookies, no credentials, and no Core token. Returns the
   * stored size and the hex SHA-256 of the stored file so the page can verify the bytes. Everything
   * up to registering the download is synchronous, so a wipe either sees it or runs first.
   */
  async download(key, address) {
    let url;
    try {
      url = new URL(address);
    } catch {
      throw new StoreError('Bad url.');
    }
    if (!this.#mayDownload(url)) throw new StoreError('Downloads must use https.');
    if (this.#wiping) throw new StoreError('The offline copy was removed.');
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const dest = this.#path(key);
    let running = this.#downloads.get(dest);
    if (running === undefined && !existsSync(dest)) {
      const controller = new AbortController();
      running = {
        controller,
        done: this.#fetchTo(url, dest, controller.signal).finally(() => {
          this.#downloads.delete(dest);
        }),
      };
      this.#downloads.set(dest, running);
    }
    await running?.done;
    const hash = createHash('sha256');
    await pipeline(createReadStream(dest), hash);
    return { bytes: statSync(dest).size, sha256: hash.digest('hex') };
  }

  async #fetchTo(start, dest, signal) {
    const part = `${dest}.${randomUUID()}.part`;
    try {
      let url = start;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await this.#assertReachable(url);
        const response = await this.#fetch(url.href, {
          redirect: 'manual',
          credentials: 'omit',
          signal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          url = new URL(response.headers.get('location') ?? '', url);
          if (!this.#mayDownload(url)) throw new StoreError('Downloads must use https.');
          continue;
        }
        if (!response.ok || response.body === null) throw new StoreError('Download failed.');
        await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { mode: 0o600 }), {
          signal,
        });
        await rename(part, dest);
        return;
      }
      throw new StoreError('Download failed.');
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    }
  }

  bytes() {
    if (!existsSync(this.#dir)) return 0;
    return readdirSync(this.#dir).reduce((sum, name) => {
      const path = join(this.#dir, name);
      return sum + (existsSync(path) ? statSync(path).size : 0);
    }, 0);
  }

  /** Stops every download, then runs `removeDatabase`, then deletes the files. */
  async wipe(removeDatabase) {
    this.#wiping = true;
    try {
      const running = [...this.#downloads.values()];
      for (const { controller } of running) controller.abort();
      await Promise.allSettled(running.map(({ done }) => done));
      await removeDatabase();
      try {
        rmSync(this.#dir, { recursive: true, force: true });
      } catch {
        throw new StoreError('Could not delete local data.');
      }
    } finally {
      this.#wiping = false;
    }
  }
}

/** The per-origin stores and the `nixStore` request dispatcher. */
export class Stores {
  #files = new Map();
  #options;
  #sql;

  constructor({
    baseDir,
    fetch = globalThis.fetch,
    resolveHost = systemResolve,
    sql,
    idleTimeoutMs,
  }) {
    this.#options = { baseDir, fetch, resolveHost };
    this.#sql = sql ?? new SqlStores({ baseDir, idleTimeoutMs });
  }

  #filesOf(origin) {
    let files = this.#files.get(origin);
    if (files === undefined) {
      files = new Files(origin, this.#options);
      this.#files.set(origin, files);
    }
    return files;
  }

  wipe(origin) {
    return this.#filesOf(origin).wipe(() => this.#sql.handle(origin, { op: 'wipe' }));
  }

  close() {
    (this.#sql.close ?? this.#sql.closeAll).call(this.#sql);
  }

  #usage(origin) {
    const path = databasePath(this.#options.baseDir, origin);
    const size = (file) => (existsSync(file) ? statSync(file).size : 0);
    return {
      databaseBytes: DATABASE_SUFFIXES.reduce((sum, suffix) => sum + size(path + suffix), 0),
      fileBytes: this.#filesOf(origin).bytes(),
    };
  }

  async handle(origin, request) {
    if (request === null || typeof request !== 'object') throw new StoreError('Bad request.');
    const key = () => {
      if (typeof request.key !== 'string' || request.key === '')
        throw new StoreError('Missing key.');
      return request.key;
    };
    switch (request.op) {
      case 'fileDownload':
        if (typeof request.url !== 'string' || request.url === '')
          throw new StoreError('Missing url.');
        return this.#filesOf(origin).download(key(), request.url);
      case 'fileGet': {
        const data = await this.#filesOf(origin).get(key());
        return { data: data === null ? null : data.toString('base64') };
      }
      case 'fileDelete':
        await this.#filesOf(origin).delete(key());
        return {};
      case 'usage':
        return this.#usage(origin);
      case 'wipe':
        await this.wipe(origin);
        return {};
      default:
        return this.#sql.handle(origin, request);
    }
  }
}
