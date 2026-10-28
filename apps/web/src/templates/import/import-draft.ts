import { z } from 'zod';

import { browserSessionStorage } from '@nix/web-foundation/lib/browser-storage';
import { TemplateImportPreviewSchema, type TemplateImportPreview } from '../template-api';

const draftKey = (workspaceId: string): string => `nix:template-import:${workspaceId}`;

const FileIdentitySchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  lastModified: z.number().int().nonnegative(),
});

const ImportDraftSchema = z.object({
  importId: z.uuid().nullable(),
  preview: TemplateImportPreviewSchema.nullable(),
  idempotencyKey: z.uuid(),
  fileIdentity: FileIdentitySchema.optional(),
});

export type FileIdentity = z.infer<typeof FileIdentitySchema>;

export interface ImportDraft {
  readonly importId: string | null;
  readonly preview: TemplateImportPreview | null;
  readonly idempotencyKey: string;
  readonly fileIdentity: FileIdentity | null;
}

export function newImportDraft(): ImportDraft {
  return {
    importId: null,
    preview: null,
    idempotencyKey: globalThis.crypto.randomUUID(),
    fileIdentity: null,
  };
}

export function identify(file: File): FileIdentity {
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

export function isSameFile(file: File, identity: FileIdentity): boolean {
  return (
    file.name === identity.name &&
    file.size === identity.size &&
    file.lastModified === identity.lastModified
  );
}

export function readDraft(workspaceId: string): ImportDraft {
  try {
    const raw = browserSessionStorage()?.getItem(draftKey(workspaceId));
    if (raw === null || raw === undefined) return newImportDraft();
    const parsed = ImportDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? { ...parsed.data, fileIdentity: parsed.data.fileIdentity ?? null }
      : newImportDraft();
  } catch {
    return newImportDraft();
  }
}

export function writeDraft(workspaceId: string, draft: ImportDraft): void {
  try {
    browserSessionStorage()?.setItem(draftKey(workspaceId), JSON.stringify(draft));
  } catch {
    // Recovery storage is optional; the durable server-side attempt remains authoritative.
  }
}

export function forgetDraft(workspaceId: string): void {
  try {
    browserSessionStorage()?.removeItem(draftKey(workspaceId));
  } catch {
    // A blocked storage API must not block cancellation or navigation.
  }
}
