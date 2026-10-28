#!/usr/bin/env bash
# Start ImgtoHTML: the local vision model (Ollama), the app server, and the
# browser. Run it from anywhere:  bash web/start.sh   (or: npm run app)
#
# Options (environment variables):
#   NO_BROWSER=1          don't open the browser
#   IMGTOHTML_VISION=off  run without the vision model (OCR only)
#   OLLAMA_BIN=/path      Ollama binary (default: ~/.local/ollama/bin/ollama, then PATH)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

URL="http://localhost:3000"
OLLAMA_URL="http://127.0.0.1:11434"
MODEL="${OLLAMA_MODEL:-qwen3-vl:8b-instruct-q4_K_M}"
say() { printf '\033[32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
up() { curl -fs -m 2 -o /dev/null "$1"; }

open_browser() {
  [[ "${NO_BROWSER:-}" == 1 ]] && return
  if command -v wslview >/dev/null; then wslview "$URL" || true
  elif command -v cmd.exe >/dev/null; then cmd.exe /c start "" "$URL" 2>/dev/null || true
  elif command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1 || true
  fi
}

# Build when the code changed since the last build.
build_if_changed() {
  if [[ ! -f dist-server/index.js || ! -f dist/index.html ]] ||
     [[ -n "$(find src server index.html package.json -newer dist-server/index.js -print -quit)" ]]; then
    say "Building the app…"
    npm run build --silent
  fi
}
# Same ID the server reports at /api/version (server/build.ts).
build_id() { sha256sum dist-server/index.js | cut -c1-12; }

# Already running? Open it if it runs the current build; otherwise restart it,
# since a running server keeps the code it started with.
if up "$URL"; then
  build_if_changed
  running="$(curl -fs -m 2 "$URL/api/version" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p' || true)"
  if [[ "$running" == "$(build_id)" ]]; then
    say "ImgtoHTML is already running at $URL"
    open_browser
    exit 0
  fi
  old=""
  for pid in $(pgrep -f 'node dist-server/index.js' || true); do
    [[ "$(readlink "/proc/$pid/cwd")" == "$PWD" ]] && old="$pid"
  done
  if [[ -z "$old" ]]; then
    warn "Something else is using $URL (build ${running:-unknown}, current $(build_id)). Stop it and run this again."
    exit 1
  fi
  warn "The running server is out of date (build ${running:-unknown}, current $(build_id)). Restarting it…"
  kill "$old"
  for _ in $(seq 30); do up "$URL" || break; sleep 0.5; done
  up "$URL" && { warn "The old server didn't stop (pid $old)."; exit 1; }
  # Its launcher stops the Ollama it started; let that finish before checking Ollama.
  sleep 2
fi

# Requirements
command -v node >/dev/null || { warn "Node.js 20+ is required."; exit 1; }
command -v tesseract >/dev/null || warn "Native Tesseract not found; using the slower built-in text reader."
if [[ ! -d node_modules ]]; then
  say "Installing packages (first run)…"
  npm install --no-audit --no-fund
fi

# Vision model
started_ollama=""
if [[ "${IMGTOHTML_VISION:-}" == off ]]; then
  warn "Vision model off (IMGTOHTML_VISION=off): OCR only."
elif up "$OLLAMA_URL/api/version"; then
  say "Ollama is already running."
else
  ollama="${OLLAMA_BIN:-$HOME/.local/ollama/bin/ollama}"
  [[ -x "$ollama" ]] || ollama="$(command -v ollama || true)"
  if [[ -z "$ollama" ]]; then
    warn "Ollama not found: running OCR only. (Expected at ~/.local/ollama/bin/ollama.)"
    export IMGTOHTML_VISION=off
  else
    say "Starting Ollama (vision model server)…"
    OLLAMA_HOST=127.0.0.1:11434 nohup "$ollama" serve >"$HOME/.local/ollama-serve.log" 2>&1 &
    started_ollama=$!
    for _ in $(seq 30); do up "$OLLAMA_URL/api/version" && break; sleep 1; done
    up "$OLLAMA_URL/api/version" || { warn "Ollama didn't start; see ~/.local/ollama-serve.log. Running OCR only."; export IMGTOHTML_VISION=off; }
  fi
fi
if [[ "${IMGTOHTML_VISION:-}" != off ]] && ! curl -fs -m 2 "$OLLAMA_URL/api/tags" | grep -q "\"$MODEL\""; then
  warn "Model $MODEL isn't downloaded. Get it once with:  ollama pull $MODEL   (OCR only until then)"
fi

build_if_changed

# Stop what this script started, when the app stops (Ctrl+C).
cleanup() {
  [[ -n "${server:-}" ]] && kill "$server" 2>/dev/null || true
  [[ -n "$started_ollama" ]] && kill "$started_ollama" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

say "Starting ImgtoHTML…"
node dist-server/index.js &
server=$!
for _ in $(seq 30); do up "$URL" && break; sleep 0.5; done
up "$URL" || { warn "The app didn't start."; exit 1; }
say "Ready at $URL  (this computer only). Press Ctrl+C to stop."
open_browser
wait "$server"
