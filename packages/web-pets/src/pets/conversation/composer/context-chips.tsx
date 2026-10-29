import { Button, Icon, Text } from '@nix/ui';
import { X } from 'lucide-react';
import { type ReactElement } from 'react';
import { type SharedContext } from '../state/use-message-context';

const chipClass =
  'flex min-w-0 max-w-64 shrink-0 items-center gap-1 rounded border border-divider bg-surface py-0.5 pl-3 pr-1';

/** What goes with the message, in one row that scrolls sideways on a narrow screen. */
export function ContextChips({
  chips,
  onRemove,
  workspace,
}: {
  readonly chips: readonly SharedContext[];
  readonly onRemove: (context: SharedContext) => void;
  /** Present while the pet may use the workspace; removing it turns that off. */
  readonly workspace: { readonly disabled: boolean; readonly onRemove: () => void } | undefined;
}): ReactElement | null {
  if (chips.length === 0 && !workspace) return null;
  return (
    <ul
      aria-label="Notes sent with your message"
      className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto"
    >
      {workspace ? (
        <li className={chipClass}>
          <Text variant="note" className="truncate">
            Workspace
          </Text>
          <Button
            variant="icon"
            aria-label="Remove Workspace"
            disabled={workspace.disabled}
            onClick={workspace.onRemove}
          >
            <Icon icon={X} size="sm" />
          </Button>
        </li>
      ) : null}
      {chips.map((context) => (
        <li key={`${context.itemId}:${context.sharedText}`} className={chipClass}>
          <Text variant="note" className="truncate">
            {context.label}
          </Text>
          <Button
            variant="icon"
            aria-label={`Remove ${context.label}`}
            onClick={() => {
              onRemove(context);
            }}
          >
            <Icon icon={X} size="sm" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
