import { Text } from '@nix/ui';
import { lazy, Suspense, type ReactNode } from 'react';

import type { CollabSync } from '@nix/web-editor/editor/collab-sync';
import { NoteEditor } from '@nix/web-editor/editor/note-editor';
import { SheetEditor } from '../../views/sheet/sheet-editor';
import type { TemplateItem } from '../template-api';
import { templateDraftDocumentPath } from './draft-model';

const TemplateCanvasEditor = lazy(async () => {
  const module = await import('@nix/web-editor/editor/canvas-editor');
  return { default: module.CanvasEditor };
});

export function TemplateBodyEditor({
  item,
  templateId,
  operationId,
  onSync,
}: {
  readonly item: TemplateItem;
  readonly templateId: string;
  readonly operationId: string;
  readonly onSync: (sync: CollabSync | null) => void;
}): ReactNode {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div>
        <Text variant="h3" as="h3">
          Body
        </Text>
      </div>
      {!item.hasBody ? (
        <Text variant="bodySmall" tone="muted" className="rounded-md bg-surface p-3">
          Starting body content was not included when this template was captured.
        </Text>
      ) : (
        <div className="flex h-96 min-h-0 overflow-hidden rounded-md bg-background">
          <TemplateBody
            item={item}
            documentPath={templateDraftDocumentPath(templateId, operationId, item.sourceId)}
            onSync={onSync}
          />
        </div>
      )}
    </section>
  );
}

function TemplateBody({
  item,
  documentPath,
  onSync,
}: {
  readonly item: TemplateItem;
  readonly documentPath: string;
  readonly onSync: (sync: CollabSync | null) => void;
}): ReactNode {
  if (item.itemType === 'canvas') {
    return (
      <Suspense
        fallback={
          <Text tone="muted" className="m-auto">
            Loading canvas…
          </Text>
        }
      >
        <TemplateCanvasEditor
          key={documentPath}
          itemId={item.sourceId}
          documentPath={documentPath}
          onSync={onSync}
        />
      </Suspense>
    );
  }
  if (item.itemType === 'spreadsheet') {
    return (
      <SheetEditor
        key={documentPath}
        itemId={item.sourceId}
        documentPath={documentPath}
        onSync={onSync}
      />
    );
  }
  return (
    <NoteEditor
      key={documentPath}
      itemId={item.sourceId}
      documentPath={documentPath}
      onSync={onSync}
    />
  );
}
