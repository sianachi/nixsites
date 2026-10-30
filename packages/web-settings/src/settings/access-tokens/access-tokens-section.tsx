import { ScrollRegion, Button, Dialog, Table, Tag, Text } from '@nix/ui';
import { useState, type ReactElement, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

import { ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import { SettingsSection } from '../shared/settings-section';
import { AccessTokenCreateDialog } from './access-token-create-dialog';
import { formatDay, tokenStatus, type TokenStatus } from './token-facts';
import { useAccessTokens, type AccessToken } from './use-access-tokens';

/**
 * The caller's personal access tokens: every one ever issued, and the controls to mint and revoke.
 *
 * **Revoked and expired tokens stay in the table.** The list is an audit of what has been able to
 * act as this principal, and an audit that forgets is not one - so a dead token keeps its row,
 * visibly told apart by its status tag and its muted name rather than removed. Only live rows
 * offer Revoke, because revoking a dead token does nothing the row does not already say.
 *
 * **Revoke confirms first.** It is destructive in the way that matters - any client holding the
 * token loses access on its next request, immediately, with no undo - and unlike deleting a note
 * there is nothing to restore: minting a replacement produces a different secret that every
 * client has to be given by hand.
 */

/** How "never used" is written. A blank cell reads as missing data; this is an answer. */
const NEVER = 'never';

function statusTag(status: TokenStatus): ReactNode {
  if (status.kind === 'live') {
    return <Tag tone="accent">Live</Tag>;
  }

  if (status.kind === 'revoked') {
    return <Tag tone="muted">Revoked {formatDay(status.at)}</Tag>;
  }

  return <Tag tone="muted">Expired {formatDay(status.at)}</Tag>;
}

export function AccessTokensSection(): ReactElement {
  const { pathname } = useLocation();
  const { status, tokens, error, reload, create, revoke } = useAccessTokens();

  const [createOpen, setCreateOpen] = useState(false);

  /** The token a revocation is being confirmed for, or null while none is. */
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const [revokeRefusal, setRevokeRefusal] = useState<string | null>(null);
  const [revokeInFlight, setRevokeInFlight] = useState(false);

  // Taken once per render rather than once per row: sixty rows asking the clock separately could
  // disagree about which side of an expiry boundary "now" is on within one paint.
  const now = new Date();

  async function confirmRevoke(token: AccessToken): Promise<void> {
    setRevokeInFlight(true);
    setRevokeRefusal(null);
    try {
      const { refusal } = await revoke(token.id);
      if (refusal !== null) {
        // The dialog stays open over a failure: closing it would report, by implication, a
        // revocation that never happened.
        setRevokeRefusal(refusal);
        return;
      }

      setRevoking(null);
      await reload();
    } finally {
      setRevokeInFlight(false);
    }
  }

  const columns = [
    {
      key: 'name',
      header: 'Name',
      rowHeader: true,
      cell: (token: AccessToken) =>
        tokenStatus(token, now).kind === 'live' ? (
          token.name
        ) : (
          // The muted role rather than an opacity wash, so a dead row stays readable - distinct
          // is not the same as illegible, and an audit row nobody can read is not an audit.
          <Text as="span" variant="bodySmall" tone="muted">
            {token.name}
          </Text>
        ),
    },
    {
      key: 'scopes',
      header: 'Scopes',
      cell: (token: AccessToken) => (
        <span className="inline-flex flex-wrap gap-1">
          {token.scopes.map((scope) => (
            <Tag key={scope}>{scope}</Tag>
          ))}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      cell: (token: AccessToken) => formatDay(token.createdAt),
    },
    {
      key: 'expiresAt',
      header: 'Expires',
      cell: (token: AccessToken) => formatDay(token.expiresAt),
    },
    {
      key: 'lastUsedAt',
      header: 'Last used',
      cell: (token: AccessToken) =>
        token.lastUsedAt === null ? (
          <Text as="span" variant="bodySmall" tone="muted">
            {NEVER}
          </Text>
        ) : (
          formatDay(token.lastUsedAt)
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (token: AccessToken) => statusTag(tokenStatus(token, now)),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (token: AccessToken) =>
        tokenStatus(token, now).kind === 'live' ? (
          <Button
            variant="subtle"
            onClick={() => {
              setRevokeRefusal(null);
              setRevoking(token);
            }}
          >
            Revoke {token.name}
          </Button>
        ) : null,
    },
  ] as const;

  return (
    <SettingsSection
      title="Access tokens"
      summary="Let a script or machine act as you, within the scopes you choose."
    >
      <div>
        <Button
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          Create token
        </Button>
      </div>
      <details>
        <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
          About this list
        </summary>
        <Text variant="note" tone="muted">
          Every token you have issued is listed, including revoked and expired ones: this is the
          audit of what has been able to act as your account.
        </Text>
      </details>
      <Text variant="note">
        <Link to={`${pathname}?tab=api`} className="text-accent-text">
          Call the HTTP API with a token
        </Link>
      </Text>

      {status === 'error' ? (
        <ErrorPanel
          title="Your tokens could not be loaded"
          detail={error ?? 'Something went wrong reading your access tokens.'}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <ScrollRegion
            className="hidden min-w-0 overflow-x-auto sm:block"
            aria-label="Access tokens table"
          >
            <Table
              caption="Your personal access tokens, newest first"
              columns={columns}
              rows={tokens}
              rowKey={(token) => token.id}
              loading={status === 'loading'}
              loadingMessage="Loading your access tokens."
              emptyMessage="You have no access tokens. Create one to let a script or machine act as you."
            />
          </ScrollRegion>
          <MobileTokenList
            status={status}
            tokens={tokens}
            now={now}
            onRevoke={(token) => {
              setRevokeRefusal(null);
              setRevoking(token);
            }}
          />
        </>
      )}

      {/* Mounted only while open, the same call `editor-page.tsx` makes for its export dialog: a
          dialog that stays mounted keeps its form in the document for queries and assistive
          technology to stumble over, and unmounting on close is also what resets the form. */}
      {createOpen ? (
        <AccessTokenCreateDialog
          open
          create={create}
          onClose={(createdToken) => {
            setCreateOpen(false);
            if (createdToken) {
              void reload();
            }
          }}
        />
      ) : null}

      {revoking === null ? null : (
        <Dialog
          open
          title={`Revoke ${revoking.name}?`}
          onClose={() => {
            if (!revokeInFlight) {
              setRevoking(null);
            }
          }}
          closeLabel="Keep the token"
          actions={
            <>
              <Button
                variant="secondary"
                disabled={revokeInFlight}
                onClick={() => {
                  setRevoking(null);
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={revokeInFlight}
                onClick={() => {
                  void confirmRevoke(revoking);
                }}
              >
                {revokeInFlight ? 'Revoking the token' : 'Revoke token'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            <Text variant="bodySmall">
              Any client using this token loses access immediately, and there is no undo: a
              replacement means minting a new token and handing its secret to every client again.
            </Text>
            {revokeRefusal === null ? null : (
              <Text variant="note" role="alert">
                {revokeRefusal}
              </Text>
            )}
          </div>
        </Dialog>
      )}
    </SettingsSection>
  );
}

function MobileTokenList({
  status,
  tokens,
  now,
  onRevoke,
}: {
  readonly status: 'loading' | 'ready' | 'error';
  readonly tokens: readonly AccessToken[];
  readonly now: Date;
  readonly onRevoke: (token: AccessToken) => void;
}): ReactElement {
  if (status === 'loading') {
    return (
      <Text as="p" variant="note" role="status" className="sm:hidden">
        Loading your access tokens.
      </Text>
    );
  }

  if (tokens.length === 0) {
    return (
      <Text as="p" variant="note" tone="muted" className="sm:hidden">
        You have no access tokens. Create one to let a script or machine act as you.
      </Text>
    );
  }

  return (
    <ul
      aria-label="Your personal access tokens, newest first"
      className="flex flex-col gap-2 sm:hidden"
    >
      {tokens.map((token) => {
        const status = tokenStatus(token, now);
        return (
          <li
            key={token.id}
            className="flex min-w-0 flex-col gap-3 rounded-md border border-divider p-3"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <Text variant="bodySmall" as="h3" className="min-w-0 flex-1 break-words">
                {token.name}
              </Text>
              {statusTag(status)}
            </div>
            <div className="flex flex-col gap-1">
              <Text variant="caption" tone="muted">
                Scopes
              </Text>
              <div className="flex flex-wrap gap-1">
                {token.scopes.map((scope) => (
                  <Tag key={scope}>{scope}</Tag>
                ))}
              </div>
            </div>
            <dl className="grid grid-cols-1 gap-x-3 gap-y-2">
              <div>
                <dt>
                  <Text variant="caption" tone="muted">
                    Created
                  </Text>
                </dt>
                <dd>
                  <Text variant="bodySmall">{formatDay(token.createdAt)}</Text>
                </dd>
              </div>
              <div>
                <dt>
                  <Text variant="caption" tone="muted">
                    Expires
                  </Text>
                </dt>
                <dd>
                  <Text variant="bodySmall">{formatDay(token.expiresAt)}</Text>
                </dd>
              </div>
              <div>
                <dt>
                  <Text variant="caption" tone="muted">
                    Last used
                  </Text>
                </dt>
                <dd>
                  {token.lastUsedAt === null ? (
                    <Text variant="bodySmall" tone="muted">
                      {NEVER}
                    </Text>
                  ) : (
                    <Text variant="bodySmall">{formatDay(token.lastUsedAt)}</Text>
                  )}
                </dd>
              </div>
            </dl>
            {status.kind === 'live' ? (
              <div className="flex justify-end border-t border-divider pt-2">
                <Button
                  variant="secondary"
                  aria-label={`Revoke ${token.name}`}
                  onClick={() => {
                    onRevoke(token);
                  }}
                >
                  Revoke token
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
