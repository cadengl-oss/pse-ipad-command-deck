#!/usr/bin/env bash
set -euo pipefail

CERT_URL="https://raw.githubusercontent.com/cadengl-oss/pse-ipad-command-deck/427ff68bf0f3166c231a6e4ceef2e8ffae3da76c/v1-cert.mjs"
APP_ROOT="/opt/pse-remote-commander/current"
MCP_TOKEN="/etc/pse/remote-commander-mcp-token"
IMAGE="node:22-bookworm-slim"

command -v docker >/dev/null || { echo "CERT_ERROR=docker unavailable"; exit 1; }
command -v curl >/dev/null || { echo "CERT_ERROR=curl unavailable"; exit 1; }

# Bind-mount sources are resolved on the Docker daemon host. Read only the
# token file metadata so the certification container can run as the token's
# actual host owner without adding DAC-bypass capabilities.
TOKEN_OWNER=$(docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$MCP_TOKEN:/probe/token:ro" \
  "$IMAGE" node -e '
    const fs=require("node:fs");
    const s=fs.statSync("/probe/token");
    process.stdout.write(String(s.uid)+":"+String(s.gid));
  ')
[[ "$TOKEN_OWNER" =~ ^[0-9]+:[0-9]+$ ]] || { echo "CERT_ERROR=invalid token owner"; exit 1; }

# Prove the exact effective UID/GID can read the host token and the live app
# dependency tree before any MCP call is attempted.
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user "$TOKEN_OWNER" \
  -v "$APP_ROOT:$APP_ROOT:ro" \
  -v "$MCP_TOKEN:$MCP_TOKEN:ro" \
  "$IMAGE" node -e '
    const fs=require("node:fs");
    const root=process.env.PSE_RC_APP_ROOT;
    fs.accessSync(root+"/package.json",fs.constants.R_OK);
    fs.accessSync(root+"/node_modules",fs.constants.R_OK);
    const token=fs.readFileSync(process.env.PSE_RC_MCP_TOKEN_FILE,"utf8").trim();
    if(token.length<32) throw new Error("invalid MCP token");
  ' \
  --env PSE_RC_APP_ROOT="$APP_ROOT" \
  --env PSE_RC_MCP_TOKEN_FILE="$MCP_TOKEN"
echo "HOST_SECRET_ACCESS=PASS"

# Prove the mounted live release exports the exact MCP v2 client APIs used by
# the certifier. Official MCP v2 docs export both from the package root.
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user "$TOKEN_OWNER" \
  -e PSE_RC_APP_ROOT="$APP_ROOT" \
  -v "$APP_ROOT:$APP_ROOT:ro" \
  "$IMAGE" node --input-type=module -e '
    import { createRequire } from "node:module";
    const root=process.env.PSE_RC_APP_ROOT;
    const requireFromApp=createRequire(root+"/package.json");
    const resolved=requireFromApp.resolve("@modelcontextprotocol/client");
    const mod=await import(resolved);
    if (typeof mod.Client!=="function") throw new Error("MCP Client export missing");
    if (typeof mod.StreamableHTTPClientTransport!=="function") throw new Error("StreamableHTTPClientTransport export missing");
  '
echo "MCP_CLIENT_API=PASS"

# With host networking, 127.0.0.1 is the Nexus host network namespace. Verify
# that the live private MCP endpoint is reachable and rejects unauthenticated
# traffic before presenting the real token.
docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user "$TOKEN_OWNER" \
  "$IMAGE" node -e "
    fetch('http://127.0.0.1:18751/mcp')
      .then(r=>{ if(r.status!==401) throw new Error('expected 401, got '+r.status); })
      .catch(e=>{ console.error(e.message); process.exit(1); });
  "
echo "MCP_LOOPBACK_REACHABILITY=PASS"

# Stream the audited certifier over stdin. The token stays a read-only host
# bind mount and is never copied to Mobile Command or printed.
curl -fsSL "$CERT_URL" | docker run --rm -i \
  --network host \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --user "$TOKEN_OWNER" \
  -e PSE_RC_APP_ROOT="$APP_ROOT" \
  -e PSE_RC_MCP_ENV_FILE=/dev/null \
  -e PSE_RC_MCP_TOKEN_FILE="$MCP_TOKEN" \
  -e PSE_RC_MCP_HOST=127.0.0.1 \
  -e PSE_RC_MCP_PORT=18751 \
  -v "$APP_ROOT:$APP_ROOT:ro" \
  -v "$MCP_TOKEN:$MCP_TOKEN:ro" \
  "$IMAGE" node --input-type=module -

echo "V1_CERT_WRAPPER=PASS"
