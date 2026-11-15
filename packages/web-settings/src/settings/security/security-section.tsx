import { Button, Dialog, Field, Input, Text } from '@nix/ui';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { useAuth } from '@nix/web-platform/auth/auth-provider';
import {
  createSecurityClient,
  SecurityRequestError,
  type SecurityClient,
  type SecurityState,
} from '@nix/web-platform/auth/security-client';
import { createCredential } from '@nix/web-platform/auth/local-auth-client';
import { SettingsSection } from '../shared/settings-section';
import { CopyBox } from '../shared/copy-box';

const MIN_PASSWORD = 10;
const MAX_PASSWORD = 256;

/** The first complaint about a new password, or null; Core enforces the same bounds. */
export function passwordFault(password: string, confirmation: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${String(MIN_PASSWORD)} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${String(MAX_PASSWORD)} characters.`;
  if (password !== confirmation) return 'The two passwords differ.';
  return null;
}

function sentence(cause: unknown): string {
  if (cause instanceof SecurityRequestError && cause.code === 'security.totp_exists')
    return 'An authenticator app is already set up. Remove it first.';
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}

/** Password, passkeys, authenticator app and sign-out-everywhere for the signed-in person. */
export function SecuritySection(props: { readonly client?: SecurityClient }): ReactElement {
  const { getAccessToken, signOut } = useAuth();
  const client = useMemo(
    () => props.client ?? createSecurityClient(getAccessToken),
    [props.client, getAccessToken],
  );
  const [state, setState] = useState<SecurityState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One current-password box serves every sensitive action; Core says when it is not enough.
  const [current, setCurrent] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [passkeyName, setPasskeyName] = useState('');
  const [totp, setTotp] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await client.getSecurity());
      setLoadError(null);
    } catch (cause) {
      setLoadError(sentence(cause));
    }
  }, [client]);
  useEffect(() => {
    // Deferred a microtask: setting state synchronously in an effect body is a cascading render.
    queueMicrotask(() => void load());
  }, [load]);

  /** Runs one action: clears the old message, shows the new one, reloads on success. */
  async function run(action: () => Promise<string>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
      return true;
    } catch (cause) {
      setError(sentence(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (state === null) {
    return (
      <SettingsSection title="Security">
        {loadError === null ? (
          <Text role="status" tone="muted">
            Loading.
          </Text>
        ) : (
          <>
            <Text role="alert">{loadError}</Text>
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </>
        )}
      </SettingsSection>
    );
  }

  const withCurrent = state.hasPassword ? current : undefined;
  const passwordProblem = newPassword === '' ? null : passwordFault(newPassword, confirmation);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      {error === null ? null : <Text role="alert">{error}</Text>}
      {notice === null ? null : <Text role="status">{notice}</Text>}

      <SettingsSection
        title="Password"
        summary={
          state.hasPassword
            ? 'Change your password. Other devices are signed out when you do.'
            : 'You sign in with a passkey. A password is optional; add one from a setup link.'
        }
      >
        {state.hasPassword ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (passwordFault(newPassword, confirmation) !== null) return;
              void run(async () => {
                await client.changePassword(newPassword, current);
                setNewPassword('');
                setConfirmation('');
                setCurrent('');
                return 'Password changed. Your other sessions were signed out.';
              });
            }}
          >
            <Field label="Current password" required>
              {(field) => (
                <Input
                  {...field}
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(event) => {
                    setCurrent(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="New password" hint="10 to 256 characters." required>
              {(field) => (
                <Input
                  {...field}
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => {
                    setNewPassword(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Repeat the new password" error={passwordProblem} required>
              {(field) => (
                <Input
                  {...field}
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => {
                    setConfirmation(event.target.value);
                  }}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={
                  busy || current === '' || passwordFault(newPassword, confirmation) !== null
                }
              >
                Change password
              </Button>
              {state.passkeys.some((key) => key.kind === 'passkey') ? (
                <Button
                  variant="secondary"
                  disabled={busy || current === ''}
                  onClick={() => {
                    void run(async () => {
                      await client.removePassword(current);
                      setCurrent('');
                      return 'Password removed. You now sign in with a passkey.';
                    });
                  }}
                >
                  Remove password
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Passkeys"
        summary={`A passkey signs you in on its own, without a password.${state.passkeyRpId === null ? '' : ` This server uses ${state.passkeyRpId} as its passkey domain.`}`}
      >
        <ul aria-label="Passkeys" className="flex flex-col divide-y divide-divider">
          {state.passkeys.length === 0 ? (
            <li>
              <Text variant="note" tone="muted">
                No passkeys yet.
              </Text>
            </li>
          ) : null}
          {state.passkeys.map((key) => (
            <li key={key.id} className="flex min-h-11 flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <Text as="p" variant="bodySmall" className="break-words">
                  {key.name}
                </Text>
                <Text as="p" variant="caption" tone="muted">
                  {key.kind === 'security_key' ? 'Security key (second step only)' : 'Passkey'}
                  {`, added ${key.createdAt.slice(0, 10)}`}
                  {key.lastUsedAt === null ? '' : `, last used ${key.lastUsedAt.slice(0, 10)}`}
                </Text>
              </div>
              <Button
                variant="secondary"
                disabled={busy}
                aria-label={`Rename ${key.name}`}
                onClick={() => {
                  setRenaming({ id: key.id, name: key.name });
                }}
              >
                Rename
              </Button>
              <Button
                variant="secondary"
                disabled={busy || (state.hasPassword && current === '')}
                aria-label={`Remove ${key.name}`}
                onClick={() => {
                  void run(async () => {
                    await client.removePasskey(key.id, withCurrent);
                    return 'Passkey removed.';
                  });
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        {state.hasPassword ? (
          <Text variant="note" tone="muted">
            Removing or adding a passkey asks for your current password, above.
          </Text>
        ) : null}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const options = await client.passkeyOptions(withCurrent);
              const credential = await createCredential(options);
              await client.passkeyVerify(credential, passkeyName.trim() || 'Passkey');
              setPasskeyName('');
              return 'Passkey added.';
            });
          }}
        >
          <Field label="Name for the new passkey" className="min-w-48 flex-1">
            {(field) => (
              <Input
                {...field}
                value={passkeyName}
                maxLength={100}
                placeholder="Laptop"
                onChange={(event) => {
                  setPasskeyName(event.target.value);
                }}
              />
            )}
          </Field>
          <Button type="submit" disabled={busy || (state.hasPassword && current === '')}>
            Add a passkey
          </Button>
        </form>
        {state.hasPassword ? (
          <Field label="Current password, for passkey and authenticator changes">
            {(field) => (
              <Input
                {...field}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => {
                  setCurrent(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Authenticator app"
        summary="A six-digit code from an app, asked for after your password."
      >
        {totp === null ? (
          state.totpEnabled ? (
            <div className="flex flex-wrap items-center gap-3">
              <Text variant="bodySmall">An authenticator app is set up.</Text>
              <Button
                variant="secondary"
                disabled={busy || (state.hasPassword && current === '')}
                onClick={() => {
                  void run(async () => {
                    await client.removeTotp(withCurrent);
                    return 'Authenticator app removed.';
                  });
                }}
              >
                Remove
              </Button>
            </div>
          ) : (
            <div>
              <Button
                variant="secondary"
                disabled={busy || (state.hasPassword && current === '')}
                onClick={() => {
                  void run(async () => {
                    setTotp(await client.startTotp(withCurrent));
                    return 'Add the secret to your app, then enter the code it shows.';
                  });
                }}
              >
                Set up an authenticator app
              </Button>
            </div>
          )
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await client.confirmTotp(totpCode.trim());
                setTotp(null);
                setTotpCode('');
                return 'Authenticator app added.';
              });
            }}
          >
            <Text variant="note">Secret (type it into your app, or open the link on a phone):</Text>
            <CopyBox text={totp.secret} label="the secret" />
            <CopyBox text={totp.otpauthUri} label="the setup link" />
            <Field label="Code from the app" required>
              {(field) => (
                <Input
                  {...field}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={totpCode}
                  onChange={(event) => {
                    setTotpCode(event.target.value);
                  }}
                />
              )}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || totpCode.trim().length !== 6}>
                Confirm
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setTotp(null);
                  setTotpCode('');
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </SettingsSection>

      <SettingsSection
        title="Sign out everywhere"
        summary="Ends every browser session of yours, including this one."
      >
        <div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setConfirmSignOut(true);
            }}
          >
            Sign out everywhere
          </Button>
        </div>
      </SettingsSection>

      <Dialog
        open={renaming !== null}
        title="Rename passkey"
        onClose={() => {
          setRenaming(null);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setRenaming(null);
              }}
            >
              Cancel
            </Button>
            <Button
              form="rename-passkey-form"
              type="submit"
              disabled={busy || (renaming?.name.trim() ?? '') === ''}
            >
              Save
            </Button>
          </>
        }
      >
        <form
          id="rename-passkey-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (renaming === null) return;
            const target = renaming;
            setRenaming(null);
            void run(async () => {
              await client.renamePasskey(target.id, target.name.trim());
              return 'Passkey renamed.';
            });
          }}
        >
          <Field label="Name">
            {(field) => (
              <Input
                {...field}
                value={renaming?.name ?? ''}
                maxLength={100}
                onChange={(event) => {
                  setRenaming((value) =>
                    value === null ? null : { ...value, name: event.target.value },
                  );
                }}
              />
            )}
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={confirmSignOut}
        title="Sign out everywhere?"
        onClose={() => {
          setConfirmSignOut(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmSignOut(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmSignOut(false);
                void run(async () => {
                  await client.signOutEverywhere();
                  await signOut().catch(() => undefined);
                  return 'Signed out everywhere.';
                });
              }}
            >
              Sign out everywhere
            </Button>
          </>
        }
      >
        <Text>You will need to sign in again on this device and on every other one.</Text>
      </Dialog>
    </div>
  );
}
