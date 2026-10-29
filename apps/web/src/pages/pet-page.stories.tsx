import type { ReactElement } from 'react';
import {
  AutoOpenCompanion,
  expectChatControls,
  PHONE_WORKSPACE,
  PhoneFrame,
} from '@nix/web-pets/pets/pet-story-fixtures';
import { PetPage } from './pet-page';

// The phone stories that open the pet page. They share the 'Nix/Companions' title with the
// package's pets.stories.tsx, so their story ids are unchanged.
export default { title: 'Nix/Companions', parameters: { layout: 'padded' } };

export const ConversationPhone = {
  render: (): ReactElement => (
    <PhoneFrame petPage={<PetPage />}>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
};
export const NoteConversationPhone280 = {
  render: (): ReactElement => (
    <PhoneFrame
      petPage={<PetPage />}
      width={280}
      initialEntry={`/w/${PHONE_WORKSPACE}/pet?root=66666666-6666-4666-8666-666666666666`}
    >
      <PetPage />
    </PhoneFrame>
  ),
};
export const DarkNoteConversationPhone280 = {
  ...NoteConversationPhone280,
  globals: { ground: 'dark' },
};

export const DarkConversationPhone = { ...ConversationPhone, globals: { ground: 'dark' } };

export const ConversationPhone320 = {
  render: (): ReactElement => (
    <PhoneFrame width={320} petPage={<PetPage />}>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
};
export const DarkConversationPhone320 = {
  ...ConversationPhone320,
  globals: { ground: 'dark' },
};

export const ConversationPhone280 = {
  render: (): ReactElement => (
    <PhoneFrame width={280} petPage={<PetPage />}>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
};
export const DarkConversationPhone280 = {
  ...ConversationPhone280,
  globals: { ground: 'dark' },
};

export const ConversationPhoneLandscape = {
  render: (): ReactElement => (
    <PhoneFrame width={568} height={320} petPage={<PetPage />}>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
};
export const DarkConversationPhoneLandscape = {
  ...ConversationPhoneLandscape,
  globals: { ground: 'dark' },
};

export const ConversationControlsPhone = {
  render: (): ReactElement => (
    <PhoneFrame width={320} petPage={<PetPage />}>
      <AutoOpenCompanion />
    </PhoneFrame>
  ),
  play: expectChatControls,
};
