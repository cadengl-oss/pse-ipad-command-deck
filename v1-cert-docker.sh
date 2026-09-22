#!/usr/bin/env bash
set -euo pipefail

CERT_URL="https://raw.githubusercontent.com/cadengl-oss/pse-ipad-command-deck/427ff68bf0f3166c231a6e4ceef2e8ffae3da76c/v1-cert.mjs"
APP_ROOT="/opt/pse-remote-commander/current"
MCP_ENV="/etc/pse/remote-commander-mcp.env"
MCP_TOKEN="/etc/pse/remote-commander-mcp-token"
IMAGE="node:22-bookworm-slim"

command -v docker >/dev/null || { echo "CERT_ERROR=docker unavailable"; exit 1; }
command -v curl >/dev/null || { echo "CERT_ERROR=curl unavailable"; exit 1; }

# All file paths below are resolved by the Nexus Docker daemon, not the
# restricted Mobile Command filesystem. Refuse to continue unless the daemon
# can see the exact host resources we need.
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true   -v "$APP_ROOT:/probe/app:ro"   -v "$MCP_ENV:/probe/mcp.env:ro"   -v "$MCP_TOKEN:/probe/mcp-token:ro"   "$IMAGE" sh -ceu '
    test -s /probe/app/package.json
    test -d /probe/app/node_modules
    test -s /probe/mcp.env
    test -s /probe/mcp-token
  '
echo "HOST_SECRET_ACCESS=PASS"

# Stream the audited certifier over stdin; the token remains a host-mounted
# file and is never copied to Mobile Command or stdout.
curl -fsSL "$CERT_URL" | docker run --rm -i   --network host   --read-only   --tmpfs /tmp:rw,noexec,nosuid,size=64m   --cap-drop ALL   --security-opt no-new-privileges:true   -e PSE_RC_APP_ROOT="$APP_ROOT"   -e PSE_RC_MCP_ENV_FILE="$MCP_ENV"   -e PSE_RC_MCP_TOKEN_FILE="$MCP_TOKEN"   -v "$APP_ROOT:$APP_ROOT:ro"   -v "$MCP_ENV:$MCP_ENV:ro"   -v "$MCP_TOKEN:$MCP_TOKEN:ro"   "$IMAGE" node --input-type=module -

echo "V1_CERT_WRAPPER=PASS"
