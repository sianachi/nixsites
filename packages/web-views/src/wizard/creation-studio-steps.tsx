import { Button, Checkbox, Field, Icon, Input, Segmented, Select, Text, useUndo } from '@nix/ui';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import type { PropertyDefinition as PropertyDefinitionType } from '@nix/web-collections/core/container-model';
import { insertAt } from '../core/use-undo-remove';
import { LineListInput } from '../core/line-list-input';
import { PROPERTY_TYPES, isDateShaped } from '@nix/web-collections/core/property-types';
import { StructuredViewConfiguration } from '../core/structured-view-configuration';
import { FilterRulesEditor } from '../core/filter-rules-editor';
import { companionView, refreshViewProperties, type StudioDraft } from './creation-studio-model';
import { SMART_LIST_STARTERS, keyForProperty, type StructuredRecipe } from './structured-recipes';

export function BasicsStep({
  recipe,
  draft,
  onChange,
  showFields = true,
}: {
  readonly recipe: StructuredRecipe;
  readonly draft: StudioDraft;
  readonly onChange: (draft: StudioDraft) => void;
  readonly showFields?: boolean;
}): ReactNode {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="max-w-prose">
        {showFields ? (
          <Text variant="h3" as="h2">
            Basics
          </Text>
        ) : null}
        <Text variant="note" tone="muted" className="mt-1">
          {recipe.id === 'board' && !showFields
            ? 'Start with To do, Doing, and Done columns.'
            : recipe.detail}
        </Text>
      </div>
      <Field label="Name">
        {(control) => (
          <Input
            {...control}
            value={draft.title}
            onChange={(event) => {
              onChange({ ...draft, title: event.target.value });
            }}
          />
        )}
      </Field>
      {!showFields ? null : draft.view.kind === 'query' ? (
        <SmartListSetup draft={draft} onChange={onChange} />
      ) : (
        <FieldsEditor
          properties={draft.properties}
          onChange={(properties) => {
            const refreshed = refreshViewProperties(draft.view, properties);
            onChange({ ...draft, properties, view: refreshed });
          }}
        />
      )}
    </section>
  );
}

export function OptionsStep({
  draft,
  existingProperties,
  onChange,
}: {
  readonly draft: StudioDraft;
  readonly existingProperties: readonly PropertyDefinitionType[];
  readonly onChange: (draft: StudioDraft) => void;
}): ReactNode {
  const fields = mergedFields(draft.properties, existingProperties);
  const hasSelect = draft.properties.some((property) => property.type === 'select');
  const hasDate = draft.properties.some((property) => isDateShaped(property.type));
  const offeredKinds = new Set(['list', 'sheet', 'board', 'calendar', 'gallery']);
  const configuredCompanion = companionView(draft);
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="max-w-prose">
        <Text variant="h3" as="h2">
          Options
        </Text>
      </div>
      {draft.view.kind === 'query' ? null : (
        <StructuredViewConfiguration
          view={draft.view}
          fields={fields}
          showColumns={['board', 'list', 'sheet'].includes(draft.view.kind)}
          showSort={['list', 'sheet'].includes(draft.view.kind)}
          showKindFilters={false}
          onChange={(view) => {
            onChange({ ...draft, view });
          }}
        />
      )}
      {draft.view.kind === 'interactive_form' ? (
        <Checkbox
          label="Publish a public response link"
          checked={draft.publish}
          onChange={(event) => {
            onChange({ ...draft, publish: event.target.checked });
          }}
        />
      ) : null}
      <Field label="Companion" hint="Shows the same items.">
        {(control) => (
          <Select
            {...control}
            value={draft.companionKind ?? ''}
            onChange={(event) => {
              const companionKind = event.target.value.length === 0 ? null : event.target.value;
              onChange({
                ...draft,
                companionKind,
                companionView:
                  companionKind === null
                    ? null
                    : draft.companionView?.kind === companionKind
                      ? draft.companionView
                      : null,
              });
            }}
          >
            <option value="">None</option>
            {draft.companionKind !== null && !offeredKinds.has(draft.companionKind) ? (
              <option value={draft.companionKind}>
                {configuredCompanion?.name ?? draft.companionKind}
              </option>
            ) : null}
            <option value="list">List</option>
            <option value="sheet">Spreadsheet</option>
            <option value="board" disabled={!hasSelect}>
              Board
            </option>
            <option value="calendar" disabled={!hasDate}>
              Calendar
            </option>
            <option value="gallery">Gallery</option>
          </Select>
        )}
      </Field>
      {draft.companionKind === null ? null : (
        <Segmented
          label="Placement"
          value={draft.companionPlacement}
          options={[
            { value: 'below', label: 'Below' },
            { value: 'beside', label: 'Side by side' },
          ]}
          onChange={(companionPlacement) => {
            onChange({ ...draft, companionPlacement });
          }}
        />
      )}
    </section>
  );
}

function mergedFields(
  nearer: readonly PropertyDefinitionType[],
  farther: readonly PropertyDefinitionType[],
): readonly PropertyDefinitionType[] {
  const nearerKeys = new Set(nearer.map((field) => field.key));
  return [...nearer, ...farther.filter((field) => !nearerKeys.has(field.key))];
}

function FieldsEditor({
  properties,
  onChange,
}: {
  readonly properties: readonly PropertyDefinitionType[];
  readonly onChange: (properties: readonly PropertyDefinitionType[]) => void;
}): ReactNode {
  const undo = useUndo();
  const latest = useRef({ properties, onChange });
  useEffect(() => {
    latest.current = { properties, onChange };
  });
  // Each undo reverses only its own change, applied to the fields as they are now.
  function apply(
    update: (current: readonly PropertyDefinitionType[]) => readonly PropertyDefinitionType[],
  ): void {
    latest.current.onChange(update(latest.current.properties));
  }
  function swap(key: string, offset: number): void {
    apply((current) => {
      const next = [...current];
      const from = next.findIndex((entry) => entry.key === key);
      const a = next[from];
      const b = next[from + offset];
      if (a === undefined || b === undefined) return next;
      next[from] = b;
      next[from + offset] = a;
      return next;
    });
  }
  function move(property: PropertyDefinitionType, index: number, offset: number): void {
    swap(property.key, offset);
    undo.push(
      `Moved “${property.label || 'field'}” to position ${String(index + offset + 1)} of ${String(properties.length)}`,
      () => {
        swap(property.key, -offset);
      },
    );
  }
  function change(
    property: PropertyDefinitionType,
    label: string,
    forward: Partial<PropertyDefinitionType>,
    back: Partial<PropertyDefinitionType>,
  ): void {
    const set = (patch: Partial<PropertyDefinitionType>): void => {
      apply((current) =>
        current.map((entry) => (entry.key === property.key ? { ...entry, ...patch } : entry)),
      );
    };
    set(forward);
    undo.push(label, () => {
      set(back);
    });
  }
  return (
    <div className="@container/fields flex min-w-0 flex-col gap-3">
      {properties.map((property, index) => (
        <div
          key={index}
          data-enter=""
          className="flex min-w-0 flex-col gap-3 rounded-md bg-surface p-3"
        >
          <div className="flex min-w-0 flex-wrap items-end gap-2 @md/fields:flex-nowrap">
            <div className="flex min-w-0 basis-full items-end gap-2 @md/fields:basis-0 @md/fields:flex-1">
              <Field label="Field name" className="min-w-0 flex-1">
                {(control) => (
                  <Input
                    {...control}
                    value={property.label}
                    onChange={(event) => {
                      const label = event.target.value;
                      onChange(
                        properties.map((entry, position) =>
                          position === index
                            ? { ...entry, label, key: keyForProperty(label) }
                            : entry,
                        ),
                      );
                    }}
                  />
                )}
              </Field>
              <Button
                variant="icon"
                aria-label={`Remove ${property.label || 'field'}`}
                onClick={() => {
                  onChange(properties.filter((_, position) => position !== index));
                  undo.push(`Removed field “${property.label || 'field'}”`, () => {
                    apply((current) => insertAt(current, index, property));
                  });
                }}
              >
                <Icon icon={Trash2} size="sm" />
              </Button>
            </div>
            <div className="flex min-w-0 basis-full items-end gap-2 @md/fields:basis-0 @md/fields:flex-1">
              <Field label="Type" className="min-w-0 flex-1">
                {(control) => (
                  <Select
                    {...control}
                    value={property.type}
                    onChange={(event) => {
                      const type = event.target.value;
                      const keepsOptions = type === 'select' || type === 'multi_select';
                      change(
                        property,
                        `Changed “${property.label || 'field'}” to ${PROPERTY_TYPES.find((entry) => entry.value === type)?.label ?? type}`,
                        { type, options: keepsOptions ? property.options : [] },
                        { type: property.type, options: property.options },
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
                aria-label={`Move ${property.label || 'field'} earlier`}
                disabled={index === 0}
                onClick={() => {
                  move(property, index, -1);
                }}
              >
                <Icon icon={ChevronUp} size="sm" />
              </Button>
              <Button
                variant="icon"
                aria-label={`Move ${property.label || 'field'} later`}
                disabled={index === properties.length - 1}
                onClick={() => {
                  move(property, index, 1);
                }}
              >
                <Icon icon={ChevronDown} size="sm" />
              </Button>
            </div>
          </div>
          {property.type === 'select' || property.type === 'multi_select' ? (
            <Field label="Options" hint="One option per line.">
              {(control) => (
                <LineListInput
                  {...control}
                  rows={3}
                  value={property.options}
                  onChange={(options) => {
                    onChange(
                      properties.map((entry, position) =>
                        position === index
                          ? {
                              ...entry,
                              options,
                            }
                          : entry,
                      ),
                    );
                  }}
                />
              )}
            </Field>
          ) : null}
          <Checkbox
            label="Required"
            checked={property.required}
            onChange={(event) => {
              const required = event.target.checked;
              change(
                property,
                `Made “${property.label || 'field'}” ${required ? 'required' : 'optional'}`,
                { required },
                { required: !required },
              );
            }}
          />
        </div>
      ))}
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          const added: PropertyDefinitionType = {
            key: `field_${String(properties.length + 1)}`,
            label: `Field ${String(properties.length + 1)}`,
            type: 'text',
            options: [],
            required: false,
          };
          onChange([...properties, added]);
          undo.push(`Added field “${added.label}”`, () => {
            apply((current) => current.filter((entry) => entry.key !== added.key));
          });
        }}
      >
        <Icon icon={Plus} size="sm" />
        Add field
      </Button>
    </div>
  );
}

function SmartListSetup({
  draft,
  onChange,
}: {
  readonly draft: StudioDraft;
  readonly onChange: (draft: StudioDraft) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Text variant="note" tone="muted">
          Start with
        </Text>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              onChange({ ...draft, view: { ...draft.view, filters: [] } });
            }}
          >
            Blank
          </Button>
          {SMART_LIST_STARTERS.map((starter) => (
            <Button
              key={starter.id}
              variant="secondary"
              onClick={() => {
                onChange({ ...draft, view: { ...draft.view, filters: [...starter.filters] } });
              }}
            >
              {starter.label}
            </Button>
          ))}
        </div>
      </div>
      <FilterRulesEditor
        rules={draft.view.filters}
        schema={draft.properties}
        onChange={(filters) => {
          onChange({ ...draft, view: { ...draft.view, filters: [...filters] } });
        }}
      />
    </div>
  );
}
