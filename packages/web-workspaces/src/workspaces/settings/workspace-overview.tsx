import { Button, Icon, Input, Menu, Text, type MenuEntry } from '@nix/ui';
import { MoreHorizontal, Pencil } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  formatBytes,
  type Administration,
  type Confirmation,
  type CurrentWorkspace,
} from './shared';

/** The workspace's name (renamed in place), its facts, and a menu for leaving or archiving it. */
export function WorkspaceOverview(props: {
  readonly workspace: CurrentWorkspace;
  readonly administration: Administration;
  readonly onConfirm: (confirmation: Confirmation) => void;
}): ReactNode {
  const { workspace, administration } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const input = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (editing) input.current?.select();
    else if (returnFocus.current) {
      returnFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  function stopEditing(): void {
    returnFocus.current = true;
    setEditing(false);
  }

  // Leaving is open to anyone who may; archiving follows the rename right (owner or administrator).
  const actions: MenuEntry[] = [
    ...(workspace.canLeave
      ? [
          {
            label: 'Leave workspace',
            destructive: true,
            onSelect: () => {
              props.onConfirm({ kind: 'leave' });
            },
          },
        ]
      : []),
    ...(workspace.canRename
      ? [
          {
            label: 'Archive workspace',
            destructive: true,
            onSelect: () => {
              props.onConfirm({ kind: 'archive' });
            },
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {editing ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = name.trim();
              if (next.length === 0 || next === workspace.name) {
                stopEditing();
                return;
              }
              void administration.rename(next).then((saved) => {
                if (saved) stopEditing();
              });
            }}
          >
            <Input
              ref={input}
              aria-label="Workspace name"
              className="min-w-0 flex-1"
              value={name}
              disabled={administration.working}
              onChange={(event) => {
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') stopEditing();
              }}
            />
            <Button type="submit" variant="secondary" disabled={administration.working}>
              Save
            </Button>
          </form>
        ) : (
          <>
            <Text
              id="workspace-management-heading"
              variant="h3"
              as="h2"
              className="min-w-0 break-words"
            >
              {workspace.name}
            </Text>
            {workspace.canRename ? (
              <Button
                ref={editButton}
                variant="icon"
                aria-label="Rename workspace"
                onClick={() => {
                  setName(workspace.name);
                  setEditing(true);
                }}
              >
                <Icon icon={Pencil} size="sm" />
              </Button>
            ) : null}
          </>
        )}
        {actions.length === 0 ? null : (
          <div className="ml-auto">
            <Menu label="Workspace actions" items={actions}>
              {(trigger) => (
                <Button {...trigger} variant="icon" aria-label="Workspace actions">
                  <Icon icon={MoreHorizontal} size="sm" />
                </Button>
              )}
            </Menu>
          </div>
        )}
      </div>
      <Text variant="note" tone="muted">
        {workspace.kind === 'shared' ? 'Shared' : 'Personal'}
        {' · '}
        {workspace.versionRetentionDays} days history
        {' · '}
        {formatBytes(workspace.storageQuotaBytes)}
        {' · '}
        created {new Date(workspace.createdAt).toLocaleDateString()}
      </Text>
    </div>
  );
}
