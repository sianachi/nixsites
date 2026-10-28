import { pets, type PetConnection, type PetMessage, type NixClient } from '@nix/api-client';
import { Button, Icon, Input, Text } from '@nix/ui';
import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { isAborted } from '@nix/web-foundation/lib/guards';

export function exportPetMessages(messages: readonly PetMessage[], name: string): void {
  const text = messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role === 'user' ? 'You' : name}\n\n${message.text}`)
    .join('\n\n---\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'nix-companion-conversation.md';
  link.click();
  URL.revokeObjectURL(url);
}

/** The title a conversation may be given: the same bounds Core and the worker enforce. */
function validTitle(value: string): boolean {
  const title = value.trim();
  return title.length > 0 && title.length <= 120 && !/\p{Cc}/u.test(title);
}

/** One line to rename a conversation: Enter saves, Escape cancels. Escape is kept from reaching the
 * conversation behind it, which would otherwise treat it as "back out of this panel". */
export function TitleEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  readonly initial: string;
  readonly busy: boolean;
  readonly onSave: (title: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Input
        ref={field}
        aria-label="Conversation title"
        value={value}
        maxLength={120}
        disabled={busy}
        className="min-w-0 flex-1"
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && validTitle(value)) {
            event.preventDefault();
            onSave(value.trim());
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <Button
        variant="secondary"
        disabled={busy || !validTitle(value)}
        onClick={() => {
          onSave(value.trim());
        }}
      >
        Save title
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export function PetHistory({
  workspaceId,
  petId,
  name,
  client,
  rootItemId,
  running = false,
  onResumed,
}: {
  readonly workspaceId: string;
  readonly petId: string;
  readonly name: string;
  readonly client: Pick<NixClient, 'execute'>;
  readonly rootItemId?: string | undefined;
  /** A turn is running in the live conversation: it cannot be swapped out until it stops. */
  readonly running?: boolean;
  /** Called with the worker's answer once an archive has become the live conversation. */
  readonly onResumed?: (connection: PetConnection) => void;
}): ReactElement {
  const [history, setHistory] = useState<NonNullable<PetConnection['history']>>([]);
  const [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<PetMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState('');
  const [renamingId, setRenamingId] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  async function load(
    operation: 'history' | 'read_history' | 'delete_history' | 'rename' | 'resume_history',
    historyId = '',
    text = '',
  ) {
    setBusy(true);
    setError('');
    try {
      const signal = lifetime.current?.signal;
      if (!signal || signal.aborted) return;
      const result = await client.execute(
        pets.runtime({
          operation,
          workspaceId,
          petId,
          ...(rootItemId ? { rootItemId } : {}),
          ...(historyId ? { historyId } : {}),
          ...(text ? { text } : {}),
        }),
        { signal },
      );
      if (isAborted(signal)) return;
      if (operation === 'resume_history') {
        onResumed?.(result);
      } else if (operation === 'read_history') {
        setMessages(result.messages ?? []);
      } else if (operation === 'rename') {
        setHistory(result.history ?? []);
        setRenamingId('');
      } else {
        setHistory(result.history ?? []);
        setLoaded(true);
        setMessages([]);
        setSelected('');
        setConfirmId('');
        setRenamingId('');
      }
    } catch {
      setError('History could not be loaded or changed. Try again.');
    } finally {
      setBusy(false);
    }
  }
  // The list is the point of this panel, so it loads on open rather than behind a button.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    queueMicrotask(() => void load('history'));
    return () => {
      controller.abort();
    };
    // Once per mount: the parent remounts this panel when the conversation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? history.filter((entry) => entry.title.toLowerCase().includes(needle))
    : history;
  return (
    <section aria-label="Companion history" className="flex min-w-0 flex-col gap-2">
      {!loaded && !error ? <Text role="status">Loading conversations…</Text> : null}
      {loaded ? (
        <>
          {history.length ? (
            <Input
              type="search"
              aria-label="Search saved conversations"
              placeholder="Search by title"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
            />
          ) : null}
          {shown.length ? (
            <ul aria-label="Saved conversations" className="flex min-w-0 flex-col">
              {shown.map((entry) => {
                const title = entry.title || 'Untitled conversation';
                const open = entry.id === selected;
                return (
                  <li key={entry.id} className="min-w-0 border-b border-divider py-1">
                    {renamingId === entry.id ? (
                      <TitleEditor
                        initial={entry.title}
                        busy={busy}
                        onSave={(next) => {
                          void load('rename', entry.id, next);
                        }}
                        onCancel={() => {
                          setRenamingId('');
                        }}
                      />
                    ) : (
                      <div className="flex min-w-0 items-center">
                        <Button
                          variant="ghost"
                          aria-expanded={open}
                          disabled={busy}
                          className="h-auto min-h-(--control-md) min-w-0 flex-1 flex-col items-start justify-center gap-0 py-1 text-left any-pointer-coarse:min-h-(--control-lg)"
                          onClick={() => {
                            setSelected(open ? '' : entry.id);
                            setMessages([]);
                            setConfirmId('');
                            if (!open) void load('read_history', entry.id);
                          }}
                        >
                          <Text as="span" variant="bodySmall" className="w-full truncate">
                            {title}
                          </Text>
                          <Text as="span" variant="caption" tone="muted">
                            {new Date(entry.createdAt).toLocaleDateString()}
                          </Text>
                        </Button>
                        <RowAction
                          label={`Rename ${title}`}
                          icon={Pencil}
                          disabled={busy}
                          onClick={() => {
                            setRenamingId(entry.id);
                            setConfirmId('');
                          }}
                        />
                        <RowAction
                          label={`Remove ${title}`}
                          icon={Trash2}
                          disabled={busy}
                          onClick={() => {
                            setConfirmId(entry.id);
                          }}
                        />
                      </div>
                    )}
                    {confirmId === entry.id ? (
                      <div className="flex flex-col gap-2 py-2">
                        <Text variant="note">
                          Permanently delete this saved Nix conversation? This cannot be undone. It
                          does not delete provider-side records.
                        </Text>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            aria-label="Delete saved conversation permanently"
                            disabled={busy}
                            onClick={() => {
                              void load('delete_history', entry.id);
                            }}
                          >
                            Delete permanently
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setConfirmId('');
                            }}
                          >
                            Keep conversation
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {open ? (
                      <div className="flex min-w-0 flex-col gap-2 py-2">
                        {messages.length ? (
                          <div className="flex min-w-0 max-h-60 flex-col gap-2 overflow-y-auto overscroll-contain">
                            {messages.map((message) => (
                              <Text
                                key={message.id}
                                variant="note"
                                className="whitespace-pre-wrap wrap-anywhere"
                              >
                                {message.role === 'system'
                                  ? message.text
                                  : `${message.role === 'user' ? 'You' : name}: ${message.text}`}
                              </Text>
                            ))}
                          </div>
                        ) : busy ? (
                          <Text role="status" variant="note" tone="muted">
                            Loading messages…
                          </Text>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            aria-label="Continue this conversation"
                            disabled={busy || running}
                            onClick={() => {
                              void load('resume_history', entry.id);
                            }}
                          >
                            Continue
                          </Button>
                          {messages.length ? (
                            <Button
                              variant="ghost"
                              aria-label="Export saved conversation"
                              onClick={() => {
                                exportPetMessages(messages, name);
                              }}
                            >
                              Export
                            </Button>
                          ) : null}
                        </div>
                        <Text variant="note" tone="muted">
                          {running
                            ? 'Stop the running turn to continue another conversation.'
                            : 'Your current conversation is saved to history.'}
                        </Text>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Text variant="note" tone="muted">
              {history.length
                ? 'No conversation matches that title.'
                : `No earlier conversations. Starting a new one saves the current one here, up to 32 ${rootItemId ? 'about this note' : 'in this workspace'}.`}
            </Text>
          )}
        </>
      ) : null}
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <Text role="alert">{error}</Text>
          {!loaded ? (
            <Button
              variant="secondary"
              onClick={() => {
                void load('history');
              }}
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RowAction({
  label,
  icon,
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly icon: typeof Pencil;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      className="w-(--control-md) shrink-0 px-0 any-pointer-coarse:w-(--control-lg)"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon icon={icon} size="sm" />
    </Button>
  );
}
