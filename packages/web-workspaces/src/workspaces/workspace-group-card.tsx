import type { Workspace } from '@nix/api-client';
import { Button, Icon, Input, Text, focusRing, useFlash } from '@nix/ui';
import { ArrowDown, ArrowUp, GripVertical, Pin, PinOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

/** One workspace under a group: tick, name and pin. Drag it onto another group to file it there. */
export function MemberRow({
  entry,
  pinned,
  placeKey,
  selected,
  disabled,
  onSelect,
  onPin,
  onDragStart,
  onDragEnd,
}: {
  readonly entry: Workspace;
  readonly pinned: boolean;
  /** Changes when the workspace is filed somewhere else, so the row flashes where it landed. */
  readonly placeKey: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: (id: string, on: boolean) => void;
  readonly onPin: (entry: Workspace) => void;
  readonly onDragStart: (id: string) => void;
  readonly onDragEnd: () => void;
}): ReactNode {
  const flash = useFlash(`${String(pinned)}|${placeKey}`);
  return (
    <li
      {...flash}
      draggable={!disabled}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', entry.id);
        onDragStart(entry.id);
      }}
      onDragEnd={onDragEnd}
      className={`group flex min-h-11 items-center gap-1 rounded-md px-1 hover:bg-foreground/5 ${selected ? 'bg-accent/10' : ''} cursor-grab`}
    >
      <Icon
        icon={GripVertical}
        size="sm"
        className="shrink-0 text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
      />
      <label className="flex size-(--control-md) shrink-0 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          className="size-5 cursor-pointer accent-accent"
          aria-label={`Select ${entry.name}`}
          checked={selected}
          onChange={(event) => {
            onSelect(entry.id, event.currentTarget.checked);
          }}
        />
      </label>
      <Text as="span" variant="bodySmall" className="min-w-0 flex-1 truncate">
        {entry.name}
      </Text>
      <Button
        variant="icon"
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${entry.name}`}
        aria-pressed={pinned}
        disabled={disabled}
        onClick={() => {
          onPin(entry);
        }}
      >
        <Icon icon={pinned ? PinOff : Pin} size="sm" />
      </Button>
    </li>
  );
}

/** A group (or the "No group" bucket when `group` is null): its members, and the group's own controls when `manage` is set. */
export function GroupCard({
  group,
  members,
  manage,
  link,
  first,
  last,
  entering,
  editing,
  disabled,
  dropActive,
  onEdit,
  onRename,
  onMove,
  onRemove,
  onDropHere,
  children,
}: {
  readonly group: { readonly id: string; readonly name: string } | null;
  readonly members: number;
  readonly manage: boolean;
  /** Where the group's name leads (the hub); omit on the group's own page. */
  readonly link: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly entering: boolean;
  readonly editing: boolean;
  readonly disabled: boolean;
  readonly dropActive: boolean;
  readonly onEdit: (id: string | null) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly onMove: (id: string, by: -1 | 1) => void;
  readonly onRemove: (id: string) => void;
  readonly onDropHere: (groupId: string | null) => void;
  readonly children: ReactNode;
}): ReactNode {
  const name = group?.name ?? 'No group';
  const flash = useFlash(name + String(members));
  const [over, setOver] = useState(false);
  const headingId = `workspace-group-card-${group?.id ?? 'none'}`;
  const commit = (value: string): void => {
    const next = value.trim();
    if (group !== null && next.length > 0 && next !== group.name) onRename(group.id, next);
    else onEdit(null);
  };
  return (
    <section
      {...flash}
      aria-labelledby={headingId}
      data-enter={entering ? '' : undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onDropHere(group?.id ?? null);
      }}
      className={`flex flex-col gap-1 rounded-lg border p-2 ${group === null ? 'border-dashed' : ''} ${over && dropActive ? 'border-accent bg-accent/10' : 'border-divider'}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Text
          as="h3"
          variant="h4"
          id={headingId}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          {editing && group !== null ? (
            <Input
              aria-label={`Name of group ${group.name}`}
              defaultValue={group.name}
              maxLength={80}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the field only appears when the person asks to rename, so focus belongs in it.
              autoFocus
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              onBlur={(event) => {
                commit(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit(event.currentTarget.value);
                if (event.key === 'Escape') onEdit(null);
              }}
            />
          ) : link && group !== null ? (
            <Link
              className={`truncate text-accent-text underline ${focusRing}`}
              to={`/workspaces/groups/${group.id}`}
            >
              {name}
            </Link>
          ) : (
            <span className="truncate">{name}</span>
          )}
          <Text as="span" variant="note" tone="muted" title={`${String(members)} workspaces`}>
            {members}
          </Text>
        </Text>
        {manage && group !== null ? (
          <div className="flex flex-wrap items-center">
            <Button
              variant="icon"
              aria-label={`Move ${name} up`}
              disabled={disabled || first}
              onClick={() => {
                onMove(group.id, -1);
              }}
            >
              <Icon icon={ArrowUp} size="sm" />
            </Button>
            <Button
              variant="icon"
              aria-label={`Move ${name} down`}
              disabled={disabled || last}
              onClick={() => {
                onMove(group.id, 1);
              }}
            >
              <Icon icon={ArrowDown} size="sm" />
            </Button>
            <Button
              variant="subtle"
              aria-label={`Rename group ${name}`}
              disabled={disabled}
              onClick={() => {
                onEdit(group.id);
              }}
            >
              Rename
            </Button>
            <Button
              variant="subtle"
              aria-label={`Remove group ${name}`}
              disabled={disabled}
              onClick={() => {
                onRemove(group.id);
              }}
            >
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {members === 0 ? (
        <Text
          variant="note"
          tone="muted"
          className="rounded-md border border-dashed border-divider p-2"
        >
          {group === null
            ? 'Every workspace is in a group.'
            : 'Empty. Drag workspaces here, or tick some and choose this group above.'}
        </Text>
      ) : (
        <ul aria-label={`Workspaces in ${name}`} className="flex flex-col">
          {children}
        </ul>
      )}
    </section>
  );
}
