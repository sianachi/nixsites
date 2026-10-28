import { Button, Dialog, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';
import { Link, useLocation } from 'react-router';

import { ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import { useCapabilities } from '../../session/capabilities-context';
import { SettingsSection } from '../shared/settings-section';
import { AccessTokenCreateDialog } from '../access-tokens/access-token-create-dialog';
import { formatDay, tokenStatus } from '../access-tokens/token-facts';
import { useAccessTokens, type AccessToken } from '../access-tokens/use-access-tokens';

/** Tokens minted from this page carry this prefix, so this page can list and revoke only them. */
export const MCP_TOKEN_PREFIX = 'mcp:';

/**
 * Model Context Protocol (requirement 9): how an AI client connects to Nix as you.
 *
 * Two transports, one contract: `nixctl mcp` on stdio using a signed-in profile, and, when the
 * deployment serves it, the same tools over HTTP at the address Core advertises, authenticated by
 * a personal access token on every request. Access is a token: creating one here enables a client,
 * revoking it disables that client at once, because every request exchanges the token with Core.
 * Nothing here grants more than the token's scopes; Core checks every call.
 */
export function McpSection(): ReactElement {
  const { pathname } = useLocation();
  const { mcpUrl } = useCapabilities();
  const { status, tokens, error, reload, create, revoke } = useAccessTokens();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);
  const [revokeRefusal, setRevokeRefusal] = useState<string | null>(null);
  const now = new Date();
  const mcpTokens = tokens.filter((token) => token.name.startsWith(MCP_TOKEN_PREFIX));
  const live = mcpTokens.filter((token) => tokenStatus(token, now).kind === 'live');

  async function revokeAll(): Promise<void> {
    setRevokeRefusal(null);
    for (const token of live) {
      const outcome = await revoke(token.id);
      if (outcome.refusal !== null) {
        setRevokeRefusal(outcome.refusal);
        break;
      }
    }
    setRevokingAll(false);
    await reload();
  }

  return (
    <SettingsSection
      title="MCP"
      summary="Let an AI client use your workspaces as you, within a token's scopes"
    >
      <details>
        <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
          More<span className="sr-only"> about MCP access</span>
        </summary>
        <Text variant="note" tone="muted">
          Works with Claude Code, Claude Desktop, Cursor and other clients through the Model Context
          Protocol. Core checks every call the same way it checks you; nothing a client sends can
          widen what the token allows. Programs that are not MCP clients use the{' '}
          <Link to={`${pathname}?tab=api`} className="text-accent-text">
            HTTP API
          </Link>
          .
        </Text>
      </details>

      <div className="flex flex-col gap-2">
        <Text variant="h5" as="h3">
          Remote access
        </Text>
        {mcpUrl === null ? (
          <Text variant="note" tone="muted" role="status">
            This deployment does not serve MCP over the network. Clients on your own computer can
            still connect through the command line, below.
          </Text>
        ) : (
          <>
            <Text variant="note">
              Served at <code className="font-mono text-sm">{mcpUrl}</code>. Each request must carry
              an <code className="font-mono text-sm">Authorization: Bearer</code> header holding a
              personal access token made here.
            </Text>
            <pre className="overflow-x-auto rounded-md border border-divider bg-surface p-3 font-mono text-sm">
              {`claude mcp add --transport http nix ${mcpUrl} --header "Authorization: Bearer <token>"`}
            </pre>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Text variant="h5" as="h3">
          On this computer
        </Text>
        <Text variant="note" tone="muted">
          With nixctl signed in, add it as a stdio server. No token from this page is needed.
        </Text>
        <pre className="overflow-x-auto rounded-md border border-divider bg-surface p-3 font-mono text-sm">
          {`{ "mcpServers": { "nix": { "command": "nixctl", "args": ["mcp"] } } }`}
        </pre>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Text variant="h5" as="h3">
            MCP tokens
          </Text>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setCreateOpen(true);
              }}
            >
              Create MCP token
            </Button>
            <Button
              variant="ghost"
              disabled={live.length === 0}
              onClick={() => {
                setRevokingAll(true);
              }}
            >
              Disable remote access
            </Button>
          </div>
        </div>
        <Text variant="note" tone="muted">
          Revoking a token disables that client immediately.
        </Text>
        <details>
          <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
            More<span className="sr-only"> about MCP tokens</span>
          </summary>
          <Text variant="note" tone="muted">
            Tokens made here are named with the {MCP_TOKEN_PREFIX} prefix so they are listed
            together. All of your tokens, these included, are also under Access tokens.
          </Text>
        </details>
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
        ) : mcpTokens.length === 0 ? (
          <Text variant="note" tone="muted" role="status">
            {status === 'loading' ? 'Loading your tokens…' : 'No MCP tokens yet.'}
          </Text>
        ) : (
          <ul aria-label="MCP tokens" className="flex flex-col divide-y divide-divider">
            {mcpTokens.map((token) => (
              <McpTokenRow
                key={token.id}
                token={token}
                now={now}
                onRevoke={async () => {
                  const outcome = await revoke(token.id);
                  if (outcome.refusal !== null) setRevokeRefusal(outcome.refusal);
                  await reload();
                }}
              />
            ))}
          </ul>
        )}
        {revokeRefusal === null ? null : (
          <Text role="alert" variant="note">
            {revokeRefusal}
          </Text>
        )}
      </div>

      {createOpen ? (
        <AccessTokenCreateDialog
          open
          create={(request) =>
            create({
              ...request,
              name: request.name.startsWith(MCP_TOKEN_PREFIX)
                ? request.name
                : `${MCP_TOKEN_PREFIX}${request.name}`,
            })
          }
          onClose={(createdToken) => {
            setCreateOpen(false);
            if (createdToken) void reload();
          }}
        />
      ) : null}

      {revokingAll ? (
        <Dialog
          open
          title="Disable remote access?"
          onClose={() => {
            setRevokingAll(false);
          }}
          actions={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setRevokingAll(false);
                }}
              >
                Cancel
              </Button>
              <Button onClick={() => void revokeAll()}>
                {`Revoke ${String(live.length)} ${live.length === 1 ? 'token' : 'tokens'}`}
              </Button>
            </>
          }
        >
          <Text as="p">
            Every live MCP token is revoked. Clients using them stop working on their next request;
            the command-line stdio server, which uses your signed-in profile, is unaffected.
          </Text>
        </Dialog>
      ) : null}
    </SettingsSection>
  );
}

function McpTokenRow({
  token,
  now,
  onRevoke,
}: {
  readonly token: AccessToken;
  readonly now: Date;
  readonly onRevoke: () => Promise<void>;
}): ReactElement {
  const state = tokenStatus(token, now).kind;
  return (
    <li className="flex flex-wrap items-center gap-3 py-2 min-h-11">
      <div className="min-w-0 flex-1">
        <Text as="p" variant="bodySmall" className="truncate">
          {token.name}
        </Text>
        <Text as="p" variant="caption" tone="muted">
          {state === 'live'
            ? `Scopes ${token.scopes.join(', ')}, expires ${formatDay(token.expiresAt)}${
                token.lastUsedAt === null
                  ? ', never used'
                  : `, last used ${formatDay(token.lastUsedAt)}`
              }`
            : state === 'revoked'
              ? 'Revoked'
              : 'Expired'}
        </Text>
      </div>
      {state === 'live' ? (
        <Button variant="secondary" onClick={() => void onRevoke()}>
          Revoke
        </Button>
      ) : null}
    </li>
  );
}
