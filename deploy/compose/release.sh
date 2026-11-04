#!/usr/bin/env bash
# One command per Compose release: release.sh [--yes] <full-40-char-commit-sha>
# Run on the host from a checkout of that commit. Host settings come from release.conf
# (NIX_RELEASE_CONF, default ~/nix-production/release.conf); secrets stay in NIX_DEPLOY_ENV,
# which this script never edits. Release image tags are exported into the environment, and
# Compose interpolation prefers shell variables over --env-file values.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
here="$root/deploy/compose"
usage='usage: release.sh [--yes] <full-40-char-commit-sha>'
die() { printf 'release: %s\n' "$*" >&2; exit 2; }

assume_yes=0
sha=
for arg in "$@"; do
  case "$arg" in
    --yes) assume_yes=1 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) [[ -z "$sha" ]] || die 'exactly one commit SHA is required'; sha=$arg ;;
  esac
done
[[ -n "$sha" ]] || die "$usage"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "not a full lowercase 40-character commit SHA: $sha"

conf=${NIX_RELEASE_CONF:-$HOME/nix-production/release.conf}
[[ -f "$conf" ]] || die "release configuration not found: $conf (copy deploy/compose/release.conf.example)"
# shellcheck source=/dev/null
source "$conf"
for key in NIX_DEPLOY_ENV NIXCTL_PROFILE NIX_SMOKE_WORKSPACE NIX_BACKUP_ROOT NIX_RELEASE_LEDGER; do
  [[ -n "${!key:-}" ]] || die "$key is not set in $conf"
done
case "$NIX_DEPLOY_ENV" in /*) ;; *) die 'NIX_DEPLOY_ENV must be an absolute path' ;; esac
[[ -f "$NIX_DEPLOY_ENV" ]] || die "secrets file not found: $NIX_DEPLOY_ENV"
NIX_IMAGE_REGISTRY=${NIX_IMAGE_REGISTRY:-ghcr.io/sianachi/nix}
offsite_required=${NIX_OFFSITE_REQUIRED:-1}
[[ "$offsite_required" == 0 || "$offsite_required" == 1 ]] || die 'NIX_OFFSITE_REQUIRED must be 0 or 1'
lock=${NIX_RELEASE_LOCK:-$HOME/nix-release.lock}

# The checked-out manifest and smoke tools must be the ones built into the images.
head=$(git -C "$root" rev-parse HEAD)
[[ "$head" == "$sha" ]] || die "checkout HEAD is $head, not $sha; check out the release commit first"
git -C "$root" diff --quiet HEAD -- || die 'the release checkout has modified tracked files'

export NIX_DEPLOY_ENV NIXCTL_PROFILE NIX_SMOKE_WORKSPACE NIX_BACKUP_ROOT NIX_IMAGE_REGISTRY
export NIX_IMAGE_TAG="$sha" NIX_WEB_IMAGE_TAG="$sha"
compose=(docker compose -p nix --env-file "$NIX_DEPLOY_ENV" -f "$root/deploy/compose.prod.yml")

# Resolve the release image matrix exactly as deploy.sh will and confirm it exists before anything else.
images=()
while IFS= read -r image; do
  if [[ "$image" == "$NIX_IMAGE_REGISTRY/"* ]]; then images+=("$image"); fi
done < <("${compose[@]}" --profile maintenance config --images | sort -u)
[[ ${#images[@]} -gt 0 ]] || die "no release images resolved for registry $NIX_IMAGE_REGISTRY"
# Not a Compose service: deploy.sh runs the smoke checks from it at the release tag.
images+=("$NIX_IMAGE_REGISTRY/release-tools:$sha")
for image in "${images[@]}"; do
  if [[ "$NIX_IMAGE_REGISTRY" == localhost/nix ]]; then
    docker image inspect "$image" >/dev/null 2>&1 || die "local image missing: $image (run deploy/compose/build.sh $sha)"
  else
    docker manifest inspect "$image" >/dev/null 2>&1 || die "image not published: $image (wait for the CI images workflow)"
  fi
done

exec 9>>"$lock"
flock -n 9 || die "another release holds $lock"

backup_dir=${NIX_BACKUP_REFERENCE:-}
if [[ -n "$backup_dir" ]]; then
  [[ -d "$backup_dir" ]] || die "NIX_BACKUP_REFERENCE is not an existing directory: $backup_dir"
  bash "$here/backup.sh" --check "$backup_dir" || die "NIX_BACKUP_REFERENCE failed backup.sh --check: $backup_dir"
  backup_plan="reuse checked backup $backup_dir"
else
  backup_plan="create with backup.sh $sha under $NIX_BACKUP_ROOT"
fi

echo "Release $sha to Compose project nix"
echo "  secrets file  $NIX_DEPLOY_ENV (read only)"
echo "  nixctl        profile $NIXCTL_PROFILE, smoke workspace $NIX_SMOKE_WORKSPACE"
echo "  backup        $backup_plan"
if [[ "$offsite_required" == 1 ]]; then
  echo "  offsite       offsite.sh push (kind=release, sha); a failure aborts before writers stop"
else
  echo "  offsite       offsite.sh push (kind=release, sha); a failure only warns (NIX_OFFSITE_REQUIRED=0)"
fi
echo "  ledger        $NIX_RELEASE_LEDGER"
# Nightly health: a warning only, since a release takes its own verified backup anyway.
nightly_marker=${NIX_NIGHTLY_MARKER:-$HOME/nix-production/last-nightly-success}
nightly_max_hours=${NIX_NIGHTLY_MAX_AGE_HOURS:-36}
nightly_epoch=$(sed -n 's/^completed_epoch=\([0-9][0-9]*\)$/\1/p' "$nightly_marker" 2>/dev/null || true)
if [[ -z "$nightly_epoch" ]]; then
  echo "  nightly       WARNING: no successful nightly backup recorded ($nightly_marker)"
else
  nightly_hours=$(( ($(date -u +%s) - nightly_epoch) / 3600 ))
  if (( nightly_hours > nightly_max_hours )); then
    echo "  nightly       WARNING: last successful nightly backup was ${nightly_hours}h ago (limit ${nightly_max_hours}h); check journalctl --user -u nix-backup-nightly.service"
  else
    echo "  nightly       last success ${nightly_hours}h ago"
  fi
fi
echo "  images"
printf '    %s\n' "${images[@]}"
echo "deploy.sh then stops application writers while migrations run (maintenance window)."
if [[ $assume_yes -ne 1 ]]; then
  [[ -t 0 ]] || die 'refusing to stop writers without --yes on a non-interactive run'
  read -r -p 'Type yes to proceed: ' answer
  [[ "$answer" == yes ]] || die 'not confirmed; nothing was changed'
fi

# From here every attempt is recorded, whatever the outcome.
result=failed:backup
record() {
  mkdir -p "$(dirname "$NIX_RELEASE_LEDGER")"
  printf '%s\t%s\t%s\t%s\toperator=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" \
    "${backup_dir:--}" "$result" "${USER:-unknown}" >> "$NIX_RELEASE_LEDGER"
}
trap record EXIT

if [[ -z "$backup_dir" ]]; then
  bash "$here/backup.sh" "$sha"
  backup_dir="$NIX_BACKUP_ROOT/pre-$sha"
  bash "$here/backup.sh" --check "$backup_dir"
fi
export NIX_BACKUP_REFERENCE="$backup_dir"

# The off-host copy is taken before deploy.sh, so a required push that fails stops nothing.
result=failed:offsite
if ! bash "$here/offsite.sh" push "$backup_dir" --tag kind=release --tag "sha=$sha"; then
  if [[ "$offsite_required" == 1 ]]; then
    printf 'release: off-host push of %s failed; aborting before any writer stops.\n' "$backup_dir" >&2
    printf 'release: fix it and rerun with NIX_BACKUP_REFERENCE=%s, or set NIX_OFFSITE_REQUIRED=0.\n' "$backup_dir" >&2
    exit 1
  fi
  printf 'release: warning: off-host push of %s failed; continuing (NIX_OFFSITE_REQUIRED=0).\n' "$backup_dir" >&2
fi

result=failed:deploy
bash "$here/deploy.sh"
result=succeeded
echo "Release $sha succeeded; recorded in $NIX_RELEASE_LEDGER."

# The nightly timer runs its own copy of the backup scripts (a release checkout can be pruned
# under it); keep that copy in step with the release just deployed. A failure here only warns:
# the release itself has already succeeded.
tools=${NIX_BACKUP_TOOLS_DIR:-$HOME/nix-production/backup-tools}
if [[ -d "$tools" ]]; then
  refreshed=1
  for script in backup.sh offsite.sh nightly.sh; do
    if ! { install -m 700 "$here/$script" "$tools/.$script.new" && mv -f "$tools/.$script.new" "$tools/$script"; }; then
      refreshed=0
    fi
  done
  if [[ "$refreshed" == 1 ]]; then
    echo "release: refreshed the nightly backup scripts in $tools."
  else
    printf 'release: warning: could not refresh the nightly backup scripts in %s.\n' "$tools" >&2
  fi
fi
