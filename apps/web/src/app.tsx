import { Text } from '@nix/ui';
import { Suspense, lazy, type ReactElement } from 'react';
import { Route, Routes } from 'react-router';

import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { AutomationsPage } from './automations/automations-page';
import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AppErrorBoundary } from '@nix/web-foundation/components/error-boundary';
import { DailyNotePage } from './daily-notes/daily-note-page';
import { NewChatNote } from './views/chat/new-chat-note';
import { BookmarksPage } from './pages/bookmarks-page';
import { CalendarPage } from './pages/calendar-page';
import { EditorPage } from './pages/editor-page';
import { GraphPage } from './pages/graph-page';
import { PetPage } from './pages/pet-page';
import { NotFoundPage } from './pages/not-found-page';
import { PublicFormPage } from './pages/public-form-page';
import { SettingsPage } from './pages/settings-page';
import { TemplateLibraryPage } from './templates/library/template-library-page';
import { TemplateImportPage } from './templates/import/template-import-page';
import { TemplateStudioPage } from './templates/template-studio-page';
import { TrashPage } from './pages/trash-page';
import { CreationStudioPage } from './views/wizard/creation-studio-page';
import { RequireSession } from './shell/require-session';
import { AppShell } from './shell/app-shell';
import { LegacyWorkspaceRedirect, WorkspaceGate } from './workspaces/workspace-gate';
import {
  WorkspaceGroupPage,
  WorkspaceGroupsPage,
  LegacyWorkspaceGroupRedirect,
} from './workspaces/workspace-group-page';
import { ArchivedWorkspacesPage } from './workspaces/archived-workspaces-page';
import { AccessibleWorkspacesProvider } from './workspaces/workspace-context';
import { PetCompanion } from './pets/pet-companion';
import { LaunchPage } from './launch/launch-page';

// Loaded when somebody opens /tokens, not before: the specimens are about 35 kB of design-lane
// reference material - every ramp step, every type scale, every rhythm demo - and nobody working
// in the product opens them. The same treatment `editor-page.tsx` gives the canvas, for the same
// reason.
const TokensPage = lazy(async () => {
  const module = await import('./pages/tokens-page');
  return { default: module.TokensPage };
});

/**
 * The server-free demo (lib/web-config.ts), which main.tsx mounts as its own root outside <App />.
 * Exported from here so the entry keeps its one dynamic import and the demo stays out of every
 * install's startup cache.
 */
export const DemoRoot = lazy(async () => {
  const module = await import('./demo/demo-page');
  await module.prepareDemo();
  return { default: module.DemoPage };
});

/**
 * The route tree and the crash barrier that wraps it.
 *
 * react-router is used in declarative mode: routes are JSX, and there are no
 * loaders, because nothing in this app fetches yet. When the api-client lands,
 * the tree moves to data mode and this file is where that happens - callers
 * only ever see <App />.
 *
 * The error boundary sits inside the router on purpose. A crash in a page
 * leaves the router mounted, so recovery re-renders the current route instead
 * of reloading the document and losing the URL state.
 *
 * <App /> expects a router above it. main.tsx supplies BrowserRouter; tests
 * supply MemoryRouter, which is what makes the URL-state convention testable
 * without a browser.
 *
 * The outer element carries the token-backed page defaults - the ground, the ink
 * and the body face - so they survive even when a crash replaces the whole route
 * tree with the error fallback.
 *
 * `min-h-dvh` is part of that promise rather than layout left over from an older
 * shell. Nothing sets a background on html or body, so this element is the only
 * thing painting the page, and the error fallback has no height of its own:
 * without a minimum, an app-level crash paints a ground the height of its own
 * error message and leaves the rest of the window browser-white - which on the
 * dark ground is a dark card on a white sheet. It does not fight the shell's
 * `h-dvh` either, because a minimum on the parent still leaves the child's
 * height definite.
 */
export function App(): ReactElement {
  return (
    <div className="min-h-dvh bg-background font-body text-foreground">
      <AppErrorBoundary>
        <AuthProvider>
          <ApiClientProvider>
            <AppRoutes />
          </ApiClientProvider>
        </AuthProvider>
      </AppErrorBoundary>
    </div>
  );
}

/**
 * Every route of the application. <App /> mounts it under the real session and API client; the
 * server-free demo mounts it under its own, in a memory router.
 */
export function AppRoutes(): ReactElement {
  return (
    <Routes>
      <Route path="/forms/:token" element={<PublicFormPage />} />

      <Route element={<RequireSession />}>
        <Route element={<AccessibleWorkspacesProvider />}>
          <Route path="/workspaces/groups" element={<WorkspaceGroupsPage />} />
          <Route
            path="/workspaces/groups/:groupId"
            element={<WorkspaceGroupPage NewChatNote={NewChatNote} />}
          />
          <Route path="/workspaces/archived" element={<ArchivedWorkspacesPage />} />
          <Route
            path="/w/:workspaceId"
            element={
              <WorkspaceGate>
                <>
                  <AppShell />
                  <PetCompanion />
                </>
              </WorkspaceGate>
            }
          >
            {/* One workspace, one place to be. The board is a view of a container rather
            than a destination, and search opens over whatever is on screen, so neither
            has a route of its own. */}
            <Route index element={<EditorPage />} />
            <Route path="new/:recipe" element={<CreationStudioPage />} />
            <Route path="items/:itemId/views/new/:recipe" element={<CreationStudioPage />} />
            <Route
              path="items/:itemId/views/:viewId/edit/:recipe"
              element={<CreationStudioPage />}
            />

            {/* The rail's workspace-view destinations. These *are* places, unlike a board
            or a search: each is a way of looking at the whole workspace rather than at
            one container, so none of them has an item to hang off and each needs an
            address of its own. Not lazy-loaded, unlike the token specimens: the screens
            are small, and a Suspense boundary around nothing is a fallback that can only
            ever flash. */}
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="daily" element={<DailyNotePage />} />
            <Route path="daily/:date" element={<DailyNotePage />} />
            <Route path="graph" element={<GraphPage />} />
            <Route path="pet" element={<PetPage />} />
            <Route path="bookmarks" element={<BookmarksPage />} />
            <Route path="trash" element={<TrashPage />} />
            <Route path="templates" element={<TemplateLibraryPage />} />
            <Route path="templates/new" element={<TemplateStudioPage />} />
            <Route path="templates/import" element={<TemplateImportPage />} />
            <Route path="templates/:templateId/create" element={<TemplateStudioPage />} />
            <Route path="templates/:templateId/edit" element={<TemplateStudioPage />} />
            <Route
              path="items/:itemId/templates/apply/:templateId"
              element={<TemplateStudioPage />}
            />

            {/* Reached from both the persistent rail and the profile menu: the rail makes
            workspace administration findable, while the profile menu keeps personal
            access tokens where somebody already expects account-level controls. Not
            lazy-loaded, for the rail destinations' reason - the screen is small, and a
            Suspense boundary around nothing is a fallback that can only ever flash. */}
            <Route path="settings" element={<SettingsPage />} />
            <Route path="workspace-groups/:groupId" element={<LegacyWorkspaceGroupRedirect />} />

            {/* The caller's own rules in this workspace (ADR-0051 section 6). A place of its
            own rather than a settings tab: a rule has an editor and a run log, and the
            address names the open rule so a link to it survives a refresh. */}
            <Route path="automations" element={<AutomationsPage />} />

            {/* Where the installed app lands from a shortcut, the share sheet or an opened
            file. `/launch/...` outside a workspace is routed here by
            `LegacyWorkspaceRedirect`, which picks the workspace exactly as for `/`. */}
            <Route path="launch/:action" element={<LaunchPage />} />

            {/* The boundary is per-route rather than around the whole tree: a fallback over
            `Routes` would blank the shell while a chunk arrives. The wording matches the
            canvas's - what is loading, named, rather than a spinner claiming nothing. */}
            <Route
              path="tokens"
              element={
                <Suspense
                  fallback={
                    <Text variant="note" as="div" tone="muted" className="p-8">
                      Loading the token specimens…
                    </Text>
                  }
                >
                  <TokensPage />
                </Suspense>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route path="*" element={<LegacyWorkspaceRedirect />} />
        </Route>
      </Route>
    </Routes>
  );
}
