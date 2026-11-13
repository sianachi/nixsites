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
    description: 'A blue owl with round glasses.',
  },
  {
    appearance: 'cat',
    name: 'Neko',
    description: 'An attentive calico cat with a calm, curious nature.',
  },
  {
    appearance: 'fox',
    name: 'Fox',
    description: 'A bright, inventive companion.',
  },
  {
    appearance: 'eye-of-ra',
    name: 'Eye of Ra',
    description: 'A golden falcon companion.',
  },
  {
    appearance: 'demiurge',
    name: 'Demiurge',
    description: 'A lion-headed serpent companion.',
  },
  {
    appearance: 'octopus',
    name: 'Octopus',
    description: 'A curious lavender octopus with restless tentacles.',
  },
  {
    appearance: 'axolotl',
    name: 'Axolotl',
    description: 'A gentle pink axolotl with feathery gills.',
  },
  {
    appearance: 'moth',
    name: 'Moth',
    description: 'A quiet silk moth with russet wings and feathery antennae.',
  },
  {
    appearance: 'pangolin',
    name: 'Pangolin',
    description: 'A shy golden pangolin with a curled tail.',
  },
  {
    appearance: 'phoenix-chick',
    name: 'Phoenix Chick',
    description: 'An eager young phoenix with an ember-red crest.',
  },
  {
    appearance: 'mushroom-sprite',
    name: 'Mushroom Sprite',
    description: 'A cheerful woodland sprite with a spotted red cap.',
  },
] as const;

export function newPet(appearance: PetProfile['appearance'] = 'owl'): PetProfile {
  const preset = petCatalog.find((entry) => entry.appearance === appearance) ?? petCatalog[0];
  return {
    id: crypto.randomUUID(),
    name: preset.name,
    appearance: preset.appearance,
    instructions: '',
    applyWithoutAsking: false,
    provider: 'chatgpt',
  };
}
