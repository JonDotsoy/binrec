#!/usr/bin/env bash
# Runs a simple command through binrec and checks that it exits with code 0.
set -u

cd "$(dirname "$0")/.."

echo "date $(date +%Y-%m-%dT%H:%M:%S)" | bun bin/binrec.ts
status=$?

if [ "$status" -ne 0 ]; then
  echo "FAIL: binrec exited with code $status" >&2
  exit 1
fi

echo "PASS: binrec exited with code 0"
