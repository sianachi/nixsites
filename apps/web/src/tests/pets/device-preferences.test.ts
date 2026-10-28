import { beforeEach, describe, expect, it } from 'vitest';
import {
  readConversationModel,
  writeConversationModel,
} from '@nix/web-foundation/lib/device-preferences';

const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const PET = '44444444-4444-4444-8444-444444444444';

describe('pet model preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('retains the historical ChatGPT choice without sharing it with other providers', () => {
    localStorage.setItem(`nix.pet.model.${WORKSPACE}.${PET}.chat`, 'gpt-model');
    expect(readConversationModel(WORKSPACE, PET, 'chatgpt')).toBe('gpt-model');
    expect(readConversationModel(WORKSPACE, PET, 'anthropic')).toBe('');
    expect(readConversationModel(WORKSPACE, PET, 'openrouter')).toBe('');

    writeConversationModel(WORKSPACE, PET, 'anthropic', 'claude-model');
    writeConversationModel(WORKSPACE, PET, 'openrouter', 'router-model');
    expect(readConversationModel(WORKSPACE, PET, 'chatgpt')).toBe('gpt-model');
    expect(readConversationModel(WORKSPACE, PET, 'anthropic')).toBe('claude-model');
    expect(readConversationModel(WORKSPACE, PET, 'openrouter')).toBe('router-model');
  });

  it('uses the legacy session choice only for ChatGPT', () => {
    sessionStorage.setItem(`nix.pet.model.${WORKSPACE}.${PET}`, 'old-gpt-model');
    expect(readConversationModel(WORKSPACE, PET, 'chatgpt')).toBe('old-gpt-model');
    expect(readConversationModel(WORKSPACE, PET, 'anthropic')).toBe('');
    expect(readConversationModel(WORKSPACE, PET, 'openrouter')).toBe('');
  });
});
