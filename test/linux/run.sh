#!/usr/bin/env bash
# Linux smoke test of the published package: packs it, installs it in a client container on the oldest supported
# Node, and syncs over SSH from a second container. Needs Docker. Exits non-zero if any check fails.
#
#   test/linux/run.sh                          # native architecture
#   PLATFORM=linux/amd64 test/linux/run.sh     # another architecture (emulated)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
node_major=$(node -p "require('$root/package.json').engines.node.match(/\\d+/)[0]")
platform=(${PLATFORM:+--platform "$PLATFORM"})

stop_host() {
  docker rm -f ccsync-host >/dev/null 2>&1 || true
  docker network rm ccsync-net >/dev/null 2>&1 || true
}
stop_host # left over from an interrupted run
ctx=$(mktemp -d)
trap 'stop_host; rm -rf "$ctx"' EXIT

cp "$here"/Dockerfile.* "$here"/client-test.sh "$here"/statusline-input.json "$ctx"/
cp -R "$root"/test/fixtures/machine-a "$root"/test/fixtures/machine-b "$ctx"/
(cd "$root" && npm pack --silent --pack-destination "$ctx" >/dev/null)
mv "$ctx"/ccusage-sync-*.tgz "$ctx"/ccusage-sync.tgz
ssh-keygen -q -t ed25519 -N '' -C ccsync-test -f "$ctx"/id_ed25519

docker build -q -t ccsync-host -f "$ctx"/Dockerfile.host "$ctx" >/dev/null
docker build -q ${platform[@]+"${platform[@]}"} --build-arg NODE="$node_major" -t ccsync-client -f "$ctx"/Dockerfile.client "$ctx" >/dev/null
docker network create ccsync-net >/dev/null
docker run -d --rm --name ccsync-host --network ccsync-net ccsync-host >/dev/null
docker run --rm ${platform[@]+"${platform[@]}"} --network ccsync-net ccsync-client
