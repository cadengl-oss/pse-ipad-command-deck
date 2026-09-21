#!/usr/bin/env python3
from pathlib import Path
import os, re, sys, shutil, tempfile, datetime, subprocess, http.client

HOST="desktop.74.208.216.118.sslip.io"
TARGET="/forge/vnc.html?autoconnect=1&resize=scale"
FORGE_PORT=26080
ROOTS=[Path("/root/Documents/Codex"),Path("/opt"),Path("/srv"),Path("/var/www"),Path("/usr/local/share"),Path("/root/.local/share")]
SKIP={".git","node_modules",".venv","venv","__pycache__",".cache","proc","sys","dev","run"}
EXT={".html",".htm",".py",".js",".mjs",".cjs",".ts",".tsx",".jsx"}

def die(code,msg,*extra):
    print(code); print(msg)
    for x in extra: print(x)
    print("CHANGED=no")
    raise SystemExit(1)

def read(p,limit=4000000):
    try:
        if p.stat().st_size>limit: return None
        return p.read_text(errors="replace")
    except Exception: return None

def http_local(port,path="/"):
    c=http.client.HTTPConnection("127.0.0.1",port,timeout=5)
    try:
        c.request("GET",path,headers={"Host":HOST,"User-Agent":"PSE-Recovery-Probe/1"})
        r=c.getresponse()
        return r.status,r.read(1500000).decode("utf-8","replace")
    finally:
        c.close()

def strip_tags(s):
    return re.sub(r"\s+"," ",re.sub(r"<[^>]+>"," ",s,flags=re.S)).strip()

def forge_links(text):
    out=[]
    for m in re.finditer(r"<a\b[^>]*>.*?</a\s*>",text,re.I|re.S):
        tag=m.group(0)
        inner=re.sub(r"^<a\b[^>]*>|</a\s*>$","",tag,flags=re.I|re.S)
        if strip_tags(inner).lower()!="forge": continue
        h=re.search(r"\bhref\s*=\s*([\"'])(.*?)\1",tag,re.I|re.S)
        if h: out.append((m.start(),m.end(),tag,h.group(2)))
    return out

def patch_text(text):
    links=forge_links(text)
    good=[x for x in links if x[3]==TARGET]
    bad=[x for x in links if x[3]=="/"]
    if len(good)==1 and not bad:
        return text,"already"
    if len(bad)!=1:
        return None,f"forge_links={len(links)} root_misroutes={len(bad)} already={len(good)}"
    a,b,tag,_=bad[0]
    nt,n=re.subn(r"(\bhref\s*=\s*)([\"'])/\2",lambda m:m.group(1)+m.group(2)+TARGET+m.group(2),tag,count=1,flags=re.I)
    if n!=1: return None,"href_replace_failed"
    return text[:a]+nt+text[b:],"patched"

def listener_pid(port):
    try:
        cp=subprocess.run(["ss","-lntp"],text=True,capture_output=True,timeout=5)
    except Exception: return None
    for line in cp.stdout.splitlines():
        if f":{port} " in line or line.rstrip().endswith(f":{port}"):
            m=re.search(r"pid=(\d+)",line)
            if m: return int(m.group(1))
    return None

def unit_for_pid(pid):
    if not pid: return None
    try: cg=Path(f"/proc/{pid}/cgroup").read_text(errors="replace")
    except Exception: return None
    units=[x for x in re.findall(r"/([^/\n]+\.service)(?:/|$)",cg) if not x.startswith("user@")]
    return units[0] if len(set(units))==1 else None

def proc_info():
    out=[]
    for p in Path("/proc").iterdir():
        if not p.name.isdigit(): continue
        try:
            cmd=(p/"cmdline").read_bytes().replace(b"\0",b" ").decode(errors="replace").strip()
        except Exception: cmd=""
        try: cwd=os.readlink(p/"cwd")
        except Exception: cwd=""
        if cmd or cwd: out.append((int(p.name),cmd,cwd))
    return out

def restart(unit):
    cp=subprocess.run(["systemctl","restart",unit],text=True,capture_output=True,timeout=20)
    if cp.returncode: return False
    cp=subprocess.run(["systemctl","is-active",unit],text=True,capture_output=True,timeout=10)
    return cp.returncode==0 and cp.stdout.strip()=="active"

def self_test():
    bad='<nav><a href="/">Home</a><a href="/">Forge</a></nav>'
    new,state=patch_text(bad)
    assert state=="patched" and TARGET in new
    same,state=patch_text(new)
    assert state=="already" and same==new
    amb='<a href="/">Forge</a><a href="/">Forge</a>'
    new,state=patch_text(amb)
    assert new is None and "root_misroutes=2" in state
    print("SELF_TEST=PASS")

if "--self-test" in sys.argv:
    self_test(); raise SystemExit(0)

print("PSE_FORGE_BUTTON_REPAIR=START")
print("MODE=FAIL_CLOSED")

# 1. Prove Forge tunnel before touching anything.
try:
    st,body=http_local(FORGE_PORT,"/vnc.html")
except Exception as e:
    die("STOP_FORGE_TUNNEL_UNAVAILABLE",type(e).__name__)
if st not in (200,301,302,304) or ("novnc" not in body.lower() and "vnc" not in body.lower()):
    die("STOP_FORGE_TUNNEL_NOT_PROVEN",f"HTTP={st}")
print("FORGE_TUNNEL=PASS")

# 2. Prove Caddy has this desktop host and the /forge route to 26080.
caddy=[]
for base in [Path("/etc/caddy"),Path("/root"),Path("/opt"),Path("/srv")]:
    if not base.exists(): continue
    for dp,dn,fn in os.walk(base):
        dn[:]=[d for d in dn if d not in SKIP]
        for name in fn:
            if "caddy" not in name.lower() and name.lower()!="caddyfile": continue
            p=Path(dp)/name; s=read(p,2000000)
            if s and HOST in s and "/forge" in s and str(FORGE_PORT) in s:
                caddy.append((p,s))
seen={}
for p,s in caddy: seen[str(p.resolve())]=(p,s)
caddy=list(seen.values())
if len(caddy)!=1:
    die("STOP_CADDY_ROUTE_AMBIGUOUS",f"COUNT={len(caddy)}",*[f"CANDIDATE={p}" for p,_ in caddy[:20]])
print("CADDY_ROUTE=PASS")
print("CADDY_CONFIG="+str(caddy[0][0]))

# 3. Search only plausible app roots for the unique Mobile Command source.
procs=proc_info()
cand=[]
for base in ROOTS:
    if not base.exists(): continue
    for dp,dn,fn in os.walk(base):
        dn[:]=[d for d in dn if d not in SKIP]
        for name in fn:
            p=Path(dp)/name
            if p.suffix.lower() not in EXT or ".bak." in name: continue
            s=read(p)
            if not s: continue
            if not all(x in s for x in ("Mobile Command","RDP Status","Forge")): continue
            patched,state=patch_text(s)
            if patched is None: continue
            score=0; why=[]
            rp=str(p.resolve())
            for pid,cmd,cwd in procs:
                if rp in cmd:
                    score+=120; why.append(f"cmd:{pid}")
                if cwd and (rp==cwd or rp.startswith(cwd.rstrip("/")+"/")):
                    score+=70; why.append(f"cwd:{pid}")
            if "Live VPS floor" in s: score+=25; why.append("live-floor")
            if "Top CPU" in s: score+=15; why.append("top-cpu")
            if "CEO Desktop" in s: score+=10; why.append("desktop-ui")
            cand.append((score,p,s,state,why))
if not cand: die("STOP_SOURCE_NOT_FOUND","No matching Mobile Command source.")
cand.sort(key=lambda x:(-x[0],str(x[1])))
if len(cand)>1 and cand[1][0]>=cand[0][0]-20:
    die("STOP_SOURCE_AMBIGUOUS","Confidence margin too small.",*[f"CANDIDATE score={x[0]} path={x[1]} why={','.join(x[4])}" for x in cand[:10]])
score,src,old,state,why=cand[0]
if score<25:
    die("STOP_SOURCE_CONFIDENCE_LOW",f"CANDIDATE={src}",f"SCORE={score}")
print("SOURCE=PASS")
print("SOURCE_FILE="+str(src))
print("SOURCE_SCORE="+str(score))

new,state=patch_text(old)
if state=="already":
    print("ALREADY_FIXED=yes"); print("RESULT=FIXED"); print("CHANGED=no"); raise SystemExit(0)
if new is None: die("STOP_PATCH_PRECONDITION",state)

# 4. Atomic backup + single-link mutation.
stamp=datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
backup=src.with_name(src.name+f".bak.PSE-forge-link.{stamp}")
shutil.copy2(src,backup)
fd,tmpname=tempfile.mkstemp(prefix=src.name+".psefix.",dir=str(src.parent)); os.close(fd)
tmp=Path(tmpname)
try:
    tmp.write_text(new)
    shutil.copystat(src,tmp)
    os.replace(tmp,src)
finally:
    try:
        if tmp.exists(): tmp.unlink()
    except Exception: pass
check=read(src)
if not check or TARGET not in check:
    shutil.copy2(backup,src)
    die("STOP_POSTWRITE_VERIFY_FAILED","Backup restored.")
print("PATCH=PASS")
print("BACKUP="+str(backup))

# 5. Restart only a provable service if the source is executed by one.
pids=[]
for pid,cmd,cwd in procs:
    if str(src.resolve()) in cmd:
        pids.append(pid)
    elif cwd and str(src.resolve()).startswith(cwd.rstrip("/")+"/") and src.suffix.lower()==".py":
        pids.append(pid)
units={u for u in (unit_for_pid(pid) for pid in pids) if u}
if len(units)>1:
    shutil.copy2(backup,src)
    die("STOP_SERVICE_AMBIGUOUS","Backup restored.",*[f"UNIT={u}" for u in sorted(units)])
if len(units)==1:
    unit=next(iter(units))
    if not restart(unit):
        shutil.copy2(backup,src); restart(unit)
        die("STOP_SERVICE_RESTART_FAILED",f"UNIT={unit}","Backup restored.")
    print("SERVICE_RESTART=PASS")
    print("SERVICE_UNIT="+unit)
else:
    print("SERVICE_RESTART=NOT_REQUIRED_OR_NOT_PROVEN")

# 6. Final local source verification.
final=read(src)
links=forge_links(final or "")
if len([x for x in links if x[3]==TARGET])!=1 or len([x for x in links if x[3]=="/"])!=0:
    shutil.copy2(backup,src)
    if len(units)==1: restart(next(iter(units)))
    die("STOP_FINAL_VERIFY_FAILED","Backup restored.")

print("FINAL_SOURCE_VERIFY=PASS")
print("FORGE_LINK="+TARGET)
print("RESULT=FIXED")
print("CHANGED=yes")
print("NEXT=Reload Mobile Command and tap Forge")
