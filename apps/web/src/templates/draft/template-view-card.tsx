import { Button, Field, Icon, Input, Select, Text } from '@nix/ui';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import type { PropertyDefinition, View } from '@nix/web-collections/core/container-model';
import { StructuredViewConfiguration } from '../../views/core/structured-view-configuration';
import { findViewKind } from '../../views/core/view-kinds';

export function TemplateViewCard({
  view,
  fields,
  views,
  isDefault,
  first,
  last,
  onChange,
  onMakeDefault,
  onMove,
  onRemove,
}: {
  readonly view: View;
  readonly fields: readonly PropertyDefinition[];
  readonly views: readonly View[];
  readonly isDefault: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly onChange: (view: View) => void;
  readonly onMakeDefault: () => void;
  readonly onMove: (by: number) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const descriptor = findViewKind(view.kind);
  const isCompanion = views.some((candidate) => candidate.companionViewId === view.id);
  const companionChoices = views.filter(
    (candidate) => candidate.id !== view.id && candidate.companionViewId === null,
  );
  return (
    <div className="@container/view-card flex min-w-0 flex-col gap-3 rounded-md bg-surface p-3">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <Field label="View name" className="min-w-0 flex-1 basis-full">
          {(control) => (
            <Input
              {...control}
              value={view.name}
              onChange={(event) => {
                onChange({ ...view, name: event.target.value });
              }}
            />
          )}
        </Field>
        <Text variant="caption" tone="muted" className="pb-2">
          {descriptor?.label ?? view.kind}
        </Text>
        <Button variant="secondary" disabled={isDefault} onClick={onMakeDefault}>
          {isDefault ? 'Default view' : 'Make default'}
        </Button>
        <Button
          variant="icon"
          aria-label={`Move ${view.name} earlier`}
          disabled={first}
          onClick={() => {
            onMove(-1);
          }}
        >
          <Icon icon={ChevronUp} size="sm" />
        </Button>
        <Button
          variant="icon"
          aria-label={`Move ${view.name} later`}
          disabled={last}
          onClick={() => {
            onMove(1);
          }}
        >
          <Icon icon={ChevronDown} size="sm" />
        </Button>
        <Button variant="icon" aria-label={`Remove ${view.name}`} onClick={onRemove}>
          <Icon icon={Trash2} size="sm" />
        </Button>
      </div>

      <StructuredViewConfiguration
        view={view}
        fields={fields}
        onChange={onChange}
        allowGroups={false}
      />

      <div className="grid min-w-0 gap-3 @lg/view-card:grid-cols-2">
        <Field
          label="Companion view"
          hint={
            isCompanion
              ? 'This view is already used as a companion, so it cannot contain another view.'
              : 'Show one other configured view with this one.'
          }
        >
          {(control) => (
            <Select
              {...control}
              disabled={isCompanion}
              value={view.companionViewId ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                onChange({
                  ...view,
                  companionViewId: value.length === 0 ? null : value,
                  companionPlacement:
                    value.length === 0 ? null : (view.companionPlacement ?? 'below'),
                });
              }}
            >
              <option value="">None</option>
              {companionChoices.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {view.companionViewId === null ? null : (
          <Field label="Companion placement">
            {(control) => (
              <Select
                {...control}
                value={view.companionPlacement ?? 'below'}
                onChange={(event) => {
                  onChange({
                    ...view,
                    companionPlacement: event.target.value as 'below' | 'beside',
                  });
                }}
              >
                <option value="below">Below</option>
                <option value="beside">Side by side</option>
              </Select>
            )}
          </Field>
        )}
      </div>
    </div>
  );
}
