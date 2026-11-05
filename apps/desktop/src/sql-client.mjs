export const BEAT_MS = 2_000;
const STALL_MS = 30_000;

/**
 * Talks to the process that owns the databases, and kills it when it stops answering. Page SQL can
 * run forever (a recursive CTE), and neither the main thread nor a worker_thread could stop it:
 * Worker.terminate() waits for SQLite to return. WAL makes the kill safe; an open transaction is
 * simply lost, and the page's next call to it is refused.
 */
export class SqlClient {
  #spawn;
  #stallMs;
  #child = null;
  #pending = new Map();
  #nextId = 0;
  #lastBeat = 0;
  #watchdog = null;

  /** `spawn` starts the process and returns something with postMessage, kill and on('message' | 'exit'). */
  constructor({ spawn, stallMs = STALL_MS }) {
    this.#spawn = spawn;
    this.#stallMs = stallMs;
  }

  #start() {
    const child = this.#spawn();
    this.#child = child;
    this.#lastBeat = Date.now();
    child.on('message', ({ id, beat, value, error }) => {
      if (beat === true) {
        this.#lastBeat = Date.now();
        return;
      }
      const waiting = this.#pending.get(id);
      this.#pending.delete(id);
      if (error !== undefined) waiting?.reject(new Error(error));
      else waiting?.resolve(value);
    });
    child.on('exit', () => {
      if (this.#child === child) this.#gone();
    });
    this.#watchdog = setInterval(() => {
      if (Date.now() - this.#lastBeat > this.#stallMs) this.#gone();
    }, this.#stallMs / 4);
    this.#watchdog.unref?.();
    return child;
  }

  /** Whatever was in flight fails; the next request starts a fresh process. */
  #gone() {
    const child = this.#child;
    this.#child = null;
    clearInterval(this.#watchdog);
    child?.kill();
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const { reject } of pending) reject(new Error('The offline copy stopped responding.'));
  }

  handle(origin, request) {
    const child = this.#child ?? this.#start();
    return new Promise((resolve, reject) => {
      this.#nextId += 1;
      this.#pending.set(this.#nextId, { resolve, reject });
      child.postMessage({ id: this.#nextId, origin, request });
    });
  }

  close() {
    this.#gone();
  }
}
