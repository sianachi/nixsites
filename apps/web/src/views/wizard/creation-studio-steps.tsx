import { Button, Checkbox, Field, Icon, Input, Segmented, Select, Text } from '@nix/ui';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { type ReactNode } from 'react';

import type { PropertyDefinition as PropertyDefinitionType } from '../../collections/core/container-model';
import { LineListInput } from '../core/line-list-input';
import { PROPERTY_TYPES, isDateShaped } from '../../collections/core/property-types';
import { StructuredViewConfiguration } from '../core/structured-view-configuration';
import { FilterRulesEditor } from '../core/filter-rules-editor';
import { companionView, refreshViewProperties, type StudioDraft } from './creation-studio-model';
import { SMART_LIST_STARTERS, keyForProperty, type StructuredRecipe } from './structured-recipes';

export function BasicsStep({
  recipe,
  draft,
  onChange,
}: {
  readonly recipe: StructuredRecipe;
  readonly draft: StudioDraft;
  readonly onChange: (draft: StudioDraft) => void;
}): ReactNode {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="max-w-prose">
        <Text variant="h3" as="h2">
          Basics
        </Text>
        <Text variant="note" tone="muted" className="mt-1">
          {recipe.detail}
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
      {draft.view.kind === 'query' ? (
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
  return (
    <div className="@container/fields flex min-w-0 flex-col gap-3">
      {properties.map((property, index) => (
        <div key={index} className="flex min-w-0 flex-col gap-3 rounded-md bg-surface p-3">
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
                      onChange(
                        properties.map((entry, position) =>
                          position === index
                            ? {
                                ...entry,
                                type: event.target.value,
                                options:
                                  event.target.value === 'select' ||
                                  event.target.value === 'multi_select'
                                    ? entry.options
                                    : [],
                              }
                            : entry,
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
                aria-label={`Move ${property.label || 'field'} earlier`}
                disabled={index === 0}
                onClick={() => {
                  const next = [...properties];
                  const previous = next[index - 1];
                  if (previous === undefined) return;
                  next[index - 1] = property;
                  next[index] = previous;
                  onChange(next);
                }}
              >
                <Icon icon={ChevronUp} size="sm" />
              </Button>
              <Button
                variant="icon"
                aria-label={`Move ${property.label || 'field'} later`}
                disabled={index === properties.length - 1}
                onClick={() => {
                  const next = [...properties];
                  const following = next[index + 1];
                  if (following === undefined) return;
                  next[index] = following;
                  next[index + 1] = property;
                  onChange(next);
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
              onChange(
                properties.map((entry, position) =>
                  position === index ? { ...entry, required: event.target.checked } : entry,
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
          onChange([
            ...properties,
            {
              key: `field_${String(properties.length + 1)}`,
              label: `Field ${String(properties.length + 1)}`,
              type: 'text',
              options: [],
              required: false,
            },
          ]);
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
