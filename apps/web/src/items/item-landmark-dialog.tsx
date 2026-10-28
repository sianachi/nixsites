import { Button, Dialog, Icon, Text, cn, focusRing } from '@nix/ui';
import {
  BookOpen,
  Briefcase,
  CalendarDays,
  FileText,
  Heart,
  NotebookPen,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { DEFAULT_LANDMARK, type ItemLandmark } from '../lib/item-landmarks';

const ICONS: Record<ItemLandmark['icon'], { readonly label: string; readonly icon: LucideIcon }> = {
  page: { label: 'Page', icon: FileText },
  notebook: { label: 'Notebook', icon: NotebookPen },
  book: { label: 'Book', icon: BookOpen },
  calendar: { label: 'Calendar', icon: CalendarDays },
  briefcase: { label: 'Briefcase', icon: Briefcase },
  wallet: { label: 'Wallet', icon: Wallet },
  heart: { label: 'Heart', icon: Heart },
};
const TONES: Record<ItemLandmark['tone'], { readonly label: string; readonly className: string }> =
  {
    muted: { label: 'Quiet', className: 'text-muted' },
    accent: { label: 'Blue', className: 'text-accent-text' },
    foreground: { label: 'Strong', className: 'text-foreground' },
  };

export function ItemLandmarkIcon({
  landmark = DEFAULT_LANDMARK,
}: {
  readonly landmark?: ItemLandmark | undefined;
}): ReactNode {
  return (
    <span className={cn('flex shrink-0 items-center', TONES[landmark.tone].className)}>
      <Icon icon={ICONS[landmark.icon].icon} size="sm" />
    </span>
  );
}

export interface ItemLandmarkDialogProps {
  readonly title: string;
  readonly landmark?: ItemLandmark | undefined;
  readonly onSave: (landmark: ItemLandmark | null) => void;
  readonly onClose: () => void;
}

export function ItemLandmarkDialog({
  title,
  landmark = DEFAULT_LANDMARK,
  onSave,
  onClose,
}: ItemLandmarkDialogProps): ReactNode {
  const [choice, setChoice] = useState(landmark);
  return (
    <Dialog
      open
      title={`Icon for ${title}`}
      onClose={onClose}
      actions={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onSave(null);
              onClose();
            }}
          >
            Reset icon
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(choice);
              onClose();
            }}
          >
            Save icon
          </Button>
        </>
      }
    >
      <Text variant="note" tone="muted">
        Choose a landmark for the Explorer and pinned items. Saved for this workspace in this
        browser.
      </Text>
      <fieldset className="flex flex-col gap-2">
        <legend>
          <Text as="span" variant="bodySmall">
            Icon
          </Text>
        </legend>
        <div className="flex flex-wrap gap-2 pt-2">
          {Object.entries(ICONS).map(([id, entry]) => (
            <button
              key={id}
              type="button"
              aria-label={entry.label}
              aria-pressed={choice.icon === id}
              className={cn(
                'flex size-(--control-lg) items-center justify-center rounded-md hover:bg-accent/10',
                choice.icon === id ? 'bg-accent/18 text-accent-text' : 'text-muted',
                focusRing,
              )}
              onClick={() => {
                setChoice({ ...choice, icon: id as ItemLandmark['icon'] });
              }}
            >
              <Icon icon={entry.icon} />
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend>
          <Text as="span" variant="bodySmall">
            Colour
          </Text>
        </legend>
        <div className="flex flex-wrap gap-2 pt-2">
          {Object.entries(TONES).map(([id, entry]) => (
            <button
              key={id}
              type="button"
              aria-pressed={choice.tone === id}
              className={cn(
                'flex min-h-(--control-lg) items-center gap-2 rounded-md px-3 hover:bg-accent/10',
                choice.tone === id && 'bg-accent/18',
                entry.className,
                focusRing,
              )}
              onClick={() => {
                setChoice({ ...choice, tone: id as ItemLandmark['tone'] });
              }}
            >
              <Icon icon={ICONS[choice.icon].icon} size="sm" />
              <Text as="span" variant="bodySmall">
                {entry.label}
              </Text>
            </button>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}
