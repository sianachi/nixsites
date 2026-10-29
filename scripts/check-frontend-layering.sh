#!/usr/bin/env bash
# Guard: the frontend's dependency direction.
#
# AGENTS.md says "apps/* -> packages/*, never sideways or upward",
# and until this script nothing enforced it. The backend has check-layering.sh;
# the frontend had review. Review is what let apps/web/src/app/ become a folder
# that was a leaf and a root at once - half the application imported its
# vocabulary, and its composition imported half the application - which produced
# a real import cycle:
#
#   app-shell.tsx -> items/workspace-sidebar.tsx -> app/announcer.ts
#
# The tiers below are what replaced that folder. The rules are a direction, not
# a taste, so unlike check-spacing-roles.sh there is no exemption marker for any
# of them: a direction rule with an escape hatch is a suggestion, and the whole
# reason layout/ and shell/ are separate folders is that no file needs one.
#
#   T0 leaf     lib/, a11y/    third-party and their own folder, nothing else
#   T0 leaf     layout/        the above, plus lib/
#               (all three live in packages/web-foundation/src)
#   T1 feature  everything else under apps/web/src    T0, siblings, shell/ type-only
#   T2 shell    shell/         anything
#   T3 root     app.tsx, main.tsx             anything
#
# The leaf rules compose, and that is the point. layout/ may only reach lib/,
# and lib/ may reach nothing, so there is no path out of the leaf set at all -
# which makes the cycle above unexpressible rather than merely detected. That is
# also why this script does not try to detect cycles directly: a DFS over the
# module graph in bash 3.2 (no associative arrays - see check-spacing-roles.sh's
# own workaround for a far smaller structure) would need path normalisation and
# extension resolution, and would earn its keep only for feature-to-feature
# cycles, which are not the problem observed.
#
# Rules enforced:
#
#   R1  layout/ imports nothing from the application but lib/.
#   R2  a11y/ imports nothing from the application.
#   R3  lib/ imports nothing from the application.
#   R4  nobody outside shell/, app.tsx and main.tsx imports shell/ for a value.
#   R5  apps/web/src/app/ does not exist.
#   R6  nothing under packages/web-* imports from apps/ (packages never import apps).
#   R7  each web package imports only the web packages on its allowed list (a DAG, see the r7_scan
#      calls below): web-foundation none, web-platform foundation, web-editor and web-workspaces
#      those two, web-sites adds workspaces, web-settings adds editor and sites, web-collections
#      foundation, platform, editor, workspaces and settings, web-views those plus web-collections, web-templates the same plus web-views.
#   R8  non-test source (anything outside a tests/ or testing/ directory) imports no */testing/*
#      module. The testing/ folders obey R6 and R7 like any other source.
#
# Be clear about what this is worth. It catches the ordinary mistake - someone
# adds `import { announce } from '../a11y/announcer'` to a layout/ file - and
# fails with a file and a line. It does not catch a determined one:
#
#   - Matching is line-oriented, so an import statement folded across lines with
#     `from` on its own is invisible. Prettier's current settings keep every
#     import in apps/web/src on one line; a reformat would silently narrow this
#     script's coverage rather than fail loudly.
#   - R4 cannot tell a genuinely type-only multi-line import from a value one.
#   - `ReturnType<typeof x>` can reach a feature's type through an allowed
#     module without ever naming it.
#
# If "the grep missed one" ever happens, the replacement is a real tool rather
# than a bigger script: eslint-plugin-import's `import/no-cycle` plus
# `no-restricted-imports` zones, which have a TypeScript resolver and see the
# whole graph. That is the same escalation check-layering.sh names for itself.
#
# Scope is apps/web/src (R4, R5), packages/web-foundation/src (R1-R3) and packages/web-* (R6). Tests may import whatever they need, so any directory
# named `tests` is pruned - the same call check-text-primitive.sh makes.
#
# Portable across BSD (macOS) and GNU grep: only -r, -n, -E and --include are
# used, and the patterns avoid word-boundary escapes (\b, \<, [[:<:]]) which the
# two implementations spell differently. bash 3.2 compatible.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

# Usage: check-frontend-layering.sh [web-src [packages-dir]]. The arguments exist so the test suite
# can point this at a fixture corpus; CI runs it bare from the repo root.
if [ "$#" -gt 0 ]; then
  src="$1"
  packages="${2:-}"
  for dir in "$src" "$packages"; do
    if [ -n "$dir" ] && [ ! -d "$dir" ]; then
      echo "check-frontend-layering: '$dir' is not a directory." >&2
      exit 2
    fi
  done
else
  cd "$repo_root"
  src="apps/web/src"
  packages="packages"
  if [ ! -d "$src" ]; then
    echo "check-frontend-layering: $src not found; nothing to check."
    exit 0
  fi
fi
foundation="${packages:+$packages/web-foundation/src}"

# Every way a module can name another file: a static import, a re-export, and a
# dynamic import(). All three are edges in the graph and all three are caught by
# looking for the `../` that leaves the folder.
edge="(from|import\()[[:space:]]*'\.\./"

# grep exits 1 when nothing matches; that is the good case here, so soak it up.
# Comment-only lines are dropped so a docblock quoting a forbidden import - this
# file's own header would trip R1 if it lived under layout/ - is not a finding.
scan() {
  pattern="$1"
  target="$2"
  if [ ! -d "$target" ]; then
    return 0
  fi
  grep -rnE --include='*.ts' --include='*.tsx' --exclude-dir=tests "$pattern" "$target" 2>/dev/null |
    grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' || true
}

# R1: layout/ may reach lib/ and nothing else. Default-deny - match every `../`
# and subtract the allowlist - so a folder added next year is forbidden without
# anyone remembering to edit this script.
layout_leaks="$(scan "$edge" "$foundation/layout" | grep -vE "(from|import\()[[:space:]]*'\.\./lib/" || true)"

# R2 and R3: absolute leaves. Any `../` at all is a finding.
a11y_leaks="$(scan "$edge" "$foundation/a11y")"
lib_leaks="$(scan "$edge" "$foundation/lib")"

# R4: the shell is the composition tier, so a feature reaching into it inverts
# the direction. A type-only import is erased at compile time and carries no
# runtime edge, so it is allowed - both spellings of it.
shell_value_imports=""
for dir in "$src"/*/; do
  name="$(basename "$dir")"
  case "$name" in
    shell | tests) continue ;;
  esac
  found="$(scan "(from|import\()[[:space:]]*'(\.\./)+shell/" "$dir" |
    grep -vE "(import[[:space:]]+type|\{[[:space:]]*type[[:space:]])" || true)"
  if [ -n "$found" ]; then
    shell_value_imports="$shell_value_imports$found
"
  fi
done
shell_value_imports="$(printf '%s' "$shell_value_imports" | grep -v '^$' || true)"

# R5: the dissolved folder stays dissolved. This also keeps `import { App } from
# '../../app'` unambiguous - it resolves to app.tsx only because no app/ sits
# beside it, and an app/index.ts would silently steal every one of those imports.
app_folder=""
if [ -d "$src/app" ]; then
  app_folder="$src/app"
fi

# R6: a web package that reaches back into an app is a cycle waiting for a build step. Both the
# relative spelling and the workspace name are caught.
apps_imports=""
if [ -n "$packages" ]; then
  for dir in "$packages"/web-*/; do
    found="$(scan "(from|import\()[[:space:]]*'([^']*/)?apps/|(from|import\()[[:space:]]*'@nix/web(/|')" "$dir")"
    if [ -n "$found" ]; then
      apps_imports="$apps_imports$found
"
    fi
  done
  apps_imports="$(printf '%s' "$apps_imports" | grep -v '^$' || true)"
fi

# R7: each web package may import only the web packages on its allowed list (plus itself). The lists
# form a DAG, listed bottom-up; add one line per new package.
r7_scan() {
  pkg="$1"
  allowed="$2"
  scan "(from|import\\()[[:space:]]*'@nix/web-[a-z-]+" "$packages/$pkg/src" |
    grep -vE "'@nix/($pkg|${allowed// /|})[/']" || true
}
up_imports=""
if [ -n "$packages" ]; then
  up_imports="$(
    r7_scan web-foundation "web-foundation"
    r7_scan web-platform "web-foundation"
    r7_scan web-editor "web-foundation web-platform"
    r7_scan web-workspaces "web-foundation web-platform"
    r7_scan web-sites "web-foundation web-platform web-workspaces"
    r7_scan web-settings "web-foundation web-platform web-editor web-workspaces web-sites"
    r7_scan web-collections "web-foundation web-platform web-editor web-workspaces web-settings"
    r7_scan web-views "web-foundation web-platform web-editor web-workspaces web-settings web-collections"
    r7_scan web-templates "web-foundation web-platform web-editor web-workspaces web-collections web-views"
  )"
  up_imports="$(printf '%s' "$up_imports" | grep -v '^$' || true)"
fi

# R8: testing helpers are for tests. scan() prunes tests/ only, so testing/ is pruned here as well.
testing_imports=""
for root in "$src" ${packages:+"$packages"/web-*/}; do
  found="$(scan "(from|import\()[[:space:]]*'[^']*/testing/" "$root" | grep -vE '^[^:]*/testing/' || true)"
  if [ -n "$found" ]; then
    testing_imports="$testing_imports$found
"
  fi
done
testing_imports="$(printf '%s' "$testing_imports" | grep -v '^$' || true)"

if [ -z "$layout_leaks" ] && [ -z "$a11y_leaks" ] && [ -z "$lib_leaks" ] &&
  [ -z "$shell_value_imports" ] && [ -z "$app_folder" ] && [ -z "$apps_imports" ] && [ -z "$up_imports" ] && [ -z "$testing_imports" ]; then
  echo "check-frontend-layering: OK (the leaves are leaves; the shell is imported for a value only by the route table)."
  exit 0
fi

echo "check-frontend-layering: FAIL" >&2

report() {
  heading="$1"
  matches="$2"
  if [ -n "$matches" ]; then
    echo "$heading" >&2
    printf '%s\n' "$matches" | while IFS= read -r line; do
      printf '  %s\n' "$line" >&2
    done
  fi
}

report "layout/ imports something other than lib/:" "$layout_leaks"
report "a11y/ imports from the application:" "$a11y_leaks"
report "lib/ imports from the application:" "$lib_leaks"
report "a web package imports from apps/:" "$apps_imports"
report "a web package imports a package above it (foundation <- platform):" "$up_imports"
report "non-test source imports a testing/ module:" "$testing_imports"
report "a feature imports shell/ for a value rather than a type:" "$shell_value_imports"
if [ -n "$app_folder" ]; then
  report "the dissolved app/ folder is back:" "$app_folder"
fi

echo >&2
echo "Rule: layout/, a11y/ and lib/ are leaves - the arrangement, the announcer" >&2
echo "and the framework-agnostic helpers, none of which may know what a feature" >&2
echo "is. layout/ may reach lib/; the other two reach nothing. The allowlist is" >&2
echo "the 'layout_leaks' line in this script, and widening it is a decision" >&2
echo "about the tiers rather than about one import." >&2
echo >&2
echo "shell/ is the composition tier and sits above the features, so a feature" >&2
echo "that needs a *value* from it has the direction backwards: push the value" >&2
echo "down into a feature folder or into layout/ rather than weakening this" >&2
echo "rule. Types are exempt because they are erased and carry no runtime edge." >&2
exit 1
