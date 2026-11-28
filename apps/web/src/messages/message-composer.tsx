import { isNixApiError, messages, type MessageAddressee, type Item } from '@nix/api-client';
import { Button, Icon, Input, Text, Textarea, focusRing } from '@nix/ui';
import { AtSign, SendHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

const REFUSALS: Record<string, string> = {
  'messages.invalid':
    'Someone you addressed cannot read this, or the message is empty or too long.',
  'messages.pets_interactive_only': 'Only the app can address a pet.',
  'messages.thread_agent_limit':
    'Agents and pets have written the last 30 messages here. Write a message yourself first.',
  'messages.token_message_limit': 'This token has posted its 500 messages for today.',
  'pets.budget_exhausted': "This month's pet budget is used up. Raise it in Settings > Pets.",
};

const kindLabel = (entry: MessageAddressee): string =>
  entry.kind === 'person' ? entry.name : `${entry.name} (${entry.kind})`;

/** The `@word` the caret is at the end of, when it starts a word: where it starts and what was typed after the @. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const query = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret))?.[2];
  return query === undefined ? null : { start: caret - query.length - 1, query };
}

/**
 * Writes a message under `parentId`. Typing @ at the caret opens a picker of the item's directory
 * (people who can read it, your own pets and agents), filtered as you type: arrows move, Enter or Tab
 * picks, Escape closes. The @ button opens the same list; the picks, not the text, become `to`.
 * Enter sends when no picker is open.
 */
export function MessageComposer({
  workspaceId,
  parentId,
  label = 'Message',
  focusOnMount = false,
  replyTo = [],
  onPosted,
}: {
  readonly workspaceId: string;
  readonly parentId: string;
  readonly label?: string;
  readonly focusOnMount?: boolean;
  /** Who a reply goes to unless removed: the chat's other participants. */
  readonly replyTo?: readonly MessageAddressee[];
  readonly onPosted: (message: Item, addressedPet: boolean) => void;
}): ReactNode {
  const client = useApiClient();
  const [text, setText] = useState('');
  const [to, setTo] = useState<readonly MessageAddressee[]>([]);
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const replying = replyTo.filter((entry) => !dropped.has(entry.id));
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [directory, setDirectory] = useState<readonly MessageAddressee[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusOnMount) input.current?.focus();
  }, [focusOnMount]);

  useEffect(() => {
    if (!picking && mention === null) return;
    const search = (mention ? mention.query : query).trim();
    const controller = new AbortController();
    void client
      .query(messages.directory(parentId, search || undefined), { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setDirectory(result.addressees);
        setActive(0);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [client, parentId, picking, query, mention]);

  async function send(): Promise<void> {
    const body = text.trim();
    if (body === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The chat's participants (unless removed), plus anyone picked and still named in the text.
      const named = [
        ...replying,
        ...to.filter(
          (entry) =>
            body.includes(`@${entry.name}`) && !replying.some((item) => item.id === entry.id),
        ),
      ];
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

  function pick(entry: MessageAddressee): void {
    setTo((current) =>
      current.some((item) => item.id === entry.id) ? current : [...current, entry],
    );
    if (mention === null) {
      setText(
        (current) =>
          `${current}${current === '' || current.endsWith(' ') ? '' : ' '}@${entry.name} `,
      );
      setPicking(false);
      input.current?.focus();
      return;
    }
    // Replace the typed @word with the name, keeping the text after the caret.
    const caret = input.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${entry.name} ${text.slice(caret)}`;
    const place = mention.start + entry.name.length + 2;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(place, place);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (mention !== null && !event.nativeEvent.isComposing) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
      if (directory.length > 0 && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'ArrowDown') setActive((active + 1) % directory.length);
        else if (event.key === 'ArrowUp')
          setActive((active + directory.length - 1) % directory.length);
        else {
          const chosen = directory[active] ?? directory[0];
          if (chosen) pick(chosen);
        }
        return;
      }
    }
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
      {replying.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1" aria-label="Replying to">
          <Text as="span" variant="note" tone="muted">
            To
          </Text>
          {replying.map((entry) => (
            <span
              key={entry.id}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-sm"
            >
              {kindLabel(entry)}
              <button
                type="button"
                className={`rounded-full px-1 text-muted hover:text-foreground ${focusRing}`}
                aria-label={`Don't send to ${entry.name}`}
                onClick={() => {
                  setDropped((current) => new Set([...current, entry.id]));
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
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
          aria-controls="message-mentions"
          aria-activedescendant={
            mention !== null && directory.length > 0
              ? `message-mention-${String(active)}`
              : undefined
          }
          onChange={(event) => {
            setText(event.target.value);
            setMention(mentionAt(event.target.value, event.target.selectionStart));
          }}
          onClick={(event) => {
            setMention(mentionAt(event.currentTarget.value, event.currentTarget.selectionStart));
          }}
          onBlur={() => {
            setMention(null);
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
      {mention !== null ? (
        <ul
          id="message-mentions"
          role="listbox"
          aria-label="Address someone"
          className="m-0 flex max-h-40 list-none flex-col overflow-y-auto rounded-md border border-border p-0"
        >
          {directory.map((entry, index) => (
            <li
              key={`${entry.kind}:${entry.id}`}
              id={`message-mention-${String(index)}`}
              role="option"
              aria-selected={index === active}
              className={`cursor-pointer px-2 py-2 text-sm transition-colors hover:bg-foreground/7 active:bg-foreground/10 ${index === active ? 'bg-foreground/7' : ''}`}
              // Before the textarea blurs, so the pick lands.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(entry);
              }}
            >
              {kindLabel(entry)}
            </li>
          ))}
          {directory.length === 0 ? (
            <li role="presentation">
              <Text variant="note" tone="muted">
                No one found.
              </Text>
            </li>
          ) : null}
        </ul>
      ) : null}
      {picking && mention === null ? (
        <div className="flex flex-col gap-1">
          <Input
            aria-label="Find a person, pet or agent"
            placeholder="Find a person, pet or agent…"
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
                    pick(entry);
                  }}
                >
                  {kindLabel(entry)}
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
