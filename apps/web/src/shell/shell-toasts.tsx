import { Toast } from '@nix/ui';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { useState, type ReactNode, type RefObject } from 'react';

export interface ShellToast {
  readonly key: string;
  readonly message: string;
  readonly action?: { readonly label: string; readonly onAction: () => void };
  readonly autoFocus?: false;
  /** A reminder: stays until acted on or dismissed, and collapses with its siblings. */
  readonly persistent?: true;
}

const MAX_SHELL_TOASTS = 2;

export interface ShellToastController {
  readonly toasts: readonly ShellToast[];
  readonly push: (toast: ShellToast) => void;
  readonly dismiss: (key: string) => void;
}

/** Holds the bounded undo/notices queue owned by the shell. */
export function useShellToasts(): ShellToastController {
  const [toasts, setToasts] = useState<readonly ShellToast[]>([]);

  function push(toast: ShellToast): void {
    setToasts((current) => {
      const next = [...current.filter((existing) => existing.key !== toast.key), toast];
      // Only routine notices are capped: a reminder dropped to make room would be one never seen.
      const routine = next.filter((t) => t.persistent !== true);
      const drop = new Set(routine.slice(0, Math.max(0, routine.length - MAX_SHELL_TOASTS)));
      return next.filter((t) => !drop.has(t));
    });
  }

  function dismiss(key: string): void {
    setToasts((current) => current.filter((toast) => toast.key !== key));
  }

  return { toasts, push, dismiss };
}

export function ShellToasts({
  toasts,
  treeRegionRef,
  onDismiss,
  onViewReminders,
}: {
  readonly toasts: readonly ShellToast[];
  readonly treeRegionRef: RefObject<HTMLDivElement | null>;
  readonly onDismiss: (key: string) => void;
  readonly onViewReminders: () => void;
}): ReactNode {
  const narrow = useNarrowViewport();
  if (toasts.length === 0) {
    return null;
  }

  // One visible on a phone, two elsewhere; reminders beyond that collapse into one summary.
  const limit = narrow ? 1 : 2;
  const reminders = toasts.filter((toast) => toast.persistent === true);
  const routine = toasts.filter((toast) => toast.persistent !== true);
  const reminderItems: readonly ShellToast[] =
    reminders.length > limit
      ? [
          {
            key: 'reminders-summary',
            message: `${String(reminders.length)} reminders`,
            action: { label: 'View', onAction: onViewReminders },
            autoFocus: false,
            persistent: true,
          },
        ]
      : reminders;
  const visible = [...routine, ...reminderItems].slice(0, limit);

  return (
    // Above the bottom nav (measured by the shell; unset when there is none), never over it. The
    // padded frame lets taps through to the page; only the toasts themselves take them.
    <div className="pointer-events-none fixed inset-x-0 bottom-[var(--mobile-nav-height,0%)] z-[25] mx-auto flex max-w-sm flex-col gap-2 p-4 *:pointer-events-auto sm:inset-x-auto sm:left-0 sm:right-auto">
      {visible.map((toast) => (
        <Toast
          key={toast.key}
          message={toast.message}
          // Omit optional props when absent so exactOptionalPropertyTypes preserves Toast's defaults.
          {...(toast.action === undefined ? {} : { action: toast.action })}
          {...(toast.autoFocus === false ? { autoFocus: false } : {})}
          {...(toast.persistent === true ? { persistent: true } : {})}
          onDismiss={() => {
            if (toast.key === 'reminders-summary') {
              for (const reminder of reminders) {
                onDismiss(reminder.key);
              }
              return;
            }
            onDismiss(toast.key);
          }}
          returnFocusRef={treeRegionRef}
        />
      ))}
    </div>
  );
}
