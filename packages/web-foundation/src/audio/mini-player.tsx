import { Button, Icon, Text } from '@nix/ui';
import { Pause, Play, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { pause, resume, stop, useAudioState } from './audio-store';

/**
 * The thin bar that keeps a recording in reach while the person is somewhere else.
 *
 * Shown whenever a track is loaded and its own page is not on screen - the full player is better
 * company than this one, so the two never appear together. The title opens the file; closing
 * stops the sound and forgets the track. Failure is not retried here: a player that cannot play
 * says so on the file's page, where the download and the retry are, and offers the way there.
 */
export function MiniPlayer({ onOpen }: { readonly onOpen: (itemId: string) => void }): ReactNode {
  const state = useAudioState();
  const track = state.track;
  if (track === null || state.viewing.includes(track.itemId)) return null;

  const failed = state.error !== null;
  const progress = state.duration > 0 ? Math.min(state.currentTime / state.duration, 1) : 0;

  return (
    <section aria-label="Now playing" className="shrink-0 border-t border-divider bg-surface">
      <div
        role="progressbar"
        aria-label="Playback progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className="h-0.5 w-full bg-divider"
      >
        <div
          className="h-full bg-accent"
          style={{ width: `${String(progress * 100)}%` }} // design-token-exempt: width encodes the playback position, a runtime proportion.
        />
      </div>
      <div className="flex items-center gap-2 px-3 py-1 sm:px-5">
        <Button
          variant="ghost"
          className="min-w-0 flex-1 justify-start px-2 py-1 text-xs"
          onClick={() => {
            onOpen(track.itemId);
          }}
        >
          <span className="min-w-0 truncate">{track.title}</span>
        </Button>
        {failed ? (
          <Text as="span" variant="caption" tone="muted" role="alert" className="whitespace-nowrap">
            Cannot play
          </Text>
        ) : null}
        <Button
          variant="icon"
          aria-label={state.playing ? 'Pause' : 'Play'}
          disabled={failed}
          onClick={() => {
            if (state.playing) pause();
            else resume();
          }}
        >
          <Icon icon={state.playing ? Pause : Play} size="sm" />
        </Button>
        <Button variant="icon" aria-label="Close player" onClick={stop}>
          <Icon icon={X} size="sm" />
        </Button>
      </div>
    </section>
  );
}
