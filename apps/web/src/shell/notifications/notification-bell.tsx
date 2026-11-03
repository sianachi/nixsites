import { Icon, focusRing } from '@nix/ui';
import { Bell } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';

export interface NotificationBellProps {
  readonly unread: number;
  readonly onClick: () => void;
}

/**
 * The inbox's entry point in the header, between Search and the profile menu: a bell with an
 * unread badge that is honest in both modalities at once - a token-backed dot for a sighted
 * glance, and the count itself folded into the accessible name so a screen reader announces
 * "Notifications, 3 unread" rather than just "Notifications".
 */
export const NotificationBell = forwardRef<HTMLButtonElement, NotificationBellProps>(
  function NotificationBell({ unread, onClick }, ref): ReactNode {
    const hasUnread = unread > 0;
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-haspopup="dialog"
        aria-label={hasUnread ? `Notifications, ${String(unread)} unread` : 'Notifications'}
        className={`relative flex size-(--rail-control) shrink-0 items-center justify-center rounded-md text-muted max-sm:min-h-(--control-lg) max-sm:min-w-(--control-lg) hover:bg-foreground/7 hover:text-foreground ${focusRing}`}
      >
        <Icon icon={Bell} size="md" />
        {hasUnread ? (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 size-2 rounded-full bg-accent-fill"
          />
        ) : null}
      </button>
    );
  },
);
