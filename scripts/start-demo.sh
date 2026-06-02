#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_FILE="$ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      "" | \#*) continue ;;
    esac
    case "$key" in
      CIVILIZATION_TOWN_* | OPENAI_*)
        value="${value%$'\r'}"
        export "$key=$value"
        ;;
    esac
  done < "$ENV_FILE"
fi

resolve_core() {
  if [ -n "${CIVILIZATION_TOWN_CORE:-}" ]; then
    printf '%s\n' "$CIVILIZATION_TOWN_CORE"
    return
  fi

  local arch platform
  case "$(uname -m)" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) arch="$(uname -m)" ;;
  esac
  case "$(uname -s)" in
    Linux*) platform="linux-$arch" ;;
    Darwin*) platform="macos-$arch" ;;
    *) platform="" ;;
  esac

  local candidates=("$ROOT/bin/civilization-town-core")
  if [ -n "$platform" ]; then
    candidates+=("$ROOT/bin/civilization-town-core-$platform")
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  printf '%s\n' "$ROOT/bin/civilization-town-core"
}

CORE="$(resolve_core)"
HOST="${CIVILIZATION_TOWN_HOST:-127.0.0.1}"
PORT="${CIVILIZATION_TOWN_PORT:-4183}"

if [ -f "$CORE" ] && [ ! -x "$CORE" ]; then
  chmod +x "$CORE" 2>/dev/null || true
fi

if [ ! -x "$CORE" ]; then
  echo "Core runtime not found or not executable: $CORE" >&2
  echo "Download a Civilization Town runtime from GitHub Releases and place it in ./bin/." >&2
  echo "Expected examples: ./bin/civilization-town-core, ./bin/civilization-town-core-linux-x64, ./bin/civilization-town-core-macos-arm64." >&2
  exit 1
fi

exec "$CORE" serve \
  --world "$ROOT/examples/town" \
  --frontend "$ROOT/frontend" \
  --listen "$HOST:$PORT" \
  --enable-remote-agents
