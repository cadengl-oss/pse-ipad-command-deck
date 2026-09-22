#!/usr/bin/env python3
from pathlib import Path
import datetime, html, http.client, os, re, shutil, subprocess, sys, tempfile, time

HOST="desktop.74.208.216.118.sslip.io"
FORGE_PORT=26080
TARGET="/forge/vnc.html?autoconnect=1&resize=scale"
SEARCH_ROOTS=[Path("/root"),Path("/opt"),Path("/srv"),Path("/var/www")]
CADDY_ROOTS=[Path("/etc/caddy"),Path("/root"),Path("/opt"),Path("/srv")]
EXTS={".html",".htm",".py",".js",".mjs",".cjs",".ts",".tsx",".jsx"}
SKIP_DIRS={".git","node_modules",".venv","venv","__pycache__",".cache","proc","sys","dev","run",".npm",".cargo",".rustup"}

def stop(code,msg,details=(),changed="no"):
    print(code); print(msg)
    for item in details: print(item)
    print("CHANGED="+changed); sys.exit(1)

def read_text(path,max_bytes=4_000_000):
    try:
        st=path.stat()
        if st.st_size>max_bytes:return None
        return path.read_text(errors="replace")
    except Exception:return None

def http_get(port,path="/",timeout=4):
    c=http.client.HTTPConnection("127.0.0.1",port,timeout=timeout)
    try:
        c.request("GET",path,headers={"Host":HOST,"User-Agent":"PSE-Recovery-Probe/1"})
        r=c.getresponse(); body=r.read(2_000_000).decode("utf-8","replace")
        return r.status,dict(r.getheaders()),body
    finally:c.close()

def visible_text(s):
    s=re.sub(r"<[^>]+>"," ",s,flags=re.S)
    return re.sub(r"\s+"," ",html.unescape(s)).strip()

def forge_links(text):
    out=[]
    for m in re.finditer(r"<a\b[^>]*>.*?</a\s*>",text,flags=re.I|re.S):
        tag=m.group(0); inner=re.sub(r"^<a\b[^>]*>|</a\s*>$","",tag,flags=re.I|re.S)
        if visible_text(inner).lower()!="forge":continue
        hm=re.search(r"\bhref\s*=\s*([\"'])(.*?)\1",tag,flags=re.I|re.S)
        if hm:out.append((m.start(),m.end(),tag,html.unescape(hm.group(2))))
    return out

def patch_one_forge_link(text):
    links=forge_links(text); already=[x for x in links if x[3]==TARGET]; bad=[x for x in links if x[3]=="/"]
    if len(already)==1 and not bad:return text,"already_fixed"
    if len(bad)!=1:return None,f"forge_link_count={len(links)} root_misroutes={len(bad)} already_fixed={len(already)}"
    start,end,tag,_=bad[0]
    new_tag,n=re.subn(r"(\bhref\s*=\s*)([\"'])/\2",lambda m:m.group(1)+m.group(2)+TARGET+m.group(2),tag,count=1,flags=re.I)
    if n!=1:return None,"href_replacement_failed"
    return text[:start]+new_tag+text[end:],"patched"

def proc_snapshot():
    procs=[]
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():continue
        pid=int(p.name)
        try:cmd=(p/"cmdline").read_bytes().replace(b"\0",b" ").decode("utf-8","replace").strip()
        except Exception:cmd=""
        try:cwd=os.readlink(p/"cwd")
        except Exception:cwd=""
        try:cgroup=(p/"cgroup").read_text(errors="replace")
        except Exception:cgroup=""
        if cmd or cwd:procs.append({"pid":pid,"cmd":cmd,"cwd":cwd,"cgroup":cgroup})
    return procs

def pid_for_listener(port):
    try:cp=subprocess.run(["ss","-lntp"],text=True,capture_output=True,timeout=5,check=False)
    except Exception:return None
    for line in cp.stdout.splitlines():
        if f":{port} " not in line and not line.rstrip().endswith(f":{port}"):continue
        m=re.search(r"pid=(\d+)",line)
        if m:return int(m.group(1))
    return None

def service_for_pid(pid,procs):
    if not pid:return None
    cg=next((p["cgroup"] for p in procs if p["pid"]==pid),"")
    hits=re.findall(r"/([^/\n]+\.service)(?:/|$)",cg)
    hits=[h for h in hits if h not in {"user@0.service","user@1000.service"}]
    return list(dict.fromkeys(hits))[0] if len(set(hits))==1 else None

def restart_service(unit):
    cp=subprocess.run(["systemctl","restart",unit],text=True,capture_output=True,timeout=20,check=False)
    if cp.returncode!=0:return False,(cp.stderr or cp.stdout).strip()[-500:]
    cp2=subprocess.run(["systemctl","is-active",unit],text=True,capture_output=True,timeout=10,check=False)
    return cp2.returncode==0 and cp2.stdout.strip()=="active",cp2.stdout.strip()

print("=== PSE FORGE BUTTON ONE-SHOT REPAIR ==="); print("MODE=fail-closed"); print("TARGET="+TARGET)

try:status,_,body=http_get(FORGE_PORT,"/vnc.html")
except Exception as e:stop("STOP_FORGE_TUNNEL_UNAVAILABLE",f"127.0.0.1:{FORGE_PORT}/vnc.html failed: {type(e).__name__}")
if status not in (200,301,302,304) or ("novnc" not in body.lower() and "vnc" not in body.lower()):
    stop("STOP_FORGE_TUNNEL_NOT_PROVEN",f"Forge tunnel response was HTTP {status}, but noVNC content was not proven.")
print("FORGE_TUNNEL=PASS")

caddy_candidates=[]
for root in CADDY_ROOTS:
    if not root.exists():continue
    for dp,dns,fns in os.walk(root):
        dns[:]=[d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            if "caddy" not in fn.lower() and fn.lower()!="caddyfile":continue
            p=Path(dp)/fn; s=read_text(p,2_000_000)
            if s and HOST in s and "/forge" in s and str(FORGE_PORT) in s:caddy_candidates.append((p,s))
seen=set(); uniq=[]
for p,s in caddy_candidates:
    if str(p) not in seen:seen.add(str(p)); uniq.append((p,s))
caddy_candidates=uniq
if len(caddy_candidates)!=1:
    stop("STOP_CADDY_CONFIG_AMBIGUOUS",f"Expected one Caddy config proving desktop+/forge+26080; found {len(caddy_candidates)}.",[f"CANDIDATE={p}" for p,_ in caddy_candidates[:20]])
caddy_path,caddy_text=caddy_candidates[0]
print("CADDY_ROUTE=PASS"); print("CADDY_CONFIG="+str(caddy_path))

ports=[]
for m in re.finditer(r"\breverse_proxy\s+(?:https?://)?(?:127\.0\.0\.1|localhost):(\d+)",caddy_text,flags=re.I):
    port=int(m.group(1))
    if port not in ports:ports.append(port)
backend_matches=[]
for port in ports:
    if port==FORGE_PORT:continue
    try:st,_,b=http_get(port,"/")
    except Exception:continue
    if st in (200,301,302) and "Mobile Command" in b and "RDP Status" in b and "Forge" in b:backend_matches.append((port,st,b))
if len(backend_matches)!=1:
    stop("STOP_MOBILE_BACKEND_AMBIGUOUS",f"Expected exactly one Mobile Command backend; found {len(backend_matches)}.",[f"BACKEND_CANDIDATE=127.0.0.1:{p} HTTP={st}" for p,st,_ in backend_matches])
backend_port,_,live_before=backend_matches[0]
print(f"MOBILE_BACKEND=PASS 127.0.0.1:{backend_port}")
live_links=forge_links(live_before); live_root=[x for x in live_links if x[3]=="/"]; live_good=[x for x in live_links if x[3]==TARGET]
if len(live_good)==1 and not live_root:
    print("ALREADY_FIXED=yes"); print("LIVE_VERIFY=PASS"); print("CHANGED=no"); sys.exit(0)
if len(live_root)!=1:stop("STOP_LIVE_FORGE_LINK_NOT_UNIQUE",f"Live page has {len(live_links)} Forge link(s), {len(live_root)} pointing to /.")
print("LIVE_BAD_LINK=PROVEN")

procs=proc_snapshot(); backend_pid=pid_for_listener(backend_port); backend_proc=next((p for p in procs if p["pid"]==backend_pid),None); backend_unit=service_for_pid(backend_pid,procs)
print("BACKEND_PID="+(str(backend_pid) if backend_pid else "unknown")); print("BACKEND_UNIT="+(backend_unit or "unknown"))
candidates=[]
for root in SEARCH_ROOTS:
    if not root.exists():continue
    for dp,dns,fns in os.walk(root):
        dns[:]=[d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            p=Path(dp)/fn
            if p.suffix.lower() not in EXTS or ".bak." in p.name or p.name.endswith("~"):continue
            s=read_text(p)
            if not s or "Mobile Command" not in s or "RDP Status" not in s or "Forge" not in s:continue
            patched,state=patch_one_forge_link(s)
            if patched is None and "already_fixed=1" not in state:continue
            score=0; reasons=[]; sp=str(p.resolve())
            if backend_proc:
                if sp in backend_proc["cmd"]:score+=120; reasons.append("source-in-backend-cmd")
                if backend_proc["cwd"]:
                    try:rel=p.resolve().is_relative_to(Path(backend_proc["cwd"]).resolve())
                    except Exception:rel=sp.startswith(str(Path(backend_proc["cwd"]).resolve()).rstrip("/")+"/")
                    if rel:score+=70; reasons.append("under-backend-cwd")
            if "Live VPS floor" in s:score+=15; reasons.append("ui-signature")
            if "Top CPU" in s:score+=10; reasons.append("run-signature")
            if "Remote Desktop" in s:score+=10; reasons.append("desktop-signature")
            candidates.append((score,p,s,state,reasons))
if not candidates:stop("STOP_SOURCE_NOT_FOUND","No source candidate matched the live Mobile Command signatures.")
candidates.sort(key=lambda x:(-x[0],str(x[1]))); score,src,source_text,source_state,reasons=candidates[0]
if len([x for x in candidates if x[0]==score])!=1:
    stop("STOP_SOURCE_AMBIGUOUS","Top source score tied.",[f"CANDIDATE score={sc} path={p} reasons={','.join(rs)}" for sc,p,_,_,rs in candidates[:20]])
if backend_proc and score<70:
    stop("STOP_SOURCE_NOT_TIED_TO_BACKEND","Source candidate was not strongly tied to the live backend.",[f"CANDIDATE={src}",f"SCORE={score}",f"REASONS={','.join(reasons)}"])
if len(candidates)>1 and candidates[1][0]>=score-20:
    stop("STOP_SOURCE_MARGIN_TOO_SMALL","Best source candidate was too close to runner-up.",[f"CANDIDATE score={sc} path={p} reasons={','.join(rs)}" for sc,p,_,_,rs in candidates[:10]])
print("SOURCE=PASS"); print("SOURCE_FILE="+str(src)); print("SOURCE_SCORE="+str(score)); print("SOURCE_REASONS="+",".join(reasons))

new_text,patch_state=patch_one_forge_link(source_text); backup=None
if patch_state=="already_fixed":print("SOURCE_ALREADY_FIXED=yes")
elif new_text is None:stop("STOP_PATCH_PRECONDITION_FAILED",patch_state)
else:
    stamp=datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"); backup=src.with_name(src.name+f".bak.PSE-forge-link.{stamp}"); shutil.copy2(src,backup)
    fd,tmpname=tempfile.mkstemp(prefix=src.name+".psefix.",dir=str(src.parent)); os.close(fd); tmp=Path(tmpname)
    try:
        tmp.write_text(new_text)
        with tmp.open("rb") as f:os.fsync(f.fileno())
        shutil.copystat(src,tmp); os.replace(tmp,src)
    finally:
        try:
            if tmp.exists():tmp.unlink()
        except Exception:pass
    check=read_text(src)
    if check is None or TARGET not in check:
        shutil.copy2(backup,src); stop("STOP_POSTWRITE_VERIFY_FAILED","Source verification failed; backup restored.")
    print("PATCH=PASS"); print("BACKUP="+str(backup))

def live_is_fixed():
    try:st,_,b=http_get(backend_port,"/")
    except Exception:return False
    if st not in (200,301,302):return False
    links=forge_links(b)
    return len([x for x in links if x[3]==TARGET])==1 and len([x for x in links if x[3]=="/"])==0

if not live_is_fixed():
    if not backend_unit:
        if backup:shutil.copy2(backup,src)
        stop("STOP_RELOAD_REQUIRED_BUT_UNIT_UNKNOWN","Source changed but live backend did not reload, and no exact systemd service could be proven. Source rolled back.")
    print("LIVE_RELOAD_REQUIRED=yes"); ok,detail=restart_service(backend_unit)
    if not ok:
        if backup:shutil.copy2(backup,src); restart_service(backend_unit)
        stop("STOP_SERVICE_RESTART_FAILED",f"Exact service {backend_unit} failed to restart; source rolled back. detail={detail}")
    time.sleep(1.5)
if not live_is_fixed():
    if backup:
        shutil.copy2(backup,src)
        if backend_unit:restart_service(backend_unit)
    stop("STOP_LIVE_VERIFY_FAILED_ROLLED_BACK","Protected backend did not serve corrected Forge link; rollback completed.")
print("LIVE_VERIFY=PASS"); print("FORGE_LINK="+TARGET); print("CHANGED=yes"); print("RESULT=FIXED"); print("NEXT=Reload Mobile Command on iPad and tap Forge")
