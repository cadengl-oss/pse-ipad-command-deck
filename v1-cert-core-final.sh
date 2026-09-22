#!/usr/bin/env bash
set -euo pipefail

CERT_URL="https://raw.githubusercontent.com/cadengl-oss/pse-ipad-command-deck/d1df597a6627899dd4433a3e32629b81701cd7c0/v1-cert.mjs"
CERT_BLOB_SHA="e893f25cc6f86a44d9582c4817005cfdffa24a20"
APP_ROOT="/opt/pse-remote-commander/current"
MCP_TOKEN="/etc/pse/remote-commander-mcp-token"
IMAGE="node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9"

command -v docker >/dev/null || { echo "CERT_ERROR=docker unavailable"; exit 1; }
command -v curl >/dev/null || { echo "CERT_ERROR=curl unavailable"; exit 1; }
command -v python3 >/dev/null || { echo "CERT_ERROR=python3 unavailable"; exit 1; }

CERT_TMP=$(mktemp /tmp/pse-rc-v1-core-cert.XXXXXX.mjs)
trap 'rm -f "$CERT_TMP"' EXIT
curl -fsSL "$CERT_URL" -o "$CERT_TMP"
ACTUAL_BLOB_SHA=$(python3 - "$CERT_TMP" <<'PY'
import hashlib, sys
data=open(sys.argv[1],"rb").read()
print(hashlib.sha1(f"blob {len(data)}\0".encode()+data).hexdigest())
PY
)
[ "$ACTUAL_BLOB_SHA" = "$CERT_BLOB_SHA" ] || { echo "CERT_ERROR=certifier integrity mismatch"; exit 1; }
echo "CERTIFIER_INTEGRITY=PASS"

TOKEN_OWNER=$(docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true   -v "$MCP_TOKEN:/probe/token:ro"   "$IMAGE" node -e '
    const fs=require("node:fs");
    const s=fs.statSync("/probe/token");
    process.stdout.write(String(s.uid)+":"+String(s.gid));
  ')
[[ "$TOKEN_OWNER" =~ ^[0-9]+:[0-9]+$ ]] || { echo "CERT_ERROR=invalid token owner"; exit 1; }

docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true   --user "$TOKEN_OWNER"   -e PSE_RC_APP_ROOT="$APP_ROOT"   -e PSE_RC_MCP_TOKEN_FILE="$MCP_TOKEN"   -v "$APP_ROOT:$APP_ROOT:ro"   -v "$MCP_TOKEN:$MCP_TOKEN:ro"   "$IMAGE" node -e '
    const fs=require("node:fs");
    const root=process.env.PSE_RC_APP_ROOT;
    fs.accessSync(root+"/package.json",fs.constants.R_OK);
    fs.accessSync(root+"/node_modules",fs.constants.R_OK);
    const token=fs.readFileSync(process.env.PSE_RC_MCP_TOKEN_FILE,"utf8").trim();
    if(token.length<32) throw new Error("invalid MCP token");
  '
echo "HOST_SECRET_ACCESS=PASS"

docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true   --user "$TOKEN_OWNER"   -e PSE_RC_APP_ROOT="$APP_ROOT"   -v "$APP_ROOT:$APP_ROOT:ro"   "$IMAGE" node --input-type=module -e '
    import { createRequire } from "node:module";
    const root=process.env.PSE_RC_APP_ROOT;
    const requireFromApp=createRequire(root+"/package.json");
    const resolved=requireFromApp.resolve("@modelcontextprotocol/client");
    const mod=await import(resolved);
    if (typeof mod.Client!=="function") throw new Error("MCP Client export missing");
    if (typeof mod.StreamableHTTPClientTransport!=="function") throw new Error("StreamableHTTPClientTransport export missing");
  '
echo "MCP_CLIENT_API=PASS"

docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true   --user "$TOKEN_OWNER"   "$IMAGE" node -e "
    fetch('http://127.0.0.1:18751/mcp')
      .then(r=>{ if(r.status!==401) throw new Error('expected 401, got '+r.status); })
      .catch(e=>{ console.error(e.message); process.exit(1); });
  "
echo "MCP_LOOPBACK_REACHABILITY=PASS"

docker run --rm -i   --network host   --read-only   --tmpfs /tmp:rw,noexec,nosuid,size=64m   --cap-drop ALL   --security-opt no-new-privileges:true   --user "$TOKEN_OWNER"   -e PSE_RC_APP_ROOT="$APP_ROOT"   -e PSE_RC_MCP_ENV_FILE=/dev/null   -e PSE_RC_MCP_TOKEN_FILE="$MCP_TOKEN"   -e PSE_RC_MCP_HOST=127.0.0.1   -e PSE_RC_MCP_PORT=18751   -e PSE_RC_REQUIRE_FULL_ANNOTATIONS=0   -v "$APP_ROOT:$APP_ROOT:ro"   -v "$MCP_TOKEN:$MCP_TOKEN:ro"   "$IMAGE" node --input-type=module - < "$CERT_TMP"

echo "V1_CORE_CERT_WRAPPER=PASS"
