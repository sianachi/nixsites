import type { PetProfile } from '@nix/api-client';

export const petProviderLabels: Record<PetProfile['provider'], string> = {
  chatgpt: 'ChatGPT',
  anthropic: 'Claude',
  openrouter: 'OpenRouter',
};

export const petCatalog = [
  {
    appearance: 'owl',
    name: 'Owl',
    personality: 'calm',
    description: 'Calm and thoughtful. Measured explanations and gentle encouragement.',
  },
  {
    appearance: 'cat',
    name: 'Neko',
    personality: 'concise',
    description: 'An attentive calico cat with a calm, curious nature.',
  },
  {
    appearance: 'fox',
    name: 'Fox',
    personality: 'playful',
    description: 'A bright, inventive companion.',
  },
  {
    appearance: 'eye-of-ra',
    name: 'Eye of Ra',
    personality: 'encouraging',
    description: 'A watchful golden falcon companion with steady, practical guidance.',
  },
  {
    appearance: 'demiurge',
    name: 'Demiurge',
    personality: 'calm',
    description: 'A thoughtful lion-headed serpent with patient, considered guidance.',
  },
  {
    appearance: 'octopus',
    name: 'Octopus',
    personality: 'playful',
    description: 'A curious lavender octopus with restless tentacles.',
  },
  {
    appearance: 'axolotl',
    name: 'Axolotl',
    personality: 'calm',
    description: 'A gentle pink axolotl with feathery gills.',
  },
  {
    appearance: 'moth',
    name: 'Moth',
    personality: 'calm',
    description: 'A quiet silk moth with russet wings and feathery antennae.',
  },
  {
    appearance: 'pangolin',
    name: 'Pangolin',
    personality: 'concise',
    description: 'A shy golden pangolin with a curled tail.',
  },
  {
    appearance: 'phoenix-chick',
    name: 'Phoenix Chick',
    personality: 'encouraging',
    description: 'An eager young phoenix with an ember-red crest.',
  },
  {
    appearance: 'mushroom-sprite',
    name: 'Mushroom Sprite',
    personality: 'playful',
    description: 'A cheerful woodland sprite with a spotted red cap.',
  },
] as const;

export function newPet(): PetProfile {
  const preset = petCatalog[0];
  return {
    id: crypto.randomUUID(),
    name: preset.name,
    appearance: 'owl',
    personality: preset.personality,
    responseLength: 'balanced',
    instructions: '',
    applyWithoutAsking: false,
    provider: 'chatgpt',
  };
}
