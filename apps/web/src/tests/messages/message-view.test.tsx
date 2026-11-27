import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageView } from '../../messages/message-view';

const PET = '33333333-3333-4333-8333-333333333333';
const ITEM = '11111111-1111-4111-8111-111111111111';
const execute = vi.fn();
const query = vi.fn();
const paginate = vi.fn();

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => ({ execute, query, paginate }),
}));

const message = {
  id: ITEM,
  workspaceId: '22222222-2222-4222-8222-222222222222',
  type: 'message',
  createdAt: '2026-11-27T00:00:00.000Z',
  properties: {
    $message: JSON.stringify({
      text: 'hello',
      author: { id: PET, kind: 'person', name: 'Ada', via: 'Claude' },
      to: [{ id: PET, kind: 'pet', name: 'Pip' }],
    }),
  },
};

describe('a message that addressed a pet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paginate.mockImplementation(() => ({
      // eslint-disable-next-line @typescript-eslint/require-await
      async *[Symbol.asyncIterator]() {
        yield* [];
      },
    }));
    query.mockImplementation((endpoint: { path?: string }) => {
      if (endpoint.path?.endsWith('/pet-turns'))
        return Promise.resolve({
          pets: [{ petId: PET, name: 'Pip', status: 'pending', reason: null, expiresAt: null }],
        });
      if (endpoint.path?.endsWith('/notifications')) return Promise.resolve({ items: [] });
      return Promise.resolve(message);
    });
    execute.mockResolvedValue({
      petId: PET,
      name: 'Pip',
      status: 'working',
      reason: null,
      expiresAt: null,
    });
  });

  it('shows the waiting pet to its owner with Approve and Dismiss', async () => {
    const user = userEvent.setup();
    render(<MessageView itemId={ITEM} />);
    expect(await screen.findByText(/Pip is waiting for your approval/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/items/${ITEM}/pet-turns/${PET}/approve`,
    });
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      path: `/api/v1/items/${ITEM}/pet-turns/${PET}/dismiss`,
    });
  });
});
