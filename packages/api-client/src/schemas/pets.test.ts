import { describe, expect, it } from 'vitest';
import { petConnectionSchema, petSettingsSchema } from './pets.js';

const pet = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Owl',
  appearance: 'owl',
  instructions: '',
};
const settings = {
  enabled: false,
  activePetId: pet.id,
  profiles: [pet],
};

describe('pet boundary schemas', () => {
  it('reads legacy settings while dropping retired fields', () => {
    expect(
      petSettingsSchema.parse({
        ...settings,
        motion: 'full',
        profiles: [{ ...pet, personality: 'playful', responseLength: 'detailed' }],
      }),
    ).toEqual({
      ...settings,
      profiles: [{ ...pet, applyWithoutAsking: false, provider: 'chatgpt' }],
      inlineWriting: false,
    });
  });
  it.each([
    'demiurge',
    'fox',
    'cat',
    'octopus',
    'axolotl',
    'moth',
    'pangolin',
    'phoenix-chick',
    'mushroom-sprite',
    'origami-crane',
    'jumping-spider',
    'lantern-spirit',
    'hermit-crab',
    'kirin-fawn',
    'gecko',
    'pocket-whale',
    'crystal-golem',
    'fruit-bat',
    'dust-bunny',
  ])('accepts the %s appearance', (appearance) => {
    expect(
      petSettingsSchema.parse({
        ...settings,
        profiles: [{ ...pet, appearance, name: 'Companion' }],
      }).profiles[0]?.appearance,
    ).toBe(appearance);
  });
  it.each(['Eye of Ra', 'Pip'])(
    'maps the retired design to Owl and preserves the companion named %s',
    (name) => {
      const profile = {
        ...pet,
        name,
        appearance: 'eye-of-ra',
        instructions: 'Keep my notes concise.',
      };
      const parsed = petSettingsSchema.parse({ ...settings, profiles: [profile] });
      expect(parsed.activePetId).toBe(pet.id);
      expect(parsed.profiles[0]).toMatchObject({
        ...profile,
        appearance: 'owl',
        name: name === 'Eye of Ra' ? 'Owl' : name,
      });
      expect(profile.appearance).toBe('eye-of-ra');
    },
  );
  it('rejects duplicate identities, unknown designs, and dangling active pets', () => {
    expect(petSettingsSchema.safeParse({ ...settings, profiles: [pet, pet] }).success).toBe(false);
    expect(
      petSettingsSchema.safeParse({
        ...settings,
        profiles: [pet, { ...pet, id: crypto.randomUUID() }],
      }).success,
    ).toBe(false);
    expect(
      petSettingsSchema.safeParse({ ...settings, profiles: [{ ...pet, appearance: 'unknown' }] })
        .success,
    ).toBe(false);
    expect(petSettingsSchema.safeParse({ ...settings, profiles: [] }).success).toBe(false);
    expect(
      petSettingsSchema.safeParse({ ...settings, activePetId: null, enabled: true }).success,
    ).toBe(false);
  });
  it('accepts connected accounts and rejects untrusted sign-in destinations', () => {
    expect(
      petConnectionSchema.safeParse({
        provider: 'chatgpt',
        status: 'connected',
        reason: '',
        canConnect: false,
      }).success,
    ).toBe(true);
    expect(
      petConnectionSchema.parse({
        provider: 'chatgpt',
        status: 'connected',
        reason: '',
        canConnect: false,
      }).revision,
    ).toBe(0);
    expect(
      petConnectionSchema.parse({
        provider: 'chatgpt',
        status: 'connected',
        reason: '',
        canConnect: false,
        revision: 42,
      }).revision,
    ).toBe(42);
    expect(
      petConnectionSchema.safeParse({
        provider: 'chatgpt',
        status: 'connecting',
        reason: '',
        canConnect: true,
        verificationUrl: 'https://attacker.example/login',
      }).success,
    ).toBe(false);
  });
});
