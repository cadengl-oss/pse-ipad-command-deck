#!/usr/bin/env bash
set -Eeuo pipefail

NODE_IMAGE="node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9"
IMAGE="pse-remote-commander-v1:1.0.0-live-preserved"
LIVE_ROOT="/opt/pse-remote-commander/current"
MCP_TOKEN="/etc/pse/remote-commander-mcp-token"
RELAY_ENV="/etc/pse/remote-commander-relay.env"
MCP_ENV="/etc/pse/remote-commander-mcp.env"
INTERNAL_TOKEN="/etc/pse/remote-commander-internal-token"
OLD_RELAY="pse-remote-commander-relay.service"
OLD_MCP="pse-remote-commander-mcp.service"

STAGE="pse-rc-v1-builder"
SMOKE_RELAY="pse-rc-v1-smoke-relay"
SMOKE_MCP="pse-rc-v1-smoke-mcp"
PROD_RELAY="pse-rc-v1-relay"
PROD_MCP="pse-rc-v1-mcp"

CERT_URL="https://raw.githubusercontent.com/cadengl-oss/pse-ipad-command-deck/d1df597a6627899dd4433a3e32629b81701cd7c0/v1-cert.mjs"
CERT_BLOB_SHA="e893f25cc6f86a44d9582c4817005cfdffa24a20"

CUTOVER_STARTED=0
PRESERVE_18752=0
CERT_TMP=""

die(){ echo "V1_ERROR=$*" >&2; exit 1; }

cleanup_temp(){
  docker rm -f "$SMOKE_MCP" "$SMOKE_RELAY" "$STAGE" >/dev/null 2>&1 || true
  [ -n "$CERT_TMP" ] && rm -f "$CERT_TMP" >/dev/null 2>&1 || true
}

wait_http_code(){
  local url=$1 expected=$2
  for _ in $(seq 1 30); do
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    [ "$code" = "$expected" ] && return 0
    sleep 1
  done
  echo "HTTP_GATE_FAILED url=$url expected=$expected" >&2
  return 1
}

wait_port_free(){
  local port=$1
  for _ in $(seq 1 30); do
    if ! ss -lnt | grep -qE ":${port}\b"; then return 0; fi
    sleep 1
  done
  echo "PORT_NOT_FREE=$port" >&2
  return 1
}

runtime_owner(){
  docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$MCP_TOKEN:/probe/token:ro" \
    "$NODE_IMAGE" node -e '
      const fs=require("node:fs");
      const s=fs.statSync("/probe/token");
      process.stdout.write(String(s.uid)+":"+String(s.gid));
    '
}

run_certification(){
  local strict=$1
  docker run --rm -i \
    --network host \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --user "$RUNTIME_OWNER" \
    -e PSE_RC_APP_ROOT="$LIVE_ROOT" \
    -e PSE_RC_MCP_ENV_FILE=/dev/null \
    -e PSE_RC_MCP_TOKEN_FILE="$MCP_TOKEN" \
    -e PSE_RC_MCP_HOST=127.0.0.1 \
    -e PSE_RC_MCP_PORT=18751 \
    -e PSE_RC_REQUIRE_FULL_ANNOTATIONS="$strict" \
    -v "$LIVE_ROOT:$LIVE_ROOT:ro" \
    -v "$MCP_TOKEN:$MCP_TOKEN:ro" \
    "$NODE_IMAGE" node --input-type=module - < "$CERT_TMP"
}

disable_legacy_boot(){
  docker run --rm --cap-drop ALL --security-opt no-new-privileges:true \
    -v /etc/systemd/system:/host-systemd \
    "$NODE_IMAGE" sh -ceu '
      mkdir -p /host-systemd/.pse-rc-v1-disabled
      for u in pse-remote-commander-relay.service pse-remote-commander-mcp.service; do
        src="/host-systemd/multi-user.target.wants/$u"
        dst="/host-systemd/.pse-rc-v1-disabled/$u"
        if [ -L "$src" ] && [ ! -e "$dst" ]; then mv "$src" "$dst"; fi
      done
    '
}

restore_legacy_boot(){
  docker run --rm --cap-drop ALL --security-opt no-new-privileges:true \
    -v /etc/systemd/system:/host-systemd \
    "$NODE_IMAGE" sh -ceu '
      mkdir -p /host-systemd/multi-user.target.wants
      for u in pse-remote-commander-relay.service pse-remote-commander-mcp.service; do
        src="/host-systemd/.pse-rc-v1-disabled/$u"
        dst="/host-systemd/multi-user.target.wants/$u"
        if [ -L "$src" ] && [ ! -e "$dst" ]; then mv "$src" "$dst"; fi
      done
    '
}

rollback_live(){
  set +e
  echo "CUTOVER_ROLLBACK=START"
  docker rm -f "$PROD_MCP" "$PROD_RELAY" >/dev/null 2>&1 || true
  restore_legacy_boot >/dev/null 2>&1 || true
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl start "$OLD_RELAY" >/dev/null 2>&1 || true
  sleep 2
  systemctl start "$OLD_MCP" >/dev/null 2>&1 || true
  sleep 5
  if curl -fsS --max-time 5 http://127.0.0.1:18750/health | grep -q pse-remote-commander-relay && run_certification 0; then
    echo "CUTOVER_ROLLBACK_CERTIFICATION=PASS"
  else
    echo "CUTOVER_ROLLBACK_CERTIFICATION=FAILED" >&2
  fi
  echo "CUTOVER_ROLLBACK=COMPLETE"
}

on_error(){
  local code=$?
  if [ "$CUTOVER_STARTED" -eq 1 ]; then rollback_live; else echo "PRE_CUTOVER_ABORT=SAFE" >&2; fi
  cleanup_temp
  exit "$code"
}
trap on_error ERR
trap cleanup_temp EXIT

[ "$(id -u)" -eq 0 ] || die "must run as root"
for bin in docker curl python3 systemctl ss; do command -v "$bin" >/dev/null || die "$bin unavailable"; done
docker info >/dev/null
test -d "$LIVE_ROOT" || die "live Remote Commander tree missing"
for f in "$MCP_TOKEN" "$RELAY_ENV" "$MCP_ENV" "$INTERNAL_TOKEN"; do
  docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$f:/probe:ro" "$NODE_IMAGE" sh -ceu 'test -s /probe' >/dev/null
done

CERT_TMP=$(mktemp /tmp/pse-rc-v1-cert.XXXXXX.mjs)
curl -fsSL "$CERT_URL" -o "$CERT_TMP"
ACTUAL_CERT_SHA=$(python3 - "$CERT_TMP" <<'PY'
import hashlib,sys
d=open(sys.argv[1],"rb").read()
print(hashlib.sha1(f"blob {len(d)}\0".encode()+d).hexdigest())
PY
)
[ "$ACTUAL_CERT_SHA" = "$CERT_BLOB_SHA" ] || die "certifier integrity mismatch"
echo "CERTIFIER_INTEGRITY=PASS"

RUNTIME_OWNER=$(runtime_owner)
[[ "$RUNTIME_OWNER" =~ ^[0-9]+:[0-9]+$ ]] || die "invalid runtime owner"
for f in "$MCP_TOKEN" "$RELAY_ENV" "$MCP_ENV" "$INTERNAL_TOKEN"; do
  docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --user "$RUNTIME_OWNER" -v "$f:/probe:ro" "$NODE_IMAGE" sh -ceu 'cat /probe >/dev/null'
done
echo "RUNTIME_SECRET_ACCESS=PASS owner=$RUNTIME_OWNER"

systemctl is-active --quiet "$OLD_RELAY"
systemctl is-active --quiet "$OLD_MCP"
curl -fsS --max-time 5 http://127.0.0.1:18750/health | grep -q pse-remote-commander-relay
run_certification 0
echo "LIVE_BASELINE_CERTIFICATION=PASS"

if ss -lnt | grep -qE ':18752\b'; then
  PRESERVE_18752=1
  echo "PORT_18752_BASELINE=PRESENT"
fi

docker rm -f "$STAGE" >/dev/null 2>&1 || true
docker create --name "$STAGE" \
  --network bridge \
  -v "$LIVE_ROOT:/live:ro" \
  "$NODE_IMAGE" sh -c 'sleep infinity' >/dev/null
docker start "$STAGE" >/dev/null

docker exec "$STAGE" sh -ceu '
  mkdir -p /app/apps /app/packages
  cp /live/package.json /live/package-lock.json /app/
  cp -a /live/apps/relay /live/apps/mcp-http /app/apps/
  cp -a /live/packages/protocol /live/packages/policy /live/packages/relay-core /live/packages/relay-server /live/packages/mcp-facade /app/packages/
'

docker exec -i "$STAGE" sh -c 'cat > /app/packages/mcp-facade/src/tool-specs-v1.mjs' <<'EOF'
import { TOOL_SPECS as LEGACY_TOOL_SPECS } from "./tool-specs.mjs";

const OPEN_WORLD_TOOLS=new Set(["read_file","write_pdf","start_process","interact_with_process"]);
const DESTRUCTIVE_TOOLS=new Set([
  "shutdown","set_config_value","write_file","write_pdf","move_file",
  "edit_block","start_process","interact_with_process","force_terminate","kill_process"
]);

function titleFor(name){
  return name.split("_").map(part=>part.charAt(0).toUpperCase()+part.slice(1)).join(" ");
}

export const TOOL_SPECS=Object.freeze(LEGACY_TOOL_SPECS.map(spec=>Object.freeze({
  ...spec,
  title:spec.title??titleFor(spec.name),
  annotations:Object.freeze({
    readOnlyHint:spec.name==="start_search"?false:Boolean(spec.annotations?.readOnlyHint),
    openWorldHint:OPEN_WORLD_TOOLS.has(spec.name),
    destructiveHint:DESTRUCTIVE_TOOLS.has(spec.name),
    ...(spec.annotations?.idempotentHint!==undefined
      ? {idempotentHint:Boolean(spec.annotations.idempotentHint)}
      : {})
  })
})));

export const TOOL_SPEC_BY_NAME=Object.freeze(
  Object.fromEntries(TOOL_SPECS.map(spec=>[spec.name,spec]))
);
EOF

docker exec -i "$STAGE" node --input-type=module - <<'NODE'
import fs from "node:fs";
const path="/app/packages/mcp-facade/src/server.mjs";
let source=fs.readFileSync(path,"utf8");
const oldImport='import { TOOL_SPECS } from "./tool-specs.mjs";';
const newImport='import { TOOL_SPECS } from "./tool-specs-v1.mjs";';
if(!source.includes(oldImport)) throw new Error("server import anchor missing");
source=source.replace(oldImport,newImport);
source=source.replace("title:spec.name,","title:spec.title??spec.name,");
fs.writeFileSync(path,source);
NODE

docker exec "$STAGE" sh -ceu 'cd /app && npm ci --omit=optional --ignore-scripts --no-audit --no-fund'
docker exec "$STAGE" sh -ceu 'cd /app && node --test \
  packages/protocol/test/*.test.mjs \
  packages/policy/test/*.test.mjs \
  packages/relay-core/test/*.test.mjs \
  packages/relay-server/test/*.test.mjs \
  packages/mcp-facade/test/mcp-facade.test.mjs \
  packages/mcp-facade/test/http-entrypoint.test.mjs'

docker exec -i "$STAGE" sh -ceu 'cd /app && node --input-type=module -' <<'NODE'
import {TOOL_SPECS} from "./packages/mcp-facade/src/tool-specs-v1.mjs";
if(TOOL_SPECS.length!==28) throw new Error("expected 28 tools");
for(const tool of TOOL_SPECS){
  for(const key of ["readOnlyHint","openWorldHint","destructiveHint"]){
    if(typeof tool.annotations?.[key]!=="boolean") throw new Error(tool.name+" missing "+key);
  }
}
const start=TOOL_SPECS.find(t=>t.name==="start_search");
if(start?.annotations?.readOnlyHint!==false) throw new Error("start_search annotation mismatch");
console.log("STRICT_TOOL_METADATA_BUILD=PASS");
NODE

docker exec -i "$STAGE" sh -c 'cat > /usr/local/bin/pse-rc-run-relay' <<'EOF'
#!/bin/sh
set -eu
set -a
. /run/pse-host/relay.env
set +a
export PSE_RC_HOST="${PSE_RC_OVERRIDE_HOST:-127.0.0.1}"
export PSE_RC_PORT="${PSE_RC_OVERRIDE_PORT:-18750}"
exec node /app/apps/relay/main.mjs
EOF

docker exec -i "$STAGE" sh -c 'cat > /usr/local/bin/pse-rc-run-mcp' <<'EOF'
#!/bin/sh
set -eu
set -a
. /run/pse-host/mcp.env
set +a
export PSE_RC_MCP_HOST="${PSE_RC_OVERRIDE_HOST:-127.0.0.1}"
export PSE_RC_MCP_PORT="${PSE_RC_OVERRIDE_PORT:-18751}"
export PSE_RC_RELAY_BASE_URL="${PSE_RC_OVERRIDE_RELAY:-http://127.0.0.1:18750}"
exec node /app/apps/mcp-http/main.mjs
EOF

docker exec "$STAGE" chmod 0755 /usr/local/bin/pse-rc-run-relay /usr/local/bin/pse-rc-run-mcp
docker stop "$STAGE" >/dev/null
docker commit \
  --change 'WORKDIR /app' \
  --change 'ENV NODE_ENV=production' \
  --change 'LABEL org.opencontainers.image.title=PSE-Remote-Commander-V1' \
  --change 'LABEL org.opencontainers.image.version=1.0.0-live-preserved' \
  "$STAGE" "$IMAGE" >/dev/null
docker rm "$STAGE" >/dev/null

IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
echo "V1_IMAGE_BUILD=PASS image=$IMAGE_ID"

docker rm -f "$SMOKE_MCP" "$SMOKE_RELAY" >/dev/null 2>&1 || true
docker run -d --name "$SMOKE_RELAY" \
  --network host --user "$RUNTIME_OWNER" --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL --security-opt no-new-privileges:true \
  -e PSE_RC_OVERRIDE_PORT=28750 \
  -v "$RELAY_ENV:/run/pse-host/relay.env:ro" \
  -v "$INTERNAL_TOKEN:$INTERNAL_TOKEN:ro" \
  "$IMAGE" /usr/local/bin/pse-rc-run-relay >/dev/null
wait_http_code http://127.0.0.1:28750/health 200

docker run -d --name "$SMOKE_MCP" \
  --network host --user "$RUNTIME_OWNER" --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL --security-opt no-new-privileges:true \
  -e PSE_RC_OVERRIDE_PORT=28751 \
  -e PSE_RC_OVERRIDE_RELAY=http://127.0.0.1:28750 \
  -v "$MCP_ENV:/run/pse-host/mcp.env:ro" \
  -v "$INTERNAL_TOKEN:$INTERNAL_TOKEN:ro" \
  -v "$MCP_TOKEN:$MCP_TOKEN:ro" \
  "$IMAGE" /usr/local/bin/pse-rc-run-mcp >/dev/null
wait_http_code http://127.0.0.1:28751/mcp 401

docker run --rm -i --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user "$RUNTIME_OWNER" \
  -e TOKEN_FILE="$MCP_TOKEN" \
  -v "$MCP_TOKEN:$MCP_TOKEN:ro" \
  "$IMAGE" node --input-type=module - <<'NODE'
import fs from "node:fs";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
const token=fs.readFileSync(process.env.TOKEN_FILE,"utf8").trim();
const client=new Client({name:"pse-v1-smoke",version:"1.0.0"});
const transport=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:28751/mcp"),{
  requestInit:{headers:{Authorization:`Bearer ${token}`}}
});
try{
  await client.connect(transport);
  const listed=await client.listTools();
  if(listed.tools.length!==28) throw new Error("tool count="+listed.tools.length);
  for(const tool of listed.tools){
    for(const key of ["readOnlyHint","openWorldHint","destructiveHint"]){
      if(typeof tool.annotations?.[key]!=="boolean") throw new Error(tool.name+" missing "+key);
    }
  }
  console.log("V1_CANDIDATE_METADATA_SMOKE=PASS");
} finally {
  await client.close().catch(()=>{});
}
NODE

docker rm -f "$SMOKE_MCP" "$SMOKE_RELAY" >/dev/null
echo "PRE_CUTOVER_GAUNTLET=PASS"

CUTOVER_STARTED=1
systemctl stop "$OLD_MCP"
systemctl stop "$OLD_RELAY"
wait_port_free 18751
wait_port_free 18750
echo "LEGACY_LISTENERS_STOPPED=PASS"

docker rm -f "$PROD_MCP" "$PROD_RELAY" >/dev/null 2>&1 || true
docker run -d --name "$PROD_RELAY" --restart unless-stopped \
  --network host --user "$RUNTIME_OWNER" --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$RELAY_ENV:/run/pse-host/relay.env:ro" \
  -v "$INTERNAL_TOKEN:$INTERNAL_TOKEN:ro" \
  "$IMAGE" /usr/local/bin/pse-rc-run-relay >/dev/null
wait_http_code http://127.0.0.1:18750/health 200

docker run -d --name "$PROD_MCP" --restart unless-stopped \
  --network host --user "$RUNTIME_OWNER" --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$MCP_ENV:/run/pse-host/mcp.env:ro" \
  -v "$INTERNAL_TOKEN:$INTERNAL_TOKEN:ro" \
  -v "$MCP_TOKEN:$MCP_TOKEN:ro" \
  "$IMAGE" /usr/local/bin/pse-rc-run-mcp >/dev/null
wait_http_code http://127.0.0.1:18751/mcp 401
echo "V1_CONTROL_PLANE_HEALTH=PASS"

CERT_OK=0
for attempt in $(seq 1 10); do
  if run_certification 1; then CERT_OK=1; break; fi
  echo "V1_CERT_RETRY=$attempt"
  sleep 5
done
[ "$CERT_OK" -eq 1 ] || die "strict live certification did not recover"
echo "V1_STRICT_LIVE_CERTIFICATION=PASS"

if [ "$PRESERVE_18752" -eq 1 ]; then
  ss -lnt | grep -qE ':18752\b'
  echo "PORT_18752_PRESERVED=PASS"
fi

disable_legacy_boot
systemctl daemon-reload || true
echo "LEGACY_BOOT_LINKS_DISABLED=PASS"

trap - ERR
CUTOVER_STARTED=0
cleanup_temp
trap - EXIT

echo "PSE_RC_V1_NEXUS_CUTOVER=PASS"
echo "IMAGE_ID=$IMAGE_ID"
echo "CONTAINER_RELAY=18750"
echo "CONTAINER_MCP=18751"
echo "RDC_USED=no"
