import { Button, Icon, Popover, Text } from '@nix/ui';
import { ChevronDown, PenLine } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useWritingModePreference, WritingModeSchema, WRITING_MODES } from './writing-mode';

export function WritingModeControl(): ReactNode {
  const [open, setOpen] = useState(false);
  const { mode, saved, setMode } = useWritingModePreference();

  return (
    <Popover
      label="Writing mode"
      className="w-80"
      open={open}
      onOpenChange={setOpen}
      trigger={(trigger) => (
        <Button
          variant="ghost"
          className="shrink-0 whitespace-nowrap"
          {...trigger}
          aria-label={`Writing mode: ${WRITING_MODES[mode].label}`}
        >
          <Icon icon={PenLine} size="sm" />
          {WRITING_MODES[mode].label}
          <Icon icon={ChevronDown} size="sm" />
        </Button>
      )}
    >
      {({ close }) => (
        <div role="group" aria-label="Writing mode" className="flex w-full shrink-0 flex-col gap-1">
          {WritingModeSchema.options.map((choice) => (
            <Button
              key={choice}
              variant="ghost"
              className="h-auto w-full shrink-0 flex-col items-start whitespace-normal py-3 text-left any-pointer-coarse:h-auto any-pointer-coarse:min-h-(--control-lg)"
              aria-pressed={mode === choice}
              onClick={() => {
                setMode(choice);
                close();
              }}
            >
              <Text as="span" variant="body">
                {WRITING_MODES[choice].label}
              </Text>
              <Text as="span" variant="note" tone="muted">
                {WRITING_MODES[choice].description}
              </Text>
            </Button>
          ))}
          <Text variant="caption" tone="muted" className="px-3 py-2">
            {saved
              ? 'Remembered on this device. Each person keeps their own writing mode.'
              : 'Available for this session. This browser could not save the writing mode.'}
          </Text>
        </div>
      )}
    </Popover>
  );
}
