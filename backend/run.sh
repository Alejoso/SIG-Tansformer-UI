#!/usr/bin/env bash
# Start the backend on :8000. Vite proxies /api here in dev.
set -euo pipefail
cd "$(dirname "$0")"
exec .venv/bin/uvicorn app.main:app --reload --port 8000
