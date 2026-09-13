#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI=(node "${ROOT}/host/dist/cli.js")

if [[ ! -e /dev/kvm ]]; then
  echo "skip: /dev/kvm is missing. Nested virtualization did not come up."
  exit 0
fi

set +e
"${CLI[@]}" exec --timeout 30 -- echo hello > /tmp/sandbox-hello.out 2>/tmp/sandbox-hello.err
status=$?
set -e
if [[ "$status" -ne 0 ]]; then
  echo "echo hello exited ${status}" >&2
  exit 1
fi
python3 -c 'import pathlib,sys; out=pathlib.Path("/tmp/sandbox-hello.out").read_bytes(); err=pathlib.Path("/tmp/sandbox-hello.err").read_bytes(); sys.exit(0 if out==b"hello\n" and err==b"" else 1)'

set +e
"${CLI[@]}" exec --timeout 30 -- false >/tmp/sandbox-false.out
false_status=$?
set -e
if [[ "$false_status" -eq 0 ]]; then
  echo "expected false to exit non-zero" >&2
  exit 1
fi
echo "integration ok"
