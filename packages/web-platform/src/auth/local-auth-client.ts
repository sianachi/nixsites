/** Plain fetch wrapper for Core's /auth/local/* endpoints (local sign-in mode). */

export type SecondStepMethod = 'totp' | 'security_key';

export interface SignedIn {
  readonly status: 'signed_in';
  readonly redirectTo: string;
}
export interface SecondStep {
  readonly status: 'second_step';
  readonly challengeId: string;
  readonly methods: readonly SecondStepMethod[];
}

export interface LinkInfo {
  readonly purpose: 'setup' | 'reset';
  readonly email: string;
  readonly name: string;
}

/** A refusal from Core. `code` is Core's own ("invalid_credentials", "paused") when it sent one. */
export class LocalAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(code ?? `Request failed (${String(status)}).`);
    this.name = 'LocalAuthError';
  }
}

/** Raised before any prompt when this browser cannot use a passkey whose RP ID is another host. */
export class PasskeyUnsupportedError extends Error {
  constructor(
    message = 'This browser cannot use that passkey on this address. Use your password instead.',
  ) {
    super(message);
    this.name = 'PasskeyUnsupportedError';
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let code: string | null = null;
    let retry: number | null = null;
    try {
      const json = (await response.json()) as { code?: unknown; retryAfterSeconds?: unknown };
      if (typeof json.code === 'string') code = json.code;
      if (typeof json.retryAfterSeconds === 'number') retry = json.retryAfterSeconds;
    } catch {
      /* A body that is not JSON carries no code. */
    }
    throw new LocalAuthError(response.status, code, retry);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown): Promise<T> => request('POST', path, body);

const link = (token: string, rest = ''): string =>
  `/auth/local/link/${encodeURIComponent(token)}${rest}`;

/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- return types are inferred from `post`. */
export const localAuth = {
  setup: (body: {
    setupCode: string;
    email: string;
    name: string;
    password: string;
    returnTo?: string;
    native?: string;
  }) => post<SignedIn>('/auth/local/setup', body),
  signIn: (body: { email: string; password: string; returnTo?: string; native?: string }) =>
    post<SignedIn | SecondStep>('/auth/local/sign-in', body),
  totp: (challengeId: string, code: string) =>
    post<SignedIn>('/auth/local/second-step/totp', { challengeId, code }),
  securityKeyOptions: (challengeId: string) =>
    post<unknown>('/auth/local/second-step/security-key/options', { challengeId }),
  securityKeyVerify: (challengeId: string, credential: unknown) =>
    post<SignedIn>('/auth/local/second-step/security-key/verify', { challengeId, credential }),
  passkeyOptions: (body: { returnTo?: string; native?: string }) =>
    post<{ challengeId: string; options: unknown }>('/auth/local/passkey/options', body),
  passkeyVerify: (challengeId: string, credential: unknown) =>
    post<SignedIn>('/auth/local/passkey/verify', { challengeId, credential }),
  getLink: (token: string) => request<LinkInfo>('GET', link(token)),
  linkPassword: (token: string, password: string) =>
    post<SignedIn>(link(token, '/password'), { password }),
  linkPasskeyOptions: (token: string) => post<unknown>(link(token, '/passkey/options'), {}),
  linkPasskeyVerify: (token: string, credential: unknown, name: string) =>
    post<SignedIn>(link(token, '/passkey/verify'), { credential, name }),
};
/* eslint-enable @typescript-eslint/explicit-module-boundary-types */

interface JsonOptions {
  readonly rpId?: string | undefined;
}
interface Capabilities {
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
}

/**
 * Passkeys kept under the old auth hostname only work from this host through WebAuthn related
 * origins. A browser that does not report that support gets a plain message instead of a prompt
 * that is certain to fail.
 */
async function assertRpIdUsable(options: JsonOptions, refusal?: string): Promise<void> {
  const host = globalThis.location.hostname;
  if (options.rpId === undefined || host === options.rpId || host.endsWith(`.${options.rpId}`))
    return;
  const capabilities = await (
    PublicKeyCredential as unknown as Capabilities
  ).getClientCapabilities?.();
  if (capabilities?.relatedOrigins !== true) throw new PasskeyUnsupportedError(refusal);
}

export const webAuthnAvailable = (): boolean =>
  typeof PublicKeyCredential !== 'undefined' && typeof navigator.credentials !== 'undefined';

/** Runs navigator.credentials.get for Core's JSON request options and returns the JSON result. */
export async function getAssertion(optionsJson: unknown): Promise<unknown> {
  await assertRpIdUsable(optionsJson as JsonOptions);
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(
    optionsJson as PublicKeyCredentialRequestOptionsJSON,
  );
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (credential === null) throw new DOMException('No credential', 'NotAllowedError');
  return credential.toJSON();
}

/** Runs navigator.credentials.create for Core's JSON creation options and returns the JSON result. */
export async function createCredential(optionsJson: unknown): Promise<unknown> {
  await assertRpIdUsable(
    { rpId: (optionsJson as { rp?: { id?: string } }).rp?.id },
    'This browser cannot add a passkey for this install. Use a password, or try Chrome, Edge or Safari.',
  );
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(
    optionsJson as PublicKeyCredentialCreationOptionsJSON,
  );
  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (credential === null) throw new DOMException('No credential', 'NotAllowedError');
  return credential.toJSON();
}
