import { Button, Field, Icon, Select, Text, focusRing } from '@nix/ui';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import type { PropertyDefinition, View } from '@nix/web-collections/core/container-model';
import { FilterRulesEditor } from './filter-rules-editor';
import { LineListInput } from './line-list-input';
import { OPEN_MODES, OPEN_MODE_LABELS } from '@nix/web-collections/core/open-policy';
import { findViewKind } from './view-kinds';

export interface StructuredViewConfigurationProps {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (view: View) => void;
  /** Creation recipes deliberately expose columns only for the kinds whose wizard promises them. */
  readonly showColumns?: boolean | undefined;
  /** Creation recipes deliberately expose sorting only where their wizard promises it. */
  readonly showSort?: boolean | undefined;
  /**
   * The saved filters. Defaults to the kinds that apply them to their children, so a kind that
   * ignores them - a chart - is never offered rules that would change nothing.
   */
  readonly showFilters?: boolean | undefined;
  /** A Smart-list wizard owns its starter choices and passes false to avoid a second filter editor. */
  readonly showKindFilters?: boolean | undefined;
  /** Whether "any of" groups may be added; a template stores plain conditions only. */
  readonly allowGroups?: boolean | undefined;
}

/**
 * The shared field controls for a stored structured view.
 *
 * Creation, template editing, and future view setup all edit the same record. Keeping the controls
 * here means a new configuration field is taught to one surface rather than copied between them.
 */
export function StructuredViewConfiguration({
  view,
  fields,
  onChange,
  showColumns = !['query', 'interactive_form', 'checklist', 'outline'].includes(view.kind),
  showSort = !['form', 'interactive_form', 'query', 'outline'].includes(view.kind),
  showFilters,
  showKindFilters = true,
  allowGroups = true,
}: StructuredViewConfigurationProps): ReactNode {
  const descriptor = findViewKind(view.kind);
  const showsSavedFilters = showFilters ?? descriptor?.appliesSavedFilters === true;

  return (
    <>
      {descriptor?.configures.map((configuration) => {
        const usable = fields.filter(configuration.accepts);
        return (
          <Field
            key={configuration.field}
            label={configuration.label}
            hint={usable.length === 0 ? configuration.emptyHint : configuration.hint}
          >
            {(control) => (
              <Select
                {...control}
                value={view[configuration.field] ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  const next: View = {
                    ...view,
                    ...configuration.clears,
                    [configuration.field]: value.length === 0 ? null : value,
                  };
                  onChange(configuration.normalize?.(next, fields) ?? next);
                }}
              >
                <option value="">{configuration.emptyChoice}</option>
                {usable.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
                {configuration.extraChoices?.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        );
      })}

      {descriptor?.chooses.map((choice) => (
        <Field key={choice.field} label={choice.label} hint={choice.hint}>
          {(control) => (
            <Select
              {...control}
              value={view[choice.field] ?? choice.fallback}
              onChange={(event) => {
                onChange({ ...view, [choice.field]: event.target.value });
              }}
            >
              {choice.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ))}

      <Field
        label="Open items"
        hint="Auto opens a dialog over most views and a page from an outline; phones always open a page."
      >
        {(control) => (
          <Select
            {...control}
            value={view.open ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              onChange({ ...view, open: value.length === 0 ? null : value });
            }}
          >
            <option value="">{OPEN_MODE_LABELS.auto}</option>
            {OPEN_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {OPEN_MODE_LABELS[mode]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {view.kind === 'board' ? (
        <Field label="Column order" hint="One select option per line.">
          {(control) => (
            <LineListInput
              {...control}
              rows={3}
              value={view.groupOrder}
              onChange={(groupOrder) => {
                onChange({
                  ...view,
                  groupOrder,
                });
              }}
            />
          )}
        </Field>
      ) : null}

      {view.kind === 'calendar' || view.kind === 'timeline' ? (
        <Field label={view.kind === 'calendar' ? 'Initial calendar view' : 'Initial time scale'}>
          {(control) => (
            <Select
              {...control}
              value={view.mode ?? (view.kind === 'calendar' ? 'week' : 'month')}
              onChange={(event) => {
                onChange({ ...view, mode: event.target.value });
              }}
            >
              {view.kind === 'calendar' ? <option value="day">Day</option> : null}
              <option value="week">Week</option>
              <option value="month">Month</option>
              {view.kind === 'timeline' ? <option value="quarter">Quarter</option> : null}
            </Select>
          )}
        </Field>
      ) : null}

      {view.kind === 'form' || view.kind === 'interactive_form' ? (
        <Field
          label="Default response mode"
          hint="The person filling the form can choose whether to save each response."
        >
          {(control) => (
            <Select
              {...control}
              value={view.mode === 'temporary' ? 'temporary' : 'saved'}
              onChange={(event) => {
                onChange({ ...view, mode: event.target.value });
              }}
            >
              <option value="saved">Save entries</option>
              <option value="temporary">Temporary calculations</option>
            </Select>
          )}
        </Field>
      ) : null}

      {descriptor?.configurationEditor?.({ view, fields, onChange })}

      {showColumns ? <ViewColumns view={view} fields={fields} onChange={onChange} /> : null}

      {showSort ? <SortChoice view={view} fields={fields} onChange={onChange} /> : null}

      {showsSavedFilters ? (
        <FilterRulesEditor
          scope="container"
          allowGroups={allowGroups}
          rules={view.filters}
          schema={fields}
          onChange={(filters) => {
            onChange({ ...view, filters: [...filters] });
          }}
        />
      ) : showKindFilters && descriptor?.editsFilters === true ? (
        <FilterRulesEditor
          allowGroups={allowGroups}
          rules={view.filters}
          schema={fields}
          onChange={(filters) => {
            onChange({ ...view, filters: [...filters] });
          }}
        />
      ) : null}
    </>
  );
}

function SortChoice({
  view,
  fields,
  onChange,
}: {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (view: View) => void;
}): ReactNode {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Sort by">
        {(control) => (
          <Select
            {...control}
            value={view.sortBy ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              // The list's first key is the one this control names; keys after it are kept unless
              // they repeat the new primary. Written together so the server's mirror of the
              // primary into sortBy never disagrees with what this control shows.
              onChange({
                ...view,
                sortBy: value.length === 0 ? null : value,
                sorts:
                  value.length === 0
                    ? []
                    : [
                        { property: value, descending: view.sortDescending },
                        ...(view.sorts ?? []).slice(1).filter((sort) => sort.property !== value),
                      ],
              });
            }}
          >
            <option value="">No sorting</option>
            <option value="title">Title</option>
            {fields.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <label className="flex items-center gap-2 self-end py-2 text-base">
        <input
          type="checkbox"
          checked={view.sortDescending}
          disabled={view.sortBy === null}
          className={focusRing}
          onChange={(event) => {
            const descending = event.target.checked;
            const [primary, ...rest] = view.sorts ?? [];
            onChange({
              ...view,
              sortDescending: descending,
              ...(primary === undefined ? {} : { sorts: [{ ...primary, descending }, ...rest] }),
            });
          }}
        />
        Descending order
      </label>
    </div>
  );
}

function ViewColumns({
  view,
  fields,
  onChange,
}: {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly onChange: (view: View) => void;
}): ReactNode {
  const available = [
    { key: 'title', label: 'Title' },
    ...fields.map((field) => ({ key: field.key, label: field.label })),
  ];
  const selected = view.columns.filter((key) => available.some((field) => field.key === key));
  const unselected = available.filter((field) => !selected.includes(field.key));

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="text-sm font-semibold">Visible fields and order</legend>
      {selected.map((key, index) => {
        const label = available.find((field) => field.key === key)?.label ?? key;
        return (
          <div key={key} className="flex items-center gap-2 rounded-md bg-background px-2 py-1">
            <Text variant="bodySmall" className="min-w-0 flex-1">
              {label}
            </Text>
            <Button
              variant="icon"
              aria-label={`Move ${label} earlier`}
              disabled={index === 0}
              onClick={() => {
                onChange({ ...view, columns: move(selected, index, -1) });
              }}
            >
              <Icon icon={ChevronUp} size="sm" />
            </Button>
            <Button
              variant="icon"
              aria-label={`Move ${label} later`}
              disabled={index === selected.length - 1}
              onClick={() => {
                onChange({ ...view, columns: move(selected, index, 1) });
              }}
            >
              <Icon icon={ChevronDown} size="sm" />
            </Button>
            <Button
              variant="icon"
              aria-label={`Hide ${label}`}
              onClick={() => {
                onChange({ ...view, columns: selected.filter((entry) => entry !== key) });
              }}
            >
              <Icon icon={Trash2} size="sm" />
            </Button>
          </div>
        );
      })}
      {unselected.length === 0 ? null : (
        <Field label="Add visible field">
          {(control) => (
            <Select
              {...control}
              value=""
              onChange={(event) => {
                if (event.target.value.length === 0) return;
                onChange({ ...view, columns: [...selected, event.target.value] });
              }}
            >
              <option value="">Choose a field</option>
              {unselected.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </fieldset>
  );
}

function move<T>(entries: readonly T[], index: number, by: number): T[] {
  const next = [...entries];
  const target = index + by;
  const entry = next[index];
  const displaced = next[target];
  if (entry === undefined || displaced === undefined) return next;
  next[index] = displaced;
  next[target] = entry;
  return next;
}
