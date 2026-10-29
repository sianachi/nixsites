import type { TemplateDetail, TemplateInitialization } from '../template-api';
import {
  rootTitleHasBindings,
  type StudioMode,
  type TemplateDraft,
} from '../template-studio-model';

export function requestInputValue(
  input: TemplateInitialization['inputs'][number],
  values: Readonly<Record<string, string | null>>,
): string {
  if (Object.hasOwn(values, input.key)) return values[input.key] ?? '';
  return input.defaultValue ?? '';
}

export function requestTemplateInputs(
  initialization: TemplateInitialization,
  values: Readonly<Record<string, string | null>>,
): Record<string, string> {
  return Object.fromEntries(
    initialization.inputs.flatMap((input) => {
      if (Object.hasOwn(values, input.key)) return [[input.key, values[input.key] ?? '']];
      return input.defaultValue === null ? [] : [[input.key, input.defaultValue]];
    }),
  );
}

/** Create-mode request fields; a templated root title is left to the server unless edited. */
export function createFields(
  template: TemplateDetail | null,
  draft: TemplateDraft,
  parentItemId: string | null,
): { readonly parentItemId: string | null; readonly title?: string } {
  return {
    parentItemId,
    ...(template !== null && !draft.titleOverridden && rootTitleHasBindings(template.root.title)
      ? {}
      : { title: draft.title.trim() }),
  };
}

export function studioTitle(mode: StudioMode, templateTitle: string | undefined): string {
  const name = templateTitle ?? 'template';
  if (mode === 'capture') return 'Save as template';
  if (mode === 'create') return `Create from ${name}`;
  if (mode === 'apply') return `Apply ${name}`;
  return `Edit ${name}`;
}

export function finishLabelFor(mode: StudioMode): string {
  if (mode === 'capture') return 'Save template';
  if (mode === 'edit') return 'Save changes';
  return mode === 'apply' ? 'Apply template' : 'Create item';
}

export function destinationLabel(
  mode: StudioMode,
  targetTitle: string | null,
  parentItemId: string | null,
  titleOf: (id: string) => string | undefined,
): string {
  if (mode === 'apply') return targetTitle ?? 'Current item';
  return parentItemId === null ? 'Workspace root' : (titleOf(parentItemId) ?? 'Current item');
}

export function fileCopyStatus(
  copyingFiles: boolean,
  fileTransferJobId: string | null,
): string | null {
  if (copyingFiles) {
    return 'Copying files. Your receipt is saved so you can retry with the same request.';
  }
  return fileTransferJobId === null
    ? null
    : 'A file copy is pending. Retry this setup to resume the same request.';
}
