#!/usr/bin/env python3
"""Final no-construction search: long cycles, turn bans, sublane, and combos."""
import os, re, subprocess, json, itertools, multiprocessing as mp
import xml.etree.ElementTree as ET, statistics as st
import nobuild2 as nb

HERE=nb.HERE; WORK=nb.WORK; SUMO_HOME=nb.SUMO_HOME; NETCONVERT=nb.NETCONVERT
SRC=nb.SRC

def ban_net(drops, tag):
    """Drop connections from BOTH the connection file and the tll file."""
    con=open(os.path.join(HERE,"plain","base.con.xml")).read()
    tll=open(os.path.join(HERE,"plain","base.tll.xml")).read()
    for f,t in drops:
        pat=rf'\s*<connection from="{re.escape(f)}" to="{re.escape(t)}"[^>]*/>'
        con,a=re.subn(pat,"",con); tll,b=re.subn(pat,"",tll)
        if a==0: print(f"    warn: con {f}->{t} not found")
    c2=os.path.join(WORK,f"{tag}.con.xml"); open(c2,"w").write(con)
    t2=os.path.join(WORK,f"{tag}.tll.xml"); open(t2,"w").write(tll)
    out=os.path.join(WORK,f"{tag}-raw.net.xml")
    p=subprocess.run([NETCONVERT,
        "--node-files",os.path.join(HERE,"plain","base.nod.xml"),
        "--edge-files",os.path.join(HERE,"plain","base.edg.xml"),
        "--connection-files",c2,"--tllogic-files",t2,"-o",out,
        "--lefthand","--no-turnarounds","true",
        "--offset.disable-normalization","true","--no-warnings"],
        capture_output=True,text=True,env=dict(os.environ,SUMO_HOME=SUMO_HOME))
    if p.returncode!=0:
        print(f"    {tag} netconvert failed:",p.stderr[-400:]); return None
    return out

# candidate turn bans (signage only). Link->yield-count from the foe matrix:
# -E6 r yields to 7, E3 r yields to 6, E3 s yields to 4, -E6 s yields to 5.
BANS = {
 "ban-2r":  [("-E6","-E5.51"),("E3","E5.36")],
 "ban-1r":  [("-E6","-E5.51")],
 "ban-3":   [("-E6","-E5.51"),("E3","E5.36"),("-E5","E6")],
}

GROUPS={"B":nb.GROUPS_B,
        "C":[["V_Varthur","S_Sarjapur"],["P_Panathur","K_Kundalahalli"]]}
CYCLES=[120,150,180,240]

def job(a):
    gk,cyc,ctl,bank,basenet,sub,level=a
    base = basenet
    if not base: return None
    txt=open(base).read()
    try: txt,g=nb.make_program(txt,GROUPS[gk],cyc,ctl)
    except Exception as e: return None
    tag=f"{gk}{cyc}{ctl[:3]}_{bank}_{'sub' if sub else 'nos'}"
    net=os.path.join(WORK,f"{tag}.net.xml"); open(net,"w").write(txt)
    rou=nb.sublane_demand(level) if sub else None
    extra=["--lateral-resolution","0.8"] if sub else None
    r=nb.run(tag,net,level,rou,extra)
    if r: r.update(grp=gk,cycle=cyc,ctl=ctl,ban=bank,sub=bool(sub),greens=g)
    return r

if __name__=="__main__":
    BANNED={}
    for k,v in BANS.items():
        n=ban_net(v,k)
        if n: BANNED[k]=n; print(f"  built {k}")
    opts=[("none",SRC)]+[(k,v) for k,v in BANNED.items()]
    jobs=[(gk,c,ctl,bk,bn,sb,"peak")
          for gk in GROUPS for c in CYCLES for ctl in ("static",)
          for (bk,bn) in opts for sb in (False,True)]
    print(f"evaluating {len(jobs)} no-construction configs at peak...")
    with mp.Pool(min(6,mp.cpu_count())) as pool:
        res=[r for r in pool.map(job,jobs) if r]
    res.sort(key=lambda r:(-r["served_pct"],r["door2door"]))
    print(f"\n{'='*112}")
    print(f"{'rank':<5}{'grp':>4}{'cyc':>5}{'ban':>8}{'sub':>5}"
          f"{'%served':>9}{'unsrvd':>8}{'travel':>9}{'depdly':>9}"
          f"{'d2d':>9}{'stopped':>9}{'halt%':>7}{'tele':>6}")
    print("="*112)
    for i,r in enumerate(res[:20],1):
        print(f"{i:<5}{r['grp']:>4}{r['cycle']:>5}{r['ban']:>8}"
              f"{'yes' if r['sub'] else 'no':>5}"
              f"{r['served_pct']:>9.1f}{r['unserved']:>8d}{r['duration']:>9.1f}"
              f"{r['depdelay']:>9.1f}{r['door2door']:>9.1f}{r['waiting']:>9.1f}"
              f"{r['halt_pct']:>7.1f}{r['teleports']:>6d}")
    json.dump(res,open(os.path.join(HERE,"nobuild3_results.json"),"w"),indent=1)
    b=res[0]
    print(f"\nBEST: grp={b['grp']} cycle={b['cycle']} ban={b['ban']} "
          f"sublane={b['sub']} greens={b['greens']} -> {b['served_pct']:.1f}% served")
