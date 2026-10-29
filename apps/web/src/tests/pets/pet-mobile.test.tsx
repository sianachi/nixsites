import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { StrictMode } from 'react';
import { PetCompanion } from '@nix/web-pets/pets/pet-companion';
import { PetPage } from '../../pages/pet-page';
import { MobileNoteToolbar } from '@nix/web-editor/editor/mobile-note-toolbar';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

const client = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
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

describe('companion on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
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
    // These tests are about the panel on a phone; the default there is the pet page.
    localStorage.setItem('nix.pet.surface', 'floating');
    client.execute.mockResolvedValue(connected);
    client.query.mockResolvedValue(connected);
  });

  it('shows the compact launcher on a phone and the regular one on a wide screen', async () => {
    stubViewport(390);
    const narrow = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('img', { name: 'Cat' })).toHaveClass('size-14');
    narrow.unmount();

    stubViewport(true);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('img', { name: 'Cat' })).toHaveClass('size-24');
  });

  it('draws no launcher on a phone when the chat opens as a page', async () => {
    stubViewport(320);
    vi.stubGlobal('innerWidth', 320);
    localStorage.setItem('nix.pet.surface', 'page-on-phones');
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(client.query).toHaveBeenCalled();
    });
    // Stays mounted for auto-run reads but is display:none, so it is not a tab stop.
    expect(screen.getByRole('complementary', { hidden: true, name: 'Cat companion' })).toHaveClass(
      'hidden',
    );
  });

  it('shows the connected conversation on the pet page under the phone page preference', async () => {
    const workspaceId = '33333333-3333-4333-8333-333333333333';
    stubViewport(320);
    vi.stubGlobal('innerWidth', 320);
    localStorage.setItem('nix.pet.surface', 'page-on-phones');
    client.execute.mockResolvedValue({ models: [] });
    client.query.mockResolvedValue({
      ...connected,
      revision: 1,
      messages: [
        { id: 'phone-user', role: 'user', text: 'Help me plan a calmer week.' },
        {
          id: 'phone-reply',
          role: 'assistant',
          text: 'Choose one priority for each day, leave a break between commitments, and keep a little room for the unexpected.',
        },
      ],
    });

    function WorkspaceRoute() {
      return (
        <>
          <PetCompanion />
          <Outlet />
        </>
      );
    }

    render(
      <MemoryRouter initialEntries={[`/w/${workspaceId}/pet`]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceRoute />}>
            <Route index element={<div>Workspace</div>} />
            <Route path="pet" element={<PetPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Choose one priority for each day/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message Cat' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message Cat' })).not.toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Open Cat' })).not.toBeInTheDocument();
  });

  it('offers conversation actions on a secondary click of the header', async () => {
    stubViewport(280);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    const title = await screen.findByRole('heading', { name: 'Cat' });
    expect(fireEvent.contextMenu(screen.getByRole('button', { name: 'Close' }))).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(fireEvent.contextMenu(title, { clientX: 20, clientY: 30 })).toBe(false);
    expect(screen.getByRole('menu', { name: 'Conversation actions' })).toBeVisible();
    await user.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
    expect(await screen.findByRole('heading', { name: 'Chat settings' })).toBeVisible();
  });

  it('offers the same conversation actions after a touch long press', async () => {
    stubViewport(280);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    const title = await screen.findByRole('heading', { name: 'Cat' });
    fireEvent.pointerDown(title, {
      pointerType: 'touch',
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 30,
    });
    expect(await screen.findByRole('menu', { name: 'Conversation actions' })).toBeVisible();
    fireEvent.pointerUp(title, { pointerType: 'touch', pointerId: 1 });
    await user.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
    expect(await screen.findByRole('heading', { name: 'Chat settings' })).toBeVisible();
  });

  it('keeps the note chat header short on a phone so the messages stay visible', async () => {
    stubViewport(390);
    const note = '55555555-5555-4555-8555-555555555555';
    client.query.mockResolvedValue({
      ...connected,
      id: note,
      title: 'Brag sheet',
      workspaceId: '33333333-3333-4333-8333-333333333333',
      locked: false,
      unlockedUntil: null,
    });
    render(
      <MemoryRouter initialEntries={[`/pet?root=${note}`]}>
        <PetPage />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    expect(
      await screen.findByRole('button', { name: 'Note access: Read only' }),
    ).toHaveAccessibleDescription(expect.stringContaining('Every change asks first'));
    // One row: the note's title is the heading and its link lives in the More menu.
    expect(screen.getByRole('heading', { name: 'Brag sheet' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    expect(screen.getByRole('menuitem', { name: 'Open note' })).toHaveAttribute(
      'href',
      `/w/33333333-3333-4333-8333-333333333333?item=${note}`,
    );
  });

  it('waits for a composer tap before opening a touch tablet keyboard', async () => {
    stubViewport(800);
    const matchMedia = window.matchMedia.bind(window);
    const touchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
      const media = matchMedia(query);
      if (query.includes('pointer: coarse'))
        Object.defineProperty(media, 'matches', { value: true });
      return media;
    });
    try {
      render(
        <MemoryRouter>
          <PetPage />
        </MemoryRouter>,
      );
      expect(await screen.findByRole('textbox', { name: 'Message Cat' })).not.toHaveFocus();
    } finally {
      touchMedia.mockRestore();
    }
  });

  it('keeps the phone dialog inside the visible viewport when the keyboard pans it', async () => {
    stubViewport(280);
    const viewport = Object.assign(new EventTarget(), { height: 460, offsetTop: 30, scale: 1 });
    vi.stubGlobal('visualViewport', viewport);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    const dialog = await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await waitFor(() => {
      expect(dialog.style.getPropertyValue('--phone-dialog-height')).toBe('460px');
      expect(dialog.style.getPropertyValue('--phone-dialog-top')).toBe('30px');
    });
    act(() => {
      viewport.height = 360;
      viewport.offsetTop = 70;
      viewport.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => {
      expect(dialog.style.getPropertyValue('--phone-dialog-height')).toBe('360px');
      expect(dialog.style.getPropertyValue('--phone-dialog-top')).toBe('70px');
    });
  });

  it('keeps the regular launcher size at tablet width while still clearing the bottom nav', async () => {
    // A tablet is past the phone breakpoint (`useNarrowViewport`, 640px) but still inside the
    // drawer-nav range (`useDrawerNavigation`, 1024px) that renders the bottom navigation - the
    // launcher's default offset has to track the second breakpoint, not the first.
    stubViewport(800);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('img', { name: 'Cat' })).toHaveClass('size-24');
    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    expect(companion.className).toContain('lg:bottom-4');
    expect(companion.className).not.toContain('sm:bottom-4');
  });

  it('opens a full-screen modal dialog on a phone and a floating non-modal card on a wide screen', async () => {
    stubViewport(390);
    const user = userEvent.setup();
    const narrow = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByRole('dialog', { name: 'Conversation with Cat' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    narrow.unmount();

    stubViewport(true);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    expect(await screen.findByRole('dialog', { name: 'Conversation with Cat' })).toHaveAttribute(
      'aria-modal',
      'false',
    );
  });

  it('returns focus to the launcher when the phone dialog closes, by Close or Escape', async () => {
    stubViewport(390);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    await user.click(launcher);
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(launcher).toHaveFocus();
    });

    await user.click(launcher);
    const dialog = await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    dialog.focus();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(launcher).toHaveFocus();
    });
  });

  it('closes the phone dialog on the browser back gesture', async () => {
    stubViewport(390);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });

    // A genuine step back, not a bare `popstate` dispatch: the back-stack fix in
    // `use-back-dismiss.ts` tells a real Back press apart from a sibling overlay's own
    // programmatic close by checking whether `history.state` actually moved past this
    // overlay's marker, so the test has to move it the same way a real gesture would.
    act(() => {
      window.history.back();
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('keeps the mobile template-library deep link open in StrictMode', async () => {
    stubViewport(390);
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/?pet=design']}>
          <PetCompanion />
        </MemoryRouter>
      </StrictMode>,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.queryByRole('button', { name: 'Design' })).not.toBeInTheDocument();
  });

  it('clamps a stored off-screen position into view on a phone', async () => {
    stubViewport(390);
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 5000, y: 5000 }));
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    // jsdom never lays out a real box, so a zero-size rect (as the launcher would also report
    // while genuinely hidden) is skipped by design; giving it a realistic size here is what
    // lets the clamp run and be asserted, the same way it would once a phone renders it.
    vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue({
      width: 64,
      height: 64,
      top: 0,
      left: 0,
      right: 64,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    await waitFor(() => {
      expect(companion).toHaveStyle({ left: '318px', top: '772px' });
    });
  });

  it('keeps a clamped position clear of the bottom nav, not just the viewport edge', async () => {
    // The shell publishes this while the bottom nav is showing (`app-shell.tsx`); set directly
    // here since this suite renders the companion on its own, without the shell around it.
    // Removed unconditionally afterwards (even if an assertion below throws), so a failure here
    // cannot leak the property into a later test.
    document.documentElement.style.setProperty('--mobile-nav-height', '64px');
    try {
      stubViewport(390);
      localStorage.setItem('nix.pet.position', JSON.stringify({ x: 5000, y: 5000 }));
      render(
        <MemoryRouter>
          <PetCompanion />
        </MemoryRouter>,
      );
      const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
      vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue({
        width: 64,
        height: 64,
        top: 0,
        left: 0,
        right: 64,
        bottom: 64,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      const companion = screen.getByRole('complementary', { name: 'Cat companion' });
      // Without the nav's 64px clearance this would land at `top: 772px` (see the plain viewport
      // clamp above) - on top of the nav's own buttons instead of clear of them.
      await waitFor(() => {
        expect(companion).toHaveStyle({ left: '318px', top: '708px' });
      });
    } finally {
      document.documentElement.style.removeProperty('--mobile-nav-height');
    }
  });

  it('keeps a saved launcher above the note dock and restores nav clearance after leaving it', async () => {
    stubViewport(240);
    vi.stubGlobal('innerWidth', 240);
    vi.stubGlobal('innerHeight', 640);
    document.documentElement.style.setProperty('--mobile-nav-height', '64px');
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 5000, y: 5000 }));
    try {
      const view = render(
        <MemoryRouter>
          <PetCompanion />
          <MobileNoteToolbar formatting={<button>Bold</button>} />
        </MemoryRouter>,
      );
      const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
      vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ width: 64, height: 64 }),
      );
      const dock = screen.getByRole('group', { name: 'Formatting actions' }).parentElement
        ?.parentElement;
      if (!dock) throw new Error('The note dock did not render.');
      vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ y: 500, width: 216, height: 48 }),
      );
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      const companion = screen.getByRole('complementary', { name: 'Cat companion' });
      await waitFor(() => {
        expect(companion).toHaveStyle({ top: '428px' });
      });
      expect(
        document.documentElement.style.getPropertyValue('--mobile-note-toolbar-clearance'),
      ).toBe('140px');

      view.rerender(
        <MemoryRouter>
          <PetCompanion />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(companion).toHaveStyle({ top: '504px' });
      });
      expect(
        document.documentElement.style.getPropertyValue('--mobile-note-toolbar-clearance'),
      ).toBe('');
    } finally {
      document.documentElement.style.removeProperty('--mobile-nav-height');
    }
  });

  it('reclamps when the shell announces a change to the nav height, without waiting for a resize', async () => {
    document.documentElement.style.setProperty('--mobile-nav-height', '64px');
    try {
      stubViewport(390);
      localStorage.setItem('nix.pet.position', JSON.stringify({ x: 5000, y: 5000 }));
      render(
        <MemoryRouter>
          <PetCompanion />
        </MemoryRouter>,
      );
      const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
      vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue({
        width: 64,
        height: 64,
        top: 0,
        left: 0,
        right: 64,
        bottom: 64,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      const companion = screen.getByRole('complementary', { name: 'Cat companion' });
      await waitFor(() => {
        expect(companion).toHaveStyle({ top: '708px' });
      });

      // A PWA banner appearing above the nav grows it without the window itself resizing; the
      // shell announces the change (`app-shell.tsx`) rather than leaving this to notice only on
      // the next real resize.
      document.documentElement.style.setProperty('--mobile-nav-height', '120px');
      act(() => {
        window.dispatchEvent(new Event('nix-mobile-nav-resized'));
      });
      await waitFor(() => {
        expect(companion).toHaveStyle({ top: '652px' });
      });
    } finally {
      document.documentElement.style.removeProperty('--mobile-nav-height');
    }
  });

  it('keeps a saved position on screen after crossing the phone breakpoint, as a rotation would', async () => {
    stubViewport(390);
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 5000, y: 5000 }));
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue({
      width: 64,
      height: 64,
      top: 0,
      left: 0,
      right: 64,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    await waitFor(() => {
      expect(companion).toHaveStyle({ left: '318px', top: '772px' });
    });

    // A phone rotated to landscape crosses back past the phone breakpoint on many devices
    // (`useNarrowViewport`, 640px) without becoming desktop-wide. The saved position - still
    // off-screen at 5000,5000 - must stay clamped to the new dimensions rather than render
    // unclamped, which an earlier version of this clamp did whenever `narrow` turned false.
    stubViewport(800);
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 390);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => {
      expect(companion).toHaveStyle({ left: '728px', top: '318px' });
    });
  });

  it('reclamps a position changed from settings rather than rendering it raw', async () => {
    stubViewport(390);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue({
      width: 64,
      height: 64,
      top: 0,
      left: 0,
      right: 64,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    // The settings page wrote an off-screen position and announced it the way `writePetPosition`
    // does - the same event a placement change there fires, both handled in this same tab.
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 9000, y: 9000 }));
    act(() => {
      window.dispatchEvent(new Event('nix-pet-device-changed'));
    });
    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    await waitFor(() => {
      expect(companion).toHaveStyle({ left: '318px', top: '772px' });
    });
  });

  it('does not persist a clamp, so a later wide viewport restores the saved position', async () => {
    // A position a real desktop drag could actually have produced - `onPointerMove` clamps live
    // against the window it is dragged in, so a saved position is never further off-screen than
    // that window was. 390x844 (the phone below) is what makes it off-screen there.
    stubViewport(390);
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 1200, y: 800 }));
    const view = render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    vi.spyOn(launcher, 'getBoundingClientRect').mockReturnValue({
      width: 64,
      height: 64,
      top: 0,
      left: 0,
      right: 64,
      bottom: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    await waitFor(() => {
      expect(companion).toHaveStyle({ left: '318px', top: '772px' });
    });
    // The clamp only ever changed what was rendered; storage still holds the desktop position.
    expect(JSON.parse(localStorage.getItem('nix.pet.position') ?? 'null')).toEqual({
      x: 1200,
      y: 800,
    });

    // Both the media query and the actual window dimensions have to grow back for this to be a
    // faithful "the window widened" - `stubViewport` alone only fakes `matchMedia`.
    stubViewport(true);
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 900);
    view.rerender(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => {
      expect(companion).toHaveStyle({ left: '1200px', top: '800px' });
    });
  });

  it('does not clamp a position while the launcher measures zero (hidden by the keyboard)', async () => {
    stubViewport(390);
    localStorage.setItem('nix.pet.position', JSON.stringify({ x: 5000, y: 5000 }));
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Talk with Cat' });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const companion = screen.getByRole('complementary', { name: 'Cat companion' });
    expect(companion).toHaveStyle({ left: '5000px', top: '5000px' });
  });

  it('hides the launcher while the software keyboard occludes the page', async () => {
    stubViewport(390);
    const viewport = Object.assign(new EventTarget(), { height: 800, scale: 1 });
    vi.stubGlobal('innerHeight', 800);
    vi.stubGlobal('visualViewport', viewport);
    render(
      <MemoryRouter>
        <PetCompanion />
        <input aria-label="Unrelated field" />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    expect(launcher).not.toHaveClass('hidden');

    act(() => {
      screen.getByRole('textbox', { name: 'Unrelated field' }).focus();
      viewport.height = 480;
      viewport.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => {
      expect(launcher).toHaveClass('hidden');
    });
  });

  it('never opens the conversation from a drag', async () => {
    stubViewport(390);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    fireEvent.pointerDown(launcher, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(launcher, {
      pointerId: 1,
      movementX: 10,
      movementY: 10,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerUp(launcher, { pointerId: 1 });
    fireEvent.click(launcher);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on a genuine tap even right after a drag whose click never fired', async () => {
    stubViewport(390);
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    const launcher = await screen.findByRole('button', { name: 'Talk with Cat' });
    // A touch drag past the slop dispatches no `click` at all; simulate that abandoned
    // sequence (no trailing click), then a plain, separate tap.
    fireEvent.pointerDown(launcher, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(launcher, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(launcher, { pointerId: 1 });

    fireEvent.pointerDown(launcher, { pointerId: 2, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(launcher, { pointerId: 2 });
    fireEvent.click(launcher);
    expect(await screen.findByRole('dialog', { name: 'Conversation with Cat' })).toBeVisible();
  });

  it('locks and restores background scroll around the phone dialog', async () => {
    stubViewport(390);
    document.body.style.overflow = 'auto';
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PetCompanion />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(document.body.style.overflow).toBe('auto');
    });
  });

  it('closes the phone dialog when the route changes underneath it', async () => {
    // Must-fix 6: a link followed from inside the conversation (here, "Pet settings" from the
    // overflow menu) has nowhere to share the screen with the dialog on a phone, so it must
    // close rather than leave the new page invisible behind it.
    stubViewport(390);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/w/33333333-3333-4333-8333-333333333333']}>
        <Routes>
          <Route path="/w/:workspaceId" element={<PetCompanion />} />
          <Route path="/w/:workspaceId/settings" element={<div>Workspace settings page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Talk with Cat' }));
    await screen.findByRole('dialog', { name: 'Conversation with Cat' });
    await user.click(screen.getByRole('button', { name: 'More conversation actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pet settings' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Workspace settings page')).toBeVisible();
  });
});
