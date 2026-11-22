import { lazy } from 'react';

// Screens opened on demand (a dialog or a secondary route), each its own chunk so the first
// load of the editor does not carry them. The service worker still precaches every chunk.
export const AttachmentsPage = lazy(async () => ({
  default: (await import('../pages/attachments-page')).AttachmentsPage,
}));
export const SettingsPage = lazy(async () => ({
  default: (await import('../pages/settings-page')).SettingsPage,
}));
export const TrashPage = lazy(async () => ({
  default: (await import('../pages/trash-page')).TrashPage,
}));
export const CreationStudioPage = lazy(async () => ({
  default: (await import('../pages/creation-studio-page')).CreationStudioPage,
}));
export const PetActivityPage = lazy(async () => ({
  default: (await import('../pages/pet-activity-page')).PetActivityPage,
}));
export const TemplateLibraryPage = lazy(async () => ({
  default: (await import('@nix/web-templates/templates/library/template-library-page'))
    .TemplateLibraryPage,
}));
export const TemplateImportPage = lazy(async () => ({
  default: (await import('@nix/web-templates/templates/import/template-import-page'))
    .TemplateImportPage,
}));
