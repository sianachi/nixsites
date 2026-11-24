import { Field, Input, Text, Textarea } from '@nix/ui';
import { useId, type ReactElement } from 'react';

function fieldLabel(name: string): string {
  const words = name
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .trim();
  return words === '' ? 'Unnamed field' : words.charAt(0).toUpperCase() + words.slice(1);
}

function sourceKeyHint(sourceKey: string | undefined, label: string): string | undefined {
  if (sourceKey === undefined || (sourceKey === label && !/\s/u.test(sourceKey))) return undefined;
  const exact = JSON.stringify(sourceKey).replace(
    /\s/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `Field name: ${exact}`;
}

function ValueField({
  label,
  value,
  sourceKey,
}: {
  readonly label: string;
  readonly value: unknown;
  readonly sourceKey?: string;
}): ReactElement {
  const descriptionId = useId();
  const sourceHint = sourceKeyHint(sourceKey, label);
  const list = Array.isArray(value);
  const entries: [string, unknown][] | null = Array.isArray(value)
    ? value.map((entry: unknown, index): [string, unknown] => [String(index), entry])
    : typeof value === 'object' && value !== null
      ? Object.entries(value)
      : null;
  if (entries !== null) {
    const collection = list
      ? `List, ${String(entries.length)} ${entries.length === 1 ? 'item' : 'items'}`
      : `Group, ${String(entries.length)} ${entries.length === 1 ? 'field' : 'fields'}`;
    return (
      <fieldset aria-describedby={descriptionId} className="m-0 flex min-w-0 flex-col gap-2 p-0">
        <legend>
          <Text as="span" variant="note" tone="muted">
            {label}
          </Text>
        </legend>
        <Text id={descriptionId} variant="note" tone="muted">
          {sourceHint === undefined ? collection : `${sourceHint}. ${collection}`}
        </Text>
        {entries.length === 0 ? (
          <Text variant="note" tone="muted">
            {Array.isArray(value) ? 'No items' : 'No fields'}
          </Text>
        ) : (
          entries.map(([name, entry], index) => (
            <ValueField
              key={name}
              label={
                list ? `Item ${String(index + 1)} of ${String(entries.length)}` : fieldLabel(name)
              }
              value={entry}
              {...(list ? {} : { sourceKey: name })}
            />
          ))
        )}
      </fieldset>
    );
  }
  const empty =
    value === null || value === undefined ? 'No value' : value === '' ? 'Empty text' : undefined;
  const display =
    typeof value === 'boolean'
      ? value
        ? 'Yes'
        : 'No'
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
  const valueHint =
    empty ??
    (typeof value === 'boolean' ? 'Yes or no' : typeof value === 'number' ? 'Number' : undefined);
  const hints = [sourceHint, valueHint].filter((text) => text !== undefined);
  const hint = hints.length === 0 ? undefined : hints.join('. ');
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      {(control) =>
        typeof value === 'string' && value !== '' ? (
          <Textarea
            {...control}
            readOnly
            autoGrow
            rows={1}
            value={display}
            className="max-h-60 wrap-anywhere"
          />
        ) : (
          <Input {...control} readOnly value={display} placeholder={empty} />
        )
      }
    </Field>
  );
}

/** Review records without treating their text as a form program. */
export function ValueFields({
  value,
  label = 'Details',
}: {
  readonly value: unknown;
  readonly label?: string;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Text variant="note" tone="muted">
        Review only
      </Text>
      <ValueField label={label} value={value} />
    </div>
  );
}
