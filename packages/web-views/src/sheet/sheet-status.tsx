import { SHEET_ERROR_HELP, isSheetError, type CellValue } from '@nix/sheet';
import { Text } from '@nix/ui';
import { type ReactNode } from 'react';

/**
 * The grid's live region: an error explanation for the active cell, else the last clipboard
 * notice. Always mounted, so a screen reader announces the text the moment it appears rather than
 * missing a region that arrived with content already in it.
 */
export function SheetStatus({
  activeKey,
  value,
  notice,
}: {
  readonly activeKey: string;
  readonly value: CellValue | undefined;
  readonly notice: string;
}): ReactNode {
  return (
    <Text
      variant="caption"
      as="p"
      aria-live="polite"
      className="shrink-0 border-t border-divider px-3 py-1"
    >
      {value === undefined || !isSheetError(value) || notice !== ''
        ? notice
        : `${activeKey}: ${value.error} — ${SHEET_ERROR_HELP[value.error]}`}
    </Text>
  );
}
