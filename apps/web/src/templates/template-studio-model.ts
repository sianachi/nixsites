import {
  emptyTemplateInitialization,
  templateInitializationSchema,
  type TemplateInitialization,
} from '@nix/api-client';
import { z } from 'zod';

import { EffectiveSchemaSchema, ViewSchema } from '@nix/web-collections/core/container-model';
import { browserSessionStorage } from '@nix/web-foundation/lib/browser-storage';
import { type TemplateEditDraft } from './template-api';
import { type TemplateItemEdits } from './draft/template-draft-editor';

export type StudioMode = 'capture' | 'create' | 'apply' | 'edit';

export interface TemplateDraft {
  readonly scope: string;
  readonly title: string;
  readonly titleOverridden: boolean;
  readonly description: string;
  readonly includeBody: boolean;
  readonly includeChildren: boolean;
  readonly idempotencyKey: string;
  readonly operationId: string | null;
  readonly fileTransferJobId: string | null;
  readonly expiresAt: string | null;
  readonly selectedSourceId: string | null;
  readonly itemEdits: TemplateItemEdits;
  readonly initialization: TemplateInitialization;
  /** null means the user explicitly cleared a default; omission means use the default. */
  readonly inputValues: Readonly<Record<string, string | null>>;
}

export interface RootTemplateFacts {
  readonly fieldCount: number;
  readonly viewCount: number;
  readonly viewKinds: readonly string[];
}

export type CaptureFacts =
  { readonly status: 'loading' | 'error' } | ({ readonly status: 'ready' } & RootTemplateFacts);

export const TEMPLATE_STUDIO_STEPS = [
  { label: 'Basics', detail: 'Name and destination' },
  { label: 'Contents', detail: 'What this carries' },
  { label: 'Review', detail: 'Check and finish' },
] as const;

const TemplateDraftRecoverySchema = z.object({
  scope: z.string(),
  title: z.string(),
  titleOverridden: z.boolean().optional().default(false),
  description: z.string(),
  includeBody: z.boolean(),
  includeChildren: z.boolean(),
  idempotencyKey: z.string(),
  operationId: z.string().nullable(),
  fileTransferJobId: z.string().nullable().optional().default(null),
  expiresAt: z.string().nullable(),
  selectedSourceId: z.string().nullable(),
  itemEdits: z.record(
    z.string(),
    z.object({
      title: z.string(),
      schema: EffectiveSchemaSchema.nullable().optional(),
      views: z
        .object({ views: z.array(ViewSchema), default: z.string() })
        .nullable()
        .optional(),
    }),
  ),
  initialization: templateInitializationSchema.optional().default(emptyTemplateInitialization),
  inputValues: z.record(z.string(), z.string().nullable()).optional().default({}),
});

export function modeFromPath(pathname: string): StudioMode {
  if (pathname.endsWith('/edit')) return 'edit';
  if (pathname.includes('/templates/apply/')) return 'apply';
  if (pathname.endsWith('/create')) return 'create';
  return 'capture';
}

export function newDraft(title: string, scope: string): TemplateDraft {
  return {
    scope,
    title,
    titleOverridden: false,
    description: '',
    includeBody: false,
    includeChildren: false,
    idempotencyKey: globalThis.crypto.randomUUID(),
    operationId: null,
    fileTransferJobId: null,
    expiresAt: null,
    selectedSourceId: null,
    itemEdits: {},
    initialization: emptyTemplateInitialization,
    inputValues: {},
  };
}

export function authoredRootTitle(template: {
  readonly title: string;
  readonly root: { readonly title: string };
}): string {
  return /\{\{[a-zA-Z0-9_]+\}\}/.test(template.root.title) ? template.root.title : template.title;
}

export function rootTitleHasBindings(title: string): boolean {
  return /\{\{[a-zA-Z0-9_]+\}\}/.test(title);
}

export function draftScope(
  mode: StudioMode,
  templateId: string | undefined,
  sourceItemId: string | null,
  itemId: string | undefined,
  parentItemId: string | null,
): string {
  if (mode === 'capture') return `source:${sourceItemId ?? 'missing'}`;
  if (mode === 'apply') {
    return `template:${templateId ?? 'missing'}:target:${itemId ?? 'missing'}`;
  }
  if (mode === 'create') {
    return `template:${templateId ?? 'missing'}:parent:${parentItemId ?? 'root'}`;
  }
  return `template:${templateId ?? 'missing'}`;
}

export function storageKey(workspaceId: string, mode: StudioMode, scope: string): string {
  return `nix:template-studio:${workspaceId}:${mode}:${scope}`;
}

export function distinctViewKinds(views: readonly { readonly kind: string }[]): readonly string[] {
  return [...new Set(views.map((view) => view.kind))];
}

export function editedRootFacts(
  editOperation: TemplateEditDraft | null,
  draft: TemplateDraft,
): RootTemplateFacts | null {
  if (editOperation === null) return null;
  const edit = draft.itemEdits[editOperation.root.sourceId];
  const schema = edit?.schema ?? editOperation.root.schema;
  const views = edit?.views ?? editOperation.root.views;
  return {
    fieldCount: schema?.properties.length ?? 0,
    viewCount: views?.views.length ?? 0,
    viewKinds: distinctViewKinds(views?.views ?? []),
  };
}

export function readDraft(
  key: string,
  fallback: TemplateDraft,
): { readonly draft: TemplateDraft; readonly recovered: boolean } {
  const raw = browserSessionStorage()?.getItem(key);
  if (raw === null || raw === undefined) return { draft: fallback, recovered: false };
  try {
    const parsed = TemplateDraftRecoverySchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.scope !== fallback.scope) {
      return { draft: fallback, recovered: false };
    }
    return {
      draft: { ...parsed.data, itemEdits: parsed.data.itemEdits as TemplateItemEdits },
      recovered: true,
    };
  } catch {
    return { draft: fallback, recovered: false };
  }
}
