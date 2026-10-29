import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PetPage } from '../../pages/pet-page';
import { chatTabId, useTabStore } from '@nix/web-foundation/lib/tab-store';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import type { PetProfile } from '@nix/api-client';

const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const ROOT = '66666666-6666-4666-8666-666666666666';
const petSettings = vi.hoisted((): { provider: PetProfile['provider']; enabled: boolean } => ({
  provider: 'chatgpt',
  enabled: true,
}));
const mock = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), send: vi.fn(), hook: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => mock }));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
}));
vi.mock('@nix/web-platform/api/use-pet-settings', () => ({
  usePetSettings: () => ({
    saved: {
      settings: {
        get enabled() {
          return petSettings.enabled;
        },
        activePetId: '44444444-4444-4444-8444-444444444444',
        motion: 'reduced',
        profiles: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Pip',
            appearance: 'cat',
            personality: 'calm',
            responseLength: 'balanced',
            instructions: '',
            applyWithoutAsking: false,
            get provider() {
              return petSettings.provider;
            },
          },
        ],
      },
    },
  }),
}));
vi.mock('@nix/web-pets/pets/use-pet-runtime', () => ({
  usePetRuntime: (...args: unknown[]) => {
    mock.hook(...args);
    return {
      runtime: { status: 'connected', state: 'idle', messages: [], tools: [], lockedRead: false },
      models: [],
      busy: false,
      error: '',
      errorKind: null,
      send: mock.send,
      setRuntime: vi.fn(),
      regenerateRequestId: vi.fn(),
      interrupt: vi.fn(),
      reset: vi.fn(),
      reload: vi.fn(),
      retryWatch: vi.fn(),
    };
  },
}));

function renderNote(root = ROOT) {
  return render(
    <MemoryRouter initialEntries={[`/w/${WORKSPACE}/pet?root=${root}`]}>
      <PetPage />
    </MemoryRouter>,
  );
}

function Where() {
  return <p>{`editor${useLocation().search}`}</p>;
}

describe('note chat page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The page is where the conversation lives when tabs are not drawn.
    stubViewport(false);
    useTabStore.setState({ workspaceId: WORKSPACE, byPane: {} });
    petSettings.provider = 'chatgpt';
    petSettings.enabled = true;
    localStorage.clear();
    sessionStorage.clear();
    mock.send.mockResolvedValue(true);
    mock.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'locks.get'
          ? { locked: false, unlockedUntil: null }
          : { id: ROOT, workspaceId: WORKSPACE, title: 'Nix documentation', type: 'note' },
      ),
    );
  });

  it('defaults to read-only retrieval for the note and lets the user require approved edits', async () => {
    const user = userEvent.setup();
    renderNote();
    const access = await screen.findByRole('button', { name: 'Note access: Read only' });
    expect(mock.hook).toHaveBeenLastCalledWith(
      WORKSPACE,
      '44444444-4444-4444-8444-444444444444',
      true,
      ROOT,
    );
    // A read-only note chat offers neither the workspace nor applying changes.
    await user.click(screen.getByRole('button', { name: 'Add to message' }));
    expect(screen.queryByRole('menuitem', { name: 'Use workspace' })).toBeNull();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Apply without asking' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(access).toHaveAccessibleDescription(/Search and results can be partial/);
    await user.type(
      screen.getByRole('textbox', { name: 'Message Pip' }),
      'Explain this documentation',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: ROOT, readOnly: true, workspaceAccess: true }),
    );
    expect(mock.send.mock.calls.at(-1)?.[0]).not.toHaveProperty('workspaceMap');
    await user.click(access);
    await user.click(screen.getByRole('menuitemradio', { name: 'Approved edits' }));
    expect(screen.getByRole('button', { name: 'Note access: Can edit' })).toBeVisible();
    // An editable note offers the same Apply without asking switch as the workspace chat.
    await user.click(screen.getByRole('button', { name: 'Add to message' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Apply without asking' })).toBeVisible();
    await user.keyboard('{Escape}');
    await user.type(screen.getByRole('textbox', { name: 'Message Pip' }), 'Append a summary');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(mock.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: ROOT, readOnly: false }),
    );
  });

  it('refuses unavailable or locked roots before opening their conversation', async () => {
    mock.query.mockImplementation((endpoint: { operation: string }) =>
      Promise.resolve(
        endpoint.operation === 'locks.get'
          ? { locked: true, unlockedUntil: null }
          : { id: ROOT, workspaceId: WORKSPACE, title: 'Private note', type: 'note' },
      ),
    );
    renderNote();
    expect(await screen.findByText('This note is unavailable')).toBeVisible();
    expect(mock.hook).not.toHaveBeenCalled();
  });

  it('loads archived history only for the note conversation', async () => {
    mock.execute.mockResolvedValue({ history: [] });
    const user = userEvent.setup();
    renderNote();
    await screen.findByRole('button', { name: 'Note access: Read only' });
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Past conversations' }));
    await waitFor(() => {
      const request: unknown = mock.execute.mock.calls.at(-1)?.[0];
      expect(request).toHaveProperty('body.operation', 'history');
      expect(request).toHaveProperty('body.rootItemId', ROOT);
    });
  });

  it('resets the page model when the same pet changes providers', async () => {
    localStorage.setItem(
      `nix.pet.model.${WORKSPACE}.44444444-4444-4444-8444-444444444444.chat`,
      'gpt-model',
    );
    const user = userEvent.setup();
    const { rerender } = render(
      <MemoryRouter initialEntries={[`/w/${WORKSPACE}/pet`]}>
        <PetPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-model');

    petSettings.provider = 'openrouter';
    rerender(
      <MemoryRouter initialEntries={[`/w/${WORKSPACE}/pet`]}>
        <PetPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('');
    expect(screen.queryByRole('option', { name: /gpt-model/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Read without asking/ })).toHaveAccessibleName(
      'Read without asking. When Workspace access is on, Pip can search and read your workspace without asking first. What it reads is sent to OpenRouter. Changes ask first unless you turn on Apply without asking in a conversation. Applies on this device.',
    );
  });

  it('opens the Pets settings tab when the companion is switched off', () => {
    petSettings.enabled = false;
    render(
      <MemoryRouter initialEntries={[`/w/${WORKSPACE}/pet`]}>
        <PetPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
      'href',
      '/w/33333333-3333-4333-8333-333333333333/settings?tab=pets',
    );
    expect(mock.hook).not.toHaveBeenCalled();
  });

  it('hands a wide window the note conversation as a pinned chat tab in the editor', async () => {
    stubViewport(true);
    render(
      <MemoryRouter initialEntries={[`/w/${WORKSPACE}/pet?root=${ROOT}`]}>
        <Routes>
          <Route path="/w/:workspaceId/pet" element={<PetPage />} />
          <Route path="/w/:workspaceId" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(`editor?item=${ROOT}&chat=${ROOT}`)).toBeVisible();
    expect(useTabStore.getState().byPane[0]).toEqual([
      { itemId: ROOT, pinned: true },
      { itemId: chatTabId(ROOT), pinned: true },
    ]);
    expect(mock.hook).not.toHaveBeenCalled();
  });

  it('keeps a narrow window on the page, and a wide one without a note', async () => {
    renderNote();
    expect(await screen.findByRole('button', { name: 'Note access: Read only' })).toBeVisible();
    stubViewport(true);
    render(
      <MemoryRouter initialEntries={[`/w/${WORKSPACE}/pet`]}>
        <PetPage />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('dialog', { name: 'Conversation with Pip' }).length).toBeGreaterThan(
      0,
    );
  });

  it.each([390, 844])(
    'keeps a touch screen %ipx wide on the page, never the desktop tab',
    async (width) => {
      // A phone (or landscape phone) answers width and coarse-pointer queries from the first render.
      globalThis.matchMedia = (query: string): MediaQueryList =>
        ({
          matches: query.includes('pointer')
            ? query.includes('coarse')
            : width >= Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList;
      renderNote();
      expect(await screen.findByRole('button', { name: 'Note access: Read only' })).toBeVisible();
    },
  );
});
