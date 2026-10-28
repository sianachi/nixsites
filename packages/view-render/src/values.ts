import type { PropertyDefinition, SchemaSnapshot } from '@nix/export';

import type { ViewRow } from './types.js';

/**
 * A property value, as a view shows it.
 *
 * **The same open-set rule the interface applies.** A type this build has never heard of is shown
 * as its stored text rather than refused, because a newer build declared it and the value is real;
 * inventing a rendering for it would be worse than showing what is there. `PROPERTY_TYPES` in the
 * web app is the list this mirrors, and the two are allowed to differ only in that direction.
 *
 * Dates are shown as stored - ISO, trimmed to the day - rather than formatted for a locale. An
 * export has no viewer's locale to read, and guessing one produces a date that is wrong by a day
 * for half the world.
 */
export function formatValue(value: unknown, definition: PropertyDefinition | null): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  switch (definition?.type) {
    case 'checkbox':
      // ASCII, per AGENTS.md, and it survives a rasteriser that has no emoji font.
      return value === true ? '[x]' : '[ ]';

    case 'date':
      return typeof value === 'string' ? value.slice(0, 10) : scalar(value);

    case 'timestamp':
      return typeof value === 'string' ? value.replace('T', ' ').slice(0, 16) : scalar(value);

    // A cell is one line: a long-text value's line breaks become spaces so a board card or a table
    // row is not split by text written for a multi-line field.
    case 'long_text':
      return typeof value === 'string'
        ? value.replace(/\s*[\r\n]+\s*/g, ' ').trim()
        : scalar(value);

    default:
      return scalar(value);
  }
}

/**
 * Any value, as characters.
 *
 * **Never `String(value)` on an unknown.** A property holding an object would render as
 * "[object Object]" in the middle of somebody's board, which looks like a bug in their data rather
 * than in this function. An ellipsis says the same thing honestly: there is something here that a
 * cell cannot show.
 */
function scalar(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'boolean') {
    return value ? '[x]' : '[ ]';
  }

  if (Array.isArray(value)) {
    return value.map((entry: unknown) => scalar(entry)).join(', ');
  }

  return '…';
}

function definitionOf(schema: SchemaSnapshot | null, key: string): PropertyDefinition | null {
  return schema?.properties.find((property) => property.key === key) ?? null;
}

export function labelOf(schema: SchemaSnapshot | null, key: string): string {
  return definitionOf(schema, key)?.label ?? key;
}

export function valueOf(row: ViewRow, key: string, schema: SchemaSnapshot | null): string {
  return formatValue(row.properties[key], definitionOf(schema, key));
}

/**
 * The raw value, for grouping and for dates.
 *
 * Grouping compares stored values rather than displayed ones, so two cards whose select differs
 * only in how it renders still land in the same column.
 */
export function rawOf(row: ViewRow, key: string | null): string | null {
  if (key === null) {
    return null;
  }

  const value = row.properties[key];

  if (value === null || value === undefined || value === '') {
    return null;
  }

  return formatValue(value, null);
}
