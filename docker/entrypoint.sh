#!/bin/sh
# Starts the Maphex backend inside its container.
#
# Why the paths matter: the backend runs `docker compose` against
# SIG-Transformer, and the bind mounts compose asks for (./data, ./logs, a
# project's DATA_DIR) are resolved by the host's daemon, not by this
# container. So every folder the backend hands to compose has to exist here
# under the same absolute path it has on the host. docker-compose.yml mounts
# the host's home at the same path for that reason, and this script works out
# where the two repositories are in it.
set -eu

die() { echo "[maphex] $*" >&2; exit 1; }

ui_dir="${MAPHEX_UI_HOST_DIR:-}"
[ -n "$ui_dir" ] || die "MAPHEX_UI_HOST_DIR is empty. Run 'docker compose up' from the SIG-UI folder."
[ -d "$ui_dir" ] || die "$ui_dir is not visible in the container. It must be under MAPHEX_HOST_ROOT (${MAPHEX_HOST_ROOT:-unset})."
ui_dir="$(realpath "$ui_dir")"

case "${MAPHEX_ENGINE_DIR:-../SIG-Transformer}" in
  /*) engine_dir="$MAPHEX_ENGINE_DIR" ;;
  *)  engine_dir="$ui_dir/${MAPHEX_ENGINE_DIR:-../SIG-Transformer}" ;;
esac
[ -f "$engine_dir/docker-compose.yml" ] \
  || die "No SIG-Transformer at $engine_dir. Set SIG_TRANSFORMER_DIR in SIG-UI/.env."
engine_dir="$(realpath "$engine_dir")"

export MAPHEX_PIPELINE_DIR="$engine_dir"
export MAPHEX_DATA_DIR="${MAPHEX_DATA_DIR:-$ui_dir/data}"
[ -S /var/run/docker.sock ] || die "The Docker socket is not mounted."

# The CLI's own config, kept out of the host's ~/.docker: Docker Desktop
# writes a credsStore there that names a Windows helper this image lacks.
export DOCKER_CONFIG=/tmp/maphex-docker
mkdir -p "$DOCKER_CONFIG" "$MAPHEX_DATA_DIR"

# Run as whoever owns the UI's folder on the host, so what the backend and
# the engine's host-side scripts write (data/, logs/, admin/, project
# folders) stays theirs instead of becoming root's. The socket's group is
# added so that user can still reach the daemon.
uid="$(stat -c %u "$ui_dir")"
gid="$(stat -c %g "$ui_dir")"
sock_gid="$(stat -c %g /var/run/docker.sock)"
chown "$uid:$gid" "$DOCKER_CONFIG" "$MAPHEX_DATA_DIR" 2>/dev/null || true

echo "[maphex] UI:     $ui_dir"
echo "[maphex] engine: $engine_dir (compose project ${COMPOSE_PROJECT_NAME:-?})"
echo "[maphex] open http://localhost:${MAPHEX_PORT:-8765}"

if [ "$uid" = "0" ]; then
  exec "$@"
fi
exec setpriv --reuid="$uid" --regid="$gid" --groups="$gid,$sock_gid" -- "$@"
