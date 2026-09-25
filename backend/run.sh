#!/usr/bin/env bash
# Start the backend. Vite proxies /api here in dev.
#
# Port defaults to 8765 rather than 8000, which is crowded — plenty of local
# tools grab it. Override with MAPHEX_PORT, and give Vite the same value so
# the proxy follows:
#
#   MAPHEX_PORT=9000 ./run.sh
#   MAPHEX_PORT=9000 npm run dev     # in frontend/
set -euo pipefail
cd "$(dirname "$0")"
exec .venv/bin/uvicorn app.main:app --reload --port "${MAPHEX_PORT:-8765}"
