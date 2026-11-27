import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PetMemorySection } from '../../pets/pet-memory-section';

const at = '2026-10-29T00:00:00.000Z';
const id = '55555555-5555-4555-8555-555555555555';

describe('the memory list', () => {
  it('says where a fact was learned, and forgets it with the existing control', async () => {
    const onChange = vi.fn();
    render(
      <PetMemorySection
        mode="always"
        onChange={onChange}
        memories={[
          {
            id,
            text: 'Likes tea.',
            createdAt: at,
            source: { kind: 'message', id, title: 'Plan', author: 'Ada via Claude' },
          },
          { id: '66666666-6666-4666-8666-666666666666', text: 'Works in London.', createdAt: at },
        ]}
      />,
    );
    expect(screen.getByText('Learned in Plan, from Ada via Claude')).toBeTruthy();
    expect(screen.getAllByText(/Learned in/)).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Forget "Likes tea."' }));
    expect(onChange).toHaveBeenCalledWith(
      [expect.objectContaining({ text: 'Works in London.' })],
      'always',
    );
  });
});
