/** The caller's synced interface settings, as `GET/PATCH /api/v1/me/ui-settings` carry them. */

import { z } from 'zod';

/** The allow-list the server enforces; a key outside it is refused with 422. */
const settingShapes = {
  'editor.keyboardMode': z.enum(['standard', 'vim', 'emacs']),
  'editor.textWidth': z.enum(['reading', 'full']),
  'editor.pageGuides': z.boolean(),
  'editor.phraseSuggestions': z.boolean(),
  'editor.unlinkedMentionUnderline': z.boolean(),
  'editor.viewSuggestions': z.enum(['on', 'off']),
  'editor.choiceOrder': z.enum(['on', 'off']),
  'dailyNotes.openTodayOnStart': z.boolean(),
  'sites.publishingEnabled': z.boolean(),
  'graph.openMode': z.enum(['page', 'dialog', 'beside', 'tab']),
} as const;

/** Stored settings: a key the person never set is absent, and keys a newer server adds are dropped. */
const uiSettingsSchema = z.object(settingShapes).partial();

/** A patch: a value sets the key, `null` deletes it, an absent key is left alone. */
export const uiSettingsPatchSchema = z.object({
  'editor.keyboardMode': settingShapes['editor.keyboardMode'].nullable().optional(),
  'editor.textWidth': settingShapes['editor.textWidth'].nullable().optional(),
  'editor.pageGuides': settingShapes['editor.pageGuides'].nullable().optional(),
  'editor.phraseSuggestions': settingShapes['editor.phraseSuggestions'].nullable().optional(),
  'editor.unlinkedMentionUnderline': settingShapes['editor.unlinkedMentionUnderline']
    .nullable()
    .optional(),
  'editor.viewSuggestions': settingShapes['editor.viewSuggestions'].nullable().optional(),
  'editor.choiceOrder': settingShapes['editor.choiceOrder'].nullable().optional(),
  'dailyNotes.openTodayOnStart': settingShapes['dailyNotes.openTodayOnStart'].nullable().optional(),
  'sites.publishingEnabled': settingShapes['sites.publishingEnabled'].nullable().optional(),
  'graph.openMode': settingShapes['graph.openMode'].nullable().optional(),
});

export const uiSettingsResponseSchema = z.object({
  settings: uiSettingsSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export type UiSettings = z.infer<typeof uiSettingsSchema>;
export type UiSettingsPatch = z.infer<typeof uiSettingsPatchSchema>;
export type UiSettingsResponse = z.infer<typeof uiSettingsResponseSchema>;
