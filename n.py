#!/usr/bin/env python3
import hashlib, json, os, re, secrets, shutil, stat, subprocess, sys, time, urllib.request
from pathlib import Path

AUTH_HOST="auth-rc.74.208.216.118.sslip.io"
MCP_HOST="commander.74.208.216.118.sslip.io"
AUTH_PORT=9153
MCP_PORT=18753
IMAGE="authelia/authelia:4.39.24"
RC=Path("/opt/pse-remote-commander/current")
AUTH_ROOT=Path("/opt/pse-remote-commander-auth")
CFG=AUTH_ROOT/"config"
SECRETS=CFG/"secrets"
CADDY=Path("/etc/caddy/Caddyfile")
AUTH_CADDY=Path("/etc/caddy/pse-remote-commander-auth.caddy")
MCP_CADDY=Path("/etc/caddy/pse-remote-commander.caddy")
UNIT=Path("/etc/systemd/system/pse-remote-commander-mcp-public.service")
ENV=Path("/etc/pse/remote-commander-mcp-public.env")
OWNER_MAP=Path("/etc/pse/remote-commander-owner-map.json")
INT_SECRET=Path("/etc/pse/remote-commander-oauth-introspection-secret")
CREDS=Path("/root/.pse-remote-commander-auth-credentials")
STAMP=time.strftime("%Y%m%dT%H%M%SZ",time.gmtime())
BACKUP=Path("/root")/f"pse-rc-no-dns-backup-{STAMP}"

STAGE_COMMIT="1078ea4ec38cdf8e9c1b795639ea7e5bb6f87b9e"
STAGED_FILES={
  "rc_public_main.mjs":("332a57b6abcaf282e8a6f47531d521acfcb72232",RC/"apps/mcp-public/main.mjs"),
  "rc_public_plugin.mjs":("32f9eacbbd85ff417d034ba0027beabb1ca07c9d",RC/"packages/mcp-facade/src/public-plugin.mjs"),
  "rc_public_edge_test.mjs":("046884df030957fa87d99f5f497e7f3c87f710e4",RC/"packages/mcp-facade/test/public-edge.test.mjs"),
  "rc_mcp_facade_test.mjs":("19beebec2f9c3085f97536140d34ee8dae16efc6",RC/"packages/mcp-facade/test/mcp-facade.test.mjs"),
  "rc_server.mjs":("53859f40e0cc9a30ac64850e86ec28aba5d34ec1",RC/"packages/mcp-facade/src/server.mjs"),
}

def run(args, check=True, capture=True, timeout=60):
    p=subprocess.run(args, text=True, capture_output=capture, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(f"command failed: {args[0]} rc={p.returncode} err={(p.stderr or '')[:500]}")
    return p

def out(args, timeout=60):
    return run(args, True, True, timeout).stdout.strip()

def active(unit):
    return run(["systemctl","is-active","--quiet",unit],False).returncode==0

def listen(port):
    p=run(["ss","-lnt"],True,True)
    return re.search(rf":{port}\b",p.stdout) is not None

def write(path,data,mode=0o600):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(data)
    os.chmod(path,mode)

def docker_hash(kind,password):
    args=["docker","run","--rm",IMAGE,"authelia","crypto","hash","generate",kind]
    if kind=="pbkdf2": args += ["--variant","sha512"]
    args += ["--password",password]
    text=out(args,120)
    m=re.search(r"Digest:\s*(\S+)",text)
    if not m: raise RuntimeError(f"unable to parse {kind} digest")
    return m.group(1)

def git_blob_sha(data):
    header=f"blob {len(data)}\0".encode()
    return hashlib.sha1(header+data).hexdigest()

def fetch_staged(name, expected_sha, destination):
    url=f"https://raw.githubusercontent.com/cadengl-oss/pse-ipad-command-deck/{STAGE_COMMIT}/{name}"
    with urllib.request.urlopen(url,timeout=20) as response:
        data=response.read()
    actual=git_blob_sha(data)
    if actual != expected_sha:
        raise RuntimeError(f"staged source hash mismatch for {name}: {actual}")
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_bytes(data)
    os.chmod(destination,0o644)
    print(f"STAGED_{name}=PASS")

def rollback():
    print("ROLLBACK=START")
    run(["systemctl","stop","pse-remote-commander-mcp-public.service"],False)
    run(["docker","rm","-f","pse-remote-commander-auth"],False)
    if (BACKUP/"Caddyfile").exists(): shutil.copy2(BACKUP/"Caddyfile",CADDY)
    for src,dst in [
        (BACKUP/"pse-remote-commander-auth.caddy",AUTH_CADDY),
        (BACKUP/"pse-remote-commander.caddy",MCP_CADDY),
        (BACKUP/"pse-remote-commander-mcp-public.service",UNIT),
        (BACKUP/"remote-commander-mcp-public.env",ENV),
        (BACKUP/"remote-commander-owner-map.json",OWNER_MAP),
        (BACKUP/"remote-commander-oauth-introspection-secret",INT_SECRET),
        (BACKUP/"main.mjs",RC/"apps/mcp-public/main.mjs"),
        (BACKUP/"public-plugin.mjs",RC/"packages/mcp-facade/src/public-plugin.mjs"),
        (BACKUP/"public-edge.test.mjs",RC/"packages/mcp-facade/test/public-edge.test.mjs"),
        (BACKUP/"mcp-facade.test.mjs",RC/"packages/mcp-facade/test/mcp-facade.test.mjs"),
        (BACKUP/"server.mjs",RC/"packages/mcp-facade/src/server.mjs"),
    ]:
        if src.exists():
            shutil.copy2(src,dst)
        elif dst.exists() and (BACKUP/(dst.name+".absent")).exists():
            dst.unlink()
    run(["systemctl","daemon-reload"],False)
    run(["caddy","reload","--config",str(CADDY)],False)
    print("ROLLBACK=COMPLETE")

try:
    print("=== PSE REMOTE COMMANDER NO-DNS BOOTSTRAP ===")
    if os.geteuid()!=0: raise RuntimeError("must run as root")
    for cmd in ["docker","caddy","systemctl","ss","curl","openssl","node"]:
        if not shutil.which(cmd): raise RuntimeError(f"missing command: {cmd}")
    if not active("pse-remote-commander-relay.service"): raise RuntimeError("relay service inactive")
    if not active("pse-remote-commander-mcp.service"): raise RuntimeError("private MCP service inactive")
    for p in [18750,18751,18752]:
        if not listen(p): raise RuntimeError(f"required core port {p} not listening")
    for p in [AUTH_PORT,MCP_PORT]:
        if listen(p): raise RuntimeError(f"new port {p} already in use")
    if run(["docker","inspect","pse-remote-commander-auth"],False).returncode==0:
        raise RuntimeError("pse-remote-commander-auth container already exists")
    main=RC/"apps/mcp-public/main.mjs"
    public_plugin=RC/"packages/mcp-facade/src/public-plugin.mjs"
    public_edge_test=RC/"packages/mcp-facade/test/public-edge.test.mjs"
    facade_test=RC/"packages/mcp-facade/test/mcp-facade.test.mjs"
    if not (RC/"apps/relay/main.mjs").exists(): raise RuntimeError("Remote Commander release tree incomplete")
    facade_server=RC/"packages/mcp-facade/src/server.mjs"
    if not facade_server.exists(): raise RuntimeError("Remote Commander MCP facade source missing")
    if not CADDY.exists(): raise RuntimeError("active Caddyfile missing")
    run(["caddy","validate","--config",str(CADDY)])

    BACKUP.mkdir(mode=0o700)
    for src,name in [
        (CADDY,"Caddyfile"),(AUTH_CADDY,"pse-remote-commander-auth.caddy"),
        (MCP_CADDY,"pse-remote-commander.caddy"),(UNIT,"pse-remote-commander-mcp-public.service"),
        (ENV,"remote-commander-mcp-public.env"),(OWNER_MAP,"remote-commander-owner-map.json"),
        (INT_SECRET,"remote-commander-oauth-introspection-secret"),(main,"main.mjs"),
        (public_plugin,"public-plugin.mjs"),(public_edge_test,"public-edge.test.mjs"),
        (facade_test,"mcp-facade.test.mjs"),
        (RC/"packages/mcp-facade/src/server.mjs","server.mjs")
    ]:
        if src.exists(): shutil.copy2(src,BACKUP/name)
        else: (BACKUP/(name+".absent")).touch()

    # The live RC19 core predates PR #11. Stage the exact audited public-edge
    # files from a pinned public commit, verifying Git blob identity first.
    for staged_name,(expected_sha,destination) in STAGED_FILES.items():
        fetch_staged(staged_name,expected_sha,destination)
    run(["node","--check",str(main)])
    run(["node","--check",str(public_plugin)])
    print("PUBLIC_EDGE_SOURCE_STAGE=PASS")

    # Patch only the RC19 owner-routing block, fail closed on unexpected source.
    src=main.read_text()
    if 'const exact=config.ownerMap.get(data.sub);' not in src:
        old='''  const mapping=config.ownerMap.get(data.sub);
  if (!mapping) throw new Error("authenticated profile is not provisioned for PSE Remote Commander");
  const scopes=new Set('''
        new='''  const exact=config.ownerMap.get(data.sub);
  const wildcard=config.ownerMap.get("*");
  const mapping=exact??wildcard;
  if (!mapping) throw new Error("authenticated profile is not provisioned for PSE Remote Commander");
  const effectiveProfile={
    ...mapping.profile,
    id:exact?mapping.profile.id:data.sub
  };
  const scopes=new Set('''
        if old not in src: raise RuntimeError("unexpected RC19 token-routing source; refusing patch")
        src=src.replace(old,new,1)
        oldret='return {subject:data.sub,ownerId:mapping.ownerId,profile:mapping.profile,scopes};'
        if oldret not in src: raise RuntimeError("unexpected RC19 identity return; refusing patch")
        src=src.replace(oldret,'return {subject:data.sub,ownerId:mapping.ownerId,profile:effectiveProfile,scopes};',1)
        tmp=BACKUP/"main.candidate.mjs"
        tmp.write_text(src)
        run(["node","--check",str(tmp)])
        shutil.copy2(tmp,main)
        print("LIVE_PUBLIC_MCP_PATCH=APPLIED")
    else:
        print("LIVE_PUBLIC_MCP_PATCH=ALREADY_PRESENT")

    # Ensure ChatGPT receives the standard top-level OAuth securitySchemes field
    # as well as the _meta compatibility mirror.
    facade=facade_server.read_text()
    oauth_old='''    const meta=publicMode?publicToolMeta(spec.name):undefined;
    if (meta) descriptor._meta=meta;'''
    oauth_new='''    const meta=publicMode?publicToolMeta(spec.name):undefined;
    if (meta) {
      descriptor.securitySchemes=meta.securitySchemes;
      descriptor._meta=meta;
    }'''
    if oauth_new not in facade:
        if oauth_old not in facade:
            raise RuntimeError("unexpected MCP facade OAuth descriptor source; refusing patch")
        facade=facade.replace(oauth_old,oauth_new,1)
        tmp_facade=BACKUP/"server.candidate.mjs"
        tmp_facade.write_text(facade)
        run(["node","--check",str(tmp_facade)])
        shutil.copy2(tmp_facade,facade_server)
        print("LIVE_OAUTH_DESCRIPTOR_PATCH=APPLIED")
    else:
        print("LIVE_OAUTH_DESCRIPTOR_PATCH=ALREADY_PRESENT")

    # Exercise the installed RC19 facade/public-edge tests against the patched
    # source before introducing any new listeners or Caddy routes.
    run([
      "node","--test",
      str(RC/"packages/mcp-facade/test/mcp-facade.test.mjs"),
      str(RC/"packages/mcp-facade/test/public-edge.test.mjs")
    ],True,True,180)
    print("RC19_PUBLIC_TESTS=PASS")

    AUTH_ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    CFG.mkdir(mode=0o700,parents=True,exist_ok=True)
    SECRETS.mkdir(mode=0o700,parents=True,exist_ok=True)

    owner_pw=secrets.token_hex(24)
    reviewer_pw=secrets.token_hex(20)
    introspection_secret=secrets.token_hex(32)
    owner_hash=docker_hash("argon2",owner_pw)
    reviewer_hash=docker_hash("argon2",reviewer_pw)
    introspection_hash=docker_hash("pbkdf2",introspection_secret)

    for name in ["session_secret","storage_encryption_key","oidc_hmac_secret"]:
        write(SECRETS/name,secrets.token_hex(48)+"\n")
    key=out(["openssl","genpkey","-algorithm","RSA","-pkeyopt","rsa_keygen_bits:2048"],120)
    write(SECRETS/"oidc_jwk.pem",key+"\n")
    key_yaml="\n".join("          "+line for line in key.splitlines())

    users=f"""users:
  pseowner:
    disabled: false
    displayname: 'PSE Owner'
    password: '{owner_hash}'
    email: 'pseowner@localhost.invalid'
    groups: ['pse-owner']
  openai-review:
    disabled: false
    displayname: 'OpenAI Review Canary'
    password: '{reviewer_hash}'
    email: 'openai-review@localhost.invalid'
    groups: ['openai-review']
"""
    write(CFG/"users.yml",users)

    config=f"""server:
  address: 'tcp4://0.0.0.0:9091'

log:
  level: 'info'

totp:
  disable: true

authentication_backend:
  password_reset:
    disable: true
  file:
    path: '/config/users.yml'
    watch: false

access_control:
  default_policy: 'one_factor'

session:
  name: 'pse_rc_session'
  cookies:
    - domain: '{AUTH_HOST}'
      authelia_url: 'https://{AUTH_HOST}'

regulation:
  max_retries: 5
  find_time: '2 minutes'
  ban_time: '10 minutes'

storage:
  local:
    path: '/config/db.sqlite3'

notifier:
  filesystem:
    filename: '/config/notification.txt'

identity_providers:
  oidc:
    enforce_pkce: 'public_clients_only'
    jwks:
      - key: |
{key_yaml}
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
        public: true
        authorization_policy: 'one_factor'
        require_pkce: true
        pkce_challenge_method: 'S256'
        redirect_uris:
          - 'https://chatgpt.com/connector_platform_oauth_redirect'
        audience:
          - 'https://{MCP_HOST}'
        requested_audience_mode: 'explicit'
        scopes:
          - 'openid'
          - 'profile'
          - 'email'
          - 'offline_access'
          - 'pse.read'
          - 'pse.write'
          - 'pse.execute'
          - 'pse.admin'
        response_types: ['code']
        grant_types: ['authorization_code','refresh_token']
        token_endpoint_auth_method: 'none'
      - client_id: 'pse-remote-commander-introspector'
        client_name: 'PSE Remote Commander - Resource Server'
        client_secret: '{introspection_hash}'
        public: false
        authorization_policy: 'one_factor'
        audience:
          - 'https://{MCP_HOST}'
        requested_audience_mode: 'explicit'
        scopes:
          - 'pse.read'
          - 'pse.write'
          - 'pse.execute'
          - 'pse.admin'
        grant_types: ['client_credentials']
        token_endpoint_auth_method: 'client_secret_basic'
        introspection_endpoint_auth_method: 'client_secret_basic'
"""
    write(CFG/"configuration.yml",config)

    os.chown(AUTH_ROOT,8000,8000)
    for root,dirs,files in os.walk(AUTH_ROOT):
        os.chown(root,8000,8000)
        os.chmod(root,0o700)
        for fn in files:
            p=Path(root)/fn
            os.chown(p,8000,8000)
            os.chmod(p,0o600)

    # Validate the exact generated Authelia configuration before changing
    # Caddy or starting a persistent container.
    validate=run([
      "docker","run","--rm","--user","8000:8000",
      "-v",f"{CFG}:/config:ro",
      "-e","AUTHELIA_SESSION_SECRET_FILE=/config/secrets/session_secret",
      "-e","AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE=/config/secrets/storage_encryption_key",
      "-e","AUTHELIA_IDENTITY_PROVIDERS_OIDC_HMAC_SECRET_FILE=/config/secrets/oidc_hmac_secret",
      IMAGE,"authelia","config","validate","--config","/config/configuration.yml"
    ],False,True,120)
    if validate.returncode != 0:
        raise RuntimeError("Authelia config validation failed: "+(validate.stderr or validate.stdout)[:1000])
    print("AUTHELIA_CONFIG_VALIDATE=PASS")

    auth_caddy=f"""{AUTH_HOST} {{
  encode zstd gzip
  reverse_proxy 127.0.0.1:{AUTH_PORT}
  header {{
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
  }}
}}
"""
    mcp_caddy=f"""{MCP_HOST} {{
  encode zstd gzip
  handle / {{
    header Content-Type "text/html; charset=utf-8"
    respond "<!doctype html><title>PSE Remote Commander</title><h1>PSE Remote Commander</h1><p>Authenticated remote computer control for PSE-linked devices through ChatGPT.</p>" 200
  }}
  handle /support {{
    header Content-Type "text/html; charset=utf-8"
    respond "<!doctype html><title>Support</title><h1>PSE Remote Commander Support</h1><p>Contact the PSE administrator who provisioned your account.</p>" 200
  }}
  handle /privacy {{
    header Content-Type "text/html; charset=utf-8"
    respond "<!doctype html><title>Privacy</title><h1>PSE Remote Commander Privacy</h1><p>Processes authenticated MCP requests, device routing metadata, and security audit records. Credentials are not intentionally logged.</p>" 200
  }}
  handle /terms {{
    header Content-Type "text/html; charset=utf-8"
    respond "<!doctype html><title>Terms</title><h1>PSE Remote Commander Terms</h1><p>Use is limited to computers and accounts you are authorized to control.</p>" 200
  }}
  handle /docs {{
    header Content-Type "text/html; charset=utf-8"
    respond "<!doctype html><title>Docs</title><h1>PSE Remote Commander Documentation</h1><p>Authenticate through ChatGPT, then use the MCP tools available to your owner-scoped PSE account.</p>" 200
  }}
  handle {{
    reverse_proxy 127.0.0.1:{MCP_PORT}
  }}
  header {{
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
  }}
}}
"""
    write(AUTH_CADDY,auth_caddy,0o644)
    write(MCP_CADDY,mcp_caddy,0o644)
    caddy_text=CADDY.read_text()
    for frag,label in [(AUTH_CADDY,"PSE Remote Commander dedicated OAuth"),(MCP_CADDY,"PSE Remote Commander public MCP")]:
        line=f"import {frag}"
        if line not in caddy_text:
            caddy_text += f"\n# {label}\n{line}\n"
    write(CADDY,caddy_text,0o644)
    run(["caddy","validate","--config",str(CADDY)])

    # Launch isolated Authelia with file-backed secrets.
    run([
      "docker","run","-d","--name","pse-remote-commander-auth","--restart","unless-stopped",
      "--user","8000:8000",
      "-p",f"127.0.0.1:{AUTH_PORT}:9091",
      "-v",f"{CFG}:/config",
      "-e","AUTHELIA_SESSION_SECRET_FILE=/config/secrets/session_secret",
      "-e","AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE=/config/secrets/storage_encryption_key",
      "-e","AUTHELIA_IDENTITY_PROVIDERS_OIDC_HMAC_SECRET_FILE=/config/secrets/oidc_hmac_secret",
      IMAGE
    ],True,True,120)

    run(["caddy","reload","--config",str(CADDY)])
    for _ in range(30):
        p=run(["curl","-fsS","--max-time","3",f"https://{AUTH_HOST}/.well-known/openid-configuration"],False)
        if p.returncode==0: break
        time.sleep(2)
    else: raise RuntimeError("dedicated OAuth discovery never became reachable")

    meta=json.loads(out(["curl","-fsS",f"https://{AUTH_HOST}/.well-known/openid-configuration"],20))
    if meta.get("issuer")!=f"https://{AUTH_HOST}": raise RuntimeError("OAuth issuer mismatch")
    if meta.get("introspection_endpoint")!=f"https://{AUTH_HOST}/api/oidc/introspection": raise RuntimeError("OAuth introspection endpoint mismatch")
    if "S256" not in meta.get("code_challenge_methods_supported",[]): raise RuntimeError("OAuth S256 PKCE missing")
    if meta.get("authorization_response_iss_parameter_supported") is not True:
        raise RuntimeError("OAuth issuer identification missing; stable ChatGPT callback unsafe")

    # Public MCP configuration.
    svc_user=out(["id","-un","pse-remote-commander"])
    svc_uid=int(out(["id","-u","pse-remote-commander"]))
    svc_gid=int(out(["id","-g","pse-remote-commander"]))
    write(INT_SECRET,introspection_secret+"\n")
    write(OWNER_MAP,json.dumps({
      "*":{"ownerId":"openai-review-canary","profile":{"id":"prf_openai_review","nickname":"OpenAI review canary"}}
    },indent=2)+"\n")
    for p in [INT_SECRET,OWNER_MAP]:
        os.chown(p,svc_uid,svc_gid); os.chmod(p,0o600)

    env=f"""PSE_RC_PUBLIC_MCP_HOST=127.0.0.1
PSE_RC_PUBLIC_MCP_PORT={MCP_PORT}
PSE_RC_PUBLIC_RESOURCE=https://{MCP_HOST}
PSE_RC_OAUTH_ISSUER=https://{AUTH_HOST}
PSE_RC_OAUTH_INTROSPECTION_URL=https://{AUTH_HOST}/api/oidc/introspection
PSE_RC_OAUTH_EXPECTED_AUDIENCE=https://{MCP_HOST}
PSE_RC_OAUTH_INTROSPECTION_CLIENT_ID=pse-remote-commander-introspector
PSE_RC_OAUTH_INTROSPECTION_CLIENT_SECRET_FILE={INT_SECRET}
PSE_RC_PUBLIC_OWNER_MAP_FILE={OWNER_MAP}
PSE_RC_RESOURCE_DOCUMENTATION_URL=https://{MCP_HOST}/docs
PSE_RC_RELAY_BASE_URL=http://127.0.0.1:18750
PSE_RC_INTERNAL_TOKEN_FILE=/etc/pse/remote-commander-internal-token
"""
    write(ENV,env,0o640)

    unit=f"""[Unit]
Description=PSE Remote Commander Public MCP Edge
After=network-online.target pse-remote-commander-relay.service
Wants=network-online.target

[Service]
Type=simple
User=pse-remote-commander
Group=pse-remote-commander
EnvironmentFile={ENV}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
WorkingDirectory={RC}
ExecStart=/usr/bin/env node {RC}/apps/mcp-public/main.mjs
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
    run(["node","--check",str(main)])
    run(["systemctl","enable","--now","pse-remote-commander-mcp-public.service"])
    for _ in range(15):
        if active("pse-remote-commander-mcp-public.service") and listen(MCP_PORT): break
        time.sleep(1)
    else: raise RuntimeError("public MCP did not become active")
    run(["caddy","reload","--config",str(CADDY)])

    # Acceptance gauntlet.
    checks=[
      ("AUTH_DISCOVERY",["curl","-fsS",f"https://{AUTH_HOST}/.well-known/openid-configuration"]),
      ("PUBLIC_HEALTH",["curl","-fsS",f"https://{MCP_HOST}/health"]),
      ("PROTECTED_RESOURCE",["curl","-fsS",f"https://{MCP_HOST}/.well-known/oauth-protected-resource"]),
      ("PRIVACY",["curl","-fsS",f"https://{MCP_HOST}/privacy"]),
      ("TERMS",["curl","-fsS",f"https://{MCP_HOST}/terms"])
    ]
    for name,args in checks:
        run(args,True,True,20); print(name+"=PASS")
    status=out(["curl","-sS","-o","/dev/null","-w","%{http_code}",f"https://{MCP_HOST}/mcp"],20)
    if status!="401": raise RuntimeError(f"unauthenticated MCP expected 401 got {status}")
    print("UNAUTH_MCP_401=PASS")
    for p in [18750,18751,18752,18753,9153]:
        if not listen(p): raise RuntimeError(f"listener {p} missing after deploy")
        print(f"PORT_{p}=PASS")
    for u in ["pse-remote-commander-relay.service","pse-remote-commander-mcp.service","pse-remote-commander-tunnel.service","pse-remote-commander-mcp-public.service"]:
        if not active(u): raise RuntimeError(f"{u} inactive after deploy")
        print(f"UNIT_{u}=PASS")

    tool_specs=RC/"packages/mcp-facade/src/tool-specs.mjs"
    if not tool_specs.exists(): raise RuntimeError("tool specs missing")
    names=re.findall(r'name:\s*"([^"]+)"',tool_specs.read_text())
    if len(names)!=28 or "list_devices" not in names or "ping" not in names or "start_process" not in names:
        raise RuntimeError(f"unexpected tool surface count={len(names)}")
    print("TOOL_SURFACE_28=PASS")

    write(CREDS,
      f"PSE Remote Commander no-DNS OAuth credentials\n"
      f"Owner username: pseowner\nOwner password: {owner_pw}\n"
      f"Reviewer username: openai-review\nReviewer password: {reviewer_pw}\n"
      f"OAuth client id: pse-remote-commander-chatgpt\n"
      f"MCP URL: https://{MCP_HOST}/mcp\n"
      f"OAuth issuer: https://{AUTH_HOST}\n",0o600)

    print("NO_DNS_BOOTSTRAP=PASS")
    print(f"MCP_URL=https://{MCP_HOST}/mcp")
    print(f"OAUTH_ISSUER=https://{AUTH_HOST}")
    print("CORE_18750=UNCHANGED")
    print("CORE_18751=UNCHANGED")
    print("TUNNEL_18752=UNCHANGED")
    print("RDC_USED=no")
    print(f"CREDENTIALS_FILE={CREDS}")
    print("NEXT=Open the credentials file locally, then proceed to OpenAI MCP/plugin submission.")
except Exception as e:
    print("BOOTSTRAP_ERROR="+str(e))
    try: rollback()
    except Exception as rexc: print("ROLLBACK_ERROR="+str(rexc))
    sys.exit(1)
