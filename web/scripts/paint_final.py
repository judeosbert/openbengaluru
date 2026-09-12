#!/usr/bin/env python3
"""Refine the 2x3.0 m re-marking plan and find its capacity ceiling."""
import os,re,json,collections,multiprocessing as mp
import xml.etree.ElementTree as ET
import gen_demand as gd, nobuild2 as nb, paint_options as po

HERE=nb.HERE; WORK=os.path.join(HERE,"paint2"); os.makedirs(WORK,exist_ok=True)
D=[["V_Varthur"],["P_Panathur"],["K_Kundalahalli"],["S_Sarjapur"]]
RAW=os.path.join(HERE,"paint","M1-raw.net.xml")

def prep(factor):
    m={k:tuple(int(round(v*factor)) for v in vals) for k,vals in gd.PEAK.items()}
    t=gd.build_trips(m)
    p=os.path.join(WORK,f"d{int(factor*100)}.rou.xml")
    gd.write_routes(p,t,gd.MAPPINGS["nouturn"])
    w=collections.Counter()
    for mm in re.finditer(r'<trip id="([^"]+)"',open(p).read()): w[mm.group(1)[0]]+=1
    return p,len(t),dict(w)

def measure(tag,net,rou,want,sub=False):
    extra=["--lateral-resolution","0.8"] if sub else None
    r=nb.run(tag,net,"peak",rou,extra,keep=True)
    if not r: return None
    tp=r.get("_trip"); got=set()
    if tp and os.path.exists(tp):
        for _,el in ET.iterparse(tp,events=("end",)):
            if el.tag=="tripinfo": got.add(el.get("id")); el.clear()
        os.remove(tp)
    sv=collections.Counter()
    for mm in re.finditer(r'<trip id="([^"]+)"',open(rou).read()):
        if mm.group(1) in got: sv[mm.group(1)[0]]+=1
    arm={k:100.0*sv[k]/want[k] for k in want}
    r.update(arm=arm,worst=min(arm.values()),
             spread=max(arm.values())-min(arm.values()))
    r.pop("_trip",None); return r

def job(a):
    kind,cyc,rou,ndem,want,factor,sub=a
    txt,g=nb.make_program(open(RAW).read(),D,cyc,"static")
    net=os.path.join(WORK,f"M1D{cyc}.net.xml"); open(net,"w").write(txt)
    r=measure(f"M1D{cyc}{'s' if sub else ''}-{int(factor*100)}",net,rou,want,sub)
    if r: r.update(cycle=cyc,factor=factor,demand=ndem,greens=g,sub=sub)
    return r

if __name__=="__main__":
    CY=[150,180,210,240,270]
    rou,ndem,want=prep(1.00)
    jobs=[("M1D",c,rou,ndem,want,1.00,s) for c in CY for s in (False,True)]
    with mp.Pool(6) as pool: res=[r for r in pool.map(job,jobs) if r]
    res.sort(key=lambda r:(-r["worst"],-r["served_pct"]))
    print(f"{'='*112}\nCYCLE REFINEMENT — 2x3.0 m marking, 4-phase protected, peak "
          f"({ndem} veh)\n{'='*112}")
    print(f"{'cyc':>5}{'lateral':>9}{'total%':>8}{'worst':>8}{'spread':>8}   "
          f"{'E':>4}{'N':>5}{'W':>5}{'S':>5}   {'travel':>8}{'stopped':>8}"
          f"{'d2d':>9}{'tele':>6}")
    for r in res:
        a=r["arm"]
        print(f"{r['cycle']:>5}{'on' if r['sub'] else 'off':>9}{r['served_pct']:>8.1f}"
              f"{r['worst']:>8.1f}{r['spread']:>8.1f}   {a['E']:>4.0f}{a['N']:>5.0f}"
              f"{a['W']:>5.0f}{a['S']:>5.0f}   {r['duration']:>8.1f}"
              f"{r['waiting']:>8.1f}{r['door2door']:>9.1f}{r['teleports']:>6d}")
    best=res[0]
    BC=best["cycle"]
    print(f"\nbest cycle = {BC} s, greens {best['greens']}")

    # capacity envelope for the winning marking + plan
    FACT=[0.60,0.70,0.80,0.90,1.00,1.10,1.20]
    env=[]
    prepped={f:prep(f) for f in FACT}
    ejobs=[("M1D",BC,*prepped[f],f,False) for f in FACT]
    with mp.Pool(6) as pool: env=[r for r in pool.map(job,ejobs) if r]
    env.sort(key=lambda r:r["factor"])
    print(f"\n{'='*112}\nCAPACITY ENVELOPE — 2x3.0 m marking, 4-phase @ {BC} s"
          f"\n{'='*112}")
    print(f"{'% peak':>7}{'veh/h':>8}{'total%':>8}{'worst':>8}   "
          f"{'E':>4}{'N':>5}{'W':>5}{'S':>5}   {'travel':>8}{'stopped':>8}{'d2d':>9}")
    for r in env:
        a=r["arm"]
        print(f"{r['factor']*100:>7.0f}{r['demand']:>8d}{r['served_pct']:>8.1f}"
              f"{r['worst']:>8.1f}   {a['E']:>4.0f}{a['N']:>5.0f}{a['W']:>5.0f}"
              f"{a['S']:>5.0f}   {r['duration']:>8.1f}{r['waiting']:>8.1f}"
              f"{r['door2door']:>9.1f}")
    for thr in (99,95,90):
        ok=[r for r in env if r["worst"]>=thr]
        b=max(ok,key=lambda r:r["factor"]) if ok else None
        print(f"  all arms >= {thr}%: "+(f"{b['demand']} veh/h "
              f"({b['factor']*100:.0f}% of peak), travel {b['duration']:.0f}s, "
              f"stopped {b['waiting']:.0f}s" if b else "not reached"))
    json.dump({"refine":res,"envelope":env,"best_cycle":BC},
              open(os.path.join(HERE,"paint_final.json"),"w"),indent=1)
