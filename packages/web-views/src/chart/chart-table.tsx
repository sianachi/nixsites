import { ScrollRegion, Table, Text, cn, focusRing, type TableColumn } from '@nix/ui';
import type { ReactNode } from 'react';

import { formatMeasure } from './chart-model';
import type { ChartPicking } from './chart-selection';

/** One column of a chart's table: a series as drawn, or a derived line. */
export interface ChartTableColumn {
  readonly key: string;
  readonly label: string;
  readonly values: readonly (number | null)[];
}

interface ChartTableRow {
  readonly key: string;
  readonly label: string;
  readonly muted?: boolean;
}

export interface ChartTableProps {
  readonly caption: string;
  /** What the first column is: the grouping property, or the period. */
  readonly rowHeader: string;
  readonly rows: readonly ChartTableRow[];
  readonly columns: readonly ChartTableColumn[];
  /** Fold the table behind a disclosure so a long one does not push the page down on a phone. */
  readonly collapse?: boolean;
  /** When given, each row's name is a button that lists the items behind it: the keyboard path to a mark. */
  readonly picking?: ChartPicking | undefined;
}

/**
 * Every figure a chart draws, as a table.
 *
 * **The drawing is decoration over this, never the other way round.** Column, pie, line and area
 * charts are SVG marked `aria-hidden`; their numbers live here, as text, so a screen reader reads
 * figures rather than a description of a picture and a copy-paste carries data. Visible rather than
 * hidden for the same reason - a person checking one value should not have to estimate it from a
 * line's height.
 *
 * The design system's `Table`, with the figures in end-aligned columns. It scrolls sideways inside
 * a focusable region when a chart has many series, so a phone never scrolls the page and a keyboard
 * can still reach the columns past the edge.
 */
export function ChartTable({
  caption,
  rowHeader,
  rows,
  columns,
  collapse = false,
  picking,
}: ChartTableProps): ReactNode {
  const indexed = rows.map((row, index) => ({ ...row, index }));
  const tableColumns: TableColumn<(typeof indexed)[number]>[] = [
    {
      key: ' row',
      header: rowHeader,
      rowHeader: true,
      cell: (row) => {
        const label = (
          <Text as="span" variant="bodySmall" tone={row.muted === true ? 'muted' : 'default'}>
            {row.label}
          </Text>
        );
        return picking === undefined ? (
          label
        ) : (
          <button
            type="button"
            aria-pressed={picking.isOn([row.key])}
            onClick={() => {
              picking.toggle([row.key]);
            }}
            className={cn(
              'rounded-sm px-1 text-left hover:bg-accent/12 active:bg-accent/24 any-pointer-coarse:min-h-(--control-lg)',
              picking.isOn([row.key]) && 'bg-accent/18 font-semibold',
              focusRing,
            )}
          >
            {label}
          </button>
        );
      },
    },
    ...columns.map((column): TableColumn<(typeof indexed)[number]> => ({
      key: column.key,
      header: column.label,
      align: 'end',
      cell: (row) => (
        <Text as="span" variant="bodySmall" className="whitespace-nowrap">
          {formatMeasure(column.values[row.index] ?? null)}
        </Text>
      ),
    })),
  ];

  const figures = (
    <ScrollRegion
      aria-label={caption}
      className={cn('min-w-0 max-w-full overflow-x-auto rounded-sm', focusRing)}
    >
      <Table
        caption={caption}
        columns={tableColumns}
        rows={indexed}
        rowKey={(row) => row.key}
        emptyMessage="There are no figures to show."
      />
    </ScrollRegion>
  );

  return collapse ? (
    <details>
      <summary
        className={cn(
          'cursor-pointer rounded-sm py-1 any-pointer-coarse:min-h-(--control-lg)',
          focusRing,
        )}
      >
        <Text as="span" variant="bodySmall">
          Show every figure
        </Text>
      </summary>
      {figures}
    </details>
  ) : (
    figures
  );
}
