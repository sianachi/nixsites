import { Button, Text } from '@nix/ui';
import type { ReactNode } from 'react';

export function NoteImageSize({
  width,
  onChange,
}: {
  readonly width: number | undefined;
  readonly onChange: (width: number | undefined) => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2 py-2" role="group" aria-label="Image size">
      <label className="flex items-center gap-2">
        <Text variant="caption">Width</Text>
        <input
          type="range"
          aria-label="Image width"
          aria-valuetext={width === undefined ? 'Original size' : `${String(width)} pixels`}
          min={48}
          max={1600}
          step={8}
          value={width ?? 640}
          onChange={(event) => {
            onChange(Number(event.target.value));
          }}
        />
      </label>
      <Text variant="caption">{width === undefined ? 'Original size' : `${String(width)} px`}</Text>
      <Button
        variant="ghost"
        onClick={() => {
          onChange(undefined);
        }}
      >
        Reset size
      </Button>
    </div>
  );
}
