import { structure } from '@nix/api-client';
import { Field, Select, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { TemplateItemPicker } from '../items/template-item-picker';
import type { PropertyDefinition } from '../core/container-model';

export function FieldSourceEditor({
  property,
  fields,
  onChange,
}: {
  readonly property: PropertyDefinition;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (source: PropertyDefinition['choiceSource']) => void;
}): ReactNode {
  const client = useOptionalApiClient();
  const source = property.choiceSource;
  const mode = !source ? 'none' : source.itemId === null ? 'previous' : 'other';
  const [loaded, setLoaded] = useState<{
    id: string;
    fields: readonly PropertyDefinition[];
  } | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const sourceId = source?.itemId;
  useEffect(() => {
    if (!sourceId || !client) return;
    const controller = new AbortController();
    void client
      .query(structure.effectiveSchema(sourceId), { signal: controller.signal })
      .then((schema) => {
        if (!controller.signal.aborted) {
          setLoaded({ id: sourceId, fields: schema.properties });
          setFailedSource(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailedSource(sourceId);
      });
    return () => {
      controller.abort();
    };
  }, [sourceId, client]);
  const available =
    mode === 'other' ? (loaded && loaded.id === sourceId ? loaded.fields : []) : fields;
  const choices = available.filter((field) =>
    ['text', 'select', 'multi_select'].includes(field.type),
  );
  return (
    <div className="flex flex-col gap-2">
      <Field
        label={`Suggestions for ${property.label}`}
        hint="Suggestions update from saved entries. New values are allowed; selections store text, not links."
      >
        {(control) => (
          <Select
            {...control}
            value={mode}
            onChange={(event) => {
              const next = event.target.value;
              onChange(
                next === 'none'
                  ? null
                  : next === 'other'
                    ? { itemId: '', field: 'title' }
                    : { itemId: null, field: property.key },
              );
            }}
          >
            <option value="none">No dynamic source</option>
            <option value="previous">Entries in this note</option>
            <option value="other">Entries in another note</option>
          </Select>
        )}
      </Field>
      {mode === 'other' && client ? (
        <TemplateItemPicker
          label="Source note"
          choiceLabel={`Source note for ${property.label}`}
          value={sourceId ?? ''}
          loadedItems={[]}
          onChange={(id) => {
            onChange(id ? { itemId: id, field: 'title' } : null);
          }}
        />
      ) : null}
      {source && (mode !== 'other' || sourceId) ? (
        <Field label={`Source field for ${property.label}`}>
          {(control) => (
            <Select
              {...control}
              value={source.field}
              onChange={(event) => {
                onChange({ ...source, field: event.target.value });
              }}
            >
              <option value="title">Title</option>
              {!choices.some((field) => field.key === source.field) && source.field !== 'title' ? (
                <option value={source.field}>{source.field}</option>
              ) : null}
              {choices.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
      {mode === 'other' && !sourceId ? (
        <Text variant="note" role="status">
          Choose a source note before saving.
        </Text>
      ) : null}
      {sourceId && loaded?.id !== sourceId && failedSource !== sourceId ? (
        <Text variant="note" role="status">
          Loading source fields.
        </Text>
      ) : null}
      {sourceId && failedSource === sourceId ? (
        <Text variant="note" role="alert">
          The source fields could not be loaded. Check access to the source note.
        </Text>
      ) : null}
    </div>
  );
}
