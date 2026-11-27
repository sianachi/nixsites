import { isNixApiError, messages, type MessageAddressee, type Item } from '@nix/api-client';
import { Button, Icon, Input, Text, Textarea, focusRing } from '@nix/ui';
import { AtSign, SendHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

const REFUSALS: Record<string, string> = {
  'messages.invalid':
    'Someone you addressed cannot read this, or the message is empty or too long.',
  'messages.pets_interactive_only': 'Only the app can address a pet.',
  'pets.budget_exhausted': "This month's pet budget is used up. Raise it in Settings > Pets.",
};

/**
 * Writes a message under `parentId`. The @ button picks addressees from the item's directory (people
 * who can read it, and your own pets); the picks, not the text, become `to`. Enter sends.
 */
export function MessageComposer({
  workspaceId,
  parentId,
  label = 'Message',
  focusOnMount = false,
  onPosted,
}: {
  readonly workspaceId: string;
  readonly parentId: string;
  readonly label?: string;
  readonly focusOnMount?: boolean;
  readonly onPosted: (message: Item, addressedPet: boolean) => void;
}): ReactNode {
  const client = useApiClient();
  const [text, setText] = useState('');
  const [to, setTo] = useState<readonly MessageAddressee[]>([]);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [directory, setDirectory] = useState<readonly MessageAddressee[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusOnMount) input.current?.focus();
  }, [focusOnMount]);

  useEffect(() => {
    if (!picking) return;
    const controller = new AbortController();
    void client
      .query(messages.directory(parentId, query.trim() || undefined), { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setDirectory(result.addressees);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [client, parentId, picking, query]);

  async function send(): Promise<void> {
    const body = text.trim();
    if (body === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Only people and pets still named in the text are addressed.
      const named = to.filter((entry) => body.includes(`@${entry.name}`));
      const posted = await client.execute(
        messages.post(workspaceId, parentId, {
          text: body,
          to: named.map(({ id, kind }) => ({ id, kind })),
        }),
      );
      setText('');
      setTo([]);
      onPosted(
        posted.message,
        named.some((entry) => entry.kind === 'pet'),
      );
      input.current?.focus();
    } catch (failure) {
      setError(
        isNixApiError(failure)
          ? (REFUSALS[failure.code] ?? 'The message was not sent.')
          : 'The message was not sent.',
      );
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const touch = typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches;
    if (
      event.key === 'Enter' &&
      !event.nativeEvent.isComposing &&
      (event.ctrlKey || event.metaKey || (!touch && !event.shiftKey))
    ) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-1">
        <Textarea
          ref={input}
          aria-label={label}
          placeholder={`${label}…`}
          value={text}
          maxLength={16000}
          rows={1}
          autoGrow
          resize="none"
          className="max-h-48 min-h-(--control-md) flex-1 py-1.5"
          onKeyDown={onKeyDown}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <Button
          variant="icon"
          aria-label="Address someone"
          title="Address someone"
          aria-expanded={picking}
          onClick={() => {
            setPicking((current) => !current);
          }}
        >
          <Icon icon={AtSign} size="sm" />
        </Button>
        <Button
          variant="icon"
          aria-label="Send"
          title="Send"
          disabled={busy || text.trim() === ''}
          onClick={() => void send()}
        >
          <Icon icon={SendHorizontal} size="sm" />
        </Button>
      </div>
      {picking ? (
        <div className="flex flex-col gap-1">
          <Input
            aria-label="Find a person or pet"
            placeholder="Find a person or pet…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <ul className="m-0 flex max-h-40 list-none flex-col overflow-y-auto p-0">
            {directory.map((entry) => (
              <li key={`${entry.kind}:${entry.id}`}>
                <button
                  type="button"
                  className={`w-full rounded-sm px-2 py-2 text-left text-sm hover:bg-foreground/7 ${focusRing}`}
                  onClick={() => {
                    setTo((current) =>
                      current.some((item) => item.id === entry.id) ? current : [...current, entry],
                    );
                    setText(
                      (current) =>
                        `${current}${current === '' || current.endsWith(' ') ? '' : ' '}@${entry.name} `,
                    );
                    setPicking(false);
                    input.current?.focus();
                  }}
                >
                  {entry.name}
                  {entry.kind === 'pet' ? ' (pet)' : ''}
                </button>
              </li>
            ))}
            {directory.length === 0 ? (
              <li>
                <Text variant="note" tone="muted">
                  No one found.
                </Text>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {error === null ? null : (
        <Text variant="note" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
