#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import fitz' 2>/dev/null; then
  .venv/bin/python -m pip install --disable-pip-version-check --quiet .
fi
exec .venv/bin/python -m checkpoint_studio "$@"
