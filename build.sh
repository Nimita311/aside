#!/usr/bin/env bash
set -euo pipefail

# Build everything a local install needs: the CLI bundle (the MCP
# server entry point), the webapp bundle, and — on macOS with a Swift
# toolchain — the aside-cal calendar helper. Link the aside CLI to this
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

echo "==> aside-cal"
if [[ "$(uname)" == "Darwin" ]] && command -v swiftc >/dev/null; then
	bash "$here/cli/native/build.sh"
else
	echo "skipped: calendar sync needs macOS 14+ with the Xcode Command Line Tools (xcode-select --install)"
fi

echo "==> link aside CLI"
(cd "$here/cli" && npm link)

echo "done"
