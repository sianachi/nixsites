import { Button, Dialog, Field, Input, ScrollRegion, Table, Text } from '@nix/ui';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { useAuth } from '@nix/web-platform/auth/auth-provider';
import {
  createSecurityClient,
  type AccountLink,
  type LocalPerson,
  type SecurityClient,
} from '@nix/web-platform/auth/security-client';
import { SettingsSection } from '../shared/settings-section';
import { CopyBox } from '../shared/copy-box';

type Pending =
  | { readonly kind: 'toggle'; readonly person: LocalPerson }
  | { readonly kind: 'reset'; readonly person: LocalPerson }
  | { readonly kind: 'link'; readonly title: string; readonly link: AccountLink };

function sentence(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}

/** Tenant admins: who has an account, add someone, hand out one-time links, disable and enable. */
export function PeopleSection(props: { readonly client?: SecurityClient }): ReactElement {
  const { getAccessToken } = useAuth();
  const client = useMemo(
    () => props.client ?? createSecurityClient(getAccessToken),
    [props.client, getAccessToken],
  );
  const [people, setPeople] = useState<readonly LocalPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [current, setCurrent] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  // Unknown (a failed load) counts as "has a password": Core refuses a wrong guess either way.
  const [hasPassword, setHasPassword] = useState(true);
  const selfId = useSessionStore((state) => state.profile?.subject);

  const load = useCallback(async () => {
    try {
      setPeople((await client.listPeople()).people);
    } catch (cause) {
      setError(sentence(cause));
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    client.getSecurity().then(
      (state) => {
        setHasPassword(state.hasPassword);
      },
      () => undefined,
    );
  }, [client]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(sentence(cause));
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    {
      key: 'person',
      header: 'Person',
      rowHeader: true,
      cell: (person: LocalPerson) => (
        <>
          {person.name}
          <Text as="span" variant="caption" tone="muted" className="block break-all">
            {person.email}
          </Text>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (person: LocalPerson) =>
        `${person.status === 'active' ? 'Active' : 'Disabled'}${person.isAdmin ? ', admin' : ''}`,
    },
    {
      key: 'methods',
      header: 'Sign-in',
      cell: (person: LocalPerson) =>
        [
          person.hasPassword ? 'password' : null,
          person.passkeyCount > 0 ? `${String(person.passkeyCount)} passkey(s)` : null,
          person.totpEnabled ? 'authenticator' : null,
        ]
          .filter((part) => part !== null)
          .join(', ') || 'not set up',
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (person: LocalPerson) => (
        <div className="flex flex-wrap gap-2">
          {person.id.toLowerCase() === selfId?.toLowerCase() ? null : (
            <Button
              variant="secondary"
              disabled={busy}
              aria-label={`Reset link for ${person.name}`}
              onClick={() => {
                setCurrent('');
                setResetError(null);
                setPending({ kind: 'reset', person });
              }}
            >
              Reset link
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy}
            aria-label={`${person.status === 'active' ? 'Disable' : 'Enable'} ${person.name}`}
            onClick={() => {
              setPending({ kind: 'toggle', person });
            }}
          >
            {person.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
        </div>
      ),
    },
  ];

  const resetTarget = pending?.kind === 'reset' ? pending.person : null;
  const target = pending?.kind === 'toggle' ? pending.person : null;
  const disabling = target?.status === 'active';

  return (
    <SettingsSection
      title="People"
      summary="Accounts on this server. A person sets their own password or passkey from a one-time link that works for one hour."
    >
      {error === null ? null : <Text role="alert">{error}</Text>}
      <ScrollRegion className="min-w-0 overflow-x-auto" aria-label="People table">
        <Table
          caption="People"
          columns={columns}
          rows={people ?? []}
          rowKey={(person) => person.id}
          loading={people === null && error === null}
          loadingMessage="Loading people."
          emptyMessage="Nobody is listed yet."
        />
      </ScrollRegion>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const created = await client.addPerson(email.trim(), name.trim());
            setEmail('');
            setName('');
            setPending({
              kind: 'link',
              title: `Setup link for ${created.person.name}`,
              link: created.link,
            });
          });
        }}
      >
        <Field label="Email" className="min-w-48 flex-1" required>
          {(field) => (
            <Input
              {...field}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Name" className="min-w-40 flex-1" required>
          {(field) => (
            <Input
              {...field}
              autoComplete="off"
              value={name}
              maxLength={100}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <Button type="submit" disabled={busy || email.trim() === '' || name.trim() === ''}>
          Add person
        </Button>
      </form>

      <Dialog
        open={pending?.kind === 'link'}
        title={pending?.kind === 'link' ? pending.title : ''}
        onClose={() => {
          setPending(null);
        }}
        actions={
          <Button
            onClick={() => {
              setPending(null);
            }}
          >
            Done
          </Button>
        }
      >
        {pending?.kind === 'link' ? (
          <div className="flex flex-col gap-3">
            <Text>
              Send this link to them yourself. It is shown once, works once, and expires{' '}
              {new Date(pending.link.expiresAt).toLocaleString()}.
            </Text>
            <CopyBox text={pending.link.url} label="the link" />
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={resetTarget !== null}
        title={resetTarget === null ? '' : `Reset link for ${resetTarget.name}`}
        onClose={() => {
          setPending(null);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPending(null);
              }}
            >
              Cancel
            </Button>
            <Button
              form="reset-link-form"
              type="submit"
              disabled={busy || (hasPassword && current === '')}
            >
              Issue link
            </Button>
          </>
        }
      >
        <form
          id="reset-link-form"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (resetTarget === null) return;
            setBusy(true);
            setResetError(null);
            client.resetLink(resetTarget.id, hasPassword ? current : undefined).then(
              (link) => {
                setCurrent('');
                setPending({ kind: 'link', title: `Reset link for ${resetTarget.name}`, link });
                setBusy(false);
              },
              (cause: unknown) => {
                setResetError(sentence(cause));
                setBusy(false);
              },
            );
          }}
        >
          <Text>Their current sign-in stops working once they use the link.</Text>
          {hasPassword ? (
            <Field label="Your current password" required>
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
          {resetError === null ? null : <Text role="alert">{resetError}</Text>}
        </form>
      </Dialog>

      <Dialog
        open={target !== null}
        title={target === null ? '' : `${disabling ? 'Disable' : 'Enable'} ${target.name}?`}
        onClose={() => {
          setPending(null);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPending(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (target === null) return;
                setPending(null);
                void run(() => client.setDisabled(target.id, disabling).then(() => undefined));
              }}
            >
              {disabling ? 'Disable' : 'Enable'}
            </Button>
          </>
        }
      >
        <Text>
          {disabling
            ? 'They are signed out everywhere and cannot sign in until you enable them again.'
            : 'They can sign in again.'}
        </Text>
      </Dialog>
    </SettingsSection>
  );
}
