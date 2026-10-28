import { Dialog, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { formatShortcut } from '../lib/shortcuts';
import { SHORTCUTS, type ShortcutEntry } from './shortcut-registry';

/** A heading id per group, for the section that names itself by it. */
function headingId(group: string): string {
  return `shortcut-group-${group.toLowerCase().replaceAll(' ', '-')}`;
}

const GROUPS: readonly ShortcutEntry['group'][] = [
  'General',
  'Editor',
  'Views',
  'Outline',
  'Panes and tabs',
  'Explorer',
];

/**
 * The keyboard shortcut sheet: every chord the application answers to, written the way this
 * platform writes them, grouped by where they apply. Opened with the platform's command key and
 * slash, or `?` anywhere that is not a text field, and from the command palette.
 *
 * A description list per group - term, then its keys - so a screen reader reads each shortcut as
 * a name and its value rather than as cells of a table without headers.
 */
export function KeyboardShortcutsDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  return (
    <Dialog open={props.open} onClose={props.onClose} title="Keyboard shortcuts">
      <div className="flex flex-col gap-5">
        {GROUPS.map((group) => (
          <section key={group} aria-labelledby={headingId(group)} className="flex flex-col gap-2">
            <Text as="h3" id={headingId(group)} variant="kicker" tone="muted">
              {group}
            </Text>
            <dl className="flex flex-col gap-1.5">
              {SHORTCUTS.filter((entry) => entry.group === group).map((entry) => (
                <div key={entry.label} className="flex items-baseline justify-between gap-4">
                  <Text as="dt" variant="bodySmall">
                    {entry.label}
                  </Text>
                  <dd className="flex shrink-0 gap-1.5">
                    {entry.keys.map((keys) => (
                      <kbd
                        key={formatShortcut(keys)}
                        className="rounded-sm bg-surface px-1.5 font-body text-xs text-muted"
                      >
                        {formatShortcut(keys)}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
