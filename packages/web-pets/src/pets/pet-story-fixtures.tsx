import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import {
  createNixClient,
  petConnectionSchema,
  type NixClient,
  type Workspace,
} from '@nix/api-client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import {
  WorkspaceProvider,
  type WorkspaceLoadState,
} from '@nix/web-workspaces/workspaces/workspace-context';
import { within } from '@testing-library/dom';
import { PetCompanion } from './pet-companion';

// Shared frames and stubs for the companion stories. The phone stories that route to the pet page
// live beside that page (apps/web/src/pages/pet-page.stories.tsx) and pass it in as `petPage`, so
// this package never imports the app.

export const PHONE_WORKSPACE = '55555555-5555-4555-8555-555555555555';

const phoneWorkspace = {
  id: PHONE_WORKSPACE,
  name: 'Northstar',
  versionRetentionDays: 90,
  storageQuotaBytes: '10737418240',
  createdAt: '2026-09-01T09:00:00Z',
  kind: 'team',
  canRename: true,
  canManageMembers: true,
  canLeave: true,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
} as unknown as Workspace;

export const phoneWorkspaceState = {
  status: 'ready',
  workspaces: [phoneWorkspace],
  error: null,
  reload: () => undefined,
  workspaceCreated: () => undefined,
  workspaceUpdated: () => undefined,
  workspaceRemoved: () => undefined,
} as WorkspaceLoadState & {
  readonly reload: () => void;
  readonly workspaceCreated: (workspace: Workspace) => void;
  readonly workspaceUpdated: (workspace: Workspace) => void;
  readonly workspaceRemoved: (workspaceId: string) => void;
};

export const phoneSettings = {
  revision: 1,
  settings: {
    enabled: true,
    activePetId: '44444444-4444-4444-8444-444444444444',
    motion: 'reduced' as const,
    profiles: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Pip',
        appearance: 'cat' as const,
        personality: 'calm' as const,
        responseLength: 'balanced' as const,
        instructions: '',
      },
    ],
  },
};

const phoneConnection = petConnectionSchema.parse({
  provider: 'chatgpt',
  status: 'connected',
  reason: 'Connected',
  canConnect: false,
  state: 'success',
  messages: [
    {
      id: 'question-1',
      role: 'user',
      text: 'Can you help me make a calm plan for the week?',
    },
    {
      id: 'answer-1',
      role: 'assistant',
      text: 'Of course. Start by choosing one thing that would make the week feel easier.\n\nOn Monday, take ten minutes to look at the commitments already in your calendar. Move anything that is not urgent, then choose one small task to finish before lunch. Keep the afternoon open for the work that needs your attention.\n\nOn Tuesday and Wednesday, leave a short break between meetings if you can. A little space makes it easier to recover when something takes longer than expected.\n\nAt the end of the week, notice what helped and carry only that forward. A plan should make room for the week you actually have, not add another standard to meet.',
    },
    {
      id: 'question-2',
      role: 'user',
      text: 'I have a busy Monday. What should I protect first?',
    },
    {
      id: 'reply',
      role: 'assistant',
      text: 'Protect a real lunch break and one focused block for your most important task. If the day fills up, those two anchors give you a place to begin and a chance to reset.\n\nYou could also leave a little space at the end of the day to write down what needs attention tomorrow. That way you do not have to keep the whole list in your head.',
    },
  ],
  verificationUrl: '',
  userCode: '',
});

/** Must-fix 9: the companion's connection now streams through the watch loop
 * (`client.query(pets.watchRuntime(...))`), not the old `execute`-only read - so a stub whose
 * `query` always answered with the settings payload made every conversation story's watch fail
 * schema validation and fall back to the connection panel instead of its own named state. Routing
 * by `endpoint.operation` is what lets the same stub answer both `pets.settings` (settings sheet)
 * and `pets.watchRuntime` (the live conversation) correctly. `revision: 1` keeps every watch tick
 * after the first a no-op rather than replaying `applyIfNewer`'s "equal revision" branch forever. */
export function routeQuery(
  settings: unknown,
  connection: ReturnType<typeof petConnectionSchema.parse>,
): (endpoint: { operation: string }) => Promise<unknown> {
  return (endpoint) =>
    endpoint.operation === 'items.get'
      ? Promise.resolve({
          id: '66666666-6666-4666-8666-666666666666',
          workspaceId: PHONE_WORKSPACE,
          title: 'Nix documentation',
          type: 'note',
        })
      : endpoint.operation === 'locks.get'
        ? Promise.resolve({ locked: false, unlockedUntil: null })
        : endpoint.operation === 'pets.watchRuntime' || endpoint.operation === 'pets.connection'
          ? Promise.resolve({ ...connection, revision: 1 })
          : Promise.resolve(settings);
}

const phoneClient = {
  ...createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }),
  query: routeQuery(phoneSettings, phoneConnection),
  execute: () => Promise.resolve(phoneConnection),
} as NixClient;

/**
 * Stubs `matchMedia` to answer narrow (below the 640px phone breakpoint) so the two stories
 * below render their phone layout, and restores the previous implementation when the story
 * unmounts rather than leaking it into whichever story renders next.
 */
function stubNarrowMatchMedia(): () => void {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) =>
    ({
      matches: !query.includes('640'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
  return () => {
    window.matchMedia = original;
  };
}

function stubPhoneSurface(): () => void {
  const previous = window.localStorage.getItem('nix.pet.surface');
  window.localStorage.setItem('nix.pet.surface', 'page-on-phones');
  return () => {
    if (previous === null) window.localStorage.removeItem('nix.pet.surface');
    else window.localStorage.setItem('nix.pet.surface', previous);
  };
}

/**
 * A device-sized frame for the phone stories below. `transform` on this box gives every
 * `position: fixed` descendant it, rather than the Storybook canvas, as its containing block
 * (CSS Transforms), which is what keeps the companion's fixed launcher and full-screen dialog
 * inside the simulated device rather than pinned to the whole preview iframe. `matchMedia` is
 * stubbed narrow synchronously, during this render, guarded by a ref so it runs once - so the
 * companion tree's own first render already sees the phone layout rather than painting wide and
 * then jumping.
 */
export function PhoneFrame({
  children,
  initialEntry = `/w/${PHONE_WORKSPACE}`,
  width = 390,
  height = 844,
  petPage,
}: {
  readonly children: ReactNode;
  readonly initialEntry?: string;
  readonly width?: number;
  readonly height?: number;
  readonly petPage?: ReactElement;
}): ReactElement {
  const restore = useRef<(() => void) | null>(null);
  restore.current ??= (() => {
    const restoreMedia = stubNarrowMatchMedia();
    const restoreSurface = stubPhoneSurface();
    return () => {
      restoreMedia();
      restoreSurface();
    };
  })();
  useEffect(
    () => () => {
      restore.current?.();
      restore.current = null;
    },
    [],
  );
  return (
    <div
      style={{ width, height, transform: 'translateZ(0)' }} // design-token-exempt: simulates a fixed device viewport for a story.
      className="relative flex h-full max-h-[calc(100dvh-var(--spacing)*8)] min-h-0 max-w-full flex-col overflow-hidden rounded-lg border border-divider"
    >
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/w/:workspaceId"
            element={
              <ApiClientOverrideProvider client={phoneClient}>
                <WorkspaceProvider state={phoneWorkspaceState}>{children}</WorkspaceProvider>
              </ApiClientOverrideProvider>
            }
          />
          {petPage && (
            <Route
              path="/w/:workspaceId/pet"
              element={
                <ApiClientOverrideProvider client={phoneClient}>
                  <WorkspaceProvider state={phoneWorkspaceState}>{petPage}</WorkspaceProvider>
                </ApiClientOverrideProvider>
              }
            />
          )}
        </Routes>
      </MemoryRouter>
    </div>
  );
}

/**
 * Follows the phone's default page preference with a native click (no test-only dependency), so
 * the conversation stories exercise the same launcher-to-page route a reader uses. The launcher
 * only exists once settings have resolved, so a `MutationObserver` waits rather than clicking on
 * the empty first render. The Talk label remains supported for a story where floating is chosen.
 */
export function AutoOpenCompanion(): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const clickWhenReady = (): boolean => {
      const button = node.querySelector<HTMLButtonElement>(
        'button[aria-label^="Open "], button[aria-label^="Talk with "]',
      );
      if (!button) return false;
      button.click();
      return true;
    };
    if (clickWhenReady()) return;
    const observer = new MutationObserver(() => {
      if (clickWhenReady()) observer.disconnect();
    });
    observer.observe(node, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <div ref={container}>
      <PetCompanion />
    </div>
  );
}

/** The one-row header and one-row composer: the controls a reader needs, each named. */
export async function expectChatControls({
  canvasElement,
}: {
  canvasElement: HTMLElement;
}): Promise<void> {
  const canvas = within(canvasElement);
  await canvas.findByRole('button', { name: 'More conversation actions' }, { timeout: 10_000 });
  await canvas.findByRole('button', { name: 'Add to message' });
  await canvas.findByRole('textbox', { name: /^Message / });
  canvas.getByRole('button', { name: 'Send' });
}
