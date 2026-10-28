#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
planner="$script_dir/changed-path-checks.sh"

assert_contains() {
  output=$1
  expected=$2
  case "$output" in
    *"$expected"*) ;;
    *) echo "expected output to contain: $expected" >&2; exit 1 ;;
  esac
}

web_output=$("$planner" apps/web/src/app.tsx)
assert_contains "$web_output" 'pnpm --filter @nix/web typecheck'
assert_contains "$web_output" 'pnpm exec prettier --check apps/web/src/app.tsx'
assert_contains "$web_output" 'check-frontend-layering.sh'

package_output=$("$planner" packages/ui/src/controls/Button.tsx)
assert_contains "$package_output" 'pnpm --filter @nix/ui test'
assert_contains "$package_output" 'pnpm exec prettier --check packages/ui/src/controls/Button.tsx'

web_package_output=$("$planner" packages/web-editor/src/editor/toolbar.tsx)
assert_contains "$web_package_output" 'pnpm --filter @nix/web-editor typecheck'
assert_contains "$web_package_output" 'pnpm --filter @nix/web test'

cli_output=$("$planner" apps/cli/src/index.ts)
assert_contains "$cli_output" 'pnpm exec prettier --check apps/cli/src/index.ts'

sites_output=$("$planner" apps/sites/src/serve/server.ts)
assert_contains "$sites_output" 'pnpm --filter @nix/sites test'

rabbit_output=$("$planner" deploy/rabbitmq/start.sh)
assert_contains "$rabbit_output" 'node --test deploy/rabbitmq/definitions.test.mjs'

backend_output=$("$planner" backend/src/Nix.Api/Authentication/UserInfoClient.cs)
assert_contains "$backend_output" 'dotnet test backend/tests/Nix.Integration.Tests/Nix.Integration.Tests.csproj'
assert_contains "$backend_output" 'Required review: security'

contract_output=$("$planner" backend/openapi/nix-api.json)
assert_contains "$contract_output" 'pnpm --filter @nix/api-client generate'
assert_contains "$contract_output" 'node scripts/generate-api-docs.mjs --check'

api_docs_output=$("$planner" docs/site/nix-docs/markdown/api/index.md)
assert_contains "$api_docs_output" 'node --test scripts/api-docs/policy.test.mjs scripts/api-docs/facts.test.mjs'

worker_output=$("$planner" apps/go-workers/internal/runtime/runtime.go)
assert_contains "$worker_output" 'go test -race ./...'

command_output=$("$planner" --commands backend/openapi/nix-api.json)
assert_contains "$command_output" 'NixGenerateOpenApiContract=true'
case "$command_output" in
  *'Changed paths:'*) echo 'command output must not include prose' >&2; exit 1 ;;
esac

workflow_output=$("$planner" scripts/validate-changed.sh)
assert_contains "$workflow_output" 'validate-changed.test.sh'

catalog_output=$("$planner" packages/structure-spec/src/catalog/tables.ts)
assert_contains "$catalog_output" 'pnpm --filter @nix/structure-spec catalog && test -z "$(git status --porcelain -- packages/structure-spec/src/generated apps/go-workers/internal/companion/catalog)"'

catalog_go_output=$("$planner" apps/go-workers/internal/companion/catalog/chat.txt)
assert_contains "$catalog_go_output" 'pnpm --filter @nix/structure-spec catalog'

compose_output=$("$planner" deploy/compose.prod.yml)
assert_contains "$compose_output" 'bash deploy/compose/check.test.sh'

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
git -C "$fixture" init -q
git -C "$fixture" -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet --allow-empty -m fixture
empty_output=$(cd "$fixture" && "$planner" --working-tree)
assert_contains "$empty_output" 'No changed paths detected'
mkdir -p "$fixture/deploy"
touch "$fixture/deploy/compose.prod.yml"
dirty_output=$(cd "$fixture" && "$planner" --working-tree)
assert_contains "$dirty_output" 'Changed paths:'
assert_contains "$dirty_output" 'bash deploy/compose/check.test.sh'

mkdir -p "$fixture/apps/cli/src"
printf 'export const kept = 1;\n' > "$fixture/apps/cli/src/format file.ts"
printf 'export const removed = 1;\n' > "$fixture/apps/cli/src/removed.ts"
git -C "$fixture" add -- 'apps/cli/src/format file.ts' apps/cli/src/removed.ts
git -C "$fixture" -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m fixture
rm "$fixture/apps/cli/src/removed.ts"
printf 'export const kept = 2;\n' > "$fixture/apps/cli/src/format file.ts"
format_output=$(cd "$fixture" && "$planner" --commands --working-tree)
assert_contains "$format_output" 'pnpm exec prettier --check apps/cli/src/format\ file.ts'
case "$format_output" in
  *'removed.ts'*) echo 'deleted files must not be passed to Prettier' >&2; exit 1 ;;
esac

echo 'changed-path-checks.test: passed'
