#!/usr/bin/env bash
# Print the smallest validation set justified by changed paths. This is advisory:
# CI and the area guides remain the merge authority.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/changed-path-checks.sh [--commands] [--working-tree | --base <ref> | <path>...]

Without arguments, compares HEAD to the working tree. Pass paths explicitly when
planning a change before editing. --base compares <ref>...HEAD.
EOF
}

format=human
if [ "${1:-}" = '--commands' ]; then
  format=commands
  shift
fi

emit() {
  if [ "$format" = commands ]; then
    printf '%s\n' "$1"
  else
    printf '  %s\n' "$1"
  fi
}

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo 'changed-path-checks: run inside a Git worktree.' >&2
  exit 2
}
cd "$repo_root"

paths=()
case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --working-tree|'')
    if [ "$#" -gt 1 ]; then
      usage >&2
      exit 2
    fi
    while IFS= read -r path; do paths+=("$path"); done < <(git diff --name-only HEAD)
    while IFS= read -r path; do paths+=("$path"); done < <(git ls-files --others --exclude-standard)
    ;;
  --base)
    [ "$#" -eq 2 ] || { usage >&2; exit 2; }
    while IFS= read -r path; do paths+=("$path"); done < <(git diff --name-only "$2...HEAD")
    ;;
  --*)
    usage >&2
    exit 2
    ;;
  *)
    paths=("$@")
    ;;
esac

if [ "${#paths[@]}" -eq 0 ]; then
  echo 'No changed paths detected; no checks selected.'
  exit 0
fi

has_frontend=false
has_frontend_sources=false
has_backend=false
has_workers=false
has_desktop=false
has_openapi=false
has_shared_frontend_config=false
has_frontend_guard=false
has_backend_guard=false
has_sensitive_backend=false
has_workflow_script=false
has_compose=false
has_catalog=false
has_api_docs=false
has_rabbitmq=false
frontend_packages=()
dependent_typechecks=()
add_dependent_typecheck() {
  local candidate=$1 existing
  for existing in "${dependent_typechecks[@]:-}"; do
    [ "$existing" = "$candidate" ] && return
  done
  dependent_typechecks+=("$candidate")
}
prettier_paths=()

add_frontend_package() {
  candidate=$1
  for existing in "${frontend_packages[@]:-}"; do
    [ "$existing" = "$candidate" ] && return
  done
  frontend_packages+=("$candidate")
}

for path in "${paths[@]}"; do
  case "$path" in
    apps/web/*) has_frontend=true; has_frontend_sources=true; add_frontend_package '@nix/web' ;;
    apps/collab/*) has_frontend=true; has_frontend_sources=true; add_frontend_package '@nix/collab' ;;
    apps/cli/*) has_frontend=true; has_frontend_sources=true; add_frontend_package '@nix/cli' ;;
    apps/sites/*) has_frontend=true; has_frontend_sources=true; add_frontend_package '@nix/sites' ;;
    packages/*/*)
      has_frontend=true; has_frontend_sources=true
      package_name=${path#packages/}
      package_name=${package_name%%/*}
      add_frontend_package "@nix/$package_name"
      # A web package runs its own tests; the packages and app above it only typecheck against it.
      case "$package_name" in web-*) add_dependent_typecheck "@nix/$package_name" ;; esac
      ;;
    backend/*|Nix.slnx|Nix.Frontend/*) has_backend=true ;;
    apps/go-workers/*) has_workers=true ;;
  esac
  case "$path" in
    *.ts|*.tsx|*.mts|*.cts) if [ -f "$path" ]; then prettier_paths+=("$path"); fi ;;
  esac
  case "$path" in
    deploy/rabbitmq/*) has_rabbitmq=true ;;
    deploy/compose/*|deploy/compose.prod*|deploy/Caddyfile.prod|deploy/docker/*|deploy/k8s/deploy*|.github/workflows/ci-deploy.yml) has_compose=true ;;
    backend/openapi/*)
      has_openapi=true; has_backend=true; has_frontend=true; has_frontend_sources=true; has_api_docs=true
      add_frontend_package '@nix/api-client'
      ;;
    scripts/generate-api-docs.mjs|scripts/api-docs/*|docs/site/nix-docs/generated/*|docs/site/nix-docs/markdown/api/*)
      has_api_docs=true
      ;;
    package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig.base.json|eslint.config.js|.prettierrc|.prettierignore)
      has_shared_frontend_config=true; has_frontend=true
      ;;
    scripts/check-raw-design-values.sh|scripts/check-raw-design-values.test.sh|scripts/check-spacing-roles.sh|scripts/check-spacing-roles.test.sh|scripts/check-text-primitive.sh|scripts/check-text-primitive.test.sh|scripts/check-frontend-layering.sh|scripts/check-frontend-layering.test.sh)
      has_frontend_guard=true; has_frontend=true
      ;;
    scripts/check-byte-array-markers.sh|scripts/check-no-controllers.sh|scripts/check-layering.sh|scripts/check-root-is-unambiguous.sh)
      has_backend_guard=true; has_backend=true
      ;;
    scripts/changed-path-checks.sh|scripts/changed-path-checks.test.sh|scripts/validate-changed.sh|scripts/validate-changed.test.sh|scripts/new-goal-worktree.sh|scripts/rebuild-stale-packages.sh|scripts/rebuild-stale-packages.test.sh|scripts/release-version.sh|scripts/release-version.test.sh|scripts/dev-db-drift.sh|lefthook.yml)
      has_workflow_script=true
      ;;
    packages/structure-spec/*|apps/go-workers/internal/companion/catalog/*)
      has_catalog=true
      ;;
    backend/*Authentication*|backend/*Authorization*|backend/*Permission*|backend/*Migration*|backend/*Persistence*|backend/*/Sql/*|backend/*/Domain/Identity/*)
      has_sensitive_backend=true
      ;;
  esac
done

if [ "$format" = human ]; then
  echo 'Changed paths:'
  printf '  - %s\n' "${paths[@]}"
  echo
  echo 'Selected local checks:'
fi

if [ "$has_frontend" = true ]; then
  if [ "$has_shared_frontend_config" = true ]; then
    emit 'pnpm lint'
    emit 'pnpm typecheck'
    emit 'pnpm test'
  else
    for package_name in "${frontend_packages[@]:-}"; do
      [ -n "$package_name" ] || continue
      emit "pnpm --filter $package_name lint"
      emit "pnpm --filter $package_name typecheck"
      emit "pnpm --filter $package_name test"
    done
    for package_name in "${dependent_typechecks[@]:-}"; do
      [ -n "$package_name" ] || continue
      emit "pnpm --filter '...^$package_name' typecheck"
    done
  fi
  if [ "$has_frontend_sources" = true ] || [ "$has_shared_frontend_config" = true ]; then
    emit './scripts/check-raw-design-values.test.sh && ./scripts/check-raw-design-values.sh'
    emit './scripts/check-spacing-roles.test.sh && ./scripts/check-spacing-roles.sh'
    emit './scripts/check-text-primitive.test.sh && ./scripts/check-text-primitive.sh'
    emit './scripts/check-frontend-layering.test.sh && ./scripts/check-frontend-layering.sh'
  fi
fi

if [ "${#prettier_paths[@]}" -gt 0 ]; then
  prettier_command='pnpm exec prettier --check'
  for path in "${prettier_paths[@]}"; do
    printf -v escaped_path '%q' "$path"
    prettier_command+=" $escaped_path"
  done
  emit "$prettier_command"
fi

if [ "$has_backend" = true ]; then
  emit 'dotnet format Nix.slnx --verify-no-changes'
  emit 'dotnet build Nix.slnx --configuration Release'
  emit './scripts/check-byte-array-markers.sh'
  emit './scripts/check-no-controllers.sh'
  emit './scripts/check-layering.sh'
  emit './scripts/check-root-is-unambiguous.sh'
  emit 'dotnet test --project backend/tests/Nix.Tests/Nix.Tests.csproj'
fi

if [ "$has_openapi" = true ]; then
  emit 'dotnet build backend/src/Nix.Api/Nix.Api.csproj -p:NixGenerateOpenApiContract=true'
  emit 'pnpm --filter @nix/api-client generate'
  emit 'git diff --exit-code -- backend/openapi packages/api-client/src/generated'
fi

if [ "$has_api_docs" = true ]; then
  emit 'node --test scripts/api-docs/policy.test.mjs scripts/api-docs/facts.test.mjs'
  emit 'node scripts/generate-api-docs.mjs --check'
fi

if [ "$has_catalog" = true ]; then
  # git status --porcelain, not git diff --exit-code: diff is blind to untracked files, so a
  # generator that grew a new output would pass a diff-only check silently. CI's "Structure
  # catalog is current" step checks the same way.
  emit 'pnpm --filter @nix/structure-spec catalog && test -z "$(git status --porcelain -- packages/structure-spec/src/generated apps/go-workers/internal/companion/catalog)"'
fi

if [ "$has_sensitive_backend" = true ]; then
  emit 'dotnet test --project backend/tests/Nix.Integration.Tests/Nix.Integration.Tests.csproj'
  [ "$format" = commands ] || echo '  Required review: security; add backend-data review for persistence, SQL, or migrations.'
fi

if [ "$has_compose" = true ]; then
  emit 'bash deploy/compose/check.test.sh'
  emit 'bash deploy/k8s/deploy.test.sh'
fi

if [ "$has_rabbitmq" = true ]; then
  emit 'node --test deploy/rabbitmq/definitions.test.mjs'
fi

if [ "$has_workers" = true ]; then
  emit '(cd apps/go-workers && test -z "$(gofmt -l .)")'
  emit '(cd apps/go-workers && go vet ./... && go test ./... && go test -race ./... && go build ./cmd/nix-worker)'
fi

if [ "$format" = human ] && [ "$has_frontend_guard" = true ]; then
  echo '  Note: guard edits require their fixture self-test before the guard (included above).'
fi
if [ "$format" = human ] && [ "$has_backend_guard" = true ]; then
  echo '  Note: backend guard edits trigger backend CI; inspect its workflow before changing scope.'
fi
if [ "$has_workflow_script" = true ]; then
  emit 'bash -n scripts/changed-path-checks.sh scripts/changed-path-checks.test.sh scripts/validate-changed.sh scripts/validate-changed.test.sh scripts/new-goal-worktree.sh scripts/rebuild-stale-packages.sh scripts/release-version.sh scripts/dev-db-drift.sh'
  emit './scripts/changed-path-checks.test.sh && ./scripts/validate-changed.test.sh && ./scripts/rebuild-stale-packages.test.sh && ./scripts/release-version.test.sh'
fi

if [ "$format" = human ]; then
  echo
  echo 'Review the applicable guide(s) in docs/agent-guides before declaring this complete.'
fi
