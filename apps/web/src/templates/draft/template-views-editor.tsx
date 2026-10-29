import { Button, Field, Icon, Select, Text } from '@nix/ui';
import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { isFilterGroup, type View } from '@nix/web-collections/core/container-model';
import {
  STRUCTURED_RECIPES,
  type StructuredRecipeId,
} from '@nix/web-views/wizard/structured-recipes';
import { move, prepareNewView, type TemplateItemEdit } from './draft-model';
import { TemplateViewCard } from './template-view-card';

export function TemplateViewsEditor({
  edit,
  onChange,
}: {
  readonly edit: TemplateItemEdit;
  readonly onChange: (edit: TemplateItemEdit) => void;
}): ReactNode {
  const views = edit.views?.views ?? [];
  const defaultView = edit.views?.default ?? 'document';
  const [addingKind, setAddingKind] = useState<StructuredRecipeId>('list');

  function replaceViews(next: readonly View[], nextDefault = defaultView, nextEdit = edit): void {
    onChange({
      ...nextEdit,
      views: {
        views: next.map((view) => ({
          ...view,
          // A template stores plain conditions only (Core refuses a group there), and this editor
          // never offers one (`allowGroups={false}` below), so this only narrows the type.
          filters: view.filters.filter((rule) => !isFilterGroup(rule)),
          companionViewId: view.companionViewId ?? null,
          companionPlacement: view.companionPlacement ?? null,
          interactiveForm: view.interactiveForm ?? null,
          open: view.open ?? null,
        })),
        default: nextDefault,
      },
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <Text variant="h3" as="h3">
          Views
        </Text>
        <Text variant="caption" tone="muted">
          The views people receive from this template.
        </Text>
      </div>
      {views.length === 0 ? (
        <Text variant="bodySmall" tone="muted" className="rounded-md bg-surface p-3">
          This item opens on its document and has no child-item views.
        </Text>
      ) : null}
      {views.map((view, index) => (
        <TemplateViewCard
          key={view.id}
          view={view}
          fields={edit.schema?.properties ?? []}
          views={views}
          isDefault={view.id === defaultView}
          first={index === 0}
          last={index === views.length - 1}
          onChange={(next) => {
            replaceViews(views.map((entry, position) => (position === index ? next : entry)));
          }}
          onMakeDefault={() => {
            replaceViews(views, view.id);
          }}
          onMove={(by) => {
            replaceViews(move(views, index, by));
          }}
          onRemove={() => {
            const next = views
              .filter((_, position) => position !== index)
              .map((entry) =>
                entry.companionViewId === view.id
                  ? { ...entry, companionViewId: null, companionPlacement: null }
                  : entry,
              );
            replaceViews(next, defaultView === view.id ? (next[0]?.id ?? 'document') : defaultView);
          }}
        />
      ))}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field
          label="New view type"
          hint="Required compatible fields are added when they are missing."
          className="sm:w-64"
        >
          {(control) => (
            <Select
              {...control}
              value={addingKind}
              onChange={(event) => {
                setAddingKind(event.target.value as StructuredRecipeId);
              }}
            >
              {STRUCTURED_RECIPES.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          variant="secondary"
          onClick={() => {
            const prepared = prepareNewView(edit, addingKind);
            replaceViews(
              [...views, prepared.view],
              views.length === 0 ? prepared.view.id : defaultView,
              prepared.edit,
            );
          }}
        >
          <Icon icon={Plus} size="sm" /> Add view
        </Button>
      </div>
    </section>
  );
}
