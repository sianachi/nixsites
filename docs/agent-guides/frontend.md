# Frontend guide

Read for `apps/web/` and `packages/` changes.

Keep dependency direction `apps/* -> packages/*`; `packages/web-*` never import
`apps/`. `lib/`, `a11y/`, `layout/`, `keyboard/`, `theme/`, `audio/` and
`components/` live in `packages/web-foundation` (see its README for the import
form): `lib/` and `a11y/` are leaves and `layout/` may additionally reach `lib/`.
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

Place web tests under `apps/web/src/tests/`, mirroring source folders; query by
role. UI components need stories and axe coverage. Run the path-selected
package checks and applicable frontend guards.
