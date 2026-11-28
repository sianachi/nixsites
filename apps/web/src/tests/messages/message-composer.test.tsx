import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MessageComposer } from '../../messages/message-composer';

const PET = '33333333-3333-4333-8333-333333333333';
const AGENT = '55555555-5555-4555-8555-555555555555';
const PERSON = '44444444-4444-4444-8444-444444444444';
const execute = vi.fn();
const query = vi.fn();

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => ({ execute, query }),
}));

describe('the message composer', () => {
  it('turns an address pick into the explicit to list and sends only those still named', async () => {
    query.mockResolvedValue({
      addressees: [
        { id: PET, name: 'Pip', kind: 'pet' },
        { id: PERSON, name: 'Ada', kind: 'person' },
      ],
    });
    execute.mockResolvedValue({ message: { id: 'new' }, pets: [], budget: null });
    const onPosted = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer workspaceId="w" parentId="p" onPosted={onPosted} />);

    await user.click(screen.getByRole('button', { name: 'Address someone' }));
    await user.click(await screen.findByRole('button', { name: 'Pip (pet)' }));
    await user.click(screen.getByRole('button', { name: 'Address someone' }));
    await user.click(await screen.findByRole('button', { name: 'Ada' }));
    // Ada is removed from the text, so she is not addressed.
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.clear(box);
    await user.type(box, '@Pip hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(onPosted).toHaveBeenCalledWith({ id: 'new' }, true);
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      path: '/api/v1/items/p/messages',
      body: { text: '@Pip hello', to: [{ id: PET, kind: 'pet' }] },
    });
  });

  it('opens the picker at an @, filters as you type, picks with the keyboard and keeps the rest of the text', async () => {
    query.mockImplementation((endpoint: { query?: { query?: string } }) =>
      Promise.resolve({
        addressees: [
          { id: PET, name: 'Pip', kind: 'pet' },
          { id: PERSON, name: 'Ada', kind: 'person' },
          { id: AGENT, name: 'Grok', kind: 'agent' },
        ].filter((entry) => entry.name.toLowerCase().includes(endpoint.query?.query ?? '')),
      }),
    );
    execute.mockResolvedValue({ message: { id: 'new' }, pets: [], budget: null });
    const user = userEvent.setup();
    render(<MessageComposer workspaceId="w" parentId="p" onPosted={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'hi @');
    expect(await screen.findByRole('option', { name: 'Grok (agent)' })).toBeTruthy();
    await user.type(box, 'g');
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(1);
    });
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('hi @Grok ');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('now{Enter}');
    await waitFor(() => {
      expect(execute).toHaveBeenCalled();
    });
    expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({
      body: { text: 'hi @Grok now', to: [{ id: AGENT, kind: 'agent' }] },
    });
  });

  it('closes the inline picker with Escape without losing the text, and Enter then sends', async () => {
    query.mockResolvedValue({ addressees: [{ id: PET, name: 'Pip', kind: 'pet' }] });
    const user = userEvent.setup();
    render(<MessageComposer workspaceId="w" parentId="p" onPosted={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, '@p');
    expect(await screen.findByRole('listbox')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box).toHaveValue('@p');
  });

  it('says why a refused message was not sent and keeps the text', async () => {
    execute.mockRejectedValue(Object.assign(new Error('x'), { code: 'messages.invalid' }));
    const user = userEvent.setup();
    render(<MessageComposer workspaceId="w" parentId="p" onPosted={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not sent|cannot read/i);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('hi');
  });
});
