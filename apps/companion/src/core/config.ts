/**
 * What the companion service reads from its environment, checked once at startup. Fail-fast, like
 * the sites worker's: a service that starts and then refuses every request is harder to diagnose
 * than one that never starts.
 */

export interface CompanionConfig {
  /** Absolute directory holding accounts, conversations and histories. */
  readonly dataDir: string;
  readonly binary: string;
  readonly chatEffort: string;
  readonly trace: boolean;
  /** How long an account may sit unused before its provider process is stopped. */
  readonly idleSeconds: number;
  readonly internalSecret: string;
  /** Core's origin, for the saved-conversation tools callback. */
  readonly apiUrl: string;
  readonly address: { readonly host: string; readonly port: number };
  readonly release: { readonly version: string; readonly commit: string };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new Error(`${name} is required.`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

/** `:8302` or `127.0.0.1:8302`. */
export function parseAddress(value: string): { host: string; port: number } {
  const match = /^(.*):(\d{1,5})$/.exec(value);
  const port = Number(match?.[2]);
  if (match === null || port < 1 || port > 65535)
    throw new Error(`'${value}' is not a host:port address.`);
  return { host: match[1] === '' ? '0.0.0.0' : (match[1] ?? '0.0.0.0'), port };
}

/** https, or http only for a hostname without a dot, 127.0.0.1 or ::1; no credentials, query or path. */
export function validServiceOrigin(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (
    url.host === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    return false;
  if (url.pathname !== '' && url.pathname !== '/') return false;
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (!url.hostname.includes('.') || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  );
}

export function readConfig(env: NodeJS.ProcessEnv): CompanionConfig {
  const dataDir = required(env, 'NIX_COMPANION_DATA_DIR');
  if (!dataDir.startsWith('/')) throw new Error('NIX_COMPANION_DATA_DIR must be an absolute path.');
  const apiUrl = required(env, 'NIX_COMPANION_API_URL');
  if (!validServiceOrigin(apiUrl))
    throw new Error('NIX_COMPANION_API_URL must be a valid Nix.Api service origin.');
  const rawIdle = env.NIX_COMPANION_IDLE_SECONDS?.trim();
  const idleSeconds = rawIdle === undefined || rawIdle === '' ? 300 : Number(rawIdle);
  if (!Number.isInteger(idleSeconds) || idleSeconds < 1)
    throw new Error('NIX_COMPANION_IDLE_SECONDS must be a positive integer.');
  const trace = env.NIX_COMPANION_TRACE;
  return {
    dataDir,
    binary: optional(env, 'NIX_COMPANION_BINARY', 'codex'),
    chatEffort: optional(env, 'NIX_COMPANION_CHAT_EFFORT', 'low'),
    trace: trace === 'true' || trace === '1',
    idleSeconds,
    internalSecret: required(env, 'NIX_COMPANION_INTERNAL_SECRET'),
    apiUrl: apiUrl.replace(/\/+$/, ''),
    address: parseAddress(optional(env, 'NIX_COMPANION_ADDRESS', ':8302')),
    release: { version: env.NIX_RELEASE_VERSION ?? '', commit: env.NIX_RELEASE_COMMIT ?? '' },
  };
}
