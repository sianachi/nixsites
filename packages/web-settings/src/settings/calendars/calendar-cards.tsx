import type { CalendarConnection, CalendarLink, WorkspaceCalendarLink } from '@nix/api-client';
import { Button, Icon, Menu, Select, Text, type MenuEntry } from '@nix/ui';
import { MoreHorizontal } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { connectionTag, formatMoment, linkTag, providerName } from './calendar-labels';

/**
 * The phone arrangement of the three calendar tables: a table with four or five columns clips at
 * 390px, so each row becomes a card with the same facts and the same actions.
 */

function Cards<T>(props: {
  readonly label: string;
  readonly rows: readonly T[];
  readonly loading: boolean;
  readonly loadingMessage: string;
  readonly emptyMessage: string;
  readonly rowKey: (row: T) => string;
  readonly children: (row: T) => ReactNode;
}): ReactElement {
  if (props.loading) {
    return (
      <Text variant="note" role="status">
        {props.loadingMessage}
      </Text>
    );
  }
  if (props.rows.length === 0) {
    return (
      <Text variant="note" tone="muted">
        {props.emptyMessage}
      </Text>
    );
  }
  return (
    <ul aria-label={props.label} className="flex flex-col gap-2">
      {props.rows.map((row) => (
        <li
          key={props.rowKey(row)}
          className="flex min-w-0 flex-col gap-2 rounded-md border border-divider p-3"
        >
          {props.children(row)}
        </li>
      ))}
    </ul>
  );
}

function ActionsMenu(props: {
  readonly label: string;
  readonly items: readonly MenuEntry[];
}): ReactElement {
  return (
    <Menu label={props.label} items={props.items}>
      {(trigger) => (
        <Button {...trigger} variant="icon" aria-label={props.label}>
          <Icon icon={MoreHorizontal} size="sm" />
        </Button>
      )}
    </Menu>
  );
}

export function ConnectionCards(props: {
  readonly loading: boolean;
  readonly connections: readonly CalendarConnection[];
  readonly actionsFor: (connection: CalendarConnection) => readonly MenuEntry[];
}): ReactElement {
  return (
    <Cards
      label="Connected accounts"
      rows={props.connections}
      loading={props.loading}
      loadingMessage="Loading your connected accounts."
      emptyMessage="No account is connected. Connect one to link its calendars."
      rowKey={(connection) => connection.id}
    >
      {(connection) => (
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <Text variant="bodySmall" as="h4" className="break-all">
              {connection.accountEmail}
            </Text>
            <Text variant="note" tone="muted">
              {providerName(connection.provider)}
            </Text>
            <span>{connectionTag(connection.status)}</span>
          </div>
          <ActionsMenu
            label={`Actions for ${connection.accountEmail}`}
            items={props.actionsFor(connection)}
          />
        </div>
      )}
    </Cards>
  );
}

export function LinkCards(props: {
  readonly loading: boolean;
  readonly links: readonly CalendarLink[];
  readonly busy: boolean;
  readonly actionsFor: (link: CalendarLink) => readonly MenuEntry[];
  readonly onDirection: (link: CalendarLink, direction: string) => void;
}): ReactElement {
  return (
    <Cards
      label="Linked calendars"
      rows={props.links}
      loading={props.loading}
      loadingMessage="Loading your linked calendars."
      emptyMessage="No calendar is linked yet."
      rowKey={(link) => link.id}
    >
      {(link) => (
        <>
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <Text variant="bodySmall" as="h4" className="break-words">
                {link.name}
              </Text>
              <Text variant="note" tone="muted">
                {providerName(link.provider)}
              </Text>
            </div>
            <ActionsMenu label={`Actions for ${link.name}`} items={props.actionsFor(link)} />
          </div>
          <div className="flex flex-col gap-1">
            <span>{linkTag(link)}</span>
            <Text variant="note" tone="muted">
              Last synced {formatMoment(link.lastSyncedAt)}
            </Text>
            {link.lastError === null ? null : <Text variant="note">{link.lastError}</Text>}
          </div>
          <Select
            aria-label={`Direction of ${link.name}`}
            value={link.direction}
            disabled={props.busy}
            onChange={(event) => {
              props.onDirection(link, event.target.value);
            }}
          >
            <option value="two_way">Both ways</option>
            <option value="import_only">Import only</option>
          </Select>
        </>
      )}
    </Cards>
  );
}

export function OthersCards(props: {
  readonly entries: readonly WorkspaceCalendarLink[];
  readonly onUnlink: (entry: WorkspaceCalendarLink) => void;
}): ReactElement {
  return (
    <Cards
      label="Calendars linked by other members"
      rows={props.entries}
      loading={false}
      loadingMessage=""
      emptyMessage="No other member has linked a calendar here."
      rowKey={(entry) => entry.containerItemId}
    >
      {(entry) => (
        <div className="flex min-w-0 items-center justify-between gap-2">
          <Text variant="bodySmall" as="h4" className="min-w-0 break-words">
            {entry.title || 'Untitled'}
          </Text>
          <Button
            variant="ghost"
            onClick={() => {
              props.onUnlink(entry);
            }}
          >
            Unlink {entry.title || 'Untitled'}
          </Button>
        </div>
      )}
    </Cards>
  );
}
