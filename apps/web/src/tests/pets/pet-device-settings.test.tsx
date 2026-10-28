import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PetDeviceSettings } from '../../pets/pet-device-settings';

describe('pet device settings', () => {
  it('tag the rows that stay on this device', () => {
    render(<PetDeviceSettings inlineWriting={false} />);

    expect(screen.getByRole('group', { name: 'This device' })).toContainElement(
      screen.getByLabelText('Chat opens'),
    );
  });
});
