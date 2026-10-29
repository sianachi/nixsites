import type { ReactNode } from 'react';

import { SuggestionAction, SuggestionHint } from '../suggest/suggestion-hint';

/**
 * The next free working-hours slot on this calendar, offered inside the reschedule dialog.
 *
 * Pressing "Use" fills the dialog's fields and nothing more; the item moves only when the person
 * presses Move, exactly as if they had typed the time. "Free here" because the slot was found among
 * this calendar's own items (`schedule-slot.ts`) and nothing else the person may have on.
 */
export interface FreeSlotHintProps {
  /** The slot as it reads: "Thu 1 Oct, 14:00 to 15:00". */
  readonly label: string;
  readonly onUse: () => void;
}

export function FreeSlotHint({ label, onUse }: FreeSlotHintProps): ReactNode {
  return (
    <SuggestionHint
      actions={
        <SuggestionAction label={`Use the free slot ${label}`} onClick={onUse}>
          Use
        </SuggestionAction>
      }
    >
      Next free slot here, in working hours: <span className="font-semibold">{label}</span>
    </SuggestionHint>
  );
}
