#!/usr/bin/env python3
import json, os, re, subprocess, urllib.request, urllib.error
from pathlib import Path

def run(args, timeout=8):
    try:
        p=subprocess.run(args,text=True,capture_output=True,timeout=timeout,check=False)
        return p.returncode,(p.stdout or "").strip(),(p.stderr or "").strip()
    except Exception as e:
        return 99,"",type(e).__name__

def get(url):
    try:
        with urllib.request.urlopen(url,timeout=3) as r:
            body=r.read(200000).decode("utf-8","replace")
            return r.status,body
    except Exception as e:
        return 0,type(e).__name__

print("=== PSE REMOTE COMMANDER CHATGPT EDGE DIAG ===")

for u in ["pse-remote-commander-relay.service","pse-remote-commander-mcp.service","pse-remote-commander-tunnel.service","pse-remote-commander-mcp-public.service"]:
    rc,out,_=run(["systemctl","is-active",u])
    print(f"UNIT {u}={out or 'absent'}")

for url in [
    "http://127.0.0.1:18750/health",
    "http://127.0.0.1:18751/health",
    "http://127.0.0.1:18752/health",
    "http://127.0.0.1:18751/",
    "http://127.0.0.1:18752/"
]:
    st,body=get(url)
    clean=re.sub(r'(?i)(token|secret|key|authorization|bearer)[\"\'=:\s]+[^,}\]\s]+',r'\1=[REDACTED]',body)
    clean=re.sub(r'plugin_asdk_app_[A-Za-z0-9_-]+',lambda m:m.group(0),clean)
    print(f"HTTP {url} STATUS={st} BODY={clean[:500].replace(chr(10),' ')}")

profile=Path("/etc/pse/remote-commander-tunnel.yaml")
print("PROFILE_PRESENT="+str(profile.exists()))
if profile.exists():
    text=profile.read_text(errors="replace")
    print("PROFILE_KEYS_BEGIN")
    for line in text.splitlines():
        s=line.strip()
        if not s or s.startswith("#"): continue
        if ":" in s:
            k=s.split(":",1)[0].strip()
            if re.match(r"^[A-Za-z0-9_.-]+$",k):
                print(k)
    print("PROFILE_KEYS_END")
    for label,pat in [
        ("TUNNEL_ID",r'(?im)^\s*(?:tunnel_id|tunnelId|id)\s*:\s*["\']?([^"\'\s#]+)'),
        ("PROFILE_NAME",r'(?im)^\s*(?:name|profile|profile_name)\s*:\s*["\']?([^"\'\s#]+)'),
        ("TARGET",r'(?im)^\s*(?:target|url|endpoint|upstream)\s*:\s*["\']?([^"\'\s#]+)')
    ]:
        m=re.search(pat,text)
        if m:
            v=m.group(1)
            if any(x in label for x in ["TUNNEL_ID","PROFILE_NAME","TARGET"]):
                print(f"{label}={v}")

rc,out,_=run(["systemctl","show","pse-remote-commander-tunnel.service","-p","ExecStart","-p","EnvironmentFiles","-p","FragmentPath"])
print("SYSTEMD_META_BEGIN")
print(re.sub(r'(?i)(TOKEN|SECRET|KEY)=\S+',r'\1=[REDACTED]',out))
print("SYSTEMD_META_END")

for root in ["/opt/pse-remote-commander/current","/etc/pse"]:
    for pat in ["*app*.json","*plugin*.json","*submission*.json","*tunnel*.json","*tunnel*.yaml","*tunnel*.yml"]:
        for p in Path(root).rglob(pat) if Path(root).exists() else []:
            try:
                txt=p.read_text(errors="replace")
            except Exception:
                continue
            ids=re.findall(r'plugin_asdk_app_[A-Za-z0-9_-]+',txt)
            tids=re.findall(r'tunnel_[A-Za-z0-9_-]+',txt)
            if ids or tids:
                print("METADATA_FILE="+str(p))
                for x in ids: print("PLUGIN_ID="+x)
                for x in tids: print("TUNNEL_ID_FOUND="+x)

print("EDGE_DIAG_COMPLETE=PASS")
