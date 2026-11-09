#!/usr/bin/env bash
set -euo pipefail

# Build everything a local install needs: the CLI bundle (the MCP
# server entry point), the webapp bundle, and — on macOS — the universal
# aside-native helper through the CLI build. Link the aside CLI to this
# checkout with npm link. Run again after `git pull`.

here="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null; then
  echo "Aside requires Node.js >= 22.12.0; no Node executable found on PATH. Install Node.js 24 LTS, then retry ./build.sh." >&2
  exit 1
fi
node "$here/cli/check-node.cjs"

echo "==> cli"
(cd "$here/cli" && npm install && npm run build)

echo "==> webapp"
(cd "$here/webapp" && npm install && npm run build)

echo "==> link aside CLI"
(cd "$here/cli" && npm link)

echo "done"

if ! command -v ollama >/dev/null 2>&1; then
	printf '%s\n' '' \
		'Optional semantic search requires Ollama 0.40 or newer running locally.' \
		'Install Ollama: https://ollama.com' \
		'Then start Ollama and download the embedding model:' \
		'  ollama pull qwen3-embedding:0.6b'
fi
