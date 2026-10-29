import { Blueprint, Button, Field, Input, Select, Text, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import type { CollabSync } from '@nix/web-editor/editor/collab-sync';
import { formatDateTime } from '@nix/web-foundation/lib/date-format';
import type { PropertyDefinition } from '@nix/web-collections/core/container-model';
import type { TemplateDetail, TemplateEditDraft, TemplateInitialization } from './template-api';
import { TemplateDraftEditor, type TemplateItemEdit } from './draft/template-draft-editor';
import { TemplateFact, TemplateFacts } from './template-studio-facts';
import type { StudioMode, TemplateDraft } from './template-studio-model';
import { StudioNotice } from './template-studio-notice';
import { TemplateInitializationEditor } from './initialization/template-initialization-editor';
import { useWorkspaceAssignablePrincipals } from '@nix/web-workspaces/workspaces/use-workspace-assignable-principals';
import type { TreeItem } from '@nix/web-collections/items/use-workspace-tree';
import { TemplateItemPicker } from '@nix/web-collections/items/template-item-picker';

export function Basics({
  mode,
  draft,
  destination,
  targetTitle,
  initialization,
  itemOptions,
  onChange,
}: {
  readonly mode: StudioMode;
  readonly draft: TemplateDraft;
  readonly destination: string;
  readonly targetTitle: string | null;
  readonly initialization: TemplateInitialization | null;
  readonly itemOptions: readonly TreeItem[];
  readonly onChange: (draft: TemplateDraft) => void;
}): ReactNode {
  if (mode === 'apply') {
    return (
      <section className="flex min-w-0 flex-col gap-4">
        <Text variant="h3" as="h2">
          Apply to {targetTitle ?? 'this item'}
        </Text>
        <Text tone="muted">
          Existing fields, views, content and children stay. Conflicts are checked before anything
          changes.
        </Text>
        <TemplateInputFields
          initialization={initialization}
          values={draft.inputValues}
          itemOptions={itemOptions}
          onChange={(inputValues) => {
            onChange({ ...draft, inputValues });
          }}
        />
      </section>
    );
  }
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div>
        <Text variant="h3" as="h2">
          {mode === 'create' ? 'Name the new item' : 'Name the template'}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {mode === 'create' ? `Creating in ${destination}` : 'Shown in the New menu.'}
        </Text>
      </div>
      <Field label="Name">
        {(control) => (
          <Input
            {...control}
            value={draft.title}
            onChange={(event) => {
              onChange({ ...draft, title: event.target.value, titleOverridden: true });
            }}
          />
        )}
      </Field>
      {mode === 'create' ? null : (
        <Field label="Description" hint="Optional. Say when this starting point is useful.">
          {(control) => (
            <Input
              {...control}
              value={draft.description}
              onChange={(event) => {
                onChange({ ...draft, description: event.target.value });
              }}
            />
          )}
        </Field>
      )}
      {mode === 'create' ? (
        <TemplateInputFields
          initialization={initialization}
          values={draft.inputValues}
          itemOptions={itemOptions}
          onChange={(inputValues) => {
            onChange({ ...draft, inputValues });
          }}
        />
      ) : null}
    </section>
  );
}

function TemplateInputFields({
  initialization,
  values,
  itemOptions,
  onChange,
}: {
  readonly initialization: TemplateInitialization | null;
  readonly values: Readonly<Record<string, string | null>>;
  readonly itemOptions: readonly TreeItem[];
  readonly onChange: (values: Readonly<Record<string, string | null>>) => void;
}): ReactNode {
  const memberDirectory = useWorkspaceAssignablePrincipals();
  const inputs = initialization?.inputs ?? [];
  if (inputs.length === 0) return null;

  function update(key: string, value: string): void {
    onChange({ ...values, [key]: value.length === 0 ? null : value });
  }

  return (
    <Blueprint aria-label="Template setup inputs" className="flex flex-col gap-4 p-4">
      <div>
        <Text variant="h3" as="h3">
          Set up this template
        </Text>
        <Text variant="caption" tone="muted">
          Answers personalize the item.
        </Text>
      </div>
      {inputs.map((input) => {
        const entered = Object.hasOwn(values, input.key) ? values[input.key] : undefined;
        const value = entered === null ? '' : (entered ?? input.defaultValue ?? '');
        const missing = input.required && value.trim().length === 0;
        if (input.type === 'item') {
          return (
            <div key={input.key} className="flex flex-col gap-2">
              <TemplateItemPicker
                label={input.label}
                hint={input.required ? 'Required answer' : 'Optional. Clear to use the default.'}
                value={value}
                loadedItems={itemOptions}
                onChange={(next) => {
                  update(input.key, next ?? '');
                }}
              />
              {missing ? (
                <Text as="p" role="alert" variant="caption">
                  This answer is required.
                </Text>
              ) : null}
            </div>
          );
        }
        return (
          <Field
            key={input.key}
            label={input.label}
            required={input.required}
            error={missing ? 'This answer is required.' : null}
          >
            {(control) => {
              if (input.type === 'member') {
                const members = memberDirectory.principals;
                return (
                  <div className="flex flex-col gap-2">
                    <Input
                      aria-label="Search workspace members"
                      placeholder="Search workspace members"
                      value={memberDirectory.query}
                      onChange={(event) => {
                        memberDirectory.setQuery(event.target.value);
                      }}
                    />
                    <Select
                      {...control}
                      value={value}
                      disabled={memberDirectory.status !== 'ready'}
                      onChange={(event) => {
                        update(input.key, event.target.value);
                      }}
                    >
                      <option value="">Choose a workspace member</option>
                      {members.map((member) => (
                        <option key={member.principalId} value={member.principalId}>
                          {member.displayName}
                        </option>
                      ))}
                    </Select>
                    {memberDirectory.hasMore ? (
                      <Button
                        variant="secondary"
                        disabled={memberDirectory.loadingMore}
                        onClick={() => void memberDirectory.loadMore()}
                      >
                        {memberDirectory.loadingMore ? 'Loading members' : 'Load more members'}
                      </Button>
                    ) : null}
                  </div>
                );
              }
              return (
                <Input
                  {...control}
                  type={input.type === 'date' ? 'date' : 'text'}
                  value={value}
                  required={input.required}
                  maxLength={4_096}
                  onChange={(event) => {
                    update(input.key, event.target.value);
                  }}
                />
              );
            }}
          </Field>
        );
      })}
      {memberDirectory.status === 'error' && inputs.some((input) => input.type === 'member') ? (
        <div className="flex items-center gap-2">
          <Text as="p" role="alert" variant="caption">
            Assignable principals could not be loaded.
          </Text>
          <Button variant="secondary" onClick={() => void memberDirectory.reload()}>
            Retry principal loading
          </Button>
        </div>
      ) : null}
    </Blueprint>
  );
}

export function Contents({
  mode,
  draft,
  template,
  editOperation,
  bodySync,
  itemOptions,
  onBodySync,
  onChange,
}: {
  readonly mode: StudioMode;
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly editOperation: TemplateEditDraft | null;
  readonly bodySync: CollabSync | null;
  readonly itemOptions: readonly TreeItem[];
  readonly onBodySync: (sync: CollabSync | null) => void;
  readonly onChange: (draft: TemplateDraft) => void;
}): ReactNode {
  if (mode === 'edit') {
    if (editOperation === null) {
      return (
        <StudioNotice title="Draft unavailable" detail="The editable copy could not be prepared." />
      );
    }
    return (
      <section className="flex min-w-0 flex-col gap-4">
        <Text variant="caption" tone="muted">
          Draft available until {formatDateTime(new Date(editOperation.expiresAt))}. Save before
          then to keep body edits.
        </Text>
        <TemplateDraftEditor
          root={editOperation.root}
          edits={draft.itemEdits}
          templateId={editOperation.templateId}
          operationId={editOperation.operationId}
          bodySync={bodySync}
          onBodySync={onBodySync}
          selectedSourceId={draft.selectedSourceId ?? editOperation.root.sourceId}
          onSelect={(selectedSourceId) => {
            onChange({ ...draft, selectedSourceId });
          }}
          onChange={(sourceId, itemEdit: TemplateItemEdit) => {
            onChange({
              ...draft,
              itemEdits: { ...draft.itemEdits, [sourceId]: itemEdit },
            });
          }}
        />
        <TemplateInitializationEditor
          root={applyTemplateItemEdits(editOperation.root, draft.itemEdits)}
          initialization={draft.initialization}
          itemOptions={itemOptions}
          onChange={(initialization) => {
            onChange({ ...draft, initialization });
          }}
        />
      </section>
    );
  }
  if (mode !== 'capture') {
    return (
      <section className="flex min-w-0 flex-col gap-4">
        <Text variant="h3" as="h2">
          What this template adds
        </Text>
        <TemplateFacts template={template} mode={mode} />
      </section>
    );
  }
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div>
        <Text variant="h3" as="h2">
          Choose what to capture
        </Text>
        <Text variant="bodySmall" tone="muted">
          Fields and views are always included.
        </Text>
      </div>
      <Blueprint className="flex flex-col gap-3 p-4">
        <TemplateFact label="Fields and views" value="Included" />
        <label
          aria-label="Include document content"
          className="flex min-h-(--control-lg) cursor-default items-start gap-3 py-1"
        >
          <input
            type="checkbox"
            checked={draft.includeBody}
            onChange={(event) => {
              onChange({ ...draft, includeBody: event.target.checked });
            }}
            className={`mt-0.5 size-4 ${focusRing}`}
          />
          <span>
            <Text variant="bodySmall" as="span" className="block">
              Include document content
            </Text>
            <Text variant="caption" as="span" tone="muted" className="block">
              Copies the note, canvas or sheet body.
            </Text>
          </span>
        </label>
        <label
          aria-label="Include everything inside"
          className="flex min-h-(--control-lg) cursor-default items-start gap-3 py-1"
        >
          <input
            type="checkbox"
            checked={draft.includeChildren}
            onChange={(event) => {
              onChange({ ...draft, includeChildren: event.target.checked });
            }}
            className={`mt-0.5 size-4 ${focusRing}`}
          />
          <span>
            <Text variant="bodySmall" as="span" className="block">
              Include everything inside
            </Text>
            <Text variant="caption" as="span" tone="muted" className="block">
              Copies readable child items and their values.
            </Text>
          </span>
        </label>
      </Blueprint>
    </section>
  );
}

function applyTemplateItemEdits(
  item: TemplateEditDraft['root'],
  edits: TemplateDraft['itemEdits'],
): TemplateEditDraft['root'] {
  const edit = edits[item.sourceId];
  const schema =
    edit === undefined
      ? item.schema
      : edit.schema === null
        ? null
        : {
            ...edit.schema,
            properties: edit.schema.properties.map(completePropertyDefinition),
            declared: edit.schema.declared.map(completePropertyDefinition),
          };
  return {
    ...item,
    ...(edit === undefined ? {} : { title: edit.title }),
    schema,
    children: item.children.map((child) => applyTemplateItemEdits(child, edits)),
  };
}

function completePropertyDefinition(
  property: PropertyDefinition,
): NonNullable<TemplateEditDraft['root']['schema']>['properties'][number] {
  return {
    ...property,
    expression: property.expression ?? null,
    aggregate: property.aggregate ?? null,
    source: property.source ?? null,
    choiceSource: property.choiceSource ?? null,
  };
}
