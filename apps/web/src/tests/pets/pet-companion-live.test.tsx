import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { PetCompanion } from '../../pets/pet-companion';
import { usePetAttention } from '../../pets/pet-attention';

const client = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('../../workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: '33333333-3333-4333-8333-333333333333' }),
}));
vi.mock('@nix/web-platform/api/use-pet-settings', () => ({
  usePetSettings: () => ({
    saved: {
      revision: 1,
      settings: {
        enabled: true,
        activePetId: '44444444-4444-4444-8444-444444444444',
        motion: 'reduced',
        profiles: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Cat',
            appearance: 'cat',
            personality: 'calm',
            responseLength: 'balanced',
            instructions: '',
            applyWithoutAsking: false,
            provider: 'chatgpt',
          },
        ],
      },
    },
  }),
}));

const base = {
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  verificationUrl: '',
  userCode: '',
};

async function openCompanion() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <PetCompanion />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
  await screen.findByRole('dialog', { name: 'Conversation with Cat' });
  return user;
}

/** Opens the composer's "+" menu and chooses `name`. */
async function chooseFromPlus(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: 'Add to message' }));
  await user.click(await screen.findByRole('menuitem', { name }));
}

describe('companion live wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('renders tool rows after the latest turn and before its final answer, and gives earlier turns none', async () => {
    client.query.mockResolvedValue({
      ...base,
      state: 'thinking',
      messages: [
        { id: 'turn-1', role: 'user', text: 'First request' },
        { id: 'turn-1:assistant', role: 'assistant', text: 'First reply' },
        { id: 'turn-2', role: 'user', text: 'Second request' },
        {
          id: 'turn-2:commentary:aaaa',
          role: 'assistant',
          text: 'Looking into it.',
        },
      ],
      tools: [
        {
          id: 'tool-1',
          arguments: JSON.stringify({
            operation: 'create_note',
            title: 'Plan',
            markdown: 'Short note.',
            itemId: '',
            parentId: '',
            query: '',
            propertiesJson: '',
          }),
          status: 'pending',
          result: '',
          claimId: '',
        },
      ],
    });
    client.execute.mockResolvedValue(base);
    await openCompanion();

    const log = await screen.findByRole('log', { name: 'Conversation messages' });
    const text = log.textContent;
    const order = [
      'First request',
      'First reply',
      'Second request',
      'Looking into it.',
      'Approve request',
    ].map((fragment) => text.indexOf(fragment));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // The earlier, finished turn shows no approval controls of its own.
    expect(screen.getByRole('button', { name: 'Approve request' })).toBeVisible();
  });

  it('shows a still-streaming draft with a caret, "Writing" status, and no thinking dots, excluded from the live region', async () => {
    client.query.mockResolvedValue({
      ...base,
      state: 'thinking',
      messages: [
        { id: 'turn-3', role: 'user', text: 'Draft this for me' },
        {
          id: 'turn-3:draft:bbbb',
          role: 'assistant',
          text: 'Here is the start of a reply',
        },
      ],
      tools: [],
    });
    client.execute.mockResolvedValue(base);
    await openCompanion();

    const draftText = await screen.findByText('Here is the start of a reply');
    const draftContainer = draftText.closest('[aria-live]');
    expect(draftContainer).toHaveAttribute('aria-live', 'off');
    expect(draftContainer?.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('Writing');
    expect(screen.queryByText(/is thinking/)).not.toBeInTheDocument();
  });

  it('badges the closed launcher for a pending tool and names it "(needs approval)"', async () => {
    client.query.mockResolvedValue({
      ...base,
      state: 'success',
      messages: [{ id: 'turn-4', role: 'user', text: 'Create a note' }],
      tools: [
        {
          id: 'tool-4',
          arguments: JSON.stringify({
            operation: 'create_note',
            title: 'Plan',
            markdown: 'Short note.',
            itemId: '',
            parentId: '',
            query: '',
            propertiesJson: '',
          }),
          status: 'pending',
          result: '',
          claimId: '',
        },
      ],
    });
    client.execute.mockResolvedValue(base);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );

    const launcher = await screen.findByRole('button', { name: /needs approval/ });
    expect(launcher).toHaveAttribute('aria-label', 'Talk with Cat (needs approval)');
    expect(launcher.querySelector('[aria-hidden="true"].rounded-full')).toBeTruthy();
  });

  it('tells the navigation about a pending tool when the page-everywhere choice leaves no launcher', async () => {
    // This file's environment has no working storage; the one preference this test needs is
    // answered directly.
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'nix.pet.surface' ? 'page' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });
    client.query.mockResolvedValue({
      ...base,
      state: 'success',
      messages: [{ id: 'turn-4', role: 'user', text: 'Create a note' }],
      tools: [
        {
          id: 'tool-4',
          arguments: JSON.stringify({
            operation: 'create_note',
            title: 'Plan',
            markdown: 'Short note.',
            itemId: '',
            parentId: '',
            query: '',
            propertiesJson: '',
          }),
          status: 'pending',
          result: '',
          claimId: '',
        },
      ],
    });
    client.execute.mockResolvedValue(base);
    function Attention() {
      return <output>{usePetAttention() ?? 'none'}</output>;
    }
    const view = render(
      <MemoryRouter>
        <PetCompanion />
        <Attention />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('approval');
    });
    // Gone with the companion, so the page (which shows the request itself) starts clean.
    view.rerender(
      <MemoryRouter>
        <Attention />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('none');
    vi.unstubAllGlobals();
  });

  it('badges the closed launcher for a reply that finished while closed, then clears it on open', async () => {
    client.query
      .mockResolvedValueOnce({
        ...base,
        state: 'thinking',
        messages: [{ id: 'turn-5', role: 'user', text: 'Plan my week' }],
        tools: [],
      })
      .mockResolvedValue({
        ...base,
        state: 'success',
        messages: [
          { id: 'turn-5', role: 'user', text: 'Plan my week' },
          { id: 'turn-5:assistant', role: 'assistant', text: 'Here is your week.' },
        ],
        tools: [],
      });
    client.execute.mockResolvedValue(base);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );

    const launcher = await screen.findByRole('button', { name: /new reply/ });
    expect(launcher).toHaveAttribute('aria-label', 'Talk with Cat (new reply)');

    const user = userEvent.setup();
    await user.click(launcher);
    expect(await screen.findByRole('button', { name: 'Close Cat' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /new reply/ })).not.toBeInTheDocument();
  });

  it('offers Regenerate and Edit on the last turn only, replacing that turn', async () => {
    const thread = {
      ...base,
      state: 'success',
      messages: [
        { id: 'turn-1', role: 'user', text: 'First request' },
        { id: 'turn-1:assistant', role: 'assistant', text: 'First reply' },
        { id: 'turn-2', role: 'user', text: 'Second request' },
        { id: 'turn-2:assistant', role: 'assistant', text: 'Second reply' },
      ],
      tools: [],
    };
    // What the worker answers once it has dropped the replaced turn and run the new one.
    const replaced = {
      ...thread,
      messages: [
        ...thread.messages.slice(0, 2),
        { id: 'turn-3', role: 'user', text: 'Better request' },
        { id: 'turn-3:assistant', role: 'assistant', text: 'Better reply' },
      ],
    };
    client.query.mockResolvedValue(thread);
    client.execute.mockResolvedValue(thread);
    const user = await openCompanion();
    const sent = () =>
      client.execute.mock.calls
        .map(
          ([endpoint]) => (endpoint as { body?: { operation?: string; text?: string } }).body ?? {},
        )
        .filter((body) => body.operation === 'send');

    expect(await screen.findAllByRole('button', { name: 'Regenerate' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Edit message' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    // The send goes out after the click resolves, so wait for it rather than read it at once.
    await waitFor(
      () => {
        expect(sent().at(-1)).toMatchObject({
          text: 'Second request',
          replaceFromMessageId: 'turn-2',
        });
      },
      { timeout: 4000 },
    );

    await user.click(await screen.findByRole('button', { name: 'Edit message' }));
    const editor = screen.getByRole('textbox', { name: 'Edit your message' });
    expect(editor).toHaveValue('Second request');
    await user.clear(editor);
    await user.type(editor, 'Better request');
    // Only now does the worker know the new turn; an earlier snapshot would close the editor.
    client.execute.mockResolvedValue(replaced);
    client.query.mockResolvedValue(replaced);
    await user.click(screen.getByRole('button', { name: 'Resend' }));
    await waitFor(
      () => {
        expect(sent().at(-1)).toMatchObject({
          text: 'Better request',
          replaceFromMessageId: 'turn-2',
        });
      },
      { timeout: 4000 },
    );

    const log = await screen.findByRole('log', { name: 'Conversation messages' });
    await waitFor(
      () => {
        expect(log).toHaveTextContent('Better reply');
      },
      { timeout: 5000 },
    );
    expect(log).not.toHaveTextContent('Second request');
    expect(log).not.toHaveTextContent('Second reply');
  });

  it('lists the attached page once, sends it as the message context, and lets it be removed', async () => {
    const item = '55555555-5555-4555-8555-555555555555';
    client.query.mockResolvedValue({ ...base, state: 'success', messages: [], tools: [] });
    client.execute.mockResolvedValue(base);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/?item=${item}`]}>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });

    await chooseFromPlus(user, 'Add this page');
    await chooseFromPlus(user, 'Add this page');
    const list = screen.getByRole('list', { name: 'Notes sent with your message' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);

    await user.type(screen.getByRole('textbox', { name: 'Message Cat' }), 'Summarize');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ operation: 'send', itemIds: [item] }) as unknown,
        }),
        expect.anything(),
      );
    });
    // The list stays for the next turn until the person removes the entry.
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^Remove This page/ }));
    expect(screen.queryByRole('list', { name: 'Notes sent with your message' })).toBeNull();
  });

  it.each(['Turn this note into views'])(
    'offers %s for the open note without sending before review',
    async (prompt) => {
      client.query.mockResolvedValue({ ...base, state: 'success', messages: [], tools: [] });
      client.execute.mockResolvedValue(base);
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={['/?item=55555555-5555-4555-8555-555555555555']}>
          <PetCompanion />
        </MemoryRouter>,
      );
      await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
      await user.click(await screen.findByRole('button', { name: prompt }));
      expect(screen.getByRole('textbox', { name: 'Message Cat' })).toHaveValue(prompt);
      const sentBody: unknown = expect.objectContaining({ operation: 'send' });
      expect(client.execute).not.toHaveBeenCalledWith(
        expect.objectContaining({ body: sentBody }),
        expect.anything(),
      );
      await user.clear(screen.getByRole('textbox', { name: 'Message Cat' }));
    },
  );

  it('removes an attached note from the list', async () => {
    client.query.mockResolvedValue({ ...base, state: 'success', messages: [], tools: [] });
    client.execute.mockResolvedValue(base);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/?item=55555555-5555-4555-8555-555555555555']}>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await chooseFromPlus(user, 'Add this page');
    await user.click(screen.getByRole('button', { name: /^Remove This page/ }));
    expect(screen.queryByRole('list', { name: 'Notes sent with your message' })).toBeNull();
  });

  it('opens the suggestion actions from a leading slash and picks one by keyboard', async () => {
    client.query.mockResolvedValue({ ...base, state: 'success', messages: [], tools: [] });
    client.execute.mockResolvedValue(base);
    const user = await openCompanion();
    const composer = await screen.findByRole('textbox', { name: 'Message Cat' });

    await user.type(composer, '/');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.type(composer, 'find');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    expect(composer).toHaveValue('Find notes about ');
    expect(screen.queryByRole('option')).toBeNull();

    await user.clear(composer);
    await user.type(composer, '/{ArrowDown}{Escape}');
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Conversation with Cat' })).toBeVisible();
    expect(composer).toHaveValue('/');
  });

  it('sends every attached entry: one id per note and the selected text joined', async () => {
    const item = '55555555-5555-4555-8555-555555555555';
    client.query.mockResolvedValue({ ...base, state: 'success', messages: [], tools: [] });
    client.execute.mockResolvedValue(base);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'chosen text',
    } as unknown as Selection);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/?item=${item}`]}>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await chooseFromPlus(user, 'Add this page');
    document.dispatchEvent(new Event('selectionchange'));
    await user.click(await screen.findByRole('button', { name: 'Share selected text' }));
    const list = screen.getByRole('list', { name: 'Notes sent with your message' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    await user.type(screen.getByRole('textbox', { name: 'Message Cat' }), 'Compare');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            operation: 'send',
            itemIds: [item],
            sharedText: 'chosen text',
          }) as unknown,
        }),
        expect.anything(),
      );
    });
    vi.restoreAllMocks();
  });

  it('sends the attached list again on Regenerate, and closes the editor when a send starts', async () => {
    const item = '55555555-5555-4555-8555-555555555555';
    const thread = {
      ...base,
      state: 'success',
      messages: [
        { id: 'turn-1', role: 'user', text: 'Summarize' },
        { id: 'turn-1:assistant', role: 'assistant', text: 'Done' },
      ],
      tools: [],
    };
    client.query.mockResolvedValue(thread);
    client.execute.mockResolvedValue(thread);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/?item=${item}`]}>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await chooseFromPlus(user, 'Add this page');
    await user.click(screen.getByRole('button', { name: 'Edit message' }));
    expect(screen.getByRole('textbox', { name: 'Edit your message' })).toBeVisible();

    // A send from the composer closes the inline editor.
    await user.type(screen.getByRole('textbox', { name: 'Message Cat' }), 'More');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Edit your message' })).toBeNull();
    });

    await user.click(await screen.findByRole('button', { name: 'Regenerate' }));
    const sends = client.execute.mock.calls
      .map(([endpoint]) => (endpoint as { body?: { operation?: string } }).body ?? {})
      .filter((body) => body.operation === 'send');
    expect(sends.at(-1)).toMatchObject({ replaceFromMessageId: 'turn-1', itemIds: [item] });
  });

  it.each(['Cancel', 'Resend'])(
    'returns focus to the composer when the message editor closes with %s',
    async (button) => {
      const thread = {
        ...base,
        state: 'success',
        messages: [
          { id: 'turn-1', role: 'user', text: 'Summarize' },
          { id: 'turn-1:assistant', role: 'assistant', text: 'Done' },
        ],
        tools: [],
      };
      client.query.mockResolvedValue(thread);
      client.execute.mockResolvedValue(thread);
      const user = await openCompanion();
      await user.click(await screen.findByRole('button', { name: 'Edit message' }));
      await user.click(screen.getByRole('button', { name: button }));
      await waitFor(() => {
        expect(screen.queryByRole('textbox', { name: 'Edit your message' })).toBeNull();
      });
      expect(screen.getByRole('textbox', { name: 'Message Cat' })).toHaveFocus();
    },
  );

  it('keeps Resend off while a turn runs', async () => {
    const running = {
      ...base,
      state: 'thinking',
      messages: [
        { id: 'turn-1', role: 'user', text: 'Question' },
        { id: 'turn-1:assistant', role: 'assistant', text: 'Answer' },
      ],
      tools: [],
    };
    client.query.mockResolvedValue({ ...running, state: 'success' });
    client.execute.mockResolvedValue(running);
    const user = await openCompanion();
    await user.click(await screen.findByRole('button', { name: 'Edit message' }));
    client.query.mockResolvedValue(running);
    await user.click(screen.getByRole('button', { name: 'Resend' }));
    expect(
      client.execute.mock.calls.filter(
        ([endpoint]) => (endpoint as { body?: { operation?: string } }).body?.operation === 'send',
      ),
    ).toHaveLength(1);
  });

  it('leaves the slash menu to the IME while composing, and Tab leaves the field', async () => {
    client.query.mockResolvedValue({ ...base, state: 'success', messages: [], tools: [] });
    client.execute.mockResolvedValue(base);
    const user = await openCompanion();
    const composer = await screen.findByRole('textbox', { name: 'Message Cat' });
    expect(composer).not.toHaveAttribute('aria-controls');

    await user.type(composer, '/');
    expect(composer).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);

    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(composer).toHaveValue('/');

    await user.tab();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Conversation with Cat' })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });
});
