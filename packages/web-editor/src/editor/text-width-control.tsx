import { Button, Icon, Popover, Text } from '@nix/ui';
import { Ruler } from 'lucide-react';
import type { ReactNode } from 'react';

import { useTextWidthPreference } from './text-width-preference';

export function TextWidthControl(): ReactNode {
  const { width, saved, setWidth } = useTextWidthPreference();
  return (
    <Popover
      label="Text width"
      trigger={(trigger) => (
        <Button variant="ghost" className="shrink-0 whitespace-nowrap" {...trigger}>
          <Icon icon={Ruler} size="sm" />
          Text width
        </Button>
      )}
    >
      {({ close }) => (
        <div className="flex shrink-0 flex-col gap-2">
          {(['reading', 'full'] as const).map((choice) => (
            <Button
              key={choice}
              variant="ghost"
              className="justify-start"
              aria-pressed={width === choice}
              onClick={() => {
                setWidth(choice);
                close();
              }}
            >
              {choice === 'reading' ? 'Reading width' : 'Full pane width'}
            </Button>
          ))}
          <Text variant="caption" tone="muted" className="max-w-xs">
            {saved
              ? 'Remembered on this device. Reading width follows your writing mode.'
              : 'Available for this session. This browser could not save the text width.'}
          </Text>
        </div>
      )}
    </Popover>
  );
}
