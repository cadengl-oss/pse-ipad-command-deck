#!/usr/bin/env python3
import json, os, re, socket, subprocess

def run(args, timeout=8):
    try:
        p=subprocess.run(args,text=True,capture_output=True,timeout=timeout,check=False)
        return p.returncode,(p.stdout or "").strip(),(p.stderr or "").strip()
    except Exception as e:
        return 99,"",type(e).__name__

def port(p):
    s=socket.socket(); s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1",p)); return "OPEN"
    except Exception: return "CLOSED"
    finally: s.close()

print("=== PSE NEXUS CONTROL DIAG ===")
rc,out,_=run(["hostname"]); print("HOSTNAME="+(out or "?"))
rc,out,_=run(["uptime","-p"]); print("UPTIME="+(out or "?"))

for p in [22,9162,18750,18751,18752,2222,26080]:
    print(f"PORT_{p}={port(p)}")

units=[
"caddy.service","tailscaled.service","pse-mission-control.service",
"pse-remote-commander-relay.service","pse-remote-commander-mcp.service",
"pse-remote-commander-mcp-public.service"
]
for u in units:
    rc,out,_=run(["systemctl","is-active",u])
    print(f"UNIT_{u}="+(out or "absent"))

rc,out,_=run(["systemctl","list-units","--all","--type=service","--no-legend","--plain"])
print("MATCHED_SYSTEM_UNITS_BEGIN")
for line in out.splitlines():
    low=line.lower()
    if any(x in low for x in ["pse","forge","tunnel","tailscale","caddy","novnc","websockify"]):
        print(re.sub(r"\s+"," ",line).strip()[:240])
print("MATCHED_SYSTEM_UNITS_END")

rc,out,_=run(["systemctl","list-unit-files","--type=service","--no-legend","--plain"])
print("MATCHED_UNIT_FILES_BEGIN")
for line in out.splitlines():
    low=line.lower()
    if any(x in low for x in ["pse","forge","tunnel","tailscale","caddy","novnc","websockify"]):
        print(re.sub(r"\s+"," ",line).strip()[:240])
print("MATCHED_UNIT_FILES_END")

rc,out,err=run(["tailscale","status","--json"],10)
print("TAILSCALE_STATUS="+("PASS" if rc==0 else "FAIL"))
if rc==0:
    try:
        d=json.loads(out)
        selfo=d.get("Self") or {}
        print("TAIL_SELF="+str(selfo.get("HostName") or selfo.get("DNSName") or "?"))
        print("TAIL_SELF_IPS="+",".join(selfo.get("TailscaleIPs") or []))
        peers=d.get("Peer") or {}
        rows=[]
        for _,v in peers.items():
            name=(v.get("HostName") or v.get("DNSName") or "").rstrip(".")
            ips=",".join(v.get("TailscaleIPs") or [])
            online=v.get("Online")
            if any(x in name.lower() for x in ["forge","omarchy","atlas","mac","nexus"]):
                rows.append((name,ips,online))
        if not rows:
            print("TAIL_PSE_PEERS=NONE_MATCHED")
        for name,ips,online in rows:
            print(f"TAIL_PEER name={name} ips={ips} online={online}")
    except Exception as e:
        print("TAIL_PARSE_FAIL="+type(e).__name__)

rc,out,_=run(["ps","-eo","pid,comm,args"],8)
print("MATCHED_PROCESSES_BEGIN")
for line in out.splitlines():
    low=line.lower()
    if any(x in low for x in ["autossh","websockify","novnc","pse-mission","pse-remote","ssh -r","ssh -l","tailscale"]):
        # redact obvious secret/token assignments and bearer-looking strings
        line=re.sub(r"(?i)(token|secret|password|api[_-]?key)=\S+",r"\1=[REDACTED]",line)
        line=re.sub(r"(?i)bearer\s+\S+","Bearer [REDACTED]",line)
        print(re.sub(r"\s+"," ",line).strip()[:300])
print("MATCHED_PROCESSES_END")

for path in ["/opt/pse-remote-control","/etc/pse-remote-control","/opt/pse-remote-commander/current","/srv/pse-mission-control/current"]:
    print("PATH "+path+"="+("PRESENT" if os.path.exists(path) else "ABSENT"))

print("DIAG_COMPLETE=PASS")
