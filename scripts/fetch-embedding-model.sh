#!/bin/sh
# Downloads the pinned local embedding model (bge-small-en-v1.5, int8-quantized ONNX, about 34 MB)
# that Core uses for pet retrieval, and checks it. Quantized: a third of the memory of the fp32
# model, with embeddings within 0.998 cosine of it. Idempotent. The Core image runs it at build; run it once for dev.
set -eu

dir="${1:-$(dirname "$0")/../backend/models/bge-small-en-v1.5}"
base="https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3"

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
fetch onnx/model_quantized.onnx model.onnx 6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4
fetch vocab.txt vocab.txt 07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3
echo "embedding model ready in $dir"
