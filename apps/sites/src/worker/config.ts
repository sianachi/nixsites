/**
 * What the sites worker reads from its environment, checked once at startup.
 *
 * Fail-fast, like collab's: a worker that starts and then refuses every job is harder to diagnose
 * than one that never starts.
 */

export interface WorkerConfig {
  readonly apiUrl: string;
  readonly internalSecret: string;
  readonly rabbitmqUrl: string;
  /** Origins Core's capability URLs may point at (the sites bucket's object store). */
  readonly objectOrigins: readonly string[];
  /** The only origin the internal secret and a body bearer are ever sent to. */
  readonly collabUrl: string;
  /** Health listener, `host:port` or `:port`. */
  readonly address: { readonly host: string; readonly port: number };
  readonly concurrency: number;
  readonly leaseSeconds: number;
  readonly renewSeconds: number;
  readonly workerId: string;
}

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

export function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${String(min)} to ${String(max)}.`);
  }
  return value;
}

/** `:8302` or `127.0.0.1:8302`. */
export function parseAddress(value: string): { host: string; port: number } {
  const match = /^(.*):(\d{1,5})$/.exec(value);
  const port = Number(match?.[2]);
  if (match === null || port < 1 || port > 65535) {
    throw new Error(`'${value}' is not a host:port address.`);
  }
  return { host: match[1] === '' ? '0.0.0.0' : (match[1] ?? '0.0.0.0'), port };
}

export function readWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const leaseSeconds = integer(env, 'NIX_SITES_LEASE_SECONDS', 60, 5, 300);
  const renewSeconds = integer(env, 'NIX_SITES_RENEW_SECONDS', 20, 1, 299);
  if (renewSeconds >= leaseSeconds) {
    throw new Error('NIX_SITES_RENEW_SECONDS must be shorter than NIX_SITES_LEASE_SECONDS.');
  }
  return {
    apiUrl: required(env, 'NIX_SITES_API_URL').replace(/\/+$/, ''),
    internalSecret: required(env, 'NIX_SITES_INTERNAL_SECRET'),
    rabbitmqUrl: required(env, 'NIX_SITES_RABBITMQ_URL'),
    objectOrigins: (env.NIX_SITES_OBJECT_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
    collabUrl: required(env, 'NIX_SITES_COLLAB_URL').replace(/\/+$/, ''),
    address: parseAddress(env.NIX_SITES_WORKER_ADDRESS ?? ':8302'),
    concurrency: integer(env, 'NIX_SITES_CONCURRENCY', 1, 1, 8),
    leaseSeconds,
    renewSeconds,
    workerId: optional(env, 'NIX_SITES_WORKER_ID', `sites-${String(process.pid)}`),
  };
}
