import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MessageComposer } from '../../messages/message-composer';

const PET = '33333333-3333-4333-8333-333333333333';
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
    execute.mockResolvedValue({ id: 'new' });
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
