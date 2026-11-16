# Maphex: the UI (React, built here) and its FastAPI backend in one image.
#
# The backend does not run the engine itself: it drives SIG-Transformer's own
# containers with `docker compose`, exactly as it does on the host. So this
# image carries the Docker CLI and the compose plugin, and talks to the host's
# daemon through the socket that docker-compose.yml mounts in. See
# docker/entrypoint.sh for why the paths inside must match the host's.

# Used by a FROM further down, so it has to be declared before the first one.
ARG COMPOSE_VERSION=v5.3.0

# ── 1. the frontend ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS frontend
WORKDIR /src/frontend
# Playwright is a dev dependency for the browser checks; the image never
# runs them, so it must not fetch a browser.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# VITE_* are read at build time, not at run time.
ARG VITE_API_BASE
ARG VITE_MAP_STYLE
RUN npm run build

# ── 2. the Docker CLI, without installing Docker ─────────────────────────
# Both binaries are static, so they run on Debian as they do on Alpine.
#
# Compose is pinned to the version `docker compose up` runs with on the host
# (Docker Desktop's: `docker compose version`). Versions disagree on how they
# record the engine image's digest, so with a different one in here each side
# recreates sig_app every time the other one has touched it. Harmless, but
# noisy; rebuild with --build-arg COMPOSE_VERSION=vX.Y.Z after Desktop updates.
FROM docker/compose-bin:${COMPOSE_VERSION} AS composebin
FROM docker:29-cli AS dockercli

# ── 3. the backend ───────────────────────────────────────────────────────
# 3.12 is what backend/requirements.txt was resolved against.
FROM python:3.12-slim-bookworm

# git: run_full.sh and run_mcda.sh record the engine's commit.
# util-linux brings setpriv, which the entrypoint uses to drop root.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git util-linux \
 && rm -rf /var/lib/apt/lists/*

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=composebin /docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv/maphex
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir --timeout 120 --retries 5 -r backend/requirements.txt

# Same layout as the repo: main.py finds the built frontend at
# ../../frontend/dist from itself.
COPY backend/ backend/
COPY --from=frontend /src/frontend/dist frontend/dist
COPY docker/entrypoint.sh /usr/local/bin/maphex-entrypoint
RUN chmod 755 /usr/local/bin/maphex-entrypoint

WORKDIR /srv/maphex/backend
EXPOSE 8765
ENTRYPOINT ["maphex-entrypoint"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765"]
