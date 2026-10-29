import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ForgetMemory } from '../../../pets/work-tools/forget-memory';

const client = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));

const memory = (text: string, id: string) => ({ id, text, createdAt: '2026-10-29T00:00:00.000Z' });

describe('forgetting a memory from the chat', () => {
  it('drops that fact only, at the revision it read', async () => {
    client.query.mockResolvedValue({
      revision: 4,
      settings: {
        enabled: true,
        activePetId: null,
        motion: 'system',
        profiles: [],
        inlineWriting: false,
        memories: [
          memory('Works in London.', '55555555-5555-4555-8555-555555555555'),
          memory('Prefers metric units.', '66666666-6666-4666-8666-666666666666'),
        ],
        memoryMode: 'always',
      },
    });
    client.execute.mockResolvedValue({ revision: 5, settings: {} });
    render(<ForgetMemory result={JSON.stringify({ remembered: 'Prefers metric units.' })} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Undo' }));

    const saved = client.execute.mock.calls[0]?.[0] as {
      body: { expectedRevision: number; settings: { memories: { text: string }[] } };
    };
    expect(saved.body.expectedRevision).toBe(4);
    expect(saved.body.settings.memories.map((entry) => entry.text)).toEqual(['Works in London.']);
    expect(await screen.findByRole('button', { name: 'Forgotten' })).toBeDisabled();
  });

  it('offers nothing for a fact that was already known', () => {
    const { container } = render(
      <ForgetMemory
        result={JSON.stringify({ remembered: 'Works in London.', alreadyKnown: true })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
