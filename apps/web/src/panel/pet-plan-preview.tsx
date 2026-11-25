import type { PetPlanPreparedStep } from '@nix/api-client';
import type { PreviewModel, PreviewNode } from '@nix/structure-spec';
import { Text, focusRing } from '@nix/ui';
import { ValueFields } from '@nix/web-pets/pets/approval/value-fields';
import { PetBodyEditPreview } from '@nix/web-pets/pets/pet-body-edit-preview';
import { PetStructurePreview } from '@nix/web-pets/pets/pet-structure-preview';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { PetCanvasDecision } from './pet-canvas-review';
import { parseCanvasReview } from './pet-canvas-review-scene';
import { PetRunProposalPreview } from './pet-run-card';

const node: z.ZodType<PreviewNode> = z.lazy(() =>
  z
    .strictObject({
      label: z.string(),
      detail: z.array(z.string()),
      children: z.array(node),
      why: z.string().optional(),
    })
    .transform(({ why, ...rest }) => ({ ...rest, ...(why === undefined ? {} : { why }) })),
);
const problem = z
  .strictObject({
    path: z.string(),
    code: z.string(),
    message: z.string(),
    modelMessage: z.string().optional(),
  })
  .transform(({ modelMessage, ...rest }) => ({
    ...rest,
    ...(modelMessage === undefined ? {} : { modelMessage }),
  }));
const range = z.strictObject({ start: z.number(), end: z.number() });
const bodyEdit = z
  .strictObject({
    scope: z.enum(['section', 'paragraph', 'list item', 'heading', 'code block', 'table cell']),
    subject: z.string(),
    before: z.string(),
    after: z.string(),
    blocksRemoved: z.number(),
    blocksAdded: z.number(),
    losesFormatting: z.boolean(),
    beforeRange: range.optional(),
    afterRange: range.optional(),
  })
  .transform(({ beforeRange, afterRange, ...rest }) => ({
    ...rest,
    ...(beforeRange === undefined ? {} : { beforeRange }),
    ...(afterRange === undefined ? {} : { afterRange }),
  }));
const model: z.ZodType<PreviewModel> = z
  .strictObject({
    headline: z.string(),
    destination: z.strictObject({ title: z.string(), path: z.array(z.string()) }),
    counts: z.strictObject({
      items: z.number(),
      fields: z.number(),
      views: z.number(),
      entries: z.number(),
      writes: z.number(),
    }),
    tree: z.array(node),
    notes: z.array(z.string()),
    warnings: z.array(problem),
    problems: z.array(problem),
    neverDoes: z.array(z.string()),
    bodyEdit: bodyEdit.optional(),
  })
  .transform(({ bodyEdit: edit, ...rest }) => ({
    ...rest,
    ...(edit === undefined ? {} : { bodyEdit: edit }),
  }));
const workspace = z.strictObject({
  kind: z.literal('workspace'),
  preview: model,
  values: z.record(z.string(), z.json()),
});
const rename = z.strictObject({
  from: z.string(),
  to: z.string(),
  itemId: z.uuid().nullish(),
  revision: z.union([z.number(), z.string()]).optional(),
});
const targets = z.object({
  itemId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  templateId: z.uuid().optional(),
});

export function hasTypedPlanPreview(step: PetPlanPreparedStep): boolean {
  if (['canvas.edit', 'sheet.edit', 'task.comment', 'comment.create'].includes(step.capability))
    return true;
  return (
    workspace.safeParse(step.effect.parameters).success ||
    (step.capability === 'task.rename' && rename.safeParse(step.effect.parameters).success)
  );
}

export function validPlanPreview(step: PetPlanPreparedStep): boolean {
  if (!step.capability.startsWith('workspace.')) return true;
  const parsed = workspace.safeParse(step.effect.parameters);
  return parsed.success && parsed.data.preview.problems.length === 0;
}

export function PetPlanStepPreview({
  step,
  onReady,
  onRefresh,
}: {
  readonly step: PetPlanPreparedStep;
  readonly onReady?: ((ready: boolean) => void) | undefined;
  readonly onRefresh?: (() => void) | undefined;
}): ReactElement {
  if (step.capability === 'canvas.edit') {
    const draft = parseCanvasReview(step.effect.parameters);
    if (draft === null)
      return <Text role="alert">The drawing preview is unavailable. Prepare a fresh plan.</Text>;
    return (
      <div className="flex h-96 min-w-0 flex-col">
        <PetCanvasDecision
          draft={draft}
          heading={step.effect.description}
          stale={step.status === 'stale'}
          busy={false}
          error={null}
          onApprove={() => Promise.resolve()}
          onDecline={() => undefined}
          onRequestChanges={() => undefined}
          onRefresh={() => {
            onRefresh?.();
          }}
          planReview={{
            onReady: (ready) => {
              onReady?.(ready);
            },
          }}
        />
      </div>
    );
  }
  if (['sheet.edit', 'task.comment', 'comment.create'].includes(step.capability))
    return (
      <PetRunProposalPreview
        proposal={{
          id: step.id,
          capability: step.capability,
          description: step.effect.description,
          preview: step.effect.parameters,
          status: step.status,
        }}
      />
    );
  const parsed = workspace.safeParse(step.effect.parameters);
  if (parsed.success) {
    const fields = new Map(step.fields.map((field) => [field.id, field.label]));
    return (
      <>
        <PetStructurePreview model={parsed.data.preview} pending>
          {parsed.data.preview.bodyEdit === undefined ? null : (
            <PetBodyEditPreview edit={parsed.data.preview.bodyEdit} />
          )}
        </PetStructurePreview>
        {Object.entries(parsed.data.values)
          .filter(
            ([key]) =>
              !['itemId', 'parentId', 'templateId'].includes(key) &&
              !(key === 'markdown' && parsed.data.preview.bodyEdit !== undefined),
          )
          .map(([key, value]) => (
            <ValueFields
              key={key}
              label={fields.get(key) ?? (key === 'markdown' ? 'Text to add' : key)}
              value={value}
            />
          ))}
      </>
    );
  }
  const title = rename.safeParse(step.effect.parameters);
  if (step.capability === 'task.rename' && title.success)
    return (
      <div role="group" aria-label="Title values" className="grid min-w-0 gap-2 @lg:grid-cols-2">
        <ValueFields label="Current Title" value={title.data.from} />
        <ValueFields label="Proposed Title" value={title.data.to} />
      </div>
    );
  return <ValueFields label="Change details" value={step.effect.parameters} />;
}

export function PetPlanTargetLinks({
  step,
  workspaceId,
}: {
  readonly step: PetPlanPreparedStep;
  readonly workspaceId: string;
}): ReactElement {
  const parsed = workspace.safeParse(step.effect.parameters);
  const values = targets.safeParse(parsed.success ? parsed.data.values : step.arguments);
  const effectTarget = z.object({ itemId: z.uuid() }).safeParse(step.effect.parameters);
  const entries: [string, string][] = values.success
    ? Object.entries(values.data).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      )
    : [];
  if (effectTarget.success && !entries.some(([, id]) => id === effectTarget.data.itemId))
    entries.push(['itemId', effectTarget.data.itemId]);
  const templateItem = ['workspace.read_template', 'workspace.apply_template'].includes(
    step.capability,
  );
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([key, id]) => {
        const template = key === 'templateId' || (key === 'itemId' && templateItem);
        return (
          <a
            key={`${key}:${id}`}
            href={
              template ? `/w/${workspaceId}/templates/${id}/create` : `/w/${workspaceId}?item=${id}`
            }
            className={`inline-flex min-h-(--control-lg) items-center underline ${focusRing}`}
          >
            <Text as="span" variant="note">
              {template
                ? 'Review template'
                : key === 'parentId'
                  ? 'Inspect destination'
                  : 'Inspect target item'}
            </Text>
          </a>
        );
      })}
    </div>
  );
}
