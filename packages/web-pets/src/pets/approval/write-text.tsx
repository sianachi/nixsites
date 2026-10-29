import { Text, cn, focusRing } from '@nix/ui';
import type { ReactElement } from 'react';

import type { WriteTextItem } from './write-gate';

/** Security fix S1: every string a pending write would store, in a focusable scroll region so
 * nothing here can hide or truncate behind a click before Approve. */
export function WriteTextSection({
  items,
}: {
  readonly items: readonly WriteTextItem[];
}): ReactElement | null {
  if (items.length === 0) return null;
  // Each scroll box is a region, and regions need distinct names: a repeated label (two node
  // titles in a blueprint, say) is numbered so every box can be told apart.
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.label, (totals.get(item.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const names = items.map((item) => {
    const total = totals.get(item.label) ?? 1;
    if (total === 1) return item.label;
    const position = (seen.get(item.label) ?? 0) + 1;
    seen.set(item.label, position);
    return `${item.label} ${String(position)} of ${String(total)}`;
  });
  // A one-line string is a label and its exact text; only a string with line breaks needs a
  // scroll region. Neither is ever clipped or folded.
  const rows = items.map((item, index) => ({ item, name: names[index] ?? item.label, index }));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Text variant="note" tone="muted">
        Text this change will write
      </Text>
      {rows.map(({ item, name, index }) => {
        const lineCount = item.text.split('\n').length;
        if (lineCount === 1)
          return (
            <dl key={`${item.label}:${String(index)}`} className="flex min-w-0 flex-col gap-0.5">
              <Text as="dt" variant="note" tone="muted">
                {name}
              </Text>
              <Text as="dd" variant="note" className="whitespace-pre-wrap wrap-anywhere">
                {item.text}
              </Text>
            </dl>
          );
        return (
          <div key={`${item.label}:${String(index)}`} className="flex min-w-0 flex-col gap-1">
            <Text variant="note" tone="muted">
              {name} ({String(lineCount)} lines)
            </Text>
            <div
              // A group, not a landmark: two waiting cards each carry a text box of the same name.
              role="group"
              aria-label={name}
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
              tabIndex={0}
              className={cn(
                'min-w-0 max-h-60 overflow-y-auto overscroll-contain whitespace-pre-wrap wrap-anywhere rounded-sm border border-divider p-2',
                focusRing,
              )}
            >
              <Text variant="note">{item.text}</Text>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (Array.isArray(value)) return value.map((entry) => formatPropertyValue(entry)).join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return JSON.stringify(value);
}

/** UX fix U15: a `set_properties` request's values as a plain key/value list, alongside (never
 * instead of) `WriteTextSection`'s full text of every string among them. */
export function PropertyValueList({
  propertiesJson,
}: {
  readonly propertiesJson: string;
}): ReactElement | null {
  let entries: [string, unknown][] = [];
  try {
    const parsed: unknown = propertiesJson.trim() ? JSON.parse(propertiesJson) : undefined;
    if (
      parsed !== undefined &&
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      entries = Object.entries(parsed as Record<string, unknown>);
    }
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  return (
    <dl className="flex flex-col gap-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex flex-wrap gap-2">
          <Text as="dt" variant="note" tone="muted">
            {key}
          </Text>
          <Text as="dd" variant="note">
            {formatPropertyValue(value)}
          </Text>
        </div>
      ))}
    </dl>
  );
}
