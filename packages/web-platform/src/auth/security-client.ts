/**
 * Plain fetch wrapper for the local-account endpoints a signed-in person uses:
 * `/api/v1/me/security/*` and `/api/v1/tenant/people/*`. Deliberately outside the generated api
 * client: Core serves these to browser sessions only, so they are not part of the public API.
 */

export interface Passkey {
  readonly id: string;
  readonly name: string;
  readonly kind: 'passkey' | 'security_key';
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface SecurityState {
  readonly hasPassword: boolean;
  readonly totpEnabled: boolean;
  readonly passkeys: readonly Passkey[];
  readonly passkeyRpId: string | null;
}

export interface LocalPerson {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: string;
  readonly isAdmin: boolean;
  readonly hasPassword: boolean;
  readonly passkeyCount: number;
  readonly totpEnabled: boolean;
  readonly createdAt: string;
}

export interface AccountLink {
  readonly url: string;
  readonly expiresAt: string;
}

/** A refusal from Core, carrying the sentence worth showing. */
export class SecurityRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export type TokenSource = (forceRefresh?: boolean) => Promise<string | null>;

async function request<T>(
  getToken: TokenSource,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getToken();
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new SecurityRequestError(0, 'Core could not be reached.');
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // A non-JSON body (a proxy error page) falls through to the generic sentence.
  }
  if (!response.ok) {
    const fields = (parsed ?? {}) as { detail?: unknown; title?: unknown; code?: unknown };
    const sentence =
      typeof fields.detail === 'string'
        ? fields.detail
        : typeof fields.title === 'string'
          ? fields.title
          : response.status === 401 || response.status === 403
            ? 'That was not accepted. Check your current password, or sign in again.'
            : 'Core refused the request.';
    throw new SecurityRequestError(
      response.status,
      sentence,
      typeof fields.code === 'string' ? fields.code : null,
    );
  }
  return parsed as T;
}

const segment = encodeURIComponent;

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- SecurityClient is derived from this return value.
export function createSecurityClient(getToken: TokenSource) {
  const call = <T>(method: string, path: string, body?: unknown): Promise<T> =>
    request<T>(getToken, method, path, body);
  const me = '/api/v1/me/security';
  const people = '/api/v1/tenant/people';
  return {
    getSecurity: () => call<SecurityState>('GET', me),
    changePassword: (newPassword: string, currentPassword?: string) =>
      call<null>('POST', `${me}/password`, { currentPassword, newPassword }),
    removePassword: (currentPassword: string) =>
      call<null>('DELETE', `${me}/password`, { currentPassword }),
    passkeyOptions: (currentPassword?: string) =>
      call<unknown>('POST', `${me}/passkeys/options`, { currentPassword }),
    passkeyVerify: (credential: unknown, name: string) =>
      call<Passkey>('POST', `${me}/passkeys/verify`, { credential, name }),
    renamePasskey: (id: string, name: string) =>
      call<null>('PATCH', `${me}/passkeys/${segment(id)}`, { name }),
    removePasskey: (id: string, currentPassword?: string) =>
      call<null>('DELETE', `${me}/passkeys/${segment(id)}`, { currentPassword }),
    startTotp: (currentPassword?: string) =>
      call<{ secret: string; otpauthUri: string }>('POST', `${me}/totp`, { currentPassword }),
    confirmTotp: (code: string) => call<null>('POST', `${me}/totp/confirm`, { code }),
    removeTotp: (currentPassword?: string) =>
      call<null>('DELETE', `${me}/totp`, { currentPassword }),
    signOutEverywhere: () => call<null>('POST', `${me}/sign-out-everywhere`),
    listPeople: () => call<{ people: LocalPerson[] }>('GET', people),
    addPerson: (email: string, name: string) =>
      call<{ person: LocalPerson; link: AccountLink }>('POST', people, { email, name }),
    resetLink: (id: string, currentPassword?: string) =>
      call<AccountLink>('POST', `${people}/${segment(id)}/reset-link`, { currentPassword }),
    setDisabled: (id: string, disabled: boolean) =>
      call<null>('POST', `${people}/${segment(id)}/${disabled ? 'disable' : 'enable'}`),
  };
}

export type SecurityClient = ReturnType<typeof createSecurityClient>;
