import { Button, Checkbox, Icon, Input, Text } from '@nix/ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

/** The workspaces a chat may read: a summary button that opens a searchable checklist. */
export function ChatSources({
  active,
  sources,
  loading,
  onChange,
}: {
  readonly active: readonly { readonly id: string; readonly name: string }[];
  readonly sources: readonly string[];
  readonly loading: boolean;
  readonly onChange: (sources: readonly string[]) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const panelId = useId();
  const selected = active.filter((entry) => sources.includes(entry.id));
  const summary =
    selected.length === 0
      ? 'Choose workspaces'
      : selected.length === 1
        ? selected[0]?.name
        : `${String(selected.length)} workspaces`;
  const unavailable = sources.filter((id) => !active.some((entry) => entry.id === id));
  const filtered = active.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()),
  );
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="secondary"
        className="justify-between"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Text as="span" variant="bodySmall" className="truncate">
          Sources: {loading ? 'Loading…' : summary}
        </Text>
        <Icon icon={open ? ChevronUp : ChevronDown} />
      </Button>
      {open ? (
        <div id={panelId} className="flex flex-col gap-2 rounded border border-divider p-3">
          <Input
            type="search"
            aria-label="Find a source workspace"
            placeholder="Find a workspace…"
            value={search}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
            }}
          />
          <fieldset
            aria-label="Source workspaces"
            className="flex max-h-40 flex-col gap-1 overflow-y-auto"
          >
            {filtered.map((entry) => (
              <Checkbox
                key={entry.id}
                label={entry.name}
                checked={sources.includes(entry.id)}
                onChange={(event) => {
                  onChange(
                    event.currentTarget.checked
                      ? [...sources, entry.id]
                      : sources.filter((id) => id !== entry.id),
                  );
                }}
              />
            ))}
            {!filtered.length ? <Text variant="note">No matching workspaces.</Text> : null}
          </fieldset>
        </div>
      ) : null}
      {unavailable.length > 0 && !loading ? (
        <div>
          <Text role="alert">Some source workspaces are no longer available.</Text>
          <Button
            variant="ghost"
            onClick={() => {
              onChange(selected.map((entry) => entry.id));
            }}
          >
            Remove unavailable sources
          </Button>
        </div>
      ) : null}
      <Text variant="note" tone="muted">
        Your pet can read these workspaces, without changing their notes.
      </Text>
    </div>
  );
}
