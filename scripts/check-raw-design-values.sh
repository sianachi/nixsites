#!/usr/bin/env bash
# Guard: design-token rule (engineering plan section 5.1).
# All colors, spacing, radii, shadows and type metrics come from the Industry
# design tokens in packages/design-tokens. A raw value anywhere else in
# frontend source is a violation. Four rules, all reported together:
#
#   1. raw hex color          '#rgb' .. '#rrggbbaa'
#   2. raw length             a px/rem literal inside a Tailwind arbitrary
#                             value, e.g. px-[14px], size-[26px], min-w-[14rem]
#   3. arbitrary letter-spacing  tracking-[...]  (the --tracking-* scale covers
#                             every step, so the arbitrary form is never needed)
#   4. inline style attribute 'style={{ ... }}' in TSX
#
# Scope:   *.ts, *.tsx, *.css under packages/ and apps/ (rule 4: *.tsx only)
# Skipped: packages/design-tokens (the one legitimate home for raw values),
#          node_modules, dist
# Exempt:  - a line containing a 'design-token-exempt' comment
#          - a whole file containing 'design-token-exempt-file'
#          - a line that opens with '//' or '/*', i.e. prose rather than
#            anything the app renders
#
# Usage:   check-raw-design-values.sh [root ...]
#          With no arguments it scans packages/ and apps/ from the repo root,
#          which is what CI runs. Explicit roots are resolved against the
#          caller's working directory and exist so the guard can be pointed at
#          a fixture corpus - see check-raw-design-values.test.sh. An argument
#          was chosen over an env var because the roots are the script's one
#          real input: a positional makes the test's intent readable at the
#          call site and cannot leak into an unrelated child process.
#
# Exits 0 cleanly when packages/ or apps/ do not exist yet.
#
# Portable across BSD (macOS) and GNU tools: find -prune, grep -E -n with
# POSIX classes/intervals only (no \b, which BSD grep handles differently).
# Also bash 3.2 compatible (the macOS system bash): no namerefs, no
# associative arrays, no ${var,,}.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

# Only scan roots that exist; zero roots is a clean pass (early repo state).
scan_roots=()
if [ "$#" -gt 0 ]; then
  # Explicit roots: a typo must not pass silently, so a missing one is fatal
  # rather than skipped. No cd - the caller's cwd is the frame of reference.
  for root in "$@"; do
    if [ ! -d "$root" ]; then
      echo "check-raw-design-values: '$root' is not a directory." >&2
      exit 2
    fi
    scan_roots+=("$root")
  done
else
  cd "$repo_root"
  for root in packages apps; do
    [ -d "$root" ] && scan_roots+=("$root")
  done
  if [ "${#scan_roots[@]}" -eq 0 ]; then
    echo "check-raw-design-values: OK (no packages/ or apps/ directories yet)."
    exit 0
  fi
fi

# Rule 1 - word-bounded raw hex color: '#' + 3..8 hex digits, not preceded or
# followed by another word character. Implemented without \b for BSD/GNU
# portability: the run must start the line or follow a non-word char, and must
# not be followed by any word char. Backtracking inside {3,8} cannot shorten a
# longer run to force a match, because every shorter prefix is still followed
# by a word char (e.g. '#define': the hex run 'def' is followed by 'i', so it
# is correctly ignored; likewise 9+ digit hex-ish tokens never match).
hex_pattern='(^|[^0-9a-zA-Z_])#[0-9a-fA-F]{3,8}([^0-9a-zA-Z_]|$)'

# Rule 2 - a px/rem literal inside a Tailwind arbitrary value.
#
# Shape: <utility>-[ ... <digits>px|rem ... ]
#
#   [0-9a-zA-Z_]-\[   the bracket must be introduced by a utility name, so the
#                     '-' carries a word char in front of it. This is what
#                     separates 'size-[26px]' and '-translate-x-[26px]' (the
#                     'x' precedes) from arithmetic or index syntax that merely
#                     happens to sit next to a bracket.
#   [^]]*             the literal may sit anywhere inside the brackets, not
#                     only alone. 'grid-cols-[400px_300px]' and
#                     'w-[min(560px,...)]' are raw lengths just as much as
#                     'px-[14px]' is; anchoring to '[<n>px]' would wave them
#                     through. ']' first inside the bracket expression is a
#                     literal ']' in POSIX ERE, so this cannot run past the
#                     closing bracket of the arbitrary value.
#   [0-9](px|rem)     the unit must be glued to a digit. This is why the
#                     regex-character-class idiom '-[0-9a-f]' - which appears
#                     in the UUID matchers under apps/collab - is not a hit,
#                     and why 'px-[calc(var(--spacing)*3.6)]' (token-derived,
#                     legitimate) is not either.
#   ([^0-9a-zA-Z_]|$) the unit must end there. Without this a longer word
#                     containing the unit would match: '16remainder' would be
#                     read as '16rem'. With it, the 'a' after 'rem' rejects the
#                     position, and backtracking cannot rescue it - every
#                     earlier digit in the run is followed by a digit, not by a
#                     unit. Same for '[12pxl]'.
#
# Units are px and rem only, deliberately. vh/vw/ch/% are viewport- and
# content-relative, have no token scale to come from, and are not what the
# rule is about.
length_pattern='[0-9a-zA-Z_]-\[[^]]*[0-9](px|rem)([^0-9a-zA-Z_]|$)'

# ...except when the length is the size of a container.
#
# 'w-[264px]' for the workspace tree, 'max-w-[680px]' for the search overlay,
# 'min-h-[520px]' for the calendar grid: these are the dimensions of one box in
# one arrangement, and ADR-0008 scopes the token sheet to the type scale, the
# control heights and the spacing step. A panel's width is none of those and is
# not going to become one, which packages/web-foundation/src/layout/regions.ts already argues at
# length for the two it owns.
#
# So the guard does not ask for them. The alternative was thirteen permanent
# 'design-token-exempt' markers sitting on correct code, and a marker that
# common stops being read - which is how a guard quietly stops working. The
# rule keeps every length that *does* have a scale to come from: padding, gaps,
# margins, control boxes ('size-[26px]'), translations, tracking.
#
# Matched occurrences are removed from the line before rule 2 runs, rather than
# the line being skipped, so 'w-[240px] px-[14px]' still reports its padding.
container_dimension='(^|[^0-9a-zA-Z_])(max-|min-)?[wh]-\[[^]]*\]'

# Rule 3 - arbitrary letter-spacing. The token scale runs --tracking-tight
# through --tracking-widest, so 'tracking-[0.08em]' has a named equivalent in
# every case. The leading '(^|[^0-9a-zA-Z_])' is the same portable word
# boundary as rule 1: it keeps a longer identifier that merely ends in
# 'tracking' from matching, while still allowing every Tailwind variant prefix
# ('md:tracking-[', 'group-hover:tracking-[') because ':' is not a word char.
tracking_pattern='(^|[^0-9a-zA-Z_])tracking-\['

# Rule 4 - inline style attribute. apps/web/src/app.css states the rule: no
# inline style, everything through utility classes and CVA variants. Optional
# whitespace around '=' is tolerated so the check does not depend on Prettier
# having normalised the attribute first.
#
# On strings: a line-oriented grep cannot tell 'style={{' in code from the same
# text quoted in a string literal, and teaching it to would mean parsing TSX -
# far past what a guard should carry. Comments are handled below; a string that
# quotes the spelling on purpose annotates its line with 'design-token-exempt'.
# The hex rule has always had the same property.
inline_style_pattern='style[[:space:]]*=[[:space:]]*\{\{'

# A line whose first non-blank characters open a comment. Every rule here is
# about what the app renders - a class string, an attribute, a color literal -
# and a comment renders nothing, so prose that quotes a banned spelling in
# order to explain the ban is not a violation of it. Applied to grep -n output,
# hence the 'NNN:' prefix in the anchor.
#
# Deliberately narrow. It does not skip a trailing comment on a code line (the
# code half of that line still ships), and it does not skip a block-comment
# continuation line, because a leading '*' is also a valid CSS universal
# selector and dropping those would open a real hole. Both of those cases keep
# the per-line 'design-token-exempt' marker as their answer.
comment_line_pattern='^[0-9]+:[[:space:]]*(//|/\*)'

# Emit "file:line:content" for every match of $2 in $1, minus comment-only
# lines and per-line exemptions. Echoes nothing when the file is clean.
scan_file() {
  local file="$1"
  local pattern="$2"
  # Optional: an ERE whose matches are deleted from each line before the rule
  # is applied, for text a rule deliberately does not reach. Removing the text
  # rather than skipping the whole line keeps a real violation sharing that
  # line visible.
  local strip="${3:-}"
  local subject hits lineno
  if [ -n "$strip" ]; then
    subject="$(sed -E "s/${strip}/ /g" "$file")"
  else
    subject="$(cat "$file")"
  fi
  # grep exits 1 when nothing matches; that is the good case, so soak it up.
  hits="$(printf '%s\n' "$subject" \
    | grep -nE "$pattern" \
    | grep -vE "$comment_line_pattern" \
    | grep -v 'design-token-exempt' || true)"
  [ -n "$hits" ] || return 0
  while IFS= read -r hit; do
    # Report the line as it is really written. The stripped copy exists only to
    # decide whether the line is a hit; showing it back would print source that
    # is not in the file.
    lineno="${hit%%:*}"
    printf '%s:%s:%s\n' "$file" "$lineno" "$(sed -n "${lineno}p" "$file")"
  done <<EOF
$hits
EOF
}

hex_violations=""
length_violations=""
tracking_violations=""
inline_style_violations=""

while IFS= read -r file; do
  # A heredoc over empty `find` output still yields one empty line; skip it
  # rather than letting grep report a missing file.
  [ -n "$file" ] || continue
  # Whole-file exemption marker.
  if grep -q 'design-token-exempt-file' "$file"; then
    continue
  fi

  new_hits="$(scan_file "$file" "$hex_pattern")"
  if [ -n "$new_hits" ]; then
    hex_violations="${hex_violations}${new_hits}
"
  fi

  new_hits="$(scan_file "$file" "$length_pattern" "$container_dimension")"
  if [ -n "$new_hits" ]; then
    length_violations="${length_violations}${new_hits}
"
  fi

  new_hits="$(scan_file "$file" "$tracking_pattern")"
  if [ -n "$new_hits" ]; then
    tracking_violations="${tracking_violations}${new_hits}
"
  fi

  # JSX only lives in .tsx, so the inline-style rule is scoped to it. Applying
  # it to .ts and .css would only ever match prose about the rule.
  case "$file" in
    *.tsx)
      new_hits="$(scan_file "$file" "$inline_style_pattern")"
      if [ -n "$new_hits" ]; then
        inline_style_violations="${inline_style_violations}${new_hits}
"
      fi
      ;;
  esac
done <<EOF2
$(find "${scan_roots[@]}" \
    \( -name node_modules -o -name dist -o -name storybook-static -o -path 'packages/design-tokens' \) -prune \
    -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) -print)
EOF2

# Print one rule's findings under a heading; silent when the rule is clean.
report_rule() {
  local heading="$1"
  local body="$2"
  [ -n "$body" ] || return 0
  echo "$heading" >&2
  printf '%s' "$body" | while IFS= read -r line; do
    printf '  %s\n' "$line" >&2
  done
}

if [ -n "${hex_violations}${length_violations}${tracking_violations}${inline_style_violations}" ]; then
  echo "check-raw-design-values: FAIL" >&2
  report_rule "Raw hex color(s) outside packages/design-tokens:" "$hex_violations"
  report_rule "Raw px/rem length(s) in a Tailwind arbitrary value:" "$length_violations"
  report_rule "Arbitrary letter-spacing (tracking-[...]):" "$tracking_violations"
  report_rule "Inline style attribute(s):" "$inline_style_violations"
  echo "Rule: colors, lengths and type metrics come from the Industry design" >&2
  echo "tokens (packages/design-tokens); layout is utility classes, never an" >&2
  echo "inline style attribute." >&2
  echo "If a raw value is genuinely required, annotate the line with a" >&2
  echo "'design-token-exempt' comment explaining why." >&2
  exit 1
fi

echo "check-raw-design-values: OK (no raw design values outside packages/design-tokens)."
