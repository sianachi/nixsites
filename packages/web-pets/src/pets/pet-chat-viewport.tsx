import { Button, Icon, focusRing } from '@nix/ui';
import { ArrowDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

/** One scroll surface: responses and their approvals stay together above the composer. */
export function PetChatViewport({
  latestKey,
  quiet = false,
  children,
}: {
  readonly latestKey: string;
  /** The conversation has its own announcer, so the log itself stays silent. */
  readonly quiet?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const viewport = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const lastLatest = useRef<Element | null>(null);
  const [unread, setUnread] = useState(false);

  function showLatest() {
    const node = viewport.current;
    const latest = node?.querySelector('[data-pet-latest-message]');
    if (!node) return;
    // Start at the beginning of a long reply, not its last line. Never scroll the workspace.
    node.scrollTop = latest
      ? node.scrollTop + latest.getBoundingClientRect().top - node.getBoundingClientRect().top
      : node.scrollHeight;
    following.current = true;
    setUnread(false);
  }

  useLayoutEffect(() => {
    const latest = viewport.current?.querySelector('[data-pet-latest-message]') ?? null;
    // Your own message always scrolls into view, even from further up the chat.
    const ownSend =
      latest !== null && latest !== lastLatest.current && latest.hasAttribute('data-pet-from-user');
    lastLatest.current = latest;
    if (following.current || ownSend) showLatest();
    else setUnread(true);
  }, [latestKey]);

  return (
    <div className="relative mx-auto flex min-h-0 min-w-0 w-full max-w-2xl flex-1 flex-col">
      <div
        ref={viewport}
        role="log"
        aria-label="Conversation messages"
        aria-live={quiet ? 'off' : 'polite'}
        // Scrollable conversation content must be reachable for keyboard scrolling.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className={`flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-3 @sm:gap-5 @sm:p-4 ${focusRing}`}
        onScroll={(event) => {
          const node = event.currentTarget;
          // Following means at the bottom, or reading the latest reply from its top: the scroll
          // that showLatest itself causes lands on a tall reply's top, not at the bottom.
          const box = node.getBoundingClientRect();
          const top = node.querySelector('[data-pet-latest-message]')?.getBoundingClientRect().top;
          following.current =
            node.scrollHeight - node.scrollTop - node.clientHeight <= 48 ||
            (top !== undefined && top >= box.top - 1 && top < box.bottom);
          if (following.current) setUnread(false);
        }}
      >
        {children}
      </div>
      {unread ? (
        // An overlay, so it never takes a row from the log.
        <Button
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
          aria-label="Show latest reply"
          onClick={showLatest}
        >
          <Icon icon={ArrowDown} size="sm" />
          Latest
        </Button>
      ) : null}
    </div>
  );
}
