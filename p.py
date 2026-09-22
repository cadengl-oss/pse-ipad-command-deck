#!/usr/bin/env python3
import os,re,subprocess
from pathlib import Path

def run(args,timeout=8):
    try:
        p=subprocess.run(args,text=True,capture_output=True,timeout=timeout,check=False)
        return p.returncode,(p.stdout or "").strip(),(p.stderr or "").strip()
    except Exception as e:
        return 99,"",type(e).__name__

print("=== PSE PUBLIC EDGE PREFLIGHT DIAG ===")

for p in [18752,18753,18754,18755]:
    rc,out,_=run(["sh","-lc",f"ss -lntp | grep -E ':{p}\\b' || true"])
    print(f"PORT_{p}_LISTENER="+(re.sub(r'\s+',' ',out)[:500] if out else "NONE"))

env=Path("/etc/pse/remote-commander-mcp-public.env")
print("PUBLIC_ENV_PRESENT="+str(env.exists()))
if env.exists():
    txt=env.read_text(errors="replace")
    keys=[]
    vals={}
    for line in txt.splitlines():
        s=line.strip()
        if not s or s.startswith("#") or "=" not in s: continue
        k,v=s.split("=",1); k=k.strip(); v=v.strip().strip('"').strip("'")
        keys.append(k)
        if k in ["PSE_RC_PUBLIC_MCP_HOST","PSE_RC_PUBLIC_MCP_PORT","PSE_RC_PUBLIC_RESOURCE","PSE_RC_OAUTH_ISSUER","PSE_RC_OAUTH_INTROSPECTION_URL","PSE_RC_OAUTH_EXPECTED_AUDIENCE","PSE_RC_RESOURCE_DOCUMENTATION_URL"]:
            vals[k]=v
    print("PUBLIC_ENV_KEYS="+",".join(keys))
    for k,v in vals.items(): print(f"{k}={v}")

for p in [
"/etc/pse/remote-commander-oauth-introspection-secret",
"/etc/pse/remote-commander-owner-map.json",
"/etc/pse/openai-apps-challenge",
"/etc/pse/remote-commander-internal-token"
]:
    path=Path(p)
    if path.exists():
        st=path.stat()
        print(f"FILE {p}=PRESENT mode={oct(st.st_mode & 0o777)[2:]} uid={st.st_uid} gid={st.st_gid} size={st.st_size}")
    else:
        print(f"FILE {p}=ABSENT")

rc,out,_=run(["systemctl","cat","pse-remote-commander-mcp-public.service"])
print("PUBLIC_SERVICE_CAT_BEGIN")
print(re.sub(r'(?i)(TOKEN|SECRET|KEY)=\S+',r'\1=[REDACTED]',out)[:4000])
print("PUBLIC_SERVICE_CAT_END")

hosts=[]
for root in ["/etc/caddy","/etc/caddy/sites","/etc/caddy/conf.d"]:
    rp=Path(root)
    if not rp.exists(): continue
    for f in rp.rglob("*"):
        if not f.is_file(): continue
        try: txt=f.read_text(errors="replace")
        except: continue
        if "reverse_proxy" not in txt and "{" not in txt: continue
        for line in txt.splitlines():
            s=line.strip()
            if not s or s.startswith("#"): continue
            m=re.match(r"^([A-Za-z0-9*_.-]+\.[A-Za-z0-9.-]+)(?::\d+)?\s*\{$",s)
            if m: hosts.append((m.group(1),str(f)))
print("CADDY_HOSTS_BEGIN")
for h,f in sorted(set(hosts)): print(f"{h} <- {f}")
print("CADDY_HOSTS_END")

for svc in ["authentik-server.service","authentik-worker.service","authelia.service"]:
    rc,out,_=run(["systemctl","is-active",svc]); print(f"UNIT {svc}={out or 'absent'}")

print("PUBLIC_EDGE_DIAG_COMPLETE=PASS")
