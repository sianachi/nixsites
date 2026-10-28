import { Text } from '@nix/ui';
import { useSyncExternalStore, type ReactNode } from 'react';
import type { Awareness } from 'y-protocols/awareness';

/**
 * Who else is in this document right now.
 *
 * Read from awareness and never from anywhere else: presence is a fact about now, the
 * server broadcasts it and forgets it, and the moment a connection drops the roster
 * shrinks - showing a colleague who already left would be the dishonest version of this
 * component.
 */

export interface PresenceListProps {
  readonly awareness: Awareness;
}

interface Peer {
  readonly clientId: number;
  readonly name: string;
  readonly color: string;
}

/** How many peers are shown before the rest collapse into a count. */
const SHOWN = 4;

function readPeers(awareness: Awareness): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID) {
      continue;
    }
    const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
    if (user === undefined || typeof user.name !== 'string') {
      continue;
    }
    peers.push({
      clientId,
      name: user.name,
      color: typeof user.color === 'string' ? user.color : 'var(--color-accent)',
    });
  }
  return peers.sort((a, b) => a.clientId - b.clientId);
}

export function PresenceList({ awareness }: PresenceListProps): ReactNode {
  const peers = useSyncExternalStore(
    (onChange) => {
      awareness.on('change', onChange);
      return () => {
        awareness.off('change', onChange);
      };
    },
    // Serialised so the store only re-renders when the roster actually changed, not on
    // every cursor twitch - awareness fires for selections too, and a presence list that
    // re-rendered per keystroke of every colleague would be paying for data it ignores.
    () => JSON.stringify(readPeers(awareness)),
  );

  const roster = JSON.parse(peers) as Peer[];
  if (roster.length === 0) {
    return null;
  }

  const shown = roster.slice(0, SHOWN);
  const overflow = roster.length - shown.length;

  return (
    <div
      aria-live="polite"
      aria-label={`${String(roster.length)} ${roster.length === 1 ? 'person' : 'people'} here`}
      className="flex shrink-0 items-center gap-1"
    >
      {shown.map((peer) => (
        <span
          key={peer.clientId}
          role="img"
          title={peer.name}
          aria-label={peer.name}
          style={
            {
              borderColor: peer.color,
            } /* design-token-exempt: the color is this peer's cursor identity, resolved from the accent ramp tokens at runtime; a class cannot vary per collaborator. */
          }
          // A quiet profile: initials on the surface, the cursor colour only as a thin outline.
          className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-surface"
        >
          <Text as="span" variant="caption" tone="muted" aria-hidden="true">
            {initialsOf(peer.name)}
          </Text>
        </span>
      ))}
      {overflow > 0 ? (
        <Text variant="caption" as="span" tone="muted">
          +{overflow}
        </Text>
      ) : null}
    </div>
  );
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return `${first}${last}`.toUpperCase() || '?';
}
