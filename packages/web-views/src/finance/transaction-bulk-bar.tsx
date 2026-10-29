import { Button, Checkbox, Select, Text } from '@nix/ui';
import type { Finance } from '@nix/api-client';
import type { ReactNode } from 'react';
import { linesBySection } from './transaction-dialog';

/** Select-all plus the assign-to-line controls for the selected rows. */
export function TransactionBulkBar({
  lines,
  visibleCount,
  selectedCount,
  allVisibleSelected,
  someVisibleSelected,
  ready,
  assigning,
  assignLineId,
  onToggleAll,
  onAssignLine,
  onPreview,
  onClear,
}: {
  readonly lines: Finance['lines'];
  readonly visibleCount: number;
  readonly selectedCount: number;
  readonly allVisibleSelected: boolean;
  readonly someVisibleSelected: boolean;
  readonly ready: boolean;
  readonly assigning: boolean;
  readonly assignLineId: string;
  readonly onToggleAll: (checked: boolean) => void;
  readonly onAssignLine: (id: string) => void;
  readonly onPreview: () => void;
  readonly onClear: () => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-raised p-3">
      <Checkbox
        label={`Select all ${String(visibleCount)} visible`}
        checked={allVisibleSelected}
        disabled={!ready || assigning}
        indeterminate={someVisibleSelected && !allVisibleSelected}
        onChange={(event) => {
          onToggleAll(event.target.checked);
        }}
      />
      {selectedCount === 0 ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Text as="span" variant="bodySmall">
            {String(selectedCount)} selected
          </Text>
          <Select
            className="min-w-0 flex-1 basis-48"
            aria-label="Assign to line"
            value={assignLineId}
            disabled={assigning}
            onChange={(event) => {
              onAssignLine(event.target.value);
            }}
          >
            <option value="">Choose a line</option>
            {linesBySection(lines).map(([section, sectionLines]) => (
              <optgroup key={section} label={section}>
                {sectionLines.map((sectionLine) => (
                  <option key={sectionLine.id} value={sectionLine.id}>
                    {sectionLine.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <Button
            disabled={assignLineId === '' || assigning || !ready}
            onClick={() => {
              onPreview();
            }}
          >
            Preview change
          </Button>
          <Button
            variant="secondary"
            disabled={assigning}
            onClick={() => {
              onClear();
            }}
          >
            Clear selection
          </Button>
        </div>
      )}
    </div>
  );
}
