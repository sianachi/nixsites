import { describe, expect, it } from 'vitest';

import { uiSettingsPatchSchema, uiSettingsResponseSchema } from '../schemas/ui-settings.js';
import { patchSettings, settings } from './ui-settings.js';

describe('the ui-settings resource', () => {
  it('settings is a GET of the caller-scoped path', () => {
    expect(settings()).toMatchObject({ kind: 'query', path: '/api/v1/me/ui-settings' });
  });

  it('patchSettings is a PATCH whose body wraps the patch, null deleting a key', () => {
    const patch = {
      'shell.layout': { preset: 'workspace', overrides: { advanced: true } },
      'graph.openMode': null,
    } as const;
    expect(patchSettings(patch)).toMatchObject({
      kind: 'command',
      method: 'PATCH',
      path: '/api/v1/me/ui-settings',
      body: { settings: patch },
    });
  });
});

describe('the ui-settings schemas', () => {
  it('accept the allow-listed keys with their value types and drop unknown stored keys', () => {
    const parsed = uiSettingsResponseSchema.parse({
      settings: { 'editor.pageGuides': false, 'graph.openMode': 'beside', future: 1 },
      revision: 4,
    });
    expect(parsed.settings).toEqual({ 'editor.pageGuides': false, 'graph.openMode': 'beside' });
  });

  it('refuse a wrong type or an unknown option in a patch, and allow null', () => {
    expect(uiSettingsPatchSchema.safeParse({ 'editor.pageGuides': 'yes' }).success).toBe(false);
    expect(uiSettingsPatchSchema.safeParse({ 'editor.keyboardMode': 'nano' }).success).toBe(false);
    expect(uiSettingsPatchSchema.safeParse({ 'editor.keyboardMode': null }).success).toBe(true);
  });

  it('validates the complete layout when saving or reading it', () => {
    const layout = { preset: 'essentials', overrides: { view: true } };
    const settings = { 'shell.layout': layout };
    expect(uiSettingsPatchSchema.parse(settings)).toEqual(settings);
    expect(uiSettingsResponseSchema.parse({ settings, revision: 2 }).settings).toEqual(settings);
    expect(uiSettingsPatchSchema.parse({ 'shell.layout': null })).toEqual({ 'shell.layout': null });
    expect(() =>
      uiSettingsPatchSchema.parse({ 'shell.layout': { ...layout, overrides: { unknown: true } } }),
    ).toThrow();
  });
});
