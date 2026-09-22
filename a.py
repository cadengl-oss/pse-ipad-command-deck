#!/usr/bin/env python3
import json,re,subprocess
HOST="auth.pilotsalesdistribution.com"

def run(args,timeout=10):
    try:
        p=subprocess.run(args,text=True,capture_output=True,timeout=timeout,check=False)
        return p.returncode,(p.stdout or "").strip(),(p.stderr or "").strip()
    except Exception as e:
        return 99,"",type(e).__name__

print("=== PSE AUTH EDGE DISCOVERY ===")
print("HOST="+HOST)

rc,out,err=run(["caddy","adapt","--config","/etc/caddy/Caddyfile","--pretty"],15)
print("CADDY_ADAPT="+("PASS" if rc==0 else "FAIL"))
if rc==0:
    try:
        data=json.loads(out)
        text=json.dumps(data,indent=2)
        lines=text.splitlines()
        hits=[i for i,l in enumerate(lines) if HOST in l]
        print("CADDY_AUTH_CONTEXT_BEGIN")
        for i in hits[:10]:
            a=max(0,i-6); b=min(len(lines),i+32)
            block="\n".join(lines[a:b])
            block=re.sub(r'(?i)(authorization|cookie|header_up|header_down)\s*[^\n]+','[REDACTED HEADER RULE]',block)
            print(block[:5000])
        print("CADDY_AUTH_CONTEXT_END")
    except Exception as e:
        print("CADDY_PARSE_FAIL="+type(e).__name__)

for runtime in ["docker","podman"]:
    rc,out,_=run([runtime,"ps","--format","{{.Names}}|{{.Image}}|{{.Ports}}"],10)
    print(runtime.upper()+"_PS="+("PASS" if rc==0 else "UNAVAILABLE"))
    if rc==0:
        print(runtime.upper()+"_AUTH_MATCHES_BEGIN")
        for line in out.splitlines():
            if re.search(r'(?i)auth|oauth|oidc|keycloak|dex|ory|authelia|authentik|kanidm',line):
                print(line[:500])
        print(runtime.upper()+"_AUTH_MATCHES_END")

for svc in ["authentik-server.service","authentik-worker.service","authelia.service"]:
    rc,out,_=run(["systemctl","is-active",svc])
    print(f"UNIT {svc}={out or 'absent'}")

def status(path):
    rc,out,err=run(["curl","-kso","/dev/null","-w","%{http_code}","--max-time","5","--resolve",f"{HOST}:443:127.0.0.1",f"https://{HOST}{path}"],8)
    print(f"HTTP {path}="+(out if rc==0 else "ERROR"))

for p in ["/","/.well-known/openid-configuration","/.well-known/oauth-authorization-server"]:
    status(p)

print("AUTH_EDGE_DISCOVERY_COMPLETE=PASS")
