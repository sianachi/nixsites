#!/usr/bin/env bash
# Guard: a text element that names a type step uses <Text> instead (U11).
#
# `check-raw-design-values.sh` catches `text-[13px]` - a size that is not on the scale at all.
# `check-spacing-roles.sh` catches a valid spacing token chosen for the wrong shape. Neither can
# catch the thing U11's sweep actually found: `<p className="text-sm text-muted">Loading…</p>`,
# where every class is a legitimate token, correctly chosen, and the defect is that a paragraph is
# dressing itself instead of asking the typography primitive for a variant. Fifty-five of those
# had accumulated across `apps/web`, and the cost was not that any one of them looked wrong - it
# was that the scale had fifty-five owners, so `note` (`--text-sm`) existed in the sheet, was used
# twenty times, and was named by nothing.
#
# **The rule.** A line in `apps/web` that opens a text element - `<p>`, `<span>`, `<h1>`...`<h6>`,
# `<li>`, `<dt>`, `<dd>`, `<figcaption>`, `<caption>`: exactly the tags `<Text>` can render - and
# also carries a type-scale size class (`text-2xs` ... `text-3xl`) fails. Those are the cases where
# `<Text variant="...">` is a drop-in, so "there was no way to say it" is never the reason.
#
# **Why only the size steps, and not family, weight or tracking.** Because `<Text>` owns the size
# axis completely and the others only partly. It offers no weight axis at all (`font-medium` on the
# login screen's workspace name has no variant and should not get one for a single call site), and
# `font-mono` is a deliberate departure the primitive will never carry. Tracking is a token scale of
# its own with legitimate uses outside type - `fieldLabel` composes it onto `<label>` elements that
# can never be a `<Text>`. A guard that flagged those would be teaching a rule the primitive does
# not actually make, and every false positive spends the exemption marker's credibility.
#
# **Why only `apps/web`.** `packages/ui` is where `<Text>` lives, and a control's internals are the
# one place raw classes are structurally required: `Text.tsx` cannot import itself, `Field.tsx`'s
# `<label>` has to be a real `<label>` carrying `htmlFor`, `Tabs`/`Segmented`/`Listbox` size their
# own options. Those internals publish their type through the primitive and through `fieldLabel`
# instead. `apps/web` consumes both and has no such excuse.
#
# **What this cannot see, by construction** - the same line-oriented limits its two sibling guards
# disclose, because parsing TSX is far past what a guard should carry:
#   - A className on a different line from its tag. `theme-choice.tsx`'s section label is written
#     `<p\n  aria-hidden="true"\n  className="...text-2xs...">` and is invisible here; it carries an
#     exemption marker anyway, for the reader rather than for this script. A formatter that folded
#     any of the lines this guard currently catches would silently drop them out of coverage.
#   - A class assembled from a constant or a variable, e.g. `className={cn(cardTitle, ...)}`. The
#     literal step never appears on the line.
#   - An element rendered by something other than a JSX tag - ProseMirror's document nodes are the
#     whole of `prose.ts`, which is why the steps there live in `prose-type.ts` as a named table
#     instead.
#   - Whether a migration was done *well*. `<Text variant="h1">` on a caption passes here.
#
# So a green run says "no visible text element is dressing itself", not "every string goes through
# the primitive".
#
# Scope:   *.tsx under apps/web/src and packages/web-*/src, excluding src/tests
# Skipped: node_modules, dist
# Exempt:  - a line containing a 'text-primitive-exempt' comment
#          - a line whose preceding 6 lines contain one, so the reason can be a paragraph above the
#            code rather than a trailing fragment squeezed onto it - which is how every exemption
#            in this repository is actually written
#          - a whole file containing 'text-primitive-exempt-file'
#          - a line that opens with '//' or '/*'
#
# Usage:   check-text-primitive.sh [root ...]
#          With no arguments it scans apps/web/src and packages/web-*/src from the repo root, which is what CI runs.
#          Explicit roots exist so the test suite can point this at a fixture corpus - see
#          check-text-primitive.test.sh.
#
# Exits 0 cleanly when apps/web/src does not exist yet.
#
# Portable across BSD (macOS) and GNU tools: no \b (BSD grep does not support it), bash 3.2
# compatible (no namerefs, no associative arrays).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

scan_roots=()
if [ "$#" -gt 0 ]; then
  for root in "$@"; do
    if [ ! -d "$root" ]; then
      echo "check-text-primitive: '$root' is not a directory." >&2
      exit 2
    fi
    scan_roots+=("$root")
  done
else
  cd "$repo_root"
  if [ ! -d apps/web/src ]; then
    echo "check-text-primitive: OK (no apps/web/src directory yet)."
    exit 0
  fi
  scan_roots+=('apps/web/src')
  # Web packages carry the app's moved code, so they answer to the same rule; packages/ui does not.
  for root in packages/web-*/src; do
    [ -d "$root" ] && scan_roots+=("$root")
  done
fi

# How far above a hit an exemption comment may sit. Six lines is enough for the four-line reasons
# this repository actually writes plus the JSX-comment braces around them.
EXEMPT_LOOKBACK=6

# The characters Tailwind glues onto a utility name, as the *contents* of a bracket expression.
# Hyphen has to count as part of the word or `text-md` would be found inside `max-w-md`.
token_chars='0-9a-zA-Z_:./%-'

# The tags <Text> can render, as an alternation. `div` is deliberately absent: it is the tag
# everything else in the app is built from, and flagging every div that sets an inherited size
# would bury the signal.
text_tags='p|span|h1|h2|h3|h4|h5|h6|li|dt|dd|figcaption|caption'

# An opening tag for one of them: '<p ' or '<p>' - never '<ProfileMenu', which is why the
# character after the tag name has to be a space or '>'.
tag_pattern="<(${text_tags})[ >]"

# A type-scale size class, whole-word. Variant prefixes are matched too (`md:text-lg` is the same
# decision made at a breakpoint), because the leading character class admits ':'.
step_pattern="(^|[^${token_chars}])(text-(2xs|xs|sm|base|md|lg|xl|2xl|3xl))([^${token_chars}]|$)"

comment_line_pattern='^[[:space:]]*(//|/\*|\*)'

violations=''

while IFS= read -r file; do
  [ -n "$file" ] || continue
  if grep -q 'text-primitive-exempt-file' "$file"; then
    continue
  fi

  hits="$(grep -nE "$tag_pattern" "$file" | grep -E "$step_pattern" || true)"
  [ -n "$hits" ] || continue

  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    lineno="${hit%%:*}"
    line="$(sed -n "${lineno}p" "$file")"

    # A comment-only line is prose about the code, not the code. Both sibling guards skip these
    # for the same reason: an example inside an explanation must not fail the thing it explains.
    if printf '%s\n' "$line" | grep -qE "$comment_line_pattern"; then
      continue
    fi

    # The hit line itself, plus the window above it. `sed -n 'a,bp'` with a floor of 1, since line
    # zero is not addressable.
    window_start=$((lineno - EXEMPT_LOOKBACK))
    [ "$window_start" -lt 1 ] && window_start=1
    if sed -n "${window_start},${lineno}p" "$file" | grep -q 'text-primitive-exempt'; then
      continue
    fi

    violations="${violations}  ${file}:${lineno}:${line}
"
  done <<EOF
$hits
EOF
done <<EOF2
$(find "${scan_roots[@]}" \
    \( -name node_modules -o -name dist -o -name tests \) -prune \
    -o -type f -name '*.tsx' -print)
EOF2

if [ -n "$violations" ]; then
  echo "check-text-primitive: FAIL" >&2
  echo "A text element names a step of the type scale instead of asking <Text> for a variant:" >&2
  printf '%s' "$violations" >&2
  echo >&2
  cat >&2 <<'GUIDANCE'
Each of these tags is one <Text> can render, so the fix is a variant rather than a class:

  text-3xl -> variant="h1"        text-md   -> variant="h5" or variant="body"
  text-2xl -> variant="h2"        text-base -> variant="bodySmall"
  text-xl  -> variant="h3"        text-sm   -> variant="note"
  text-lg  -> variant="h4"        text-xs   -> variant="caption"
                                  text-2xs  -> variant="kicker"

`as` keeps the tag when the outline or the parent element demands it (<Text as="li">), `tone`
carries text-muted / text-accent-text, and className stays for layout only.

If the raw class is genuinely right - a wordmark, a monogram, a specimen quoting another surface
verbatim, a weight or tracking the primitive does not offer - say so in a comment containing
'text-primitive-exempt', on the line or in the six lines above it, and record the case in
apps/web/src/pages/tokens/type-adoption-specimen.tsx so the allowlist stays somewhere a reviewer
reads rather than only somewhere a script does.
GUIDANCE
  exit 1
fi

echo "check-text-primitive: OK (every text element in apps/web takes its type from <Text>)."
