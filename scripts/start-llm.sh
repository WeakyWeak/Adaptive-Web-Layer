#!/usr/bin/env bash
# Start the local model for Adaptive Web Layer on port 8080 (all layers on GPU).
# Override with env vars: LLAMA_SERVER, MODEL, CTX, PORT.
set -euo pipefail
cd "$(dirname "$0")/.."
LLAMA_SERVER="${LLAMA_SERVER:-}"
if [[ -z "$LLAMA_SERVER" ]]; then
  if command -v llama-server >/dev/null; then LLAMA_SERVER="llama-server"
  elif [[ -x "$HOME/llama.cpp/build/bin/llama-server" ]]; then LLAMA_SERVER="$HOME/llama.cpp/build/bin/llama-server"
  else echo "llama-server not found; set LLAMA_SERVER=/path/to/llama-server" >&2; exit 1; fi
fi
MODEL="${MODEL:-qwen/qwen2.5-coder-7b-instruct-q4_k_m.gguf}"
exec "$LLAMA_SERVER" -m "$MODEL" -ngl 99 -c "${CTX:-8192}" --jinja --host 127.0.0.1 --port "${PORT:-8080}"
