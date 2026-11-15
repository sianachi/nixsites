#!/usr/bin/env bash
# Prerequisite checks in deploy/install.sh. Stubs stand in for Docker and the other tools,
# so this does not start a stack or talk to the network.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
bash_bin=$(command -v bash)
bash -n deploy/install.sh

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
empty=$fixture/empty
bin=$fixture/bin
src=$fixture/src
state=$fixture/state
called=$fixture/called
mkdir -p "$empty" "$bin" "$src"

stub() {
  printf '%s\n' "$2" > "$bin/$1"
  chmod +x "$bin/$1"
}

# Present on PATH, but any real invocation is a failure we can see.
stub curl '#!/bin/sh
printf curl >> "'"$called"'"
exit 1'
stub openssl '#!/bin/sh
exit 0'
stub jq '#!/bin/sh
exit 0'

assert_ok() {
  if [ "$code" -ne 0 ]; then
    printf 'expected success, got %s\n%s\n' "$code" "$out" >&2
    exit 1
  fi
}
assert_fail() {
  if [ "$code" -eq 0 ]; then
    printf 'expected failure\n%s\n' "$out" >&2
    exit 1
  fi
}
assert_has() {
  if ! printf '%s\n' "$out" | grep -F -q -- "$1"; then
    printf 'expected to find: %s\n%s\n' "$1" "$out" >&2
    exit 1
  fi
}
assert_lacks() {
  if printf '%s\n' "$out" | grep -F -q -- "$1"; then
    printf 'did not expect: %s\n%s\n' "$1" "$out" >&2
    exit 1
  fi
}

run() {
  set +e
  out=$(env -u NIX_SOURCE_DIR PATH="$1" "$bash_bin" deploy/install.sh "${@:2}" 2>&1)
  code=$?
  set -e
}

# Flags still win, and help does not need the tools.
run "$empty" --help
assert_ok
assert_has 'usage: install.sh'

run "$empty" --not-a-flag
assert_fail
assert_has 'unknown option --not-a-flag'
assert_lacks 'missing'

run "$empty" --version
assert_fail
assert_lacks 'missing'

# Every missing tool is named, and nothing is created yet.
rm -rf "$state"
run "$empty" --dir "$state"
assert_fail
assert_has 'missing curl, openssl, jq, docker'
assert_lacks 'downloading release'
[ ! -e "$state" ]

# Compose is its own missing piece once the docker binary is there.
stub docker '#!/bin/sh
exit 1'
run "$bin" --dir "$state"
assert_fail
assert_has 'missing Docker Compose plugin (docker compose)'
assert_lacks 'cannot reach the Docker daemon'
[ ! -e "$state" ]

# Daemon down fails before the state directory or a download.
stub docker '#!/bin/sh
if [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi
exit 1'
: > "$called"
run "$bin" --dir "$state" --version v0.0.0
assert_fail
assert_has 'cannot reach the Docker daemon'
assert_lacks 'GiB available'
[ ! -s "$called" ]
[ ! -e "$state" ]

# Under about 4 GB, warn and carry on. The empty source dir is what stops the run.
docker_mem() {
  stub docker "#!/bin/sh
if [ \"\$1\" = compose ] && [ \"\$2\" = version ]; then exit 0; fi
if [ \"\$1\" = info ]; then printf '%s\\n' '$1'; exit 0; fi
exit 1"
}
run_mem() {
  : > "$called"
  rm -rf "$state"
  set +e
  out=$(env PATH="$bin:/usr/bin:/bin" NIX_SOURCE_DIR="$src" "$bash_bin" deploy/install.sh --dir "$state" --version v0.0.0 2>&1)
  code=$?
  set -e
}
docker_mem 2147483648
run_mem
assert_fail
assert_has 'Docker has 2.0 GiB available. Give it about 4 GB, or the stack can run out of memory.'
assert_has 'NIX_SOURCE_DIR has no deploy/compose.prod.yml'
assert_lacks 'missing'
[ ! -s "$called" ]
[ -d "$state" ]

# 3 GiB is the floor (a 4 GB Docker Desktop VM reports a little less). One byte under warns.
docker_mem 3221225471
run_mem
assert_fail
assert_has 'GiB available'

docker_mem 3221225472
run_mem
assert_fail
assert_lacks 'GiB available'
assert_has 'NIX_SOURCE_DIR has no deploy/compose.prod.yml'

docker_mem 17179869184
run_mem
assert_fail
assert_lacks 'warning:'

docker_mem 'not-a-number'
run_mem
assert_fail
assert_has 'could not read how much memory Docker has'
assert_has 'NIX_SOURCE_DIR has no deploy/compose.prod.yml'

# Kubernetes keeps its own tools and does not ask for Docker or its memory.
rm -f "$bin/docker"
run "$bin" --kubernetes --version v0.0.0 --dir "$state" https://nix.example.org
assert_fail
assert_has 'missing kubectl, envsubst (gettext)'
assert_lacks 'docker'
assert_lacks 'GiB'

stub kubectl '#!/bin/sh
exit 0'
stub envsubst '#!/bin/sh
exit 0'
: > "$called"
rm -rf "$state"
set +e
out=$(env PATH="$bin:/usr/bin:/bin" NIX_SOURCE_DIR="$src" "$bash_bin" deploy/install.sh \
  --kubernetes --ingress-class demo --storage-class demo --pod-cidr 10.0.0.0/16 \
  --version v0.0.0 --dir "$state" https://nix.example.org 2>&1)
code=$?
set -e
assert_fail
assert_has 'NIX_SOURCE_DIR has no deploy/compose.prod.yml'
assert_lacks 'missing'
assert_lacks 'unknown option'
assert_lacks 'GiB'
[ ! -s "$called" ]

echo 'install prerequisite checks passed.'
