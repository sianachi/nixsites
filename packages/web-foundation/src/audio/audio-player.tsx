import { Button, Icon, Select, Text } from '@nix/ui';
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type ReactElement } from 'react';

import { readAudioPosition } from '../lib/audio-positions';
import { formatClock } from './clock';
import {
  pause,
  play,
  registerAudioViewer,
  resume,
  retry,
  seek,
  setRate,
  useAudioState,
  type FreshAudioUrl,
} from './audio-store';

/**
 * The player on an audio file's own page.
 *
 * It draws the shared store's state and starts nothing by itself: the first play is a press,
 * because browsers refuse sound nobody asked for and a note app should not make it. Until then it
 * shows the file and, if this device remembers one, where it will resume. Leaving the page does
 * not stop the sound - the store owns the element - and while this player is on screen it says so
 * to the store, which is how the shell's mini player knows to stay out of the way.
 *
 * Skips are asymmetric on purpose, back 15 and forward 30: going back is for the sentence just
 * missed, going forward is for the part not wanted.
 */

const SKIP_BACK_SECONDS = 15;
const SKIP_FORWARD_SECONDS = 30;
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function rateLabel(rate: number): string {
  return `${String(rate)}x`;
}

export function AudioPlayer({
  itemId,
  title,
  resolveUrl,
  onDownload,
}: {
  readonly itemId: string;
  readonly title: string;
  /** Asks for an authorised address; called to start, and again if the address has expired. */
  readonly resolveUrl: FreshAudioUrl;
  readonly onDownload: () => void;
}): ReactElement {
  const state = useAudioState();
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const [remembered] = useState(() => readAudioPosition(itemId));

  useEffect(() => registerAudioViewer(itemId), [itemId]);

  const mine = state.track?.itemId === itemId;
  const loaded = mine && state.duration > 0;
  const failure = startFailed ? 'network' : mine ? state.error : null;
  const currentTime = mine ? state.currentTime : (remembered ?? 0);

  async function start(): Promise<void> {
    if (mine && state.error === null) {
      resume();
      return;
    }
    setStarting(true);
    setStartFailed(false);
    try {
      const url = await resolveUrl();
      play({ itemId, title, url }, resolveUrl);
    } catch {
      setStartFailed(true);
    } finally {
      setStarting(false);
    }
  }

  function toggle(): void {
    if (mine && state.playing) pause();
    else void start();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== ' ' || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    // A button or the speed menu already answers Space itself; the slider and the player's own
    // frame do not, so those are where Space is taken.
    if (target.closest('button, select') !== null) return;
    event.preventDefault();
    toggle();
  }

  const busy = starting || (mine && state.loading && !state.playing);
  const playing = mine && state.playing;

  return (
    // The frame is focusable so Space works once the player has been tabbed to or clicked.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Space toggles playback anywhere inside the player; the controls inside are the real interactive elements.
    <section
      aria-label={`Audio player: ${title}`}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- see above: the frame takes focus so Space has somewhere to land.
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex w-full max-w-prose flex-col gap-4 rounded-md border border-divider bg-surface p-5"
    >
      <Text variant="body" as="p" className="min-w-0 truncate font-semibold">
        {title}
      </Text>

      {failure === null ? null : (
        <div className="flex flex-col gap-2">
          <Text variant="note" as="p" role="alert">
            {failure === 'network'
              ? 'The audio could not be loaded. Check the connection and try again.'
              : 'This browser cannot play this file. Its format may not be supported here.'}
          </Text>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                if (startFailed || !mine) void start();
                else retry();
              }}
            >
              Try again
            </Button>
            <Button variant="secondary" onClick={onDownload}>
              Download
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <input
          type="range"
          aria-label="Seek"
          aria-valuetext={`${formatClock(currentTime)} of ${formatClock(state.duration)}`}
          min={0}
          max={loaded ? state.duration : 0}
          step={1}
          value={loaded ? Math.min(currentTime, state.duration) : 0}
          disabled={!loaded}
          onChange={(event) => {
            seek(Number(event.target.value));
          }}
          className="w-full"
        />
        <div className="flex justify-between">
          <Text as="span" variant="caption" tone="muted">
            {formatClock(currentTime)}
          </Text>
          <Text as="span" variant="caption" tone="muted">
            {loaded ? formatClock(state.duration) : '--:--'}
          </Text>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="icon"
          aria-label={`Back ${String(SKIP_BACK_SECONDS)} seconds`}
          disabled={!loaded}
          onClick={() => {
            seek(state.currentTime - SKIP_BACK_SECONDS);
          }}
        >
          <Icon icon={RotateCcw} size="sm" />
        </Button>
        <Button onClick={toggle} disabled={busy && !playing}>
          <Icon icon={playing ? Pause : Play} size="sm" />
          {playing ? 'Pause' : 'Play'}
        </Button>
        <Button
          variant="icon"
          aria-label={`Forward ${String(SKIP_FORWARD_SECONDS)} seconds`}
          disabled={!loaded}
          onClick={() => {
            seek(state.currentTime + SKIP_FORWARD_SECONDS);
          }}
        >
          <Icon icon={RotateCw} size="sm" />
        </Button>
        <span className="flex-1" />
        <Select
          aria-label="Playback speed"
          value={String(state.rate)}
          onChange={(event) => {
            setRate(Number(event.target.value));
          }}
          className="w-auto"
        >
          {RATES.map((rate) => (
            <option key={rate} value={String(rate)}>
              {rateLabel(rate)}
            </option>
          ))}
        </Select>
      </div>

      <Text variant="note" tone="muted" as="p" role="status">
        {busy
          ? 'Loading…'
          : !mine && remembered !== null
            ? `Resumes at ${formatClock(remembered)}.`
            : ''}
      </Text>
    </section>
  );
}
