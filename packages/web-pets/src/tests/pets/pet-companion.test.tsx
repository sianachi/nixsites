import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PetCompanion } from '../../pets/pet-companion';
import { PetConnectionPanel } from '../../pets/pet-connection-panel';
import { NixApiError, type PetProfile } from '@nix/api-client';

const client = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: '33333333-3333-4333-8333-333333333333' }),
}));
const petSettings = vi.hoisted(
  (): { applyWithoutAsking: boolean; provider: PetProfile['provider'] } => ({
    applyWithoutAsking: false,
    provider: 'chatgpt',
  }),
);
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
            get applyWithoutAsking() {
              return petSettings.applyWithoutAsking;
            },
            get provider() {
              return petSettings.provider;
            },
          },
        ],
      },
    },
  }),
}));

const connected = {
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  state: 'success',
  messages: [],
  verificationUrl: '',
  userCode: '',
};

function OpenedPetPage() {
  return <h1>Companion page</h1>;
}

/** Opens the composer's "+" menu and chooses `name`. */
async function chooseFromPlus(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  role: 'menuitem' | 'menuitemcheckbox' = 'menuitem',
) {
  await user.click(await screen.findByRole('button', { name: 'Add to message' }));
  await user.click(await screen.findByRole(role, { name }));
}

describe('companion workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    petSettings.provider = 'chatgpt';
    petSettings.applyWithoutAsking = false;
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      clear: () => {
        stored.clear();
      },
      getItem: (key: string) => stored.get(key) ?? null,
      removeItem: (key: string) => {
        stored.delete(key);
      },
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    });
    sessionStorage.clear();
    client.execute.mockResolvedValue(connected);
    client.query.mockResolvedValue(connected);
  });

  it('opens the conversation as a page through the actions menu', async () => {
    localStorage.setItem('nix.pet.surface', 'both');
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/w/33333333-3333-4333-8333-333333333333']}>
        <Routes>
          <Route path="/w/:workspaceId" element={<PetCompanion />} />
          <Route path="/w/:workspaceId/pet" element={<OpenedPetPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open as page' }));

    expect(await screen.findByRole('heading', { name: 'Companion page' })).toBeVisible();
  });

  it('opens upward when a moved companion is near the bottom of the screen', async () => {
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 24, y: 700 }));
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = screen.getByRole('button', { name: 'Talk with Cat' });
    vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue({
      bottom: 760,
      height: 60,
      left: 24,
      right: 84,
      top: 700,
      width: 60,
      x: 24,
      y: 700,
      toJSON: () => ({}),
    });

    await userEvent.click(launcher);

    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    // jsdom lays the panel out at 0x0, so the panel's bottom aligns with the launcher's bottom
    // (760) and the viewport clamp keeps it 8px inside the window's bottom edge.
    expect(companion).toHaveStyle({
      top: `${String(Math.min(760, window.innerHeight - 8))}px`,
      left: '24px',
    });
    expect(companion.style.bottom).toBe('');
    expect(screen.getByRole('button', { name: 'Close Cat' })).toHaveClass('hidden');
  });

  it('sends only explicitly entered text and scopes the conversation', async () => {
    const user = userEvent.setup();
    const view = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    // The runtime hook now lives on `Companion` itself (L4: closed launcher), so it starts
    // model discovery and the watch loop as soon as the launcher mounts, before the panel is
    // ever opened - only a `send` is gated on the user actually composing one.
    expect(
      client.execute.mock.calls.some(
        ([endpoint]) => (endpoint as { body?: { operation?: string } }).body?.operation === 'send',
      ),
    ).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await user.type(screen.getByRole('textbox', { name: 'Message Cat' }), 'Help with a plan');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            operation: 'send',
            text: 'Help with a plan',
            workspaceId: '33333333-3333-4333-8333-333333333333',
          }) as unknown,
        }),
        expect.anything(),
      );
    });
    const call = client.execute.mock.calls.find(
      ([endpoint]) => (endpoint as { body?: { operation?: string } }).body?.operation === 'send',
    );
    expect(call?.[0]).toMatchObject({
      body: { sharedText: '', mode: '' },
    });
    view.unmount();
  });

  it('maps the workspace on the first message with workspace access, and never again', async () => {
    const container = '55555555-5555-4555-8555-555555555555';
    const paginate = vi.fn(async function* (endpoint: { query: { parentId?: string } }) {
      await Promise.resolve();
      if (endpoint.query.parentId === undefined)
        yield {
          id: container,
          workspaceId: '33333333-3333-4333-8333-333333333333',
          parentId: null,
          title: 'Tasks',
          type: 'note',
          hasChildren: false,
        };
    });
    Object.assign(client, { paginate, cache: { peek: vi.fn() } });
    const user = userEvent.setup();
    const view = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await chooseFromPlus(user, 'Use workspace');
    await user.type(screen.getByRole('textbox', { name: 'Message Cat' }), 'What is due?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const sends = () =>
      client.execute.mock.calls
        .map(([endpoint]) => (endpoint as { body?: Record<string, unknown> }).body)
        .filter((body) => body?.operation === 'send');
    await waitFor(() => {
      expect(sends()).toHaveLength(1);
    });
    expect(sends()[0]).toMatchObject({
      workspaceAccess: true,
      workspaceMap: [{ id: container, title: 'Tasks', type: 'note', viewKinds: null }],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(sends()[0]?.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Once the conversation has a user message, later turns rely on the thread's history.
    const withHistory = {
      ...connected,
      messages: [{ id: 'first', role: 'user', text: 'What is due?' }],
    };
    client.execute.mockResolvedValue(withHistory);
    client.query.mockResolvedValue(withHistory);
    await screen.findAllByText('What is due?');
    await user.type(screen.getByRole('textbox', { name: 'Message Cat' }), 'And tomorrow?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(sends()).toHaveLength(2);
    });
    expect(sends()[1]?.workspaceMap).toBeNull();
    expect(paginate).toHaveBeenCalledOnce();
    view.unmount();
    Object.assign(client, { paginate: undefined, cache: undefined });
  });

  it('has one conversation: no mode switch, and no mode on any runtime call', async () => {
    client.query.mockResolvedValue({
      ...connected,
      messages: [{ id: 'chat-reply', role: 'assistant', text: 'Chat conversation' }],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByText('Chat conversation')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Design' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Conversation mode' })).not.toBeInTheDocument();
    const calls = [...client.execute.mock.calls, ...client.query.mock.calls].map(
      ([endpoint]) => endpoint as { body?: { mode?: string }; query?: { mode?: string } },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((endpoint) => !endpoint.body?.mode && !endpoint.query?.mode)).toBe(true);
  });

  it('opens the conversation from the template library entry point', async () => {
    render(
      <MemoryRouter initialEntries={['/w/33333333-3333-4333-8333-333333333333?pet=design']}>
        <PetCompanion />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('dialog', { name: 'Conversation with Cat' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Find notes about' })).toBeVisible();
  });

  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
  }

  it('remembers the model choice under the key it was always stored under', async () => {
    client.execute.mockResolvedValue({
      ...connected,
      models: [{ id: 'chat-model', name: 'Chat model', default: false }],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await openSettings(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'chat-model');
    expect(
      localStorage.getItem(
        'nix.pet.model.33333333-3333-4333-8333-333333333333.44444444-4444-4444-8444-444444444444.chat',
      ),
    ).toBe('chat-model');
  });

  it.each([
    { provider: 'anthropic', label: 'Claude' },
    { provider: 'openrouter', label: 'OpenRouter' },
  ] satisfies { provider: PetProfile['provider']; label: string }[])(
    'shows $label setup instead of ChatGPT sign-in when its key is missing',
    async ({ provider, label }) => {
      petSettings.provider = provider;
      client.query.mockResolvedValue({
        ...connected,
        provider,
        status: 'disconnected',
        reason: `Add a ${label} API key in Pet settings.`,
      });
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <PetCompanion />
        </MemoryRouter>,
      );
      await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        `Add a ${label} API key in Pet settings.`,
      );
      expect(screen.getByRole('link', { name: 'Open Pet settings' })).toHaveAttribute(
        'href',
        '/w/33333333-3333-4333-8333-333333333333/settings?tab=pets',
      );
      expect(screen.queryByRole('button', { name: 'Connect ChatGPT' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Open ChatGPT sign-in' })).not.toBeInTheDocument();
      for (const [request] of client.query.mock.calls)
        expect(request).not.toHaveProperty('operation', 'pets.connection');
    },
  );

  it('clears ChatGPT status and models when the same pet switches to Claude', async () => {
    const gptModel = { id: 'gpt-model', name: 'GPT model', supportsTools: true };
    const claudeModel = { id: 'claude-model', name: 'Claude model', supportsTools: true };
    localStorage.setItem(
      'nix.pet.model.33333333-3333-4333-8333-333333333333.44444444-4444-4444-8444-444444444444.chat',
      'gpt-model',
    );
    client.execute.mockResolvedValue({ ...connected, models: [gptModel] });
    client.query.mockResolvedValue({
      ...connected,
      revision: 25,
      messages: [{ id: 'gpt-message', role: 'assistant', text: 'ChatGPT conversation' }],
    });
    const user = userEvent.setup();
    const { rerender } = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByText('ChatGPT conversation')).toBeVisible();
    await openSettings(user);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-model');
    expect(screen.getByRole('link', { name: 'Pet settings' })).toHaveAttribute(
      'href',
      '/w/33333333-3333-4333-8333-333333333333/settings?tab=pets',
    );

    petSettings.provider = 'anthropic';
    client.execute.mockResolvedValue({
      ...connected,
      provider: 'anthropic',
      models: [claudeModel],
    });
    let finishWatch: ((value: unknown) => void) | undefined;
    client.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWatch = resolve;
        }),
    );
    rerender(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(screen.queryByText('ChatGPT conversation')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Connecting');
    finishWatch?.({
      ...connected,
      provider: 'anthropic',
      revision: 1,
      messages: [{ id: 'claude-message', role: 'assistant', text: 'Claude conversation' }],
    });
    expect(await screen.findByText('Claude conversation')).toBeVisible();
    await openSettings(user);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Provider default' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /GPT model|gpt-model/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Claude model' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Read without asking/ })).toHaveAccessibleName(
      'Read without asking. When Workspace access is on, Cat can search and read your workspace without asking first. What it reads is sent to Claude. Changes ask first unless you turn on Apply without asking in a conversation. Applies on this device.',
    );
  });

  it('replaces an established Claude conversation with key setup after removal', async () => {
    petSettings.provider = 'anthropic';
    let finishSetup: ((value: unknown) => void) | undefined;
    const setup = new Promise((resolve) => {
      finishSetup = resolve;
    });
    client.query
      .mockResolvedValueOnce({
        ...connected,
        provider: 'anthropic',
        revision: 25,
        messages: [{ id: 'claude-message', role: 'assistant', text: 'Claude conversation' }],
      })
      .mockReturnValue(setup);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByText('Claude conversation')).toBeVisible();
    await act(async () => {
      finishSetup?.({
        ...connected,
        provider: 'anthropic',
        status: 'disconnected',
        revision: 0,
        messages: [],
        reason: 'Add a Claude API key in Pet settings.',
      });
      await setup;
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Add a Claude API key in Pet settings.',
    );
    expect(screen.queryByText('Claude conversation')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message Cat' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Pet settings' })).toHaveAttribute(
      'href',
      '/w/33333333-3333-4333-8333-333333333333/settings?tab=pets',
    );
    expect(screen.queryByRole('button', { name: 'Connect ChatGPT' })).not.toBeInTheDocument();
  });

  it('prioritises replies and keeps secondary controls tucked into the overflow menu', async () => {
    // The connection - including its messages - now arrives through the watch loop
    // (`client.query`), not an `execute` read; the fixture is mocked there.
    client.query.mockResolvedValue({
      ...connected,
      messages: [
        {
          id: 'visible-reply',
          role: 'assistant',
          text: 'Your reply stays in the reading area.',
        },
      ],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByText('Your reply stays in the reading area.')).toBeVisible();
    const messages = screen.getByRole('log', { name: 'Conversation messages' });
    expect(messages).not.toContainElement(screen.getByRole('textbox', { name: 'Message Cat' }));
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    expect(screen.getByRole('menuitem', { name: 'New conversation' })).toBeVisible();
  });

  it('keeps the chosen model when the chat is closed and reopened', async () => {
    client.execute.mockResolvedValue({
      ...connected,
      models: [{ id: 'gpt-5.3-codex-spark', name: 'GPT-5.3-Codex-Spark', default: false }],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await openSettings(user);
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Model' }),
      'gpt-5.3-codex-spark',
    );
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await openSettings(user);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-5.3-codex-spark');
  });

  it('shows response failures without requiring users to open the menu', async () => {
    client.query.mockResolvedValue({
      ...connected,
      state: 'error',
      reason: 'The response could not finish.',
    });
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The response could not finish.');
    expect(screen.getByRole('alert')).toBeVisible();
  });

  it('shows safe provider credit guidance and preserves the composer for an untouched retry', async () => {
    petSettings.provider = 'anthropic';
    const runtime = { ...connected, provider: 'anthropic', revision: 1 };
    client.query.mockResolvedValue(runtime);
    client.execute
      .mockResolvedValueOnce(runtime)
      .mockRejectedValueOnce(
        NixApiError.fromProblemDetails(402, {
          code: 'pets.provider_credit_balance',
          detail:
            'Claude reports that this API key has insufficient credit. Check API billing for the key, then try again.',
        }),
      )
      .mockResolvedValue({ ...runtime, revision: 2 });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    const composer = await screen.findByRole('textbox', { name: 'Message Cat' });
    await user.type(composer, 'Plan my notes');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Claude reports that this API key has insufficient credit. Check API billing for the key, then try again. Your draft is preserved.',
    );
    expect(composer).toHaveValue('Plan my notes');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(composer).toHaveValue('');
    });
    expect(client.execute.mock.calls[2]?.[0]).toEqual(client.execute.mock.calls[1]?.[0]);
  });

  it('renders a system notice without an author or approval controls', async () => {
    client.query.mockResolvedValue({
      ...connected,
      messages: [
        {
          id: 'notice',
          role: 'system',
          text: 'Your pet was updated and starts a fresh conversation.',
        },
      ],
    });
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    expect(
      await screen.findByText('Your pet was updated and starts a fresh conversation.'),
    ).toBeVisible();
    const log = within(screen.getByRole('log', { name: 'Conversation messages' }));
    expect(log.queryByText('You')).not.toBeInTheDocument();
    expect(log.queryByText('Cat')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dictate' })).not.toBeInTheDocument();
    expect(log.queryByRole('button', { name: 'Read this reply aloud' })).not.toBeInTheDocument();
  });

  it('approval state derives only from pending tool calls', async () => {
    // The connection arrives through the watch loop; kept in sync with `execute` (used by the
    // explicit "Reload conversation" action below) so a background watch tick never overwrites
    // what the reload just applied with this stale fixture.
    client.execute.mockResolvedValue({
      ...connected,
      messages: [
        {
          id: 'message-one',
          role: 'assistant',
          text: 'I can create this note.',
        },
      ],
      tools: [],
    });
    client.query.mockResolvedValue({
      ...connected,
      messages: [
        {
          id: 'message-one',
          role: 'assistant',
          text: 'I can create this note.',
        },
      ],
      tools: [],
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Talk with Cat' }));
    await screen.findByText('I can create this note.');
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent('Waiting for your approval');

    const pendingConnection = {
      ...connected,
      messages: [
        {
          id: 'message-one',
          role: 'assistant',
          text: 'I can create this note.',
        },
      ],
      tools: [
        {
          id: 'tool-one',
          arguments: '{}',
          status: 'pending',
          result: '',
          claimId: '',
        },
      ],
    };
    client.execute.mockResolvedValue(pendingConnection);
    client.query.mockResolvedValue(pendingConnection);
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Reload conversation' }));
    expect(await screen.findByText('Waiting for your approval')).toBeVisible();
  });

  it('never shows "Waiting for your approval" nor badges the launcher for an auto-run read that is still pending', async () => {
    // Must-fix 1: an auto-run read (readWithoutAsking defaults on, and `search` is read-only)
    // stays `pending` until its own claim round trip finishes - here it never does, so the tool
    // is pending the whole test - but it must never read as something the owner is being asked
    // to decide, because it never was.
    const autoRunConnection = {
      ...connected,
      messages: [{ id: 'msg-1', role: 'user', text: 'Find my reading notes' }],
      tools: [
        {
          id: 'auto-tool-1',
          arguments: JSON.stringify({
            operation: 'search',
            query: 'reading',
            itemId: '',
            parentId: '',
            title: '',
            markdown: '',
            propertiesJson: '',
          }),
          status: 'pending',
          result: '',
          claimId: '',
        },
      ],
    };
    client.query.mockResolvedValue(autoRunConnection);
    client.execute.mockImplementation((endpoint: unknown) => {
      const operation = (endpoint as { body?: { operation?: string } }).body?.operation;
      // The claim itself never succeeds in this test - which keeps the tool `pending` for the
      // whole run without ever reaching the (mocked-elsewhere) `@nix/companion` execution path.
      if (operation === 'tool_claim') return Promise.reject(new Error('offline'));
      return Promise.resolve(autoRunConnection);
    });
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    await waitFor(() => {
      expect(launcher).toHaveAttribute('aria-label', 'Talk with Cat');
    });
    expect(launcher.querySelector('[aria-hidden="true"].rounded-full')).toBeNull();

    await userEvent.click(launcher);
    const dialog = await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    // Scoped to the header's own name/status pairing (not the read row's separate "Running…"
    // status, which shares the same role) - `getByText` finds the header `<h2>` and its status
    // sibling is the second child of their shared wrapper.
    const heading = within(dialog).getByRole('heading', { name: 'Cat' });
    const headerStatus = heading.parentElement?.querySelector('[role="status"]');
    expect(headerStatus).not.toHaveTextContent('Waiting for your approval');
  });

  it('shows no "(new reply)" badge for a conversation that is already finished the first time it loads', async () => {
    // Must-fix 2: the very first state this hook ever observes is a baseline, not a reply that
    // "just" finished - only a real thinking -> success transition earns the badge.
    client.query.mockResolvedValue({
      ...connected,
      state: 'success',
      messages: [
        { id: 'already-1', role: 'user', text: 'Earlier question' },
        { id: 'already-1:assistant', role: 'assistant', text: 'Earlier answer' },
      ],
    });
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    await waitFor(() => {
      expect(launcher).toHaveAttribute('aria-label', 'Talk with Cat');
    });
    expect(screen.queryByRole('button', { name: /new reply/ })).not.toBeInTheDocument();
  });

  it('focuses the sub-panel heading on open, and Escape backs out of it instead of closing', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
    const heading = await screen.findByRole('heading', { name: 'Chat settings', level: 3 });
    await waitFor(() => {
      expect(document.activeElement).toContainElement(heading);
    });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Chat settings' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('dialog', { name: 'Conversation with Cat' })).toBeInTheDocument();
  });

  it('returns focus to the overflow menu trigger when Back leaves a sub-panel', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    const trigger = screen.getByRole('button', { name: 'More conversation actions' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Past conversations' }));
    await screen.findByRole('heading', { name: 'Past conversations', level: 3 });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  describe('the open note as automatic context', () => {
    const note = '66666666-6666-4666-8666-666666666666';
    const sends = () =>
      client.execute.mock.calls
        .map(([endpoint]) => (endpoint as { body?: Record<string, unknown> }).body)
        .filter((body) => body?.operation === 'send');

    function openNote(lock: { locked: boolean; unlockedUntil: string | null }) {
      Object.assign(client, {
        paginate: async function* () {
          await Promise.resolve();
          yield* [];
        },
        cache: { peek: vi.fn() },
      });
      client.query.mockImplementation((endpoint: { operation?: string }) =>
        Promise.resolve(
          endpoint.operation === 'locks.get'
            ? lock
            : endpoint.operation === 'items.get'
              ? { id: note, title: 'Weekly plan' }
              : connected,
        ),
      );
      return render(
        <MemoryRouter initialEntries={[`/w/33333333-3333-4333-8333-333333333333?item=${note}`]}>
          <Routes>
            <Route path="/w/:workspaceId" element={<PetCompanion />} />
          </Routes>
        </MemoryRouter>,
      );
    }

    async function sendMessage(user: ReturnType<typeof userEvent.setup>, text: string) {
      await user.type(screen.getByRole('textbox', { name: 'Message Cat' }), text);
      await user.click(screen.getByRole('button', { name: 'Send' }));
    }

    it('sends only its id while it is unlocked and workspace access is on, until the chip is removed', async () => {
      const user = userEvent.setup();
      const view = openNote({ locked: false, unlockedUntil: null });
      await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
      await chooseFromPlus(user, 'Use workspace');
      expect(await screen.findByText('This page: Weekly plan')).toBeVisible();

      await sendMessage(user, 'What is due?');
      await waitFor(() => {
        expect(sends()).toHaveLength(1);
      });
      expect(sends()[0]).toMatchObject({ itemId: note, sharedText: '' });
      expect(sends()[0]?.itemIds ?? null).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Remove This page: Weekly plan' }));
      expect(screen.queryByText('This page: Weekly plan')).not.toBeInTheDocument();
      await sendMessage(user, 'And tomorrow?');
      await waitFor(() => {
        expect(sends()).toHaveLength(2);
      });
      expect(sends()[1]?.itemId ?? null).toBeNull();
      view.unmount();
    });

    it('sends nothing about a locked note', async () => {
      const user = userEvent.setup();
      const view = openNote({ locked: true, unlockedUntil: null });
      await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
      await chooseFromPlus(user, 'Use workspace');
      await sendMessage(user, 'What is due?');
      await waitFor(() => {
        expect(sends()).toHaveLength(1);
      });
      expect(screen.queryByText('This page: Weekly plan')).not.toBeInTheDocument();
      expect(sends()[0]?.itemId ?? null).toBeNull();
      view.unmount();
    });

    it('sends nothing while workspace access is off', async () => {
      const user = userEvent.setup();
      const view = openNote({ locked: false, unlockedUntil: null });
      await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
      await screen.findByRole('dialog', { name: 'Conversation with Cat' });
      await sendMessage(user, 'What is due?');
      await waitFor(() => {
        expect(sends()).toHaveLength(1);
      });
      expect(screen.queryByText('This page: Weekly plan')).not.toBeInTheDocument();
      expect(sends()[0]?.itemId ?? null).toBeNull();
      view.unmount();
    });
  });

  it('renders no second runtime while a pane shows the workspace conversation', async () => {
    const note = '66666666-6666-4666-8666-666666666666';
    const render_ = (search: string) =>
      render(
        <MemoryRouter initialEntries={[`/w/33333333-3333-4333-8333-333333333333?${search}`]}>
          <Routes>
            <Route path="/w/:workspaceId" element={<PetCompanion />} />
          </Routes>
        </MemoryRouter>,
      );
    const beside = render_(`item=${note}`);
    expect(await screen.findByRole('button', { name: 'Talk with Cat' })).toBeInTheDocument();
    beside.unmount();

    render_(`item=${note}&chat=workspace`);
    expect(screen.queryByRole('button', { name: 'Talk with Cat' })).not.toBeInTheDocument();
  });

  it('shows the live conversation title and renames it from the actions menu', async () => {
    const named = {
      ...connected,
      title: 'Weekly plan',
      messages: [{ id: 'first', role: 'user', text: 'What is due?' }],
    };
    client.query.mockResolvedValue(named);
    client.execute.mockResolvedValue({ ...named, title: 'Sprint review' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByText('Weekly plan')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename conversation' }));
    const field = screen.getByRole('textbox', { name: 'Conversation title' });
    await user.clear(field);
    await user.type(field, 'Sprint review{Enter}');
    await waitFor(() => {
      const bodies = client.execute.mock.calls.map(
        ([endpoint]) => (endpoint as { body?: unknown }).body,
      );
      expect(bodies).toContainEqual(
        expect.objectContaining({ operation: 'rename', text: 'Sprint review' }),
      );
    });
    expect(await screen.findByText('Sprint review')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Conversation title' })).not.toBeInTheDocument();
  });

  it('offers device sign-in and cancellation without handling credentials in the browser', async () => {
    client.query.mockResolvedValue({ ...connected, status: 'disconnected', canConnect: true });
    client.execute.mockResolvedValue({
      ...connected,
      status: 'connecting',
      canConnect: true,
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'TEST-CODE',
    });
    const user = userEvent.setup();
    render(<PetConnectionPanel />);
    const button = await screen.findByRole('button', { name: 'Connect ChatGPT' });
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
    await user.click(button);
    expect(await screen.findByRole('link', { name: 'Open ChatGPT sign-in' })).toHaveAttribute(
      'href',
      'https://auth.openai.com/codex/device',
    );
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          operation: 'disconnect',
          text: '',
          sharedText: '',
        }) as unknown,
      }),
      expect.anything(),
    );
  });

  it('draws no floating pet once the chat is given its own page everywhere', () => {
    localStorage.setItem('nix.pet.surface', 'page');
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    // jsdom applies no stylesheet, so `hidden` is asserted as the class the other launcher tests
    // assert; in a browser it takes both out of the layout and the accessibility tree.
    expect(screen.getByRole('complementary', { name: 'Cat companion' })).toHaveClass('hidden');
    expect(screen.getByRole('button', { name: 'Open Cat' })).toHaveClass('hidden');
  });
  it('starts a conversation with the switch on when the pet is saved that way', async () => {
    petSettings.applyWithoutAsking = true;
    try {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <PetCompanion />
        </MemoryRouter>,
      );
      await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
      const dialog = await screen.findByRole('dialog', { name: 'Conversation with Cat' });
      await chooseFromPlus(user, 'Use workspace');
      expect(within(dialog).getByText('Applying changes without asking')).toBeVisible();
      // Still the owner's to turn off for this conversation.
      await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
      expect(within(dialog).queryByText('Applying changes without asking')).toBeNull();
    } finally {
      petSettings.applyWithoutAsking = false;
    }
  });
  it('applies without asking only while the owner has switched it on for this conversation', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    const dialog = await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    const plus = within(dialog).getByRole('button', { name: 'Add to message' });
    // Nothing can be applied without workspace tools, so the switch only exists with access on.
    await user.click(plus);
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Apply without asking' })).toBeNull();
    await user.keyboard('{Escape}');
    await chooseFromPlus(user, 'Use workspace');
    expect(within(dialog).queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();

    await chooseFromPlus(user, 'Apply without asking', 'menuitemcheckbox');
    expect(within(dialog).getByText('Applying changes without asking')).toBeVisible();
    // Which writes still ask is said beside the switch, and the menu entry carries the state.
    expect(
      within(dialog).getByText(/Moves, trash, template saves and external links still ask/),
    ).toBeVisible();
    await user.click(plus);
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Apply without asking', checked: true }),
    ).toBeVisible();
    await user.keyboard('{Escape}');

    // Turning it off from the banner hands focus back to the "+" that turns it on.
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(within(dialog).queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
    expect(plus).toHaveFocus();

    // Removing the workspace chip turns access off and takes the switch with it.
    await chooseFromPlus(user, 'Apply without asking', 'menuitemcheckbox');
    expect(within(dialog).getByRole('button', { name: 'Turn off' })).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Remove Workspace' }));
    expect(within(dialog).queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
    await user.click(plus);
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Apply without asking' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Use workspace' })).toBeVisible();
  });
});
