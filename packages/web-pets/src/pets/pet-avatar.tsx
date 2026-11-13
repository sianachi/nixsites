import { Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PetProfile } from '@nix/api-client';
import atlas from './owl-atlas.json';
import eyeOfRaAtlas from './eye-of-ra-atlas.json';
import demiurgeAtlas from './demiurge-atlas.json';
import foxAtlas from './fox-atlas.json';
import nekoAtlas from './neko-atlas.json';
import octopusAtlas from './octopus-atlas.json';
import axolotlAtlas from './axolotl-atlas.json';
import mothAtlas from './moth-atlas.json';
import pangolinAtlas from './pangolin-atlas.json';
import phoenixChickAtlas from './phoenix-chick-atlas.json';
import mushroomSpriteAtlas from './mushroom-sprite-atlas.json';

export const petAtlases = {
  'eye-of-ra': eyeOfRaAtlas,
  demiurge: demiurgeAtlas,
  fox: foxAtlas,
  cat: nekoAtlas,
  octopus: octopusAtlas,
  axolotl: axolotlAtlas,
  moth: mothAtlas,
  pangolin: pangolinAtlas,
  'phoenix-chick': phoenixChickAtlas,
  'mushroom-sprite': mushroomSpriteAtlas,
} as const;

export const petAnimationStates = [
  'idle',
  'hover',
  'listening',
  'thinking',
  'working',
  'awaiting-approval',
  'speaking',
  'success',
  'error',
] as const;
export type PetAnimationState = (typeof petAnimationStates)[number];

/** The avatar CSS sizes leave its canvas backing store unchanged. */
export type PetAvatarSize = 'regular' | 'compact' | 'header' | 'preview';
const avatarBox: Readonly<Record<PetAvatarSize, string>> = {
  regular: 'size-24',
  compact: 'size-14',
  header: 'size-10',
  preview: 'size-40',
};

/** Playback state is supplied by the caller; animation never starts work or audio. */
export function PetAvatar({
  appearance = 'owl',
  state = 'idle',
  motion = 'system',
  label = 'Owl companion',
  size = 'regular',
}: {
  readonly appearance?: PetProfile['appearance'];
  readonly state?: PetAnimationState;
  readonly motion?: 'system' | 'reduced';
  readonly label?: string;
  readonly size?: PetAvatarSize;
}): ReactElement {
  return appearance === 'owl' ? (
    <OwlAvatar state={state} motion={motion} label={label} size={size} />
  ) : (
    <AtlasAvatar
      key={appearance}
      atlas={petAtlases[appearance]}
      state={state}
      motion={motion}
      label={label}
      size={size}
    />
  );
}

interface SpriteAtlas {
  readonly source: string;
  readonly columns: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly frameDurationMs: number;
  readonly stateRows: Readonly<Record<PetAnimationState, number>>;
  readonly frameCounts: readonly number[];
}

function AtlasAvatar({
  atlas: spriteAtlas,
  state,
  motion,
  label,
  size,
}: {
  readonly atlas: SpriteAtlas;
  readonly state: PetAnimationState;
  readonly motion: 'system' | 'reduced';
  readonly label: string;
  readonly size: PetAvatarSize;
}): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const picture = new Image();
    const reduced = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let loaded = false;
    let inViewport = true;
    let frameRequest = 0;
    let epoch = 0;
    let previous = -1;
    const row = spriteAtlas.stateRows[state];
    const frameCount = spriteAtlas.frameCounts[row] ?? spriteAtlas.columns;
    const idleFrames = [0, 0, 0, 0, 1, 2, 3, 4, 5];
    const moving = () => motion === 'system' && !reduced.matches;
    function draw(frame: number): void {
      if (!context || !element || !loaded || frame === previous) return;
      previous = frame;
      context.clearRect(0, 0, element.width, element.height);
      context.drawImage(
        picture,
        frame * spriteAtlas.cellWidth,
        row * spriteAtlas.cellHeight,
        spriteAtlas.cellWidth,
        spriteAtlas.cellHeight,
        0,
        0,
        element.width,
        element.height,
      );
    }
    function tick(now: number): void {
      if (disposed || !loaded || document.hidden || !inViewport || !moving()) return;
      if (epoch === 0) epoch = now;
      const step = Math.floor((now - epoch) / spriteAtlas.frameDurationMs);
      draw(state === 'idle' ? (idleFrames[step % idleFrames.length] ?? 0) : step % frameCount);
      frameRequest = requestAnimationFrame(tick);
    }
    function sync(): void {
      cancelAnimationFrame(frameRequest);
      epoch = 0;
      previous = -1;
      draw(0);
      if (loaded && !disposed && !document.hidden && inViewport && moving())
        frameRequest = requestAnimationFrame(tick);
    }
    picture.onload = () => {
      if (disposed) return;
      if (
        picture.naturalWidth !== spriteAtlas.imageWidth ||
        picture.naturalHeight !== spriteAtlas.imageHeight
      ) {
        setFailed(true);
        return;
      }
      loaded = true;
      sync();
    };
    picture.onerror = () => {
      if (!disposed) setFailed(true);
    };
    picture.src = `/pets/${spriteAtlas.source}`;
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            inViewport = entries.some((entry) => entry.isIntersecting);
            sync();
          });
    observer?.observe(element);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    return () => {
      disposed = true;
      cancelAnimationFrame(frameRequest);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
      picture.onload = null;
      picture.onerror = null;
    };
  }, [motion, spriteAtlas, state]);
  return failed ? (
    <Text variant="note">Companion preview unavailable</Text>
  ) : (
    <canvas
      ref={canvas}
      width={spriteAtlas.cellWidth}
      height={spriteAtlas.cellHeight}
      role="img"
      aria-label={label}
      className={`${avatarBox[size]} shrink-0 object-contain`}
    />
  );
}

function OwlAvatar({
  state,
  motion,
  label,
  size,
}: {
  readonly state: PetAnimationState;
  readonly motion: 'system' | 'reduced';
  readonly label: string;
  readonly size: PetAvatarSize;
}): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const picture = new Image();
    const reduced = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let loaded = false;
    let inViewport = true;
    let frameRequest = 0;
    let epoch = 0;
    let previous = -1;
    const row = petAnimationStates.indexOf(state);
    const sourceTop = atlas.rowStarts[row] ?? 0;
    const sourceHeight = atlas.rowHeights[row] ?? atlas.cellWidth;
    const baseline = atlas.rowBaselines[row] ?? 197;
    const idleFrames = [0, 0, 0, 0, 0, 0, 1, 2, 3];
    const moving = () => motion === 'system' && !reduced.matches;
    function draw(frame: number): void {
      if (!context || !element || !loaded || frame === previous) return;
      previous = frame;
      context.clearRect(0, 0, element.width, element.height);
      context.drawImage(
        picture,
        frame * atlas.cellWidth,
        sourceTop,
        atlas.cellWidth,
        sourceHeight,
        0,
        ((197 - baseline) * element.height) / atlas.cellWidth,
        element.width,
        (sourceHeight * element.height) / atlas.cellWidth,
      );
    }
    function tick(now: number): void {
      if (disposed || !loaded || document.hidden || !inViewport || !moving()) return;
      if (epoch === 0) epoch = now;
      const step = Math.floor((now - epoch) / atlas.frameDurationMs);
      draw(state === 'idle' ? (idleFrames[step % idleFrames.length] ?? 0) : step % atlas.columns);
      frameRequest = requestAnimationFrame(tick);
    }
    function sync(): void {
      cancelAnimationFrame(frameRequest);
      epoch = 0;
      draw(0);
      if (loaded && !disposed && !document.hidden && inViewport && moving())
        frameRequest = requestAnimationFrame(tick);
    }
    picture.onload = () => {
      if (disposed) return;
      if (
        picture.naturalWidth !== atlas.imageWidth ||
        picture.naturalHeight !== atlas.imageHeight
      ) {
        setFailed(true);
        return;
      }
      loaded = true;
      sync();
    };
    picture.onerror = () => {
      if (!disposed) setFailed(true);
    };
    picture.src = `/pets/${atlas.source}`;
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            inViewport = entries.some((entry) => entry.isIntersecting);
            sync();
          });
    observer?.observe(element);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    return () => {
      disposed = true;
      cancelAnimationFrame(frameRequest);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
      picture.onload = null;
      picture.onerror = null;
    };
  }, [state, motion]);
  return failed ? (
    <Text variant="note">Owl preview unavailable</Text>
  ) : (
    <canvas
      ref={canvas}
      width={192}
      height={192}
      role="img"
      aria-label={label}
      className={`${avatarBox[size]} shrink-0`}
    />
  );
}
