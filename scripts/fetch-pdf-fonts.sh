#!/bin/sh
# Downloads the pinned PDF fallback fonts, Noto Sans SC and Noto Sans KR (static Regular TTFs,
# SIL OFL 1.1, licence in backend/fonts/OFL.txt, about 17 MB together), and checks them. PDF
# exports draw Chinese, Japanese and Korean text with them; without them that text exports as "?".
# Idempotent. The Core image runs it at build; run it once for dev.
set -eu

dir="${1:-$(dirname "$0")/../backend/fonts}"
base="https://fonts.gstatic.com/s"

check() {
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$1  $2" | sha256sum -c - >/dev/null 2>&1
  else
    echo "$1  $2" | shasum -a 256 -c - >/dev/null 2>&1
  fi
}

fetch() {
  check "$3" "$dir/$2" && return 0
  curl -fsSL -o "$dir/$2" "$base/$1"
  check "$3" "$dir/$2" || { echo "checksum mismatch for $2" >&2; rm -f "$dir/$2"; exit 1; }
}

mkdir -p "$dir"
fetch notosanssc/v41/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYw.ttf NotoSansSC-Regular.ttf 450625c8d46ab3df97b7904ded955ec2746d17ec76740cb1e91d1ba63a0f89af
fetch notosanskr/v40/PbyxFmXiEBPT4ITbgNA5Cgms3VYcOA-vvnIzzuoyeLQ.ttf NotoSansKR-Regular.ttf 84e2b8acadd0a01af9f0de6b0a2d29117fb5b0eabd7c2f8353d9d2da0461d5fa
echo "PDF fonts ready in $dir"
