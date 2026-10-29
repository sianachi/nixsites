import { Button, Checkbox, Field, Icon, Input, Select, Text, Textarea } from '@nix/ui';
import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { PROPERTY_TYPES } from '../../collections/core/property-types';
import { declaredFields, replaceDeclaredFields, type TemplateItemEdit } from './draft-model';

export function TemplateFieldsEditor({
  edit,
  onChange,
}: {
  readonly edit: TemplateItemEdit;
  readonly onChange: (edit: TemplateItemEdit) => void;
}): ReactNode {
  const fields = declaredFields(edit);
  return (
    <section className="@container/template-fields flex min-w-0 flex-col gap-3">
      <div>
        <Text variant="h3" as="h3">
          Fields
        </Text>
        <Text variant="caption" tone="muted">
          Available to every item created inside this one.
        </Text>
      </div>
      {fields.length === 0 ? (
        <Text variant="bodySmall" tone="muted" className="rounded-md bg-surface p-3">
          This item does not declare any fields.
        </Text>
      ) : null}
      {fields.map((field, index) => (
        <div key={field.key} className="flex flex-col gap-3 rounded-md bg-surface p-3">
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            <Field
              label="Field name"
              className="min-w-0 flex-1 basis-full @md/template-fields:basis-0"
            >
              {(control) => (
                <Input
                  {...control}
                  value={field.label}
                  onChange={(event) => {
                    onChange(
                      replaceDeclaredFields(
                        edit,
                        fields.map((entry, position) =>
                          position === index ? { ...entry, label: event.target.value } : entry,
                        ),
                      ),
                    );
                  }}
                />
              )}
            </Field>
            <Field label="Type" className="min-w-0 flex-1 basis-full @md/template-fields:basis-0">
              {(control) => (
                <Select
                  {...control}
                  value={field.type}
                  onChange={(event) => {
                    const type = event.target.value;
                    onChange(
                      replaceDeclaredFields(
                        edit,
                        fields.map((entry, position) =>
                          position === index
                            ? {
                                ...entry,
                                type,
                                options:
                                  type === 'select' || type === 'multi_select' ? entry.options : [],
                              }
                            : entry,
                        ),
                      ),
                    );
                  }}
                >
                  {PROPERTY_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button
              variant="icon"
              aria-label={`Remove ${field.label || 'field'}`}
              onClick={() => {
                onChange(
                  replaceDeclaredFields(
                    edit,
                    fields.filter((_, position) => position !== index),
                  ),
                );
              }}
            >
              <Icon icon={Trash2} size="sm" />
            </Button>
          </div>
          {field.type === 'select' || field.type === 'multi_select' ? (
            <Field label="Options" hint="One option per line.">
              {(control) => (
                <Textarea
                  {...control}
                  rows={3}
                  value={field.options.join('\n')}
                  onChange={(event) => {
                    const options = event.target.value
                      .split('\n')
                      .map((value) => value.trim())
                      .filter(Boolean);
                    onChange(
                      replaceDeclaredFields(
                        edit,
                        fields.map((entry, position) =>
                          position === index ? { ...entry, options } : entry,
                        ),
                      ),
                    );
                  }}
                />
              )}
            </Field>
          ) : null}
          <Checkbox
            label="Required"
            checked={field.required}
            onChange={(event) => {
              onChange(
                replaceDeclaredFields(
                  edit,
                  fields.map((entry, position) =>
                    position === index ? { ...entry, required: event.target.checked } : entry,
                  ),
                ),
              );
            }}
          />
        </div>
      ))}
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          const number = fields.length + 1;
          onChange(
            replaceDeclaredFields(edit, [
              ...fields,
              {
                key: `field_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
                label: `Field ${String(number)}`,
                type: 'text',
                options: [],
                required: false,
              },
            ]),
          );
        }}
      >
        <Icon icon={Plus} size="sm" /> Add field
      </Button>
    </section>
  );
}
