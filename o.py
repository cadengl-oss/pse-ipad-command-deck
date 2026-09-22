#!/usr/bin/env python3
import json,re,subprocess
from pathlib import Path

C="pse-app-library-authelia-1"

def run(args,timeout=10):
    try:
        p=subprocess.run(args,text=True,capture_output=True,timeout=timeout,check=False)
        return p.returncode,(p.stdout or "").strip(),(p.stderr or "").strip()
    except Exception as e:
        return 99,"",type(e).__name__

print("=== PSE AUTHELIA STRUCTURE DIAG ===")

rc,out,err=run(["docker","inspect",C],15)
if rc!=0:
    print("STOP_AUTHELIA_INSPECT_FAILED")
    print("DETAIL="+err[:300])
    raise SystemExit(1)

d=json.loads(out)[0]
print("CONTAINER="+d.get("Name","").lstrip("/"))
print("IMAGE="+(d.get("Config",{}).get("Image") or "?"))
print("STATE="+str(d.get("State",{}).get("Status") or "?"))

print("MOUNTS_BEGIN")
mounts=[]
for m in d.get("Mounts",[]):
    src=m.get("Source") or ""
    dst=m.get("Destination") or ""
    rw=m.get("RW")
    print(f"{src} -> {dst} rw={rw}")
    mounts.append((src,dst,rw))
print("MOUNTS_END")

# Locate config directory from mounts only.
cfg_sources=[]
for src,dst,rw in mounts:
    if dst.rstrip("/") in ["/config","/etc/authelia"] or "authelia" in dst.lower():
        cfg_sources.append(Path(src))
print("CONFIG_SOURCE_COUNT="+str(len(cfg_sources)))

cfg_files=[]
for root in cfg_sources:
    if root.is_file():
        cfg_files.append(root)
    elif root.is_dir():
        for name in ["configuration.yml","configuration.yaml","config.yml","config.yaml"]:
            p=root/name
            if p.exists(): cfg_files.append(p)
print("CONFIG_FILES_BEGIN")
for p in cfg_files: print(str(p))
print("CONFIG_FILES_END")

# Print only nonsecret OIDC structure; never values of secret-bearing keys.
secret_key=re.compile(r'(?i)(secret|password|token|key|cookie|jwt|encryption|hmac)')
for p in cfg_files:
    try: lines=p.read_text(errors="replace").splitlines()
    except Exception: continue
    print("OIDC_STRUCTURE_BEGIN "+str(p))
    in_oidc=False
    base_indent=None
    for i,line in enumerate(lines):
        raw=line.rstrip()
        stripped=raw.strip()
        if not stripped or stripped.startswith("#"): continue
        indent=len(raw)-len(raw.lstrip())
        if re.match(r'^\s*oidc\s*:',raw) or re.match(r'^\s*openid_connect\s*:',raw):
            in_oidc=True; base_indent=indent
            print(stripped); continue
        if in_oidc and indent<=base_indent and not re.match(r'^\s*[-#]',raw):
            in_oidc=False
        if not in_oidc: continue
        if ":" not in stripped: continue
        k,v=stripped.split(":",1)
        k=k.strip(); v=v.strip()
        if secret_key.search(k):
            print(" " * indent + k + ": [PRESENT]" if v else " " * indent + k + ":")
            continue
        if k in {"client_id","redirect_uris","scopes","grant_types","response_types","authorization_policy","public","audience","audiences","require_pkce","pkce_challenge_method","token_endpoint_auth_method","introspection_endpoint_auth_method"}:
            # Print safe structure values only.
            print(" " * indent + k + ":" + (" "+v if v else ""))
        elif stripped.startswith("- ") and re.search(r'https?://|^[\s-]*(openid|profile|email|offline_access|pse\.)',stripped,re.I):
            print(" " * indent + stripped)
    print("OIDC_STRUCTURE_END")

# Secret/config file names only, no contents.
for root in cfg_sources:
    if not root.is_dir(): continue
    print("CONFIG_DIR_FILES_BEGIN "+str(root))
    for p in sorted(root.glob("*")):
        try:
            st=p.stat()
            mode=oct(st.st_mode & 0o777)[2:]
            typ="dir" if p.is_dir() else "file"
            print(f"{p.name}|{typ}|mode={mode}|size={st.st_size}")
        except Exception: pass
    print("CONFIG_DIR_FILES_END")

# Active Caddyfile import directives + auth fragments on disk.
main=Path("/etc/caddy/Caddyfile")
if main.exists():
    print("ACTIVE_CADDY_IMPORTS_BEGIN")
    for line in main.read_text(errors="replace").splitlines():
        s=line.strip()
        if s.startswith("import "): print(s)
    print("ACTIVE_CADDY_IMPORTS_END")

print("AUTH_CADDY_FRAGMENTS_BEGIN")
for p in sorted(Path("/etc/caddy").glob("*.caddy")):
    try: txt=p.read_text(errors="replace")
    except Exception: continue
    if "auth.pilotsalesdistribution.com" in txt or "9151" in txt or "authelia" in txt.lower():
        print(str(p))
        # print only host + reverse_proxy lines; redact headers.
        for line in txt.splitlines():
            s=line.strip()
            if "auth.pilotsalesdistribution.com" in s or s.startswith("reverse_proxy") or s.startswith("import "):
                print("  "+s[:500])
print("AUTH_CADDY_FRAGMENTS_END")

print("AUTHELIA_STRUCTURE_DIAG_COMPLETE=PASS")
