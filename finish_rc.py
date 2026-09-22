#!/usr/bin/env python3
import json, os, pathlib, pwd, re, secrets, shutil, socket, stat, subprocess, sys, time, uuid

AUTH_HOST="auth-rc.74.208.216.118.sslip.io"
MCP_HOST="commander.74.208.216.118.sslip.io"
BASE_DOMAIN="74.208.216.118.sslip.io"
AUTH_PORT=9152
PUBLIC_PORT=18753
IMAGE="authelia/authelia:4.39.24"
CONTAINER="pse-remote-commander-auth"
AUTH_DIR=pathlib.Path("/opt/pse-remote-commander-auth")
CONFIG=AUTH_DIR/"configuration.yml"
USERS=AUTH_DIR/"users_database.yml"
MARKER=AUTH_DIR/".managed-by-pse-remote-commander"
CADDY=pathlib.Path("/etc/caddy/Caddyfile")
FRAGMENT=pathlib.Path("/etc/caddy/pse-remote-commander-nodns.caddy")
ENV=pathlib.Path("/etc/pse/remote-commander-mcp-public.env")
UNIT=pathlib.Path("/etc/systemd/system/pse-remote-commander-mcp-public.service")
OWNER_MAP=pathlib.Path("/etc/pse/remote-commander-owner-map.json")
INTRO_SECRET=pathlib.Path("/etc/pse/remote-commander-oauth-introspection-secret")
CHALLENGE=pathlib.Path("/etc/pse/openai-apps-challenge")
OWNER_LOGIN=pathlib.Path("/root/pse-remote-commander-owner-login.txt")
REVIEW_LOGIN=pathlib.Path("/root/pse-remote-commander-review-login.txt")
OAUTH_SECRET_COPY=pathlib.Path("/root/pse-remote-commander-oauth-client-secret.txt")
SUBJECTS=AUTH_DIR/"subjects.json"
PUB_MAIN=pathlib.Path("/opt/pse-remote-commander/current/apps/mcp-public/main.mjs")
INTERNAL_TOKEN=pathlib.Path("/etc/pse/remote-commander-internal-token")

def run(cmd, check=True, timeout=90):
    p=subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(cmd)}\n{(p.stderr or p.stdout)[-2000:]}")
    return p

def active(unit):
    return run(["systemctl","is-active","--quiet",unit],check=False).returncode==0

def port_open(port):
    s=socket.socket()
    s.settimeout(.4)
    try:
        return s.connect_ex(("127.0.0.1",port))==0
    finally:
        s.close()

def write(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data)
    os.chmod(path, mode)

def rand(n=64):
    return secrets.token_urlsafe(n)[:n]

def digest(kind, password):
    cmd=["docker","run","--rm",IMAGE,"authelia","crypto","hash","generate",kind,"--password",password,"--no-confirm"]
    if kind=="pbkdf2":
        cmd += ["--variant","sha512"]
    p=run(cmd)
    text=(p.stdout or "")+"\n"+(p.stderr or "")
    pat=r"(\$argon2(?:id|i|d)\$[^\s]+)" if kind=="argon2" else r"(\$pbkdf2-sha512\$[^\s]+)"
    m=re.search(pat,text)
    if not m:
        raise RuntimeError(f"could not parse {kind} digest")
    return m.group(1)

def wait_url(url, expect=None, timeout=100):
    end=time.time()+timeout
    last=""
    while time.time()<end:
        p=run(["curl","-fsS","--max-time","8",url],check=False,timeout=12)
        if p.returncode==0 and (expect is None or expect in p.stdout):
            return p.stdout
        last=(p.stderr or p.stdout)[-500:]
        time.sleep(2)
    raise RuntimeError(f"timeout waiting for {url}: {last}")

def status(url):
    p=run(["curl","-sS","-o","/dev/null","-w","%{http_code}","--max-time","10",url],check=False,timeout=15)
    return p.stdout.strip() if p.returncode==0 else "000"

def backup(path, stamp):
    if path.exists():
        dst=path.with_name(path.name+f".bak.{stamp}")
        shutil.copy2(path,dst)
        return dst
    return None

def restore(src,dst):
    if src and pathlib.Path(src).exists():
        shutil.copy2(src,dst)
    elif dst.exists():
        dst.unlink()

def main():
    print("=== PSE REMOTE COMMANDER NO-DNS FINISH ===")
    print("MODE=fail-closed")
    if os.geteuid()!=0:
        print("STOP_ROOT_REQUIRED"); return 1

    for binary in ["docker","caddy","curl","openssl","systemctl"]:
        if shutil.which(binary) is None:
            print("STOP_MISSING_BINARY="+binary); return 1

    # Freeze and prove the existing core before touching the additive edge.
    for unit in ["pse-remote-commander-relay.service","pse-remote-commander-mcp.service","pse-remote-commander-tunnel.service"]:
        if not active(unit):
            print("STOP_CORE_UNIT_DOWN="+unit); return 1
    for p in [18750,18751,18752]:
        if not port_open(p):
            print("STOP_CORE_PORT_DOWN="+str(p)); return 1
    if not PUB_MAIN.is_file() or not INTERNAL_TOKEN.is_file():
        print("STOP_RC19_PUBLIC_CODE_OR_TOKEN_MISSING"); return 1

    # Avoid clobbering unrelated services.
    if port_open(PUBLIC_PORT):
        print("STOP_PUBLIC_PORT_ALREADY_USED"); return 1
    if port_open(AUTH_PORT):
        print("STOP_AUTH_PORT_ALREADY_USED"); return 1
    exists=run(["docker","inspect",CONTAINER],check=False).returncode==0
    if exists and not MARKER.exists():
        print("STOP_AUTH_CONTAINER_NAME_CONFLICT"); return 1
    if exists:
        run(["docker","rm","-f",CONTAINER],check=False)

    try:
        svc=pwd.getpwnam("pse-remote-commander")
    except KeyError:
        print("STOP_SERVICE_USER_MISSING"); return 1

    stamp=time.strftime("%Y%m%dT%H%M%SZ",time.gmtime())
    caddy_bak=backup(CADDY,stamp)
    frag_bak=backup(FRAGMENT,stamp)
    env_bak=backup(ENV,stamp)
    unit_bak=backup(UNIT,stamp)
    map_bak=backup(OWNER_MAP,stamp)
    intro_bak=backup(INTRO_SECRET,stamp)
    challenge_bak=backup(CHALLENGE,stamp)
    changed_caddy=False
    started_auth=False
    started_public=False

    try:
        AUTH_DIR.mkdir(parents=True,exist_ok=True)
        os.chmod(AUTH_DIR,0o700)
        write(MARKER,"managed-by=pse-remote-commander\n",0o600)

        # Generate credentials once per bootstrap and store root-only.
        owner_pw=rand(48)
        review_pw=rand(48)
        oauth_secret=rand(72)
        session_secret=rand(72)
        storage_secret=rand(72)
        reset_secret=rand(72)
        hmac_secret=rand(72)
        owner_sub=str(uuid.uuid4())
        review_sub=str(uuid.uuid4())

        owner_hash=digest("argon2",owner_pw)
        review_hash=digest("argon2",review_pw)
        oauth_hash=digest("pbkdf2",oauth_secret)

        key=AUTH_DIR/"oidc-rsa.key"
        run(["openssl","genpkey","-algorithm","RSA","-pkeyopt","rsa_keygen_bits:2048","-out",str(key)])
        os.chmod(key,0o600)
        key_block="\n".join("          "+line for line in key.read_text().splitlines())

        config=f"""server:
  address: 'tcp://0.0.0.0:9091/'

log:
  level: 'info'

identity_validation:
  reset_password:
    jwt_secret: '{reset_secret}'

authentication_backend:
  file:
    path: '/config/users_database.yml'
    watch: false

access_control:
  default_policy: 'one_factor'

session:
  secret: '{session_secret}'
  cookies:
    - domain: '{BASE_DOMAIN}'
      authelia_url: 'https://{AUTH_HOST}'
      same_site: 'lax'
      inactivity: '10m'
      expiration: '1h'
      remember_me: '1d'

regulation:
  max_retries: 5
  find_time: '2m'
  ban_time: '10m'

storage:
  encryption_key: '{storage_secret}'
  local:
    path: '/config/db.sqlite3'

notifier:
  filesystem:
    filename: '/config/notification.txt'

identity_providers:
  oidc:
    hmac_secret: '{hmac_secret}'
    jwks:
      - algorithm: 'RS256'
        use: 'sig'
        key: |
{key_block}
    scopes:
      pse.read:
        claims: []
      pse.write:
        claims: []
      pse.execute:
        claims: []
      pse.admin:
        claims: []
    clients:
      - client_id: 'pse-remote-commander-chatgpt'
        client_name: 'PSE Remote Commander - ChatGPT'
        client_secret: '{oauth_hash}'
        public: false
        authorization_policy: 'one_factor'
        require_pkce: true
        pkce_challenge_method: 'S256'
        redirect_uris:
          - 'https://chatgpt.com/connector_platform_oauth_redirect'
        audience:
          - 'https://{MCP_HOST}'
        scopes:
          - 'openid'
          - 'profile'
          - 'email'
          - 'offline_access'
          - 'pse.read'
          - 'pse.write'
          - 'pse.execute'
          - 'pse.admin'
        response_types:
          - 'code'
        grant_types:
          - 'authorization_code'
          - 'refresh_token'
        access_token_signed_response_alg: 'none'
        userinfo_signed_response_alg: 'none'
        token_endpoint_auth_method: 'client_secret_basic'
        introspection_endpoint_auth_method: 'client_secret_basic'
"""
        users=f"""users:
  caden:
    disabled: false
    displayname: 'PSE Owner'
    password: '{owner_hash}'
    email: 'owner@pse.local'
    groups:
      - 'pse-owner'
  openai-review:
    disabled: false
    displayname: 'OpenAI Review Canary'
    password: '{review_hash}'
    email: 'review@pse.local'
    groups:
      - 'pse-review'
"""
        write(CONFIG,config,0o600)
        write(USERS,users,0o600)
        write(SUBJECTS,json.dumps({"caden":owner_sub,"openai-review":review_sub},indent=2)+"\n",0o600)

        # Validate before starting anything.
        p=run(["docker","run","--rm","-v",f"{AUTH_DIR}:/config:ro",IMAGE,"authelia","config","validate","--config","/config/configuration.yml"],check=False,timeout=90)
        if p.returncode!=0:
            raise RuntimeError("Authelia config validation failed: "+(p.stderr or p.stdout)[-1800:])

        run(["docker","run","-d","--name",CONTAINER,"--restart","unless-stopped",
             "--user","0:0","-p",f"127.0.0.1:{AUTH_PORT}:9091",
             "-v",f"{AUTH_DIR}:/config",IMAGE])
        started_auth=True
        wait_url(f"http://127.0.0.1:{AUTH_PORT}/api/health",timeout=60)

        # Pin deterministic OIDC subject IDs so the owner map is valid before first login.
        for username,sub in [("caden",owner_sub),("openai-review",review_sub)]:
            p=run(["docker","exec",CONTAINER,"authelia","storage","user","identifiers","add",username,
                   "--identifier",sub,"--config","/config/configuration.yml"],check=False,timeout=60)
            if p.returncode!=0 and "already" not in ((p.stderr or "")+(p.stdout or "")).lower():
                raise RuntimeError(f"failed to provision OIDC subject for {username}: "+(p.stderr or p.stdout)[-1000:])

        # Dedicated Caddy fragment. No existing site blocks are edited.
        fragment=f"""{AUTH_HOST} {{
  encode zstd gzip
  reverse_proxy 127.0.0.1:{AUTH_PORT}
  header {{
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
  }}
}}

{MCP_HOST} {{
  encode zstd gzip

  handle /about {{
    respond "PSE Remote Commander - authenticated remote computer control for PSE-linked devices through ChatGPT." 200
  }}
  handle /support {{
    respond "PSE Remote Commander support: support is provided by Pilot Sales Enterprise through the account that provisioned this plugin." 200
  }}
  handle /privacy {{
    respond "PSE Remote Commander privacy: authenticated tool requests are processed only to operate devices explicitly linked to the authenticated PSE owner. Authentication secrets are not returned by tools. Operational call records may be retained for security, auditing, and troubleshooting." 200
  }}
  handle /terms {{
    respond "PSE Remote Commander terms: use is limited to computers and accounts you are authorized to control. Users are responsible for requested commands and credential security. Access may be suspended for misuse or unauthorized access." 200
  }}
  handle {{
    reverse_proxy 127.0.0.1:{PUBLIC_PORT}
  }}

  header {{
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
  }}
}}
"""
        write(FRAGMENT,fragment,0o644)

        main_text=CADDY.read_text()
        import_line="import /etc/caddy/pse-remote-commander-nodns.caddy"
        if import_line not in main_text:
            with CADDY.open("a") as fh:
                fh.write("\n# PSE Remote Commander no-DNS production edge\n"+import_line+"\n")
            changed_caddy=True

        p=run(["caddy","validate","--config",str(CADDY)],check=False)
        if p.returncode!=0:
            raise RuntimeError("Caddy validation failed: "+(p.stderr or p.stdout)[-1800:])

        # Public edge configuration with exact, pre-provisioned subjects.
        owner_map={
          owner_sub:{"ownerId":"caden","profile":{"id":"prf_pse_owner","nickname":"PSE owner"}},
          review_sub:{"ownerId":"openai-review-canary","profile":{"id":"prf_openai_review","nickname":"OpenAI review canary"}}
        }
        env=f"""PSE_RC_PUBLIC_MCP_HOST=127.0.0.1
PSE_RC_PUBLIC_MCP_PORT={PUBLIC_PORT}
PSE_RC_PUBLIC_RESOURCE=https://{MCP_HOST}
PSE_RC_OAUTH_ISSUER=https://{AUTH_HOST}
PSE_RC_OAUTH_INTROSPECTION_URL=https://{AUTH_HOST}/api/oidc/introspection
PSE_RC_OAUTH_EXPECTED_AUDIENCE=https://{MCP_HOST}
PSE_RC_OAUTH_INTROSPECTION_CLIENT_ID=pse-remote-commander-chatgpt
PSE_RC_OAUTH_INTROSPECTION_CLIENT_SECRET_FILE={INTRO_SECRET}
PSE_RC_PUBLIC_OWNER_MAP_FILE={OWNER_MAP}
PSE_RC_OPENAI_APPS_CHALLENGE_FILE={CHALLENGE}
PSE_RC_RESOURCE_DOCUMENTATION_URL=https://{MCP_HOST}/about
PSE_RC_RELAY_BASE_URL=http://127.0.0.1:18750
PSE_RC_INTERNAL_TOKEN_FILE={INTERNAL_TOKEN}
"""
        write(ENV,env,0o600)
        write(OWNER_MAP,json.dumps(owner_map,indent=2)+"\n",0o600)
        write(INTRO_SECRET,oauth_secret+"\n",0o600)
        write(CHALLENGE,"PENDING_OPENAI_DOMAIN_CHALLENGE\n",0o600)
        for pth in [ENV,OWNER_MAP,INTRO_SECRET,CHALLENGE]:
            os.chown(pth,svc.pw_uid,svc.pw_gid)
            os.chmod(pth,0o600)

        unit="""[Unit]
Description=PSE Remote Commander Public MCP Edge (No-DNS)
After=network-online.target pse-remote-commander-relay.service
Wants=network-online.target

[Service]
Type=simple
User=pse-remote-commander
Group=pse-remote-commander
EnvironmentFile=/etc/pse/remote-commander-mcp-public.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/opt/pse-remote-commander/current
ExecStart=/usr/bin/env node /opt/pse-remote-commander/current/apps/mcp-public/main.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UMask=0077

[Install]
WantedBy=multi-user.target
"""
        write(UNIT,unit,0o644)
        run(["systemctl","daemon-reload"])
        run(["systemctl","enable","--now","pse-remote-commander-mcp-public.service"])
        started_public=True
        wait_url(f"http://127.0.0.1:{PUBLIC_PORT}/health","pse-remote-commander-public-mcp",60)

        # Only reload Caddy after both backends are healthy.
        run(["caddy","reload","--config",str(CADDY)])
        discovery=wait_url(f"https://{AUTH_HOST}/.well-known/openid-configuration",timeout=120)
        d=json.loads(discovery)
        if "S256" not in d.get("code_challenge_methods_supported",[]):
            raise RuntimeError("OAuth discovery does not advertise S256")
        if not d.get("introspection_endpoint"):
            raise RuntimeError("OAuth discovery lacks introspection endpoint")
        if d.get("issuer","").rstrip("/") != f"https://{AUTH_HOST}":
            raise RuntimeError("OAuth issuer mismatch: "+str(d.get("issuer")))

        wait_url(f"https://{MCP_HOST}/health","pse-remote-commander-public-mcp",120)
        meta=wait_url(f"https://{MCP_HOST}/.well-known/oauth-protected-resource",timeout=30)
        if f"https://{AUTH_HOST}" not in meta:
            raise RuntimeError("protected resource metadata does not advertise dedicated issuer")
        if status(f"https://{MCP_HOST}/mcp")!="401":
            raise RuntimeError("unauthenticated /mcp did not return 401")
        for path in ["/about","/support","/privacy","/terms"]:
            if status(f"https://{MCP_HOST}{path}")!="200":
                raise RuntimeError(f"listing page failed: {path}")

        # Store credentials root-only; do not print secrets into chat logs.
        write(OWNER_LOGIN,f"username=caden\npassword={owner_pw}\nissuer=https://{AUTH_HOST}\n",0o600)
        write(REVIEW_LOGIN,f"username=openai-review\npassword={review_pw}\nissuer=https://{AUTH_HOST}\n",0o600)
        write(OAUTH_SECRET_COPY,f"client_id=pse-remote-commander-chatgpt\nclient_secret={oauth_secret}\n",0o600)

        # Re-prove frozen core after additive deployment.
        for unit_name in ["pse-remote-commander-relay.service","pse-remote-commander-mcp.service","pse-remote-commander-tunnel.service"]:
            if not active(unit_name):
                raise RuntimeError("frozen core unit changed state: "+unit_name)
        for p in [18750,18751,18752,18753,9152]:
            if not port_open(p):
                raise RuntimeError("expected listener missing after deploy: "+str(p))

        print("NO_DNS_BOOTSTRAP=PASS")
        print("PUBLIC_MCP=https://"+MCP_HOST+"/mcp")
        print("OAUTH_ISSUER=https://"+AUTH_HOST)
        print("OAUTH_CLIENT_ID=pse-remote-commander-chatgpt")
        print("OWNER_LOGIN_FILE="+str(OWNER_LOGIN))
        print("REVIEW_LOGIN_FILE="+str(REVIEW_LOGIN))
        print("OAUTH_CLIENT_SECRET_FILE="+str(OAUTH_SECRET_COPY))
        print("OPENAI_CHALLENGE=READY_FOR_PORTAL_TOKEN")
        print("CORE_18750=UNCHANGED")
        print("CORE_18751=UNCHANGED")
        print("TUNNEL_18752=UNCHANGED")
        print("RDC_USED=no")
        return 0

    except Exception as e:
        print("FAIL="+str(e).replace("\n"," | ")[:2200])
        # Fail closed: stop only components created by this script, restore config.
        if started_public:
            run(["systemctl","disable","--now","pse-remote-commander-mcp-public.service"],check=False)
        if started_auth:
            run(["docker","rm","-f",CONTAINER],check=False)
        restore(unit_bak,UNIT); restore(env_bak,ENV); restore(map_bak,OWNER_MAP)
        restore(intro_bak,INTRO_SECRET); restore(challenge_bak,CHALLENGE)
        restore(frag_bak,FRAGMENT); restore(caddy_bak,CADDY)
        run(["systemctl","daemon-reload"],check=False)
        run(["caddy","reload","--config",str(CADDY)],check=False)
        print("ROLLBACK=COMPLETE")
        print("CORE_18750_18751_18752=NOT_TOUCHED")
        return 1

if __name__=="__main__":
    raise SystemExit(main())
