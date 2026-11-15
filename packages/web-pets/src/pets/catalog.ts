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
  {
    appearance: 'origami-crane',
    name: 'Origami Crane',
    description: 'A thoughtful paper crane with crisp blue-edged wings.',
  },
  {
    appearance: 'jumping-spider',
    name: 'Jumping Spider',
    description: 'A curious little spider with fluffy teal legs and bright amber eyes.',
  },
  {
    appearance: 'lantern-spirit',
    name: 'Lantern Spirit',
    description: 'A warm paper lantern with a gentle glow and a swaying golden tassel.',
  },
  {
    appearance: 'hermit-crab',
    name: 'Hermit Crab',
    description: 'A shy coral crab carrying a tiny house with a blue front door.',
  },
  {
    appearance: 'kirin-fawn',
    name: 'Kirin Fawn',
    description: 'A playful young kirin with golden antlers and turquoise scales.',
  },
  {
    appearance: 'gecko',
    name: 'Gecko',
    description: 'An inquisitive mint-green gecko with a curled turquoise tail.',
  },
  {
    appearance: 'pocket-whale',
    name: 'Pocket Whale',
    description: 'A little blue whale that glides through the air.',
  },
  {
    appearance: 'crystal-golem',
    name: 'Crystal Golem',
    description: 'A patient stone companion with glowing lavender crystals.',
  },
  {
    appearance: 'fruit-bat',
    name: 'Fruit Bat',
    description: 'A sleepy cocoa-brown bat with enormous ears and soft folded wings.',
  },
  {
    appearance: 'dust-bunny',
    name: 'Dust Bunny',
    description: 'A bouncy lavender fluffball with rabbit ears and a copper button.',
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
