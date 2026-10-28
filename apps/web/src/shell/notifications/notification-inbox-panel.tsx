import { type NotificationDto } from '@nix/api-client';
import { Button, Dialog, Text } from '@nix/ui';
import type { ReactElement } from 'react';

import { formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import type { NotificationsInboxState } from './use-notifications-inbox';

export interface NotificationInboxPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly inbox: NotificationsInboxState;
  /** Opens the item a notification points at, in the caller's own way of opening one. */
  readonly onOpenItem: (itemId: string) => void;
  /** Opens a workspace; an invitation's workspace shows only its Accept and Decline. */
  readonly onOpenWorkspace?: (workspaceId: string) => void;
}

/** The notification inbox: what the bell (header) and the Inbox destination (mobile nav) both
 * open. A `<Dialog>` rather than a positioned popover - see the shell header's own note on why -
 * so it gets a full-screen sheet on a phone for free and the same modal keyboard and focus
 * handling every other dialog in the app already has. */
export function NotificationInboxPanel({
  open,
  onClose,
  inbox,
  onOpenItem,
  onOpenWorkspace,
}: NotificationInboxPanelProps): ReactElement {
  // `title` and `body` below are untrusted plain text - a reminder source or an automation's
  // `notify` action can put anything in them - and are rendered as JSX text content only, never
  // through `dangerouslySetInnerHTML` or a Markdown renderer. Likewise, opening a notification
  // never parses a destination out of that text: it navigates only through `notification.itemId`
  // (a UUID Core issued), the same contract `notification.data.url`'s same-origin check in
  // `public/service-worker.js` enforces for a push notification's own click.
  function openNotification(notification: NotificationDto): void {
    if (notification.readAt === null) inbox.markRead(notification.id);
    if (notification.itemId !== null) {
      onOpenItem(notification.itemId);
      onClose();
    } else if (
      notification.kind === 'invitation' &&
      notification.workspaceId !== null &&
      onOpenWorkspace !== undefined
    ) {
      onOpenWorkspace(notification.workspaceId);
      onClose();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Notifications"
      actions={
        inbox.unread > 0 ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              inbox.markAllRead();
            }}
          >
            Mark all read
          </Button>
        ) : undefined
      }
    >
      {inbox.loading && inbox.items.length === 0 ? (
        <Text role="status">Loading notifications…</Text>
      ) : null}
      {inbox.error !== null ? (
        <div className="flex flex-col gap-2">
          <Text role="alert">{inbox.error}</Text>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              inbox.reload();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {!inbox.loading && inbox.error === null && inbox.items.length === 0 ? (
        <Text variant="note" tone="muted">
          No notifications yet. Reminders and other notices will show up here.
        </Text>
      ) : null}
      {inbox.items.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {inbox.items.map((notification) => {
            const unread = notification.readAt === null;
            return (
              <li key={notification.id}>
                <button
                  type="button"
                  onClick={() => {
                    openNotification(notification);
                  }}
                  className={`flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left hover:bg-foreground/7 ${unread ? 'bg-surface' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <Text variant="bodySmall" className="min-w-0 flex-1">
                      {notification.title}
                    </Text>
                    {unread ? (
                      <span
                        aria-hidden="true"
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent-fill"
                      />
                    ) : null}
                  </div>
                  {notification.body.length > 0 ? (
                    <Text variant="note" tone="muted" className="line-clamp-2">
                      {notification.body}
                    </Text>
                  ) : null}
                  <Text variant="caption" tone="muted">
                    {formatRelativeTime(new Date(notification.createdAt))}
                  </Text>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {inbox.hasMore ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={inbox.loadingMore}
            onClick={() => {
              inbox.loadMore();
            }}
          >
            {inbox.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}
