import type { NixClient } from '@nix/api-client';

import {
  saveTemplateEditDraft,
  updateTemplateEditDraft,
  updateTemplateEditDraftItem,
  type TemplateDetail,
  type TemplateEditDraft,
} from '../template-api';
import type { TemplateDraft } from '../template-studio-model';

/** Writes the edit draft, then saves it. 'stale' means the operation was superseded mid-way. */
export async function saveTemplateEdit(
  client: NixClient,
  template: TemplateDetail,
  activeEdit: TemplateEditDraft,
  draft: TemplateDraft,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<'saved' | 'invalid' | 'stale'> {
  if (Object.values(draft.itemEdits).some((itemEdit) => itemEdit.title.trim().length === 0)) {
    return 'invalid';
  }
  await client.execute(
    updateTemplateEditDraft(template.id, activeEdit.operationId, {
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      initialization: draft.initialization,
    }),
    { signal },
  );
  for (const [sourceId, itemEdit] of Object.entries(draft.itemEdits)) {
    await client.execute(
      updateTemplateEditDraftItem(template.id, activeEdit.operationId, sourceId, {
        title: itemEdit.title.trim(),
        schema: itemEdit.schema ?? null,
        views: itemEdit.views ?? null,
      }),
      { signal },
    );
    if (signal.aborted || !isCurrent()) return 'stale';
  }
  await client.execute(saveTemplateEditDraft(template, activeEdit.operationId), { signal });
  return signal.aborted || !isCurrent() ? 'stale' : 'saved';
}
