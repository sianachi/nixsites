import type { WorkspaceCalendarLink, CalendarConnection, CalendarLink } from '@nix/api-client';
import { Button, Dialog, Icon, Menu, Select, Table, Text, type MenuEntry } from '@nix/ui';
import { MoreHorizontal } from 'lucide-react';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router';

import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import {
  connectionTag,
  formatMoment,
  linkTag,
  providerName,
  RETURN_NOTICES,
} from './calendar-labels';
import { ConnectionCards, LinkCards, OthersCards } from './calendar-cards';
import { ConfirmDisconnectDialog } from './disconnect-dialog';
import { LinkCalendarDialog } from './link-calendar-dialog';
import { SyncLogDialog } from './sync-log-dialog';
import { UnlinkDialog } from './unlink-dialog';
import { SettingsSection } from '../shared/settings-section';
import { useCalendarSync } from './use-calendar-sync';

/**
 * Calendar sync: the Google and Outlook accounts connected to this account, and the calendars
 * linked into the workspace.
 *
 * **A linked calendar is a container of ordinary items**, one per event. They are edited like any
 * other item and the change goes to the calendar, but they are removed in exactly two ways: at the
 * calendar itself, or by unlinking here. That is why the unlink dialog asks what should become of
 * them rather than deciding: the notes may hold work that the calendar never saw.
 *
 * **Unlinking never touches the external calendar.** Both choices say so, because "move to the
 * trash" next to a calendar's name reads as deleting the meetings.
 */

export function CalendarsSection(): ReactElement {
  const sync = useCalendarSync();
  const narrow = useNarrowViewport();
  const { status, providers, connections, links, othersLinks, error, reload } = sync;
  const location = useLocation();
  const [search, setSearch] = useSearchParams();

  // What the provider's consent screen sent back, read once and then taken out of the address:
  // left there it would be announced again on every reload and every return to this tab.
  // The provider returns with a full page load, so the value at mount is the only one there is.
  const returnStatus = search.get('calendar_status');
  const [returned] = useState<string | null>(() => RETURN_NOTICES[returnStatus ?? ''] ?? null);
  useEffect(() => {
    if (returnStatus === null) {
      return;
    }
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('calendar_status');
        return next;
      },
      { replace: true },
    );
  }, [returnStatus, setSearch]);

  /** The last refusal of a row action, shown above the tables. */
  const [notice, setNotice] = useState<string | null>(null);
  /** What the last row action did, when the tables alone would not show it. */
  const [done, setDone] = useState<string | null>(null);
  /** Whether a row action is in flight, so a second press cannot queue behind the first. */
  const [busy, setBusy] = useState(false);
  /** The link whose change to syncing both ways is waiting to be confirmed. */
  const [widening, setWidening] = useState<CalendarLink | null>(null);
  const [linking, setLinking] = useState<CalendarConnection | null>(null);
  const [unlinking, setUnlinking] = useState<CalendarLink | null>(null);
  const [unlinkingOthers, setUnlinkingOthers] = useState<WorkspaceCalendarLink | null>(null);
  const [disconnecting, setDisconnecting] = useState<CalendarConnection | null>(null);
  const [logFor, setLogFor] = useState<CalendarLink | null>(null);

  async function act(
    run: () => Promise<{ readonly refusal: string | null }>,
    success: string | null = null,
  ): Promise<void> {
    setNotice(null);
    setDone(null);
    setBusy(true);
    try {
      const { refusal } = await run();
      setNotice(refusal);
      setDone(refusal === null ? success : null);
    } finally {
      setBusy(false);
    }
  }

  const connectTo = (provider: string): Promise<{ readonly refusal: string | null }> =>
    sync.connect(provider, `${location.pathname}?tab=integrations`);

  function connectionActions(connection: CalendarConnection): readonly MenuEntry[] {
    return [
      connection.status === 'active'
        ? {
            label: 'Link a calendar',
            disabled: busy,
            onSelect: () => {
              setLinking(connection);
            },
          }
        : {
            label: 'Reconnect',
            disabled: busy,
            onSelect: () => {
              void act(() => connectTo(connection.provider));
            },
          },
      {
        label: 'Disconnect account',
        disabled: busy,
        destructive: true,
        onSelect: () => {
          setDisconnecting(connection);
        },
      },
    ];
  }

  function linkActions(link: CalendarLink): readonly MenuEntry[] {
    const actions: MenuEntry[] = [];
    if (link.status === 'active') {
      actions.push({
        label: 'Sync now',
        disabled: busy,
        onSelect: () => {
          void act(() => sync.sync(link.id), `A sync of ${link.name} has started.`);
        },
      });
    }
    if (link.status === 'active' || link.status === 'paused') {
      actions.push({
        label: link.status === 'active' ? 'Pause syncing' : 'Resume syncing',
        disabled: busy,
        onSelect: () => {
          void act(() =>
            sync.update(link, { status: link.status === 'active' ? 'paused' : 'active' }),
          );
        },
      });
    }
    actions.push(
      {
        label: 'View sync log',
        onSelect: () => {
          setLogFor(link);
        },
      },
      {
        label: 'Unlink calendar',
        disabled: busy,
        destructive: true,
        onSelect: () => {
          setUnlinking(link);
        },
      },
    );
    return actions;
  }

  // Narrowing to import-only is applied at once. Widening sends this workspace's edits to the
  // calendar, so it is confirmed first, with what that means said plainly.
  function changeDirection(link: CalendarLink, direction: string): void {
    if (direction === 'two_way') {
      setWidening(link);
      return;
    }
    void act(() => sync.update(link, { direction }));
  }

  const connectionColumns = [
    {
      key: 'account',
      header: 'Account',
      rowHeader: true,
      cell: (connection: CalendarConnection) => connection.accountEmail,
    },
    {
      key: 'provider',
      header: 'Provider',
      cell: (connection: CalendarConnection) => providerName(connection.provider),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (connection: CalendarConnection) => connectionTag(connection.status),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (connection: CalendarConnection) => (
        <Menu
          label={`Actions for ${connection.accountEmail}`}
          items={connectionActions(connection)}
        >
          {(trigger) => (
            <Button
              {...trigger}
              variant="icon"
              aria-label={`Actions for ${connection.accountEmail}`}
            >
              <Icon icon={MoreHorizontal} size="sm" />
            </Button>
          )}
        </Menu>
      ),
    },
  ] as const;

  const linkColumns = [
    {
      key: 'name',
      header: 'Calendar',
      rowHeader: true,
      cell: (link: CalendarLink) => link.name,
    },
    {
      key: 'provider',
      header: 'Provider',
      cell: (link: CalendarLink) => providerName(link.provider),
    },
    {
      key: 'direction',
      header: 'Direction',
      cell: (link: CalendarLink) => (
        <Select
          aria-label={`Direction of ${link.name}`}
          value={link.direction}
          disabled={busy}
          onChange={(event) => {
            changeDirection(link, event.target.value);
          }}
        >
          <option value="two_way">Both ways</option>
          <option value="import_only">Import only</option>
        </Select>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (link: CalendarLink) => (
        <div className="flex flex-col gap-1">
          {linkTag(link)}
          <Text as="span" variant="note" tone="muted">
            Last synced {formatMoment(link.lastSyncedAt)}
          </Text>
          {link.lastError === null ? null : (
            <Text as="span" variant="note">
              {link.lastError}
            </Text>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (link: CalendarLink) => (
        <Menu label={`Actions for ${link.name}`} items={linkActions(link)}>
          {(trigger) => (
            <Button {...trigger} variant="icon" aria-label={`Actions for ${link.name}`}>
              <Icon icon={MoreHorizontal} size="sm" />
            </Button>
          )}
        </Menu>
      ),
    },
  ] as const;

  return (
    <SettingsSection
      title="Calendars"
      summary="Sync Google or Outlook calendars into this workspace."
    >
      <details>
        <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
          How linked calendars work
        </summary>
        <Text variant="note" tone="muted">
          Each linked calendar becomes an item holding one note per event, and shows on the
          workspace calendar. Events are removed at the calendar or by unlinking here, never from
          the Explorer.
        </Text>
      </details>

      {returned === null ? null : (
        <Text variant="note" role="status">
          {returned}
        </Text>
      )}
      {notice === null ? null : (
        <Text variant="note" role="alert">
          {notice}
        </Text>
      )}
      {done === null ? null : (
        <Text variant="note" role="status">
          {done}
        </Text>
      )}

      {status === 'error' ? (
        <ErrorPanel
          title="Your calendars could not be loaded"
          detail={error ?? 'Something went wrong reading your calendar connections.'}
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
          <div className="flex flex-wrap gap-2">
            {providers.map((entry) => (
              <Button
                key={entry.provider}
                variant="secondary"
                disabled={!entry.available || busy}
                onClick={() => {
                  void act(() => connectTo(entry.provider));
                }}
              >
                Connect {providerName(entry.provider)}
              </Button>
            ))}
          </div>
          {providers.some((entry) => !entry.available) ? (
            <Text variant="note" tone="muted">
              A provider that cannot be chosen has not been set up on this server yet.
            </Text>
          ) : null}

          {narrow ? (
            <ConnectionCards
              loading={status === 'loading'}
              connections={connections}
              actionsFor={connectionActions}
            />
          ) : (
            <ScrollRegion label="Calendar accounts table">
              <Table
                caption="Connected accounts"
                columns={connectionColumns}
                rows={connections}
                rowKey={(connection) => connection.id}
                rowContextMenu={connectionActions}
                rowContextMenuLabel={(connection) => `Actions for ${connection.accountEmail}`}
                loading={status === 'loading'}
                loadingMessage="Loading your connected accounts."
                emptyMessage="No account is connected. Connect one to link its calendars."
              />
            </ScrollRegion>
          )}

          <Text variant="h5" as="h3" className="mt-3">
            Linked calendars
          </Text>
          {narrow ? (
            <LinkCards
              loading={status === 'loading'}
              links={links}
              busy={busy}
              actionsFor={linkActions}
              onDirection={changeDirection}
            />
          ) : (
            <ScrollRegion label="Linked calendars table">
              <Table
                caption="Linked calendars"
                columns={linkColumns}
                rows={links}
                rowKey={(link) => link.id}
                rowContextMenu={linkActions}
                rowContextMenuLabel={(link) => `Actions for ${link.name}`}
                loading={status === 'loading'}
                loadingMessage="Loading your linked calendars."
                emptyMessage="No calendar is linked yet."
              />
            </ScrollRegion>
          )}

          {/* Only drawn when there is something in it: Core fills it for somebody who manages the
              workspace and for nobody else, so an empty heading would promise a power most
              readers do not have. */}
          {othersLinks.length === 0 ? null : (
            <>
              <Text variant="h5" as="h3" className="mt-3">
                Linked by other members
              </Text>
              <Text variant="note" tone="muted">
                You manage this workspace, so you can unlink these.
              </Text>
              {narrow ? (
                <OthersCards entries={othersLinks} onUnlink={setUnlinkingOthers} />
              ) : (
                <ScrollRegion label="Other members' calendars table">
                  <Table
                    caption="Calendars linked by other members"
                    columns={
                      [
                        {
                          key: 'title',
                          header: 'Item',
                          rowHeader: true,
                          cell: (entry: WorkspaceCalendarLink) => entry.title || 'Untitled',
                        },
                        {
                          key: 'actions',
                          header: 'Actions',
                          cell: (entry: WorkspaceCalendarLink) => (
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setUnlinkingOthers(entry);
                              }}
                            >
                              Unlink {entry.title || 'Untitled'}
                            </Button>
                          ),
                        },
                      ] as const
                    }
                    rows={othersLinks}
                    rowKey={(entry) => entry.containerItemId}
                    emptyMessage="No other member has linked a calendar here."
                  />
                </ScrollRegion>
              )}
            </>
          )}
        </>
      )}

      {linking === null ? null : (
        <LinkCalendarDialog
          connection={linking}
          sync={sync}
          onClose={() => {
            setLinking(null);
          }}
        />
      )}

      {widening === null ? null : (
        <Dialog
          open
          title={`Sync ${widening.name} both ways?`}
          onClose={() => {
            setWidening(null);
          }}
          closeLabel="Keep it import only"
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setWidening(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const link = widening;
                  setWidening(null);
                  void act(() => sync.update(link, { direction: 'two_way' }));
                }}
              >
                Sync both ways
              </Button>
            </>
          }
        >
          <Text variant="bodySmall">
            Changes made to these events in the workspace will be sent to the calendar. In a shared
            workspace that includes changes made by anybody who can edit it.
          </Text>
        </Dialog>
      )}

      {unlinking === null ? null : (
        <UnlinkDialog
          name={unlinking.name}
          unlink={(items) => sync.unlink(unlinking.id, items)}
          onClose={() => {
            setUnlinking(null);
          }}
        />
      )}

      {unlinkingOthers === null ? null : (
        <UnlinkDialog
          name={unlinkingOthers.title || 'Untitled'}
          unlink={(items) => sync.unlinkOthers(unlinkingOthers.containerItemId, items)}
          onClose={() => {
            setUnlinkingOthers(null);
          }}
        />
      )}

      {disconnecting === null ? null : (
        <ConfirmDisconnectDialog
          connection={disconnecting}
          sync={sync}
          onClose={() => {
            setDisconnecting(null);
          }}
        />
      )}

      {logFor === null ? null : (
        <SyncLogDialog
          link={logFor}
          sync={sync}
          onClose={() => {
            setLogFor(null);
          }}
        />
      )}
    </SettingsSection>
  );
}

/** A table wider than its column scrolls inside this region, which keyboard users can reach. */
function ScrollRegion(props: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div
      className="min-w-0 overflow-x-auto"
      role="region"
      aria-label={props.label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to scroll table columns horizontally.
      tabIndex={0}
    >
      {props.children}
    </div>
  );
}
