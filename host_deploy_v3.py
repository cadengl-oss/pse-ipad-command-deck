#!/usr/bin/env python3
import hashlib, json, os, re, secrets, shutil, ssl, subprocess, sys, time, urllib.request
from pathlib import Path

HOST_ROOT=Path("/host")
AUTH_HOST="auth-rc.74.208.216.118.sslip.io"
MCP_HOST="commander.74.208.216.118.sslip.io"
AUTH_PORT=9153
MCP_PORT=18753
AUTH_IMAGE="authelia/authelia:4.39.24"
PUBLIC_IMAGE="pse-remote-commander-public:rc19-nodns-v3"
PUBLIC_CONTAINER="pse-remote-commander-public"
AUTH_CONTAINER="pse-remote-commander-auth"
BASE_REL=Path("/opt/pse-remote-commander-public")
BASE=HOST_ROOT/BASE_REL.relative_to("/")
BUILD=BASE/"build"
SECRETS=BASE/"secrets"
AUTH_DIR=BASE/"authelia"
ENV_FILE=BASE/"public.env"
MARKER=BASE/".managed-by-pse-rc-public-v3"
CADDY_MAIN=HOST_ROOT/"etc/caddy/Caddyfile"
CADDY_AUTH=HOST_ROOT/"etc/caddy/pse-remote-commander-auth.caddy"
CADDY_MCP=HOST_ROOT/"etc/caddy/pse-remote-commander.caddy"
INTERNAL_TOKEN_SRC=HOST_ROOT/"etc/pse/remote-commander-internal-token"
STAMP=time.strftime("%Y%m%dT%H%M%SZ",time.gmtime())
BACKUP=HOST_ROOT/"root"/f"pse-rc-public-v3-backup-{STAMP}"
BUNDLE_COMMIT="fe4e46276139561294b4abe5b8ad91269359eb05"
BUNDLE={
  "rc_public_main.mjs":("bdb56157cd8fb5a731b0ba2582839c40c1db027a","apps/mcp-public/main.mjs"),
  "rc_server.mjs":("53859f40e0cc9a30ac64850e86ec28aba5d34ec1","packages/mcp-facade/src/server.mjs"),
  "rc_public_plugin.mjs":("32f9eacbbd85ff417d034ba0027beabb1ca07c9d","packages/mcp-facade/src/public-plugin.mjs"),
  "rc_relay_client.mjs":("ca982c5c14be65a952169919129d6c99f1ded782","packages/mcp-facade/src/relay-client.mjs"),
  "rc_tool_specs.mjs":("cd7cafc26a62097801e093e00d431a209144d13e","packages/mcp-facade/src/tool-specs.mjs"),
  "rc_public_edge_test.mjs":("8e4628b16c293e8ece8dc86bc104f6529ad16fd8","packages/mcp-facade/test/public-edge.test.mjs"),
  "rc_mcp_facade_test.mjs":("19beebec2f9c3085f97536140d34ee8dae16efc6","packages/mcp-facade/test/mcp-facade.test.mjs"),
}
MUTATED=False
BASE_PREEXISTED=False

def host_enter():
    os.chroot(str(HOST_ROOT))
    os.chdir("/")

def host_run(args,check=True,timeout=120,input_text=None):
    env=os.environ.copy()
    env["PATH"]="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    p=subprocess.run(args,text=True,input=input_text,capture_output=True,timeout=timeout,check=False,env=env,preexec_fn=host_enter)
    if check and p.returncode:
        raise RuntimeError(f"host command failed rc={p.returncode}: {' '.join(args)} :: {(p.stderr or p.stdout)[:1200]}")
    return p

def host_sh(command,check=True,timeout=120):
    return host_run(["/bin/sh","-lc",command],check,timeout)

def git_blob_sha(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode()+data).hexdigest()

def fetch(url,timeout=30):
    req=urllib.request.Request(url,headers={"User-Agent":"PSE-Remote-Commander-Bootstrap/3"})
    with urllib.request.urlopen(req,timeout=timeout,context=ssl.create_default_context()) as r:
        return r.read()

def write(path,data,mode=0o600,uid=None,gid=None):
    path.parent.mkdir(parents=True,exist_ok=True)
    if isinstance(data,str): data=data.encode()
    path.write_bytes(data)
    os.chmod(path,mode)
    if uid is not None or gid is not None:
        os.chown(path,uid if uid is not None else -1,gid if gid is not None else -1)

def copy_or_absent(src,name):
    if src.exists():
        dst=BACKUP/name
        dst.parent.mkdir(parents=True,exist_ok=True)
        if src.is_dir(): shutil.copytree(src,dst,symlinks=True)
        else: shutil.copy2(src,dst)
    else:
        write(BACKUP/(name+".absent"),b"",0o600)

def restore(src,name):
    saved=BACKUP/name
    absent=BACKUP/(name+".absent")
    if saved.exists():
        if src.exists():
            if src.is_dir(): shutil.rmtree(src)
            else: src.unlink()
        if saved.is_dir(): shutil.copytree(saved,src,symlinks=True)
        else:
            src.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(saved,src)
    elif absent.exists() and src.exists():
        if src.is_dir(): shutil.rmtree(src)
        else: src.unlink()

def container_exists(name):
    return host_run(["/usr/bin/docker","inspect",name],False,30).returncode==0

def remove_container(name):
    if container_exists(name):
        host_run(["/usr/bin/docker","rm","-f",name],False,60)

def listening(port):
    p=host_sh("ss -lntH",True,20)
    return re.search(rf":{port}\b",p.stdout) is not None

def wait_http(url,expected=200,timeout=60):
    end=time.time()+timeout
    last=""
    while time.time()<end:
        p=host_run(["/usr/bin/curl","-ksS","-o","/tmp/pse-rc-http-body","-w","%{http_code}","--max-time","5",url],False,10)
        last=(p.stdout or "").strip()
        if last==str(expected): return
        time.sleep(2)
    raise RuntimeError(f"HTTP gate failed {url}: last={last}")

def docker_hash(kind,password):
    args=["/usr/bin/docker","run","--rm",AUTH_IMAGE,"authelia","crypto","hash","generate",kind]
    if kind=="pbkdf2": args += ["--variant","sha512"]
    args += ["--password",password]
    p=host_run(args,True,180)
    m=re.search(r"Digest:\s*(\S+)",p.stdout+p.stderr)
    if not m: raise RuntimeError(f"unable to parse Authelia {kind} digest")
    return m.group(1)

def rollback():
    print("ROLLBACK=START")
    remove_container(PUBLIC_CONTAINER)
    remove_container(AUTH_CONTAINER)
    restore(CADDY_MAIN,"Caddyfile")
    restore(CADDY_AUTH,"pse-remote-commander-auth.caddy")
    restore(CADDY_MCP,"pse-remote-commander.caddy")
    if not BASE_PREEXISTED and BASE.exists():
        shutil.rmtree(BASE,ignore_errors=True)
    elif BASE_PREEXISTED:
        restore(BASE,"base")
    host_run(["/usr/bin/caddy","validate","--config","/etc/caddy/Caddyfile"],False,30)
    host_run(["/usr/bin/caddy","reload","--config","/etc/caddy/Caddyfile"],False,30)
    print("ROLLBACK=COMPLETE")

def preflight():
    global BASE_PREEXISTED
    print("=== PSE REMOTE COMMANDER HOST-ROOT V3 ===")
    if os.geteuid()!=0: raise RuntimeError("helper must run as root")
    required=[
      HOST_ROOT/"etc/os-release", CADDY_MAIN,
      HOST_ROOT/"opt/pse-remote-commander/current",
      INTERNAL_TOKEN_SRC, HOST_ROOT/"run"
    ]
    for p in required:
        if not p.exists(): raise RuntimeError(f"host-root probe missing: {p}")
    for directory,label in [(HOST_ROOT/"opt","HOST_OPT_WRITABLE"),(HOST_ROOT/"etc","HOST_ETC_WRITABLE"),(HOST_ROOT/"tmp","HOST_TMP_WRITABLE")]:
        probe=directory/f".pse-rc-write-probe-{os.getpid()}"
        write(probe,"probe\n",0o600); probe.unlink()
        print(label+"=PASS")
    pid1=host_sh("cat /proc/1/comm",True,10).stdout.strip()
    if not pid1: raise RuntimeError("unable to identify host PID 1")
    print("HOST_PID1="+pid1)
    host_sh("systemctl is-system-running >/dev/null 2>&1 || [ $? -le 1 ]",True,15)
    for unit in ["caddy.service","pse-remote-commander-relay.service","pse-remote-commander-mcp.service","pse-remote-commander-tunnel.service"]:
        if host_run(["/usr/bin/systemctl","is-active","--quiet",unit],False,15).returncode!=0:
            raise RuntimeError(f"required host service inactive: {unit}")
        print("CORE_UNIT_"+unit+"=PASS")
    for port in [18750,18751,18752]:
        if not listening(port): raise RuntimeError(f"required core listener missing: {port}")
        print(f"CORE_PORT_{port}=PASS")
    host_run(["/usr/bin/docker","info"],True,30)
    host_run(["/usr/bin/caddy","validate","--config","/etc/caddy/Caddyfile"],True,30)
    print("HOST_DOCKER=PASS")
    print("CADDY_VALIDATE_BEFORE=PASS")
    for port in [AUTH_PORT,MCP_PORT]:
        if listening(port): raise RuntimeError(f"new port already occupied: {port}")
    for name in [AUTH_CONTAINER,PUBLIC_CONTAINER]:
        if container_exists(name): raise RuntimeError(f"container name already exists: {name}")
    BASE_PREEXISTED=BASE.exists()
    if BASE_PREEXISTED and not MARKER.exists():
        raise RuntimeError(f"refusing unmanaged existing path: {BASE}")
    print("HOST_ROOT_PREFLIGHT=PASS")

def backup():
    BACKUP.mkdir(parents=True,mode=0o700)
    copy_or_absent(CADDY_MAIN,"Caddyfile")
    copy_or_absent(CADDY_AUTH,"pse-remote-commander-auth.caddy")
    copy_or_absent(CADDY_MCP,"pse-remote-commander.caddy")
    if BASE_PREEXISTED: copy_or_absent(BASE,"base")

def stage_and_build_public():
    if BASE.exists() and BASE_PREEXISTED: shutil.rmtree(BASE)
    BASE.mkdir(parents=True,mode=0o700)
    BUILD.mkdir(parents=True,mode=0o700)
    SECRETS.mkdir(parents=True,mode=0o700)
    write(MARKER,"managed-by=pse-remote-commander-public-v3\n",0o600)
    for name,(expected,rel) in BUNDLE.items():
        url=f"https://raw.githubusercontent.com/cadengl-oss/pse-ipad-command-deck/{BUNDLE_COMMIT}/{name}"
        data=fetch(url)
        actual=git_blob_sha(data)
        if actual!=expected: raise RuntimeError(f"bundle hash mismatch {name}: {actual}")
        write(BUILD/rel,data,0o644)
        print(f"BUNDLE_{name}=PASS")
    specs=(BUILD/"packages/mcp-facade/src/tool-specs.mjs").read_text()
    names=re.findall(r'name:\s*"([^"]+)"',specs)
    if len(names)!=28 or not {"list_devices","ping","who_am_i","start_process"}.issubset(set(names)):
        raise RuntimeError(f"unexpected tool surface: {len(names)}")
    print("TOOL_SURFACE_28_STATIC=PASS")
    package={
      "name":"pse-remote-commander-public-container",
      "private":True,"version":"1.0.0","type":"module",
      "engines":{"node":">=22"},
      "dependencies":{
        "@modelcontextprotocol/client":"2.0.0",
        "@modelcontextprotocol/node":"2.0.0",
        "@modelcontextprotocol/server":"2.0.0",
        "zod":"4.6.5"
      }
    }
    write(BUILD/"package.json",json.dumps(package,indent=2)+"\n",0o644)
    dockerfile="""FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY apps ./apps
COPY packages ./packages
RUN node --check apps/mcp-public/main.mjs \
 && node --check packages/mcp-facade/src/server.mjs \
 && node --test packages/mcp-facade/test/mcp-facade.test.mjs packages/mcp-facade/test/public-edge.test.mjs
RUN chown -R 10001:10001 /app
USER 10001:10001
ENV NODE_ENV=production
CMD ["node","apps/mcp-public/main.mjs"]
"""
    write(BUILD/"Dockerfile",dockerfile,0o644)
    p=host_run(["/usr/bin/docker","build","--pull","--tag",PUBLIC_IMAGE,str(BASE_REL/"build")],True,600)
    combined=(p.stdout or "")+(p.stderr or "")
    if "fail" in combined.lower() and "failed to" in combined.lower():
        raise RuntimeError("public MCP image build reported failure")
    print("PUBLIC_IMAGE_BUILD_AND_TEST=PASS")

def configure_auth():
    AUTH_DIR.mkdir(parents=True,mode=0o700)
    secret_dir=AUTH_DIR/"secrets"; secret_dir.mkdir(parents=True,mode=0o700)
    owner_pw=secrets.token_urlsafe(32)
    reviewer_pw=secrets.token_urlsafe(28)
    introspection_secret=secrets.token_urlsafe(48)
    owner_hash=docker_hash("argon2",owner_pw)
    reviewer_hash=docker_hash("argon2",reviewer_pw)
    introspection_hash=docker_hash("pbkdf2",introspection_secret)
    for name in ["session_secret","storage_encryption_key","oidc_hmac_secret"]:
        write(secret_dir/name,secrets.token_hex(48)+"\n",0o600,8000,8000)
    keyp=host_run(["/usr/bin/openssl","genpkey","-algorithm","RSA","-pkeyopt","rsa_keygen_bits:2048"],True,120)
    key=keyp.stdout.strip()
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
    write(AUTH_DIR/"users.yml",users,0o600,8000,8000)
    config=f"""server:
  address: 'tcp4://127.0.0.1:{AUTH_PORT}'

log:
  level: 'info'

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
    write(AUTH_DIR/"configuration.yml",config,0o600,8000,8000)
    for d in [AUTH_DIR,secret_dir]:
        os.chown(d,8000,8000); os.chmod(d,0o700)
    args=[
      "/usr/bin/docker","run","--rm","--user","8000:8000","--network","host",
      "-v",f"{BASE_REL}/authelia:/config:ro",
      "-e","AUTHELIA_SESSION_SECRET_FILE=/config/secrets/session_secret",
      "-e","AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE=/config/secrets/storage_encryption_key",
      "-e","AUTHELIA_IDENTITY_PROVIDERS_OIDC_HMAC_SECRET_FILE=/config/secrets/oidc_hmac_secret",
      AUTH_IMAGE,"authelia","config","validate","--config","/config/configuration.yml"
    ]
    host_run(args,True,180)
    print("AUTHELIA_CONFIG_VALIDATE=PASS")
    write(SECRETS/"introspection_secret",introspection_secret+"\n",0o400,10001,10001)
    token=INTERNAL_TOKEN_SRC.read_text().strip()
    if len(token)<32: raise RuntimeError("invalid existing Remote Commander internal token")
    write(SECRETS/"internal_token",token+"\n",0o400,10001,10001)
    owner_map={"*":{"ownerId":"openai-review-canary","profile":{"id":"prf_openai_review","nickname":"OpenAI review canary"}}}
    write(SECRETS/"owner_map.json",json.dumps(owner_map,indent=2)+"\n",0o400,10001,10001)
    os.chown(SECRETS,10001,10001); os.chmod(SECRETS,0o500)
    env=f"""PSE_RC_PUBLIC_MCP_HOST=127.0.0.1
PSE_RC_PUBLIC_MCP_PORT={MCP_PORT}
PSE_RC_PUBLIC_RESOURCE=https://{MCP_HOST}
PSE_RC_OAUTH_ISSUER=https://{AUTH_HOST}
PSE_RC_OAUTH_INTROSPECTION_URL=https://{AUTH_HOST}/api/oidc/introspection
PSE_RC_OAUTH_EXPECTED_AUDIENCE=https://{MCP_HOST}
PSE_RC_OAUTH_INTROSPECTION_CLIENT_ID=pse-remote-commander-introspector
PSE_RC_OAUTH_INTROSPECTION_CLIENT_SECRET_FILE=/run/secrets/introspection_secret
PSE_RC_PUBLIC_OWNER_MAP_FILE=/run/secrets/owner_map.json
PSE_RC_OPENAI_APPS_CHALLENGE_FILE=/run/secrets/openai_challenge
PSE_RC_RESOURCE_DOCUMENTATION_URL=https://{MCP_HOST}/docs
PSE_RC_RELAY_BASE_URL=http://127.0.0.1:18750
PSE_RC_INTERNAL_TOKEN_FILE=/run/secrets/internal_token
"""
    write(ENV_FILE,env,0o600)
    creds=BASE/"credentials.txt"
    write(creds,
      f"Owner username: pseowner\nOwner password: {owner_pw}\n"
      f"Reviewer username: openai-review\nReviewer password: {reviewer_pw}\n"
      f"OAuth client id: pse-remote-commander-chatgpt\n"
      f"MCP URL: https://{MCP_HOST}/mcp\n"
      f"OAuth issuer: https://{AUTH_HOST}\n",0o600)
    print("AUTH_SECRETS_AND_CREDENTIALS=PASS")

def configure_caddy():
    auth=f"""{AUTH_HOST} {{
  encode zstd gzip
  reverse_proxy 127.0.0.1:{AUTH_PORT}
  header {{
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
  }}
}}
"""
    mcp=f"""{MCP_HOST} {{
  encode zstd gzip
  reverse_proxy 127.0.0.1:{MCP_PORT}
  header {{
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
  }}
}}
"""
    write(CADDY_AUTH,auth,0o644)
    write(CADDY_MCP,mcp,0o644)
    text=CADDY_MAIN.read_text()
    for frag,label in [("/etc/caddy/pse-remote-commander-auth.caddy","PSE Remote Commander OAuth"),("/etc/caddy/pse-remote-commander.caddy","PSE Remote Commander public MCP")]:
        line=f"import {frag}"
        if line not in text: text+=f"\n# {label}\n{line}\n"
    write(CADDY_MAIN,text,0o644)
    host_run(["/usr/bin/caddy","validate","--config","/etc/caddy/Caddyfile"],True,30)
    print("CADDY_VALIDATE_AFTER=PASS")

def start_containers():
    auth_args=[
      "/usr/bin/docker","run","-d","--name",AUTH_CONTAINER,
      "--label","com.pse.component=remote-commander-auth",
      "--restart","unless-stopped","--user","8000:8000","--network","host",
      "--read-only","--tmpfs","/tmp:rw,nosuid,nodev,noexec,size=16m",
      "-v",f"{BASE_REL}/authelia:/config",
      "-e","AUTHELIA_SESSION_SECRET_FILE=/config/secrets/session_secret",
      "-e","AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE=/config/secrets/storage_encryption_key",
      "-e","AUTHELIA_IDENTITY_PROVIDERS_OIDC_HMAC_SECRET_FILE=/config/secrets/oidc_hmac_secret",
      AUTH_IMAGE
    ]
    host_run(auth_args,True,120)
    pub_args=[
      "/usr/bin/docker","run","-d","--name",PUBLIC_CONTAINER,
      "--label","com.pse.component=remote-commander-public",
      "--restart","unless-stopped","--network","host",
      "--read-only","--cap-drop","ALL","--security-opt","no-new-privileges",
      "--pids-limit","128","--tmpfs","/tmp:rw,nosuid,nodev,noexec,size=16m",
      "--env-file",str(BASE_REL/"public.env"),
      "-v",f"{BASE_REL}/secrets:/run/secrets:ro",
      PUBLIC_IMAGE
    ]
    host_run(pub_args,True,120)
    if not listening(AUTH_PORT): raise RuntimeError("Authelia listener did not start")
    if not listening(MCP_PORT): raise RuntimeError("public MCP listener did not start")
    print("CONTAINERS_AND_LISTENERS=PASS")
    host_run(["/usr/bin/caddy","reload","--config","/etc/caddy/Caddyfile"],True,30)
    print("CADDY_RELOAD=PASS")

def acceptance():
    wait_http(f"http://127.0.0.1:{MCP_PORT}/health",200,30)
    print("LOCAL_PUBLIC_HEALTH=PASS")
    wait_http(f"https://{AUTH_HOST}/.well-known/openid-configuration",200,90)
    wait_http(f"https://{MCP_HOST}/health",200,90)
    for path in ["/","/docs","/support","/privacy","/terms","/.well-known/oauth-protected-resource"]:
        wait_http(f"https://{MCP_HOST}{path}",200,30)
        print("HTTPS_"+(path.strip("/").replace("/","_") or "website").upper()+"=PASS")
    wait_http(f"https://{MCP_HOST}/.well-known/openai-apps-challenge",404,15)
    print("OPENAI_CHALLENGE_READY_FOR_TOKEN=PASS")
    p=host_run(["/usr/bin/curl","-ksS","-o","/dev/null","-w","%{http_code}","-X","POST",f"https://{MCP_HOST}/mcp"],True,20)
    if p.stdout.strip()!="401": raise RuntimeError(f"unauthenticated MCP expected 401 got {p.stdout.strip()}")
    print("UNAUTH_MCP_401=PASS")
    meta=json.loads(host_run(["/usr/bin/curl","-ksS",f"https://{AUTH_HOST}/.well-known/openid-configuration"],True,20).stdout)
    if meta.get("issuer")!=f"https://{AUTH_HOST}": raise RuntimeError("OAuth issuer mismatch")
    if "S256" not in meta.get("code_challenge_methods_supported",[]): raise RuntimeError("OAuth S256 not advertised")
    if not meta.get("introspection_endpoint"): raise RuntimeError("OAuth introspection endpoint missing")
    if meta.get("authorization_response_iss_parameter_supported") is not True:
        raise RuntimeError("RFC9207 issuer identification not advertised")
    if not meta.get("userinfo_endpoint"): raise RuntimeError("OIDC userinfo endpoint missing")
    print("OAUTH_DISCOVERY_PKCE_INTROSPECTION_RFC9207_USERINFO=PASS")
    for port in [18750,18751,18752,18753,9153]:
        if not listening(port): raise RuntimeError(f"listener missing after deployment: {port}")
    for unit in ["pse-remote-commander-relay.service","pse-remote-commander-mcp.service","pse-remote-commander-tunnel.service"]:
        if host_run(["/usr/bin/systemctl","is-active","--quiet",unit],False,15).returncode!=0:
            raise RuntimeError(f"core service changed state: {unit}")
    print("CORE_18750_18751_18752_UNCHANGED=PASS")
    for name in [AUTH_CONTAINER,PUBLIC_CONTAINER]:
        state=host_sh(f"docker inspect -f '{{{{.State.Status}}}}' {name}",True,20).stdout.strip()
        if state!="running": raise RuntimeError(f"container not running: {name} state={state}")
    print("CONTAINER_STATE=PASS")
    print("NO_DNS_HOSTROOT_DEPLOY=PASS")
    print(f"MCP_URL=https://{MCP_HOST}/mcp")
    print(f"OAUTH_ISSUER=https://{AUTH_HOST}")
    print(f"CREDENTIALS_FILE={BASE_REL}/credentials.txt")
    print("RDC_USED=no")

def main():
    global MUTATED
    preflight()
    backup()
    MUTATED=True
    stage_and_build_public()
    configure_auth()
    configure_caddy()
    start_containers()
    acceptance()

if __name__=="__main__":
    try:
        main()
    except Exception as e:
        print("HOSTROOT_DEPLOY_ERROR="+str(e))
        if MUTATED:
            try: rollback()
            except Exception as rexc: print("ROLLBACK_ERROR="+str(rexc))
        sys.exit(1)
