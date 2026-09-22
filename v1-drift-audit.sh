#!/usr/bin/env bash
set -euo pipefail

AUDIT_URL="https://raw.githubusercontent.com/cadengl-oss/pse-ipad-command-deck/ebacf2afa0762b85870348996478bba2deeddd94/v1-drift-audit.mjs"
AUDIT_BLOB_SHA="1132102d4e750cfb4628e1dda861bdc4b1b8b231"
LIVE_ROOT="/opt/pse-remote-commander/current"
NODE_IMAGE="node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9"

command -v docker >/dev/null || { echo "DRIFT_ERROR=docker unavailable"; exit 1; }
command -v curl >/dev/null || { echo "DRIFT_ERROR=curl unavailable"; exit 1; }
command -v python3 >/dev/null || { echo "DRIFT_ERROR=python3 unavailable"; exit 1; }

AUDIT_TMP=$(mktemp /tmp/pse-rc-v1-drift.XXXXXX.mjs)
trap 'rm -f "$AUDIT_TMP"' EXIT
curl -fsSL "$AUDIT_URL" -o "$AUDIT_TMP"

ACTUAL_BLOB_SHA=$(python3 - "$AUDIT_TMP" <<'PY'
import hashlib, sys
data=open(sys.argv[1],"rb").read()
print(hashlib.sha1(f"blob {len(data)}\0".encode()+data).hexdigest())
PY
)
[ "$ACTUAL_BLOB_SHA" = "$AUDIT_BLOB_SHA" ] || { echo "DRIFT_ERROR=audit integrity mismatch"; exit 1; }
echo "DRIFT_AUDITOR_INTEGRITY=PASS"

LIVE_OWNER=$(docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true   -v "$LIVE_ROOT:/live:ro"   "$NODE_IMAGE" node -e '
    const fs=require("node:fs");
    const s=fs.statSync("/live/package.json");
    process.stdout.write(String(s.uid)+":"+String(s.gid));
  ')
[[ "$LIVE_OWNER" =~ ^[0-9]+:[0-9]+$ ]] || { echo "DRIFT_ERROR=invalid live tree owner"; exit 1; }

docker run --rm -i   --read-only   --cap-drop ALL   --security-opt no-new-privileges:true   --user "$LIVE_OWNER"   -e PSE_RC_LIVE_ROOT=/live   -v "$LIVE_ROOT:/live:ro"   "$NODE_IMAGE" node --input-type=module - < "$AUDIT_TMP"

echo "V1_DRIFT_WRAPPER=PASS"
