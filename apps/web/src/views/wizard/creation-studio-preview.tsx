import { Blueprint, Text } from '@nix/ui';
import { PRINT_PALETTE } from '@nix/design-tokens/print';
import { renderView } from '@nix/view-render';
import { useDeferredValue, type ReactNode } from 'react';

import { isFilterGroup } from '../../collections/core/container-model';
import { isDateShaped } from '../../collections/core/property-types';
import { InteractiveFormRespondentPreview } from '../form/interactive-form-editor';
import type { StudioDraft } from './creation-studio-model';

export function StudioPreview({ draft: live }: { readonly draft: StudioDraft }): ReactNode {
  const draft = useDeferredValue(live);
  if (draft.view.kind === 'finance') {
    return (
      <Blueprint className="mt-3 flex flex-col gap-4 p-4">
        <Text variant="h3" as="h2">
          {draft.title || 'Finances'}
        </Text>
        <Text variant="bodySmall">Dashboard, Budget, Transactions, Accounts and Cash flow</Text>
        <Text variant="note" tone="muted">
          After creating this view, choose your currency and plan dates, then add accounts, budget
          lines and transactions. Your dashboard will show their calculated figures.
        </Text>
      </Blueprint>
    );
  }
  const form = draft.view.interactiveForm;
  if (form !== null && form !== undefined) {
    return (
      <div className="mt-3">
        <InteractiveFormRespondentPreview form={form} schema={draft.properties} />
      </div>
    );
  }

  const rows = Array.from({ length: 6 }, (_unused, index) => ({
    id: `preview-${String(index + 1)}`,
    title: `Example ${String(index + 1)}`,
    properties: Object.fromEntries(
      draft.properties.map((property) => [property.key, previewValue(property, index)]),
    ),
  }));
  const view = {
    ...draft.view,
    // The printed preview draws sample rows and never applies filters, and the archive snapshot
    // it renders from holds plain conditions only, so a group is left out of what it is handed.
    filters: draft.view.filters.filter((rule) => !isFilterGroup(rule)),
    companionViewId: draft.view.companionViewId ?? null,
    companionPlacement: draft.view.companionPlacement ?? null,
    interactiveForm: null,
  };
  const rendered = renderView({
    view,
    rows,
    schema: { properties: draft.properties, declared: draft.properties, inherit: false },
    palette: PRINT_PALETTE,
    width: 360,
  });
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`;
  return (
    <Blueprint className="mt-3 flex flex-col gap-4 p-4">
      <div>
        <Text variant="h3" as="h2">
          {draft.title || 'Untitled'}
        </Text>
        <Text variant="note" tone="muted">
          {draft.view.name}
        </Text>
      </div>
      <img
        src={source}
        alt={`${draft.view.name} live preview`}
        className="h-auto w-full rounded-md bg-background"
      />
      {rendered.notes.length === 0 ? null : (
        <Text variant="caption" tone="muted">
          {rendered.notes.join(' ')}
        </Text>
      )}
    </Blueprint>
  );
}

function previewValue(property: StudioDraft['properties'][number], index: number): unknown {
  if (property.type === 'checkbox') return index % 2 === 0;
  if (property.type === 'number') return index + 1;
  if (isDateShaped(property.type)) return `2026-08-${String(index + 10).padStart(2, '0')}`;
  if (property.type === 'multi_select') return property.options.slice(0, 2);
  if (property.type === 'select')
    return property.options[index % Math.max(1, property.options.length)] ?? '';
  return `${property.label} ${String(index + 1)}`;
}
