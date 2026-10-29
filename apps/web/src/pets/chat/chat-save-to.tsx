import { Button, Field, Select, Text } from '@nix/ui';
import { useId, useState, type ReactNode } from 'react';
import { ChatDestination } from './chat-destination';

interface Workspace {
  readonly id: string;
  readonly name: string;
}

/** Where the chat note is saved: the current choice, and a panel to change it. */
export function ChatSaveTo({
  active,
  current,
  destination,
  workspaceId,
  parentId,
  parentTitle,
  onWorkspace,
  onParent,
}: {
  readonly active: readonly Workspace[];
  readonly current: Workspace | undefined;
  readonly destination: Workspace | undefined;
  readonly workspaceId: string;
  readonly parentId: string | null;
  /** The parent note's title, or null while it is still being checked. */
  readonly parentTitle: string | null;
  readonly onWorkspace: (id: string) => void;
  readonly onParent: (id: string | null) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Text variant="kicker">Save to</Text>
          <Text variant="bodySmall" className="break-words">
            {parentId ? `${parentTitle ?? 'Checking destination…'} · ` : ''}
            {destination?.name ?? 'Choose a workspace'}
            {current?.id === workspaceId && !parentId ? ' (this workspace)' : ''}
          </Text>
        </div>
        <Button
          variant="ghost"
          className="shrink-0"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? 'Done' : 'Somewhere else…'}
        </Button>
      </div>
      {open ? (
        <div id={panelId} className="flex flex-col gap-3 rounded border border-divider p-3">
          <Field label="Destination workspace">
            {(control) => (
              <Select
                {...control}
                value={workspaceId}
                onChange={(event) => {
                  onWorkspace(event.currentTarget.value);
                }}
              >
                <option value="">Choose where to save</option>
                {active.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {workspaceId ? (
            <ChatDestination
              workspaceId={workspaceId}
              parentId={parentId}
              onChange={(id) => {
                onParent(id);
              }}
            />
          ) : null}
          {current && (workspaceId !== current.id || parentId !== null) ? (
            <Button
              variant="ghost"
              onClick={() => {
                onWorkspace(current.id);
              }}
            >
              Use this workspace
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
