#!/usr/bin/env bash
# Tests for check-frontend-layering.sh.
#
# Same shape as check-spacing-roles.test.sh: a fixture corpus this script owns, never the
# repository tree, so a legitimate new import elsewhere cannot turn into a spurious failure here
# and this suite stays a test of the matcher rather than a change detector for other people's work.
#
# Portable across BSD (macOS) and GNU tools; bash 3.2 compatible.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
guard="$script_dir/check-frontend-layering.sh"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/check-frontend-layering.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

passed=0
failed=0

# The leaves live in the web-foundation package; features and the shell stay in the app tree.
f="$work_dir/packages/web-foundation/src"

# A tree with every tier present and nothing in it that violates a rule. Each case below starts
# from this and adds exactly one file, so a failure names the rule rather than the fixture.
reset_tree() {
  rm -rf "${work_dir:?}/src" "${work_dir:?}/packages"
  mkdir -p "$f/layout" "$f/a11y" "$f/lib" \
    "$work_dir/src/shell" "$work_dir/src/items" "$work_dir/src/tests"
  printf "export const paneClip = 'min-h-0';\n" >"$f/layout/regions.ts"
  printf "export function announce(): void {}\n" >"$f/a11y/announcer.ts"
  printf "export function browserStorage(): void {}\n" >"$f/lib/browser-storage.ts"
  printf "export interface ShellContext { readonly id: string }\n" >"$work_dir/src/shell/shell-context.ts"
  printf "export function Sidebar(): null { return null; }\n" >"$work_dir/src/items/workspace-sidebar.tsx"
}

# add <relative path> ; body on stdin. A leaf folder (layout, a11y, lib) goes to the package,
# anything else to the app; a path starting with packages/ is taken as given.
add() {
  case "$1" in
    layout/* | a11y/* | lib/*) target="$f/$1" ;;
    packages/*) target="$work_dir/$1" ;;
    *) target="$work_dir/src/$1" ;;
  esac
  mkdir -p "$(dirname "$target")"
  cat >"$target"
}

# expect <exit code> <description> [expected substring of output ...]
expect() {
  want_code="$1"
  description="$2"
  shift 2

  output=""
  got_code=0
  output="$("$guard" "$work_dir/src" "$work_dir/packages" 2>&1)" || got_code=$?

  problem=""
  if [ "$got_code" -ne "$want_code" ]; then
    problem="exit $got_code, wanted $want_code"
  else
    for needle in "$@"; do
      case "$output" in
        *"$needle"*) ;;
        *) problem="output missing '$needle'" ;;
      esac
    done
  fi

  if [ -n "$problem" ]; then
    failed=$((failed + 1))
    printf '  FAIL  %s\n' "$description" >&2
    printf '        %s\n' "$problem" >&2
    printf '%s\n' "$output" | while IFS= read -r line; do
      printf '        | %s\n' "$line" >&2
    done
  else
    passed=$((passed + 1))
    printf '  ok    %s\n' "$description"
  fi
}

echo "check-frontend-layering.test: fixtures in $work_dir"

# --- the clean tree ----------------------------------------------------------

reset_tree
expect 0 "a tree with every tier and no violation passes"

# --- R1: layout/ is a leaf that may reach lib/ -------------------------------

reset_tree
add layout/use-sidebar.ts <<'FIXTURE'
import { browserStorage } from '../lib/browser-storage';
export const width = browserStorage;
FIXTURE
expect 0 "layout/ may import lib/"

reset_tree
add layout/use-sidebar.ts <<'FIXTURE'
import { paneClip } from './regions';
export const width = paneClip;
FIXTURE
expect 0 "layout/ may import its own folder"

reset_tree
add layout/use-sidebar.ts <<'FIXTURE'
import { announce } from '../a11y/announcer';
export const width = announce;
FIXTURE
expect 1 "layout/ importing a11y/ fails" "layout/ imports something other than lib/" "use-sidebar.ts"

reset_tree
add layout/use-sidebar.ts <<'FIXTURE'
import { Sidebar } from '../items/workspace-sidebar';
export const width = Sidebar;
FIXTURE
expect 1 "layout/ importing a feature fails" "layout/ imports something other than lib/"

reset_tree
add layout/barrel.ts <<'FIXTURE'
export { Sidebar } from '../items/workspace-sidebar';
FIXTURE
expect 1 "a re-export out of layout/ is an edge like any other" "layout/ imports something other than lib/"

reset_tree
add layout/lazy.ts <<'FIXTURE'
export const load = async () => import('../items/workspace-sidebar');
FIXTURE
expect 1 "a dynamic import out of layout/ is an edge like any other" "layout/ imports something other than lib/"

reset_tree
add layout/documented.ts <<'FIXTURE'
/**
 * This folder must never do the following, which is why it is written here:
 *   import { Sidebar } from '../items/workspace-sidebar';
 */
// import { announce } from '../a11y/announcer';
export const nothing = 0;
FIXTURE
expect 0 "an import quoted in a comment is not a finding"

# --- R2 and R3: the absolute leaves ------------------------------------------

reset_tree
add a11y/live-region.ts <<'FIXTURE'
import { browserStorage } from '../lib/browser-storage';
export const store = browserStorage;
FIXTURE
expect 1 "a11y/ is tighter than layout/ - even lib/ is out of reach" "a11y/ imports from the application"

reset_tree
add lib/helper.ts <<'FIXTURE'
import { paneClip } from '../layout/regions';
export const clip = paneClip;
FIXTURE
expect 1 "lib/ importing the application fails" "lib/ imports from the application"

# --- R4: the shell is not imported for a value -------------------------------

reset_tree
add items/tree.tsx <<'FIXTURE'
import type { ShellContext } from '../shell/shell-context';
export const id = (c: ShellContext) => c.id;
FIXTURE
expect 0 "a feature may import a type from shell/"

reset_tree
add items/tree.tsx <<'FIXTURE'
import { type ShellContext } from '../shell/shell-context';
export const id = (c: ShellContext) => c.id;
FIXTURE
expect 0 "the inline type-import spelling is allowed too"

reset_tree
add items/tree.tsx <<'FIXTURE'
import { AppShell } from '../shell/app-shell';
export const shell = AppShell;
FIXTURE
expect 1 "a feature importing a value from shell/ fails" "imports shell/ for a value"

reset_tree
add shell/nav-rail.tsx <<'FIXTURE'
import { AppShell } from './app-shell';
export const rail = AppShell;
FIXTURE
expect 0 "shell/ may import itself for a value"

# --- R5: the dissolved folder stays dissolved --------------------------------

reset_tree
mkdir -p "$work_dir/src/app"
printf "export const App = 0;\n" >"$work_dir/src/app/index.ts"
expect 1 "an app/ folder coming back fails" "the dissolved app/ folder is back"

# --- R6: packages never import apps -----------------------------------------

reset_tree
add packages/web-foundation/src/lib/uses-app.ts <<'FIXTURE'
import { Sidebar } from '../../../../apps/web/src/items/workspace-sidebar';
export const s = Sidebar;
FIXTURE
expect 1 "a web package importing apps/ by path fails" "a web package imports from apps/" "uses-app.ts"

reset_tree
add packages/web-other/src/uses-app.ts <<'FIXTURE'
import { App } from '@nix/web/app';
export const a = App;
FIXTURE
expect 1 "any web-* package importing @nix/web fails" "a web package imports from apps/"

# --- R7: foundation <- platform ----------------------------------------------

reset_tree
add packages/web-foundation/src/lib/up.ts <<'FIXTURE'
import { useAuth } from '@nix/web-platform/auth/auth-provider';
export const u = useAuth;
FIXTURE
expect 1 "foundation importing platform fails" "imports a package above it" "up.ts"

reset_tree
add packages/web-platform/src/auth/down.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
import { x } from '@nix/web-other/x';
export const d = [announce, x];
FIXTURE
expect 1 "platform importing a package other than foundation fails" "imports a package above it" "down.ts"

reset_tree
add packages/web-platform/src/auth/ok.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
export const d = announce;
FIXTURE
expect 0 "platform importing foundation passes"

reset_tree
add packages/web-workspaces/src/workspaces/up.ts <<'FIXTURE'
import { x } from '@nix/web-sites/x';
export const u = x;
FIXTURE
expect 1 "workspaces importing a package above it fails" "imports a package above it" "up.ts"

reset_tree
add packages/web-workspaces/src/workspaces/ok.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
import { useAuth } from '@nix/web-platform/auth/auth-provider';
export const d = [announce, useAuth];
FIXTURE
expect 0 "workspaces importing foundation and platform passes"

reset_tree
add packages/web-sites/src/sites/up.ts <<'FIXTURE'
import { x } from '@nix/web-other/x';
export const u = x;
FIXTURE
expect 1 "sites importing a package outside its stack fails" "imports a package above it" "up.ts"

reset_tree
add packages/web-sites/src/sites/ok.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
export const d = [announce, useAuth, useWorkspace];
FIXTURE
expect 0 "sites importing foundation, platform and workspaces passes"

reset_tree
add packages/web-settings/src/settings/up.ts <<'FIXTURE'
import { x } from '@nix/web-other/x';
export const u = x;
FIXTURE
expect 1 "settings importing a package outside its stack fails" "imports a package above it" "up.ts"

reset_tree
add packages/web-settings/src/settings/ok.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { refusalMessage } from '@nix/web-sites/sites/site-copy';
export const d = [announce, useAuth, useWorkspace, refusalMessage];
FIXTURE
expect 0 "settings importing foundation, platform, workspaces and sites passes"

reset_tree
add packages/web-editor/src/editor/up.ts <<'FIXTURE'
import { x } from '@nix/web-other/x';
export const u = x;
FIXTURE
expect 1 "editor importing a package other than foundation or platform fails" "imports a package above it" "up.ts"

reset_tree
add packages/web-editor/src/editor/ok.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
export const d = [announce, useApiClient];
FIXTURE
expect 0 "editor importing foundation and platform passes"

reset_tree
add packages/web-settings/src/settings/up-collections.ts <<'FIXTURE'
import { x } from '@nix/web-collections/core/container-model';
export const u = x;
FIXTURE
expect 1 "settings importing web-collections (upward) fails" "imports a package above it" "up-collections.ts"

reset_tree
add packages/web-editor/src/editor/up-collections.ts <<'FIXTURE'
import { x } from '@nix/web-collections/core/container-model';
export const u = x;
FIXTURE
expect 1 "editor importing web-collections (upward) fails" "imports a package above it" "up-collections.ts"

reset_tree
add packages/web-collections/src/core/ok.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { PreferencesSection } from '@nix/web-settings/settings/preferences/PreferencesSection';
export const d = [announce, useAuth, useWorkspace, PreferencesSection];
FIXTURE
expect 0 "collections importing foundation, platform, workspaces and settings passes"

reset_tree
add packages/web-collections/src/core/up-views.ts <<'FIXTURE'
import { x } from '@nix/web-views/core/view-kinds';
export const u = x;
FIXTURE
expect 1 "collections importing web-views (upward) fails" "imports a package above it" "up-views.ts"

reset_tree
add packages/web-settings/src/settings/up-views.ts <<'FIXTURE'
import { x } from '@nix/web-views/core/view-kinds';
export const u = x;
FIXTURE
expect 1 "settings importing web-views (upward) fails" "imports a package above it" "up-views.ts"

reset_tree
add packages/web-views/src/core/ok.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
import { Container } from '@nix/web-collections/core/use-container';
import { PreferencesSection } from '@nix/web-settings/settings/preferences/PreferencesSection';
export const d = [announce, Container, PreferencesSection];
FIXTURE
expect 0 "views importing foundation, collections and settings passes"

reset_tree
add packages/web-views/src/core/up-app.ts <<'FIXTURE'
import { x } from '@nix/web-sites/sites/site-copy';
export const u = x;
FIXTURE
expect 1 "views importing a package outside its list (web-sites) fails" "imports a package above it" "up-app.ts"

reset_tree
add packages/web-collections/src/core/up-templates.ts <<'FIXTURE'
import { x } from '@nix/web-templates/templates/template-api';
export const u = x;
FIXTURE
expect 1 "collections importing web-templates (upward) fails" "imports a package above it" "up-templates.ts"

reset_tree
add packages/web-views/src/core/up-templates.ts <<'FIXTURE'
import { x } from '@nix/web-templates/templates/template-api';
export const u = x;
FIXTURE
expect 1 "views importing web-templates (upward) fails" "imports a package above it" "up-templates.ts"

reset_tree
add packages/web-templates/src/templates/ok.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
import { Container } from '@nix/web-collections/core/use-container';
import { findViewKind } from '@nix/web-views/core/view-kinds';
export const d = [announce, Container, findViewKind];
FIXTURE
expect 0 "templates importing foundation, collections and views passes"

reset_tree
add packages/web-templates/src/templates/up-settings.ts <<'FIXTURE'
import { x } from '@nix/web-settings/settings/preferences/PreferencesSection';
export const u = x;
FIXTURE
expect 1 "templates importing a package outside its list (web-settings) fails" "imports a package above it" "up-settings.ts"

reset_tree
add packages/web-other/src/fine.ts <<'FIXTURE'
import { announce } from '@nix/web-foundation/a11y/announcer';
export const a = announce;
FIXTURE
expect 0 "a web package importing another package is fine"

# --- R8: testing helpers are for tests ---------------------------------------

reset_tree
add packages/web-platform/src/api/uses-helper.ts <<'FIXTURE'
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
export const s = stubCoreApi;
FIXTURE
expect 1 "non-test source importing a testing/ module fails" "non-test source imports a testing/ module" "uses-helper.ts"

reset_tree
add items/uses-helper.ts <<'FIXTURE'
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';
export const m = memoryStorage;
FIXTURE
expect 1 "app source importing a testing/ module fails too" "non-test source imports a testing/ module"

reset_tree
add packages/web-editor/src/testing/render.tsx <<'FIXTURE'
import { signedIn } from '@nix/web-foundation/testing/render-with-router';
export const s = signedIn;
FIXTURE
expect 0 "a testing/ module may import another testing/ module"

reset_tree
add packages/web-foundation/src/testing/leak.ts <<'FIXTURE'
import { renderAt } from '@nix/web-editor/testing/render-with-router';
export const r = renderAt;
FIXTURE
expect 1 "testing/ folders obey R7: foundation testing may not import web-editor" "imports a package above it" "leak.ts"

# --- tests/ are out of scope -------------------------------------------------

reset_tree
add tests/layout/sidebar.test.tsx <<'FIXTURE'
import { Sidebar } from '../../items/workspace-sidebar';
import { announce } from '../../a11y/announcer';
export const t = [Sidebar, announce];
FIXTURE
expect 0 "tests may import anything"

reset_tree
add layout/tests/helper.ts <<'FIXTURE'
import { Sidebar } from '../../items/workspace-sidebar';
export const s = Sidebar;
FIXTURE
expect 0 "a tests directory nested inside a leaf is pruned too"

# --- argument handling -------------------------------------------------------

missing_code=0
"$guard" "$work_dir/not-a-directory" >/dev/null 2>&1 || missing_code=$?
if [ "$missing_code" -eq 2 ]; then
  passed=$((passed + 1))
  echo "  ok    a non-existent explicit root is an error, not a silent pass"
else
  failed=$((failed + 1))
  echo "  FAIL  a non-existent explicit root is an error, not a silent pass" >&2
  echo "        exit $missing_code, wanted 2" >&2
fi

# --- summary -----------------------------------------------------------------

printf '\ncheck-frontend-layering.test: %d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
