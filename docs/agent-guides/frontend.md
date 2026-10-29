# Frontend guide

Read for `apps/web/` and `packages/` changes.

Keep dependency direction `apps/* -> packages/*`; `packages/web-*` never import
`apps/`. The web app's lower layers are packages, each importing only the packages on its allowed list in `scripts/check-frontend-layering.sh` (R7, a DAG):
`web-foundation` (`lib/`, `a11y/`, `layout/`, `keyboard/`, `theme/`, `audio/`,
`components/`) <- `web-platform` (`auth/`, `pwa/`, `api/`, `session/`, `panes/`,
`routing/`, `export/`) <- `web-editor` (`editor/`, `plugins/`) and `web-workspaces`
(`workspaces/`, `import/`, `launch/`) <- `web-sites` (`sites/`) <- `web-settings` (`settings/`) <- `web-collections` (`core/`,
`properties/`, `items/`, `sheet/`, `thumbnails/`) <- `web-views` (the view registry and every view kind, `suggest/`, `wizard/`) <- `web-templates` (`templates/`). They export TypeScript
source (no build); import deep paths that mirror the folders, e.g.
`@nix/web-foundation/lib/browser-storage`. A new `.tsx` file needs its own exact
`exports` entry in the package's `package.json` (the `./*` pattern only reaches `.ts`).
Each package is a TypeScript composite project (`tsc -b`, output in a gitignored `.tsbuild/`):
list every web package it imports under `references`, and add new packages to `apps/web`'s.
A package's tests live in its `src/tests` and run in that package; shared test helpers
live in `web-foundation/src/testing`, `web-editor/src/testing`, `web-collections/src/testing` and `web-views/src/testing`, which non-test code may not
import (R8). Tests that render the whole app stay in `apps/web/src/tests`. `check-frontend-layering.sh` (R6, R7) enforces the
order. In `web-foundation`, `lib/` and `a11y/` are leaves and `layout/` may additionally reach `lib/`.
Inside `apps/web/src`, features may import those, siblings, and `shell/` types
only; only `app.tsx` value-imports `shell/`. Put a file where its knowledge
belongs: pure arguments in `lib/`, arrangement in `layout/`, data regions in
features, composition in `shell/`.

Use stateless-first state, Zod at runtime boundaries, cache-backed API client
requests with cancellation, and workspace-scoped navigation/state. Do not revive
a browser OIDC client or make authorization decisions from claims. Manual React
memoization requires an adjacent identity, profiled-cost, or library-contract
reason.

Use token-backed Tailwind utilities/CVA, semantic colour roles, `Text` for text
variants, and the existing design grammar. No general CSS, raw design values,
`dark:` escape hatches, or emojis. UI data states must honestly show loading,
empty, error, and partial results.

Place web tests under the owning package's `src/tests/` (the app's under
`apps/web/src/tests/`), mirroring source folders; query by role. UI components need stories and axe coverage. Run the path-selected
package checks and applicable frontend guards.
