import { Field, Icon, Input, Text, cn, focusRing } from '@nix/ui';
import { FileText } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { CollabSync } from '@nix/web-editor/editor/collab-sync';
import type { TemplateItem } from '../template-api';
import { currentItem, flatten, type TemplateItemEdit, type TemplateItemEdits } from './draft-model';
import { TemplateBodyEditor } from './template-body-editor';
import { TemplateFieldsEditor } from './template-fields-editor';
import { TemplateViewsEditor } from './template-views-editor';

export { templateDraftDocumentPath } from './draft-model';
export type { TemplateItemEdit, TemplateItemEdits } from './draft-model';

export function TemplateDraftEditor({
  root,
  edits,
  selectedSourceId,
  templateId,
  operationId,
  bodySync,
  onBodySync,
  onSelect,
  onChange,
}: {
  readonly root: TemplateItem;
  readonly edits: TemplateItemEdits;
  readonly selectedSourceId: string;
  readonly templateId: string;
  readonly operationId: string;
  readonly bodySync: CollabSync | null;
  readonly onBodySync: (sync: CollabSync | null) => void;
  readonly onSelect: (sourceId: string) => void;
  readonly onChange: (sourceId: string, edit: TemplateItemEdit) => void;
}): ReactNode {
  const items = flatten(root);
  const selected = items.find(({ item }) => item.sourceId === selectedSourceId)?.item ?? root;
  const edit = currentItem(selected, edits);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const previousSelectedSourceId = useRef(selected.sourceId);
  const itemNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (previousSelectedSourceId.current === selected.sourceId) return;
    previousSelectedSourceId.current = selected.sourceId;
    itemNameRef.current?.focus();
  }, [selected.sourceId]);

  return (
    <section className="@container/draft flex min-w-0 flex-col gap-4">
      <div>
        <Text variant="h3" as="h2">
          Edit the template contents
        </Text>
        <Text variant="bodySmall" tone="muted">
          Changes stay in a private draft until Save.
        </Text>
      </div>

      <div className="grid min-h-0 min-w-0 gap-4 @2xl/draft:grid-cols-4">
        <nav aria-label="Items in this template" className="min-w-0 rounded-md bg-surface p-2">
          <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
            {items.map(({ item, depth }) => (
              <li key={item.sourceId}>
                <button
                  type="button"
                  disabled={item.sourceId === selected.sourceId}
                  aria-current={item.sourceId === selected.sourceId ? 'page' : undefined}
                  onClick={() => {
                    void (async () => {
                      try {
                        await bodySync?.flushAndWait();
                        setBodyError(null);
                        onSelect(item.sourceId);
                      } catch {
                        setBodyError(
                          'The current body has not finished saving. Keep this item open and try again.',
                        );
                      }
                    })();
                  }}
                  className={cn(
                    'flex min-h-(--control-lg) min-w-0 w-full items-center gap-2 rounded-sm py-1.5 pr-2 text-left',
                    depth === 0 ? 'pl-2' : depth === 1 ? 'pl-4' : depth === 2 ? 'pl-6' : 'pl-8',
                    item.sourceId === selected.sourceId
                      ? 'bg-accent/10 text-accent-text'
                      : 'hover:bg-foreground/7',
                    focusRing,
                  )}
                >
                  <Icon icon={FileText} size="sm" className="shrink-0" />
                  <span className="truncate">{currentItem(item, edits).title || 'Untitled'}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-4 @2xl/draft:col-span-3">
          {bodyError === null ? null : (
            <Text variant="bodySmall" role="alert" className="rounded-md bg-surface px-3 py-2">
              {bodyError}
            </Text>
          )}
          <Field label="Item name">
            {(control) => (
              <Input
                {...control}
                ref={itemNameRef}
                value={edit.title}
                onChange={(event) => {
                  onChange(selected.sourceId, { ...edit, title: event.target.value });
                }}
              />
            )}
          </Field>

          <TemplateFieldsEditor
            edit={edit}
            onChange={(next) => {
              onChange(selected.sourceId, next);
            }}
          />

          <TemplateViewsEditor
            edit={edit}
            onChange={(next) => {
              onChange(selected.sourceId, next);
            }}
          />

          <TemplateBodyEditor
            key={selected.sourceId}
            item={selected}
            templateId={templateId}
            operationId={operationId}
            onSync={onBodySync}
          />
        </div>
      </div>
    </section>
  );
}
