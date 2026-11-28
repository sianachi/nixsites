import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageView } from '../../messages/message-view';

const PET = '33333333-3333-4333-8333-333333333333';
const ITEM = '11111111-1111-4111-8111-111111111111';
const execute = vi.fn();
const query = vi.fn();
const paginate = vi.fn();
const client = { execute, query, paginate };

vi.mock('@nix/web-pets/pets/pet-avatar', () => ({
  PetAvatar: ({ label }: { label: string }) => <span data-testid="pet-avatar">{label}</span>,
}));

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
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
    Element.prototype.scrollIntoView = vi.fn();
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

  it('offers a fact the pet wants to remember with Remember and Dismiss', async () => {
    query.mockImplementation((endpoint: { path?: string }) => {
      if (endpoint.path?.endsWith('/pet-turns'))
        return Promise.resolve({
          pets: [
            {
              petId: PET,
              name: 'Pip',
              status: 'answered',
              reason: null,
              expiresAt: null,
              memory: 'Prefers metric units',
            },
          ],
        });
      if (endpoint.path?.endsWith('/notifications')) return Promise.resolve({ items: [] });
      return Promise.resolve(message);
    });
    const user = userEvent.setup();
    render(<MessageView itemId={ITEM} />);
    expect(await screen.findByText(/Wants to remember: Prefers metric units/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remember' }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      path: `/api/v1/items/${ITEM}/pet-turns/${PET}/approve`,
    });
  });
});

const ME = '44444444-4444-4444-8444-444444444444';

function reply(id: string, author: object, text: string, at: string) {
  return {
    id,
    workspaceId: message.workspaceId,
    type: 'message',
    createdAt: at,
    properties: { $message: JSON.stringify({ text, author, to: [] }) },
  };
}

describe('the chat', () => {
  function open(turns: object[], thread: object[], onQuery?: (path: string) => unknown) {
    paginate.mockImplementation(() => ({
      // eslint-disable-next-line @typescript-eslint/require-await
      async *[Symbol.asyncIterator]() {
        yield* thread;
      },
    }));
    query.mockImplementation((endpoint: { path?: string }) => {
      const path = endpoint.path ?? '';
      const custom = onQuery?.(path);
      if (custom !== undefined) return Promise.resolve(custom);
      if (path.endsWith('/pet-turns')) return Promise.resolve({ pets: turns });
      if (path.endsWith('/notifications')) return Promise.resolve({ items: [] });
      if (path.endsWith('/me')) return Promise.resolve({ id: ME });
      return Promise.resolve(message);
    });
    return render(
      <MemoryRouter>
        <MessageView itemId={ITEM} />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    execute.mockResolvedValue({ question: null });
  });

  it('puts the viewer on the right, groups an author and gives pets their avatar', async () => {
    const mine = { id: ME, kind: 'person', name: 'Ada Admin' };
    open(
      [],
      [
        reply('a1', mine, 'one', '2026-11-27T00:01:00.000Z'),
        reply('a2', mine, 'two', '2026-11-27T00:02:00.000Z'),
        reply('a3', { id: PET, kind: 'pet', name: 'Pip' }, 'hi there', '2026-11-27T00:03:00.000Z'),
      ],
    );
    await waitFor(() => {
      expect(screen.getAllByRole('article')).toHaveLength(4);
      expect(screen.getAllByText('You')).toHaveLength(1);
    });
    const articles = screen.getAllByRole('article');
    // The opening message is Ada's too, from another id, so it reads as someone else's.
    expect(articles[1]?.className).toContain('flex-row-reverse');
    expect(articles[2]?.className).toContain('flex-row-reverse');
    expect(articles[0]?.className).not.toContain('flex-row-reverse');
    expect(screen.getByTestId('pet-avatar')).toHaveTextContent('Pip');
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
  });

  it('shows a typing indicator while a pet works', async () => {
    open([{ petId: PET, name: 'Pip', status: 'working', reason: null, expiresAt: null }], []);
    expect(await screen.findByRole('status', { name: 'Pip is answering' })).toBeTruthy();
  });

  it('reviews sharing inline for a refused turn and starts it again once approved', async () => {
    const user = userEvent.setup();
    open(
      [
        {
          petId: PET,
          name: 'Pip',
          status: 'failed',
          reason: 'Review the selected sources and provider before sharing content.',
          expiresAt: null,
          code: 'pets.sharing_required',
        },
      ],
      [],
    );
    await user.click(await screen.findByRole('button', { name: 'Review sharing' }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(2);
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      body: { petId: PET, sourceScope: { kind: 'workspace' } },
    });
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      path: `/api/v1/items/${ITEM}/pet-turns/${PET}/approve`,
    });
  });

  it('points to Settings when the pet has no provider key', async () => {
    open(
      [
        {
          petId: PET,
          name: 'Pip',
          status: 'failed',
          reason: 'Add a key.',
          expiresAt: null,
          code: 'pets.no_provider_key',
        },
      ],
      [],
    );
    const link = await screen.findByRole('link', { name: /provider key/ });
    expect(link.getAttribute('href')).toBe(`/w/${message.workspaceId}/settings?tab=pets`);
    expect(screen.queryByRole('button', { name: 'Review sharing' })).toBeNull();
  });

  it('opens a reply as the whole thread, from its first message', async () => {
    const REPLY = '55555555-5555-4555-8555-555555555555';
    const opened = { ...message, id: REPLY, parentId: ITEM };
    const first = { ...message, id: ITEM, parentId: null };
    open([], [], (path) => {
      if (path === `/api/v1/items/${REPLY}`) return opened;
      if (path === `/api/v1/items/${ITEM}`) return first;
      return undefined;
    });
    // Opened by the reply's id, the chat still starts at ITEM: the composer posts under it.
    render(<MessageView itemId={REPLY} />);
    await waitFor(() => {
      expect(
        query.mock.calls.some(([e]) => (e as { path?: string }).path?.endsWith(`/${ITEM}`)),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(JSON.stringify(paginate.mock.calls)).toContain(ITEM);
    });
    expect(JSON.stringify(paginate.mock.calls)).not.toContain(REPLY);
  });

  it('keeps the newest 300 messages of a long chat', async () => {
    const thread = Array.from({ length: 350 }, (_, n) =>
      reply(
        `r${String(n).padStart(3, '0')}`,
        { id: ME, kind: 'person', name: 'Ada' },
        `msg-${String(n)}`,
        new Date(Date.UTC(2026, 10, 28, 0, n)).toISOString(),
      ),
    );
    open([], thread);
    expect(await screen.findByText('msg-349')).toBeTruthy();
    expect(screen.queryByText('msg-0')).toBeNull();
  });

  describe('polling', () => {
    const turn = (status: string) => [
      { petId: PET, name: 'Pip', status, reason: null, expiresAt: null },
    ];
    const turnReads = () =>
      query.mock.calls.filter(([e]) => (e as { path?: string }).path?.endsWith('/pet-turns'))
        .length;

    it('re-reads a working turn and the thread, even with no recent post', async () => {
      open(turn('working'), []);
      await screen.findByRole('status', { name: 'Pip is answering' });
      const reads = turnReads();
      const lists = paginate.mock.calls.length;
      await waitFor(
        () => {
          expect(turnReads()).toBeGreaterThan(reads);
          expect(paginate.mock.calls.length).toBeGreaterThan(lists);
        },
        { timeout: 6000 },
      );
    });

    it('reads a settled turn once', async () => {
      open(turn('answered'), []);
      await screen.findByText(/Pip answered/);
      const reads = turnReads();
      const lists = paginate.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 3500));
      expect(turnReads()).toBe(reads);
      expect(paginate.mock.calls.length).toBe(lists);
    });
  });
});
