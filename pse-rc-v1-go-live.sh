#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

STAGE=init
fail(){ echo "PSE_RC_GO_LIVE=FAIL stage=${STAGE} reason=$*" >&2; exit 1; }
trap 'rc=$?; echo "PSE_RC_GO_LIVE=FAIL stage=${STAGE} line=${LINENO} exit=${rc}" >&2; exit ${rc}' ERR

[ "$(id -u)" -eq 0 ] || fail "run as root"

SHA=${PSE_RC_RELEASE_SHA:-}
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "PSE_RC_RELEASE_SHA must be an exact 40-character lowercase commit SHA"

NO_DNS=${PSE_RC_NO_DNS:-0}
if [ "$NO_DNS" = "1" ]; then
  PUBLIC_HOST=${PSE_RC_PUBLIC_HOST:-commander.74.208.216.118.sslip.io}
  AUTH_HOST=${PSE_RC_AUTH_HOST:-auth-rc.74.208.216.118.sslip.io}
else
  PUBLIC_HOST=${PSE_RC_PUBLIC_HOST:-commander.pilotsalesdistribution.com}
  AUTH_HOST=${PSE_RC_AUTH_HOST:-auth-rc.pilotsalesdistribution.com}
fi
PUBLIC_PORT=${PSE_RC_PUBLIC_PORT:-18753}
AUTH_PORT=${PSE_RC_AUTH_PORT:-9153}
EXPECTED_IP=${PSE_RC_EXPECTED_PUBLIC_IP:-74.208.216.118}
REPO_URL=${PSE_RC_REPO_URL:-https://github.com/cadengl-oss/PSE-MAIN-GITHUB-REPO.git}
BASE=${PSE_RC_BASE:-/opt/pse-remote-commander}
SOURCE_ROOT=${PSE_RC_SOURCE_ROOT:-$BASE/deploy-source/$SHA}
REPLACE_LEGACY=${PSE_RC_REPLACE_LEGACY_PUBLIC_EDGE:-0}
SKIP_DNS_IP_MATCH=${PSE_RC_SKIP_DNS_IP_MATCH:-0}

for cmd in git node npm curl docker caddy openssl systemctl ss getent awk sed tar; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
done

PRIVATE_GIT_TOKEN=${PSE_RC_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}
git_private(){
  if [ -n "$PRIVATE_GIT_TOKEN" ]; then
    git -c "http.extraheader=AUTHORIZATION: bearer $PRIVATE_GIT_TOKEN" "$@"
  else
    git "$@"
  fi
}

if ! git_private ls-remote "$REPO_URL" HEAD >/dev/null 2>&1; then
  fail "private GitHub repo access missing; authenticate Nexus once with GitHub CLI or pass PSE_RC_GITHUB_TOKEN"
fi

certify_core(){
  local cert="$BASE/current/deploy/v1/certify-live-core.sh"
  [ -x "$cert" ] || fail "missing V1 core certifier at $cert"
  "$cert"
}

backup_legacy_public_edge(){
  STAGE=legacy-backup
  local backup="/root/pse-rc-legacy-public-edge-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 "$backup"
  for path in     /etc/caddy/Caddyfile     /etc/caddy/pse-remote-commander-auth.caddy     /etc/caddy/pse-remote-commander-public.caddy     /etc/pse/remote-commander-mcp-public.env     /etc/pse/remote-commander-owner-map.json     /etc/pse/remote-commander-oauth-introspection-secret     /etc/pse/openai-apps-challenge     /etc/systemd/system/pse-remote-commander-mcp-public.service     /root/.pse-remote-commander-auth-credentials; do
    [ -e "$path" ] && cp -a "$path" "$backup/" || true
  done
  [ -d /opt/pse-remote-commander-auth ] && cp -a /opt/pse-remote-commander-auth "$backup/" || true
  echo "LEGACY_PUBLIC_EDGE_BACKUP=$backup"
}

cleanup_legacy_public_edge(){
  [ "$REPLACE_LEGACY" = "1" ] || fail "unmanaged legacy public edge detected; rerun with PSE_RC_REPLACE_LEGACY_PUBLIC_EDGE=1"
  STAGE=legacy-cleanup-precert
  certify_core
  backup_legacy_public_edge

  STAGE=legacy-cleanup
  systemctl disable --now pse-remote-commander-mcp-public.service >/dev/null 2>&1 || true

  if docker inspect pse-remote-commander-auth >/dev/null 2>&1; then
    local image
    image=$(docker inspect -f '{{.Config.Image}}' pse-remote-commander-auth 2>/dev/null || true)
    [[ "$image" == authelia/authelia:* ]] || fail "refusing to remove unexpected container image: ${image:-unknown}"
    docker rm -f pse-remote-commander-auth >/dev/null
  fi

  if [ -f /etc/caddy/Caddyfile ]; then
    sed -i '\|^[[:space:]]*import /etc/caddy/pse-remote-commander-auth\.caddy[[:space:]]*$|d' /etc/caddy/Caddyfile
    sed -i '\|^[[:space:]]*import /etc/caddy/pse-remote-commander-public\.caddy[[:space:]]*$|d' /etc/caddy/Caddyfile
  fi

  rm -f     /etc/caddy/pse-remote-commander-auth.caddy     /etc/caddy/pse-remote-commander-public.caddy     /etc/pse/remote-commander-mcp-public.env     /etc/pse/remote-commander-owner-map.json     /etc/pse/remote-commander-oauth-introspection-secret     /etc/pse/openai-apps-challenge     /etc/systemd/system/pse-remote-commander-mcp-public.service     /etc/pse/remote-commander-public-edge-owned.json     /root/.pse-remote-commander-auth-credentials
  rm -rf /opt/pse-remote-commander-auth

  systemctl daemon-reload
  if [ -f /etc/caddy/Caddyfile ]; then
    caddy validate --config /etc/caddy/Caddyfile
    caddy reload --config /etc/caddy/Caddyfile
  fi

  STAGE=legacy-cleanup-postcert
  certify_core
}

check_dns(){
  STAGE=dns
  local host ips
  for host in "$PUBLIC_HOST" "$AUTH_HOST"; do
    ips=$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '
' ' ' || true)
    if [ -z "$ips" ]; then
      echo "DNS_NEEDED: A $host -> $EXPECTED_IP" >&2
      return 20
    fi
    if [ "$SKIP_DNS_IP_MATCH" != "1" ] && ! grep -qw "$EXPECTED_IP" <<<"$ips"; then
      echo "DNS_MISMATCH: $host resolves to [$ips], expected $EXPECTED_IP" >&2
      echo "DNS_NEEDED: A $host -> $EXPECTED_IP" >&2
      return 21
    fi
  done
}

STAGE=source
if [ ! -d "$SOURCE_ROOT/.git" ]; then
  install -d -m 0755 "$(dirname "$SOURCE_ROOT")"
  git_private clone --filter=blob:none --no-checkout "$REPO_URL" "$SOURCE_ROOT"
fi
git_private -C "$SOURCE_ROOT" fetch --depth=1 origin "$SHA"
git_private -C "$SOURCE_ROOT" checkout --detach "$SHA"
[ "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" = "$SHA" ] || fail "checkout SHA mismatch"
git -C "$SOURCE_ROOT" diff --quiet
git -C "$SOURCE_ROOT" diff --cached --quiet
MODULE="$SOURCE_ROOT/pse-remote-commander"
[ -f "$MODULE/package.json" ] || fail "remote commander module missing"

STAGE=pre-core-cert
if [ -x "$BASE/current/deploy/v1/certify-live-core.sh" ]; then
  certify_core
fi

STAGE=stage-release
RELEASE="$BASE/releases/$SHA"
if [ ! -f "$RELEASE/.release-sha" ]; then
  "$MODULE/deploy/nexus/stage-release.sh" "$MODULE" "$SHA"
else
  [ "$(cat "$RELEASE/.release-sha")" = "$SHA" ] || fail "existing release marker mismatch"
  echo "STAGE_RELEASE=SKIP already_verified"
fi

STAGE=promote-release
if [ "$(readlink -f "$BASE/current" 2>/dev/null || true)" != "$RELEASE" ]; then
  "$MODULE/deploy/nexus/promote-release.sh" "$SHA"
else
  echo "PROMOTE_RELEASE=SKIP already_current"
fi

STAGE=retention-proof
curl -fsS http://127.0.0.1:18750/health | node -e '
let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{
  const x=JSON.parse(s);
  if(x.ok!==true||x.service!=="pse-remote-commander-relay"||x.retention?.arguments_ms!==3600000||x.retention?.calls_ms!==2592000000)process.exit(1);
  console.log("RELAY_RETENTION=PASS");
});'
certify_core

check_dns || exit $?

export PSE_RC_PUBLIC_HOST="$PUBLIC_HOST"
export PSE_RC_AUTH_HOST="$AUTH_HOST"
export PSE_RC_PUBLIC_PORT="$PUBLIC_PORT"
export PSE_RC_AUTH_PORT="$AUTH_PORT"
cd "$BASE/current"

STAGE=public-edge-check
set +e
CHECK_OUT=$(node deploy/v1/public-edge/bootstrap.mjs --check 2>&1)
CHECK_RC=$?
set -e
if [ "$CHECK_RC" -ne 0 ]; then
  if [ -f /etc/pse/remote-commander-public-edge-owned.json ]; then
    echo "$CHECK_OUT" >&2
    STAGE=managed-public-edge-rollback
    node deploy/v1/public-edge/bootstrap.mjs --rollback
    certify_core
  elif grep -Eq 'unmanaged public edge state|public edge configuration drift|managed public edge drift' <<<"$CHECK_OUT"; then
    echo "$CHECK_OUT" >&2
    cleanup_legacy_public_edge
  else
    echo "$CHECK_OUT" >&2
    fail "public-edge preflight failed"
  fi
  STAGE=public-edge-recheck
  node deploy/v1/public-edge/bootstrap.mjs --check
else
  printf '%s
' "$CHECK_OUT"
fi

STAGE=public-edge-install
node deploy/v1/public-edge/bootstrap.mjs --install
ss -lnt | grep -q ":${PUBLIC_PORT}\b" || fail "public MCP loopback $PUBLIC_PORT not listening"
ss -lnt | grep -q ":${AUTH_PORT}\b" || fail "OAuth loopback $AUTH_PORT not listening"

STAGE=public-edge-idempotency
node deploy/v1/public-edge/bootstrap.mjs --check | tee /tmp/pse-rc-public-edge-check.json
node -e '
const fs=require("fs"); const x=JSON.parse(fs.readFileSync("/tmp/pse-rc-public-edge-check.json","utf8"));
if(!Array.isArray(x.plan)||x.plan.length!==0)process.exit(1);
console.log("PUBLIC_EDGE_IDEMPOTENT=PASS");'

STAGE=public-tls
curl -fsS "https://$PUBLIC_HOST/health" | node -e '
let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const x=JSON.parse(s);if(x.ok!==true||x.service!=="pse-remote-commander-public-mcp")process.exit(1);console.log("PUBLIC_HEALTH=PASS");});'
curl -fsS "https://$PUBLIC_HOST/.well-known/oauth-protected-resource" >/dev/null
curl -fsS "https://$AUTH_HOST/.well-known/openid-configuration" >/dev/null
for path in support privacy terms docs; do curl -fsS "https://$PUBLIC_HOST/$path" >/dev/null; done
UNAUTH_MCP_401=$(curl -sS -o /tmp/pse-rc-unauth-mcp.json -w '%{http_code}' -X POST "https://$PUBLIC_HOST/mcp")
[ "$UNAUTH_MCP_401" = "401" ] || fail "unauthenticated MCP returned HTTP $UNAUTH_MCP_401 instead of 401"
echo "UNAUTH_MCP_401=PASS"

if [ "$NO_DNS" = "1" ]; then
  STAGE=no-dns-submission-skip
  echo "NO_DNS mode: production submission listing intentionally skipped for sslip.io staging edge"
else
  STAGE=submission-listing
  PSE_RC_PUBLIC_HOST="$PUBLIC_HOST" npm run submission:listing -- submission/plugin-listing.production.json
fi

echo "PSE_RC_RELEASE_SHA=$SHA"
echo "PSE_RC_PUBLIC_HOST=$PUBLIC_HOST"
echo "PSE_RC_AUTH_HOST=$AUTH_HOST"
echo "PSE_RC_OWNER_LOGIN=pseowner"
echo "PSE_RC_REVIEWER_LOGIN=openai-review"
echo "PSE_RC_AUTH_CREDENTIALS_FILE=/root/.pse-remote-commander-auth-credentials"
if [ "$NO_DNS" = "1" ]; then
  echo "PSE_RC_NO_DNS_EDGE_LIVE=PASS"
else
  echo "PSE_RC_PLUGIN_LISTING=$BASE/current/submission/plugin-listing.production.json"
fi
echo "PUBLIC_MCP=https://$PUBLIC_HOST/mcp"
echo "OAUTH_ISSUER=https://$AUTH_HOST"
echo "PSE_RC_PUBLIC_EDGE_LIVE=PASS"
