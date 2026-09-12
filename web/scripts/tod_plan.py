#!/usr/bin/env python3
"""Best cycle per demand level -> a time-of-day signal plan, plus diagnosis of
where unserved trips are lost."""
import os,re,json,collections,multiprocessing as mp
import xml.etree.ElementTree as ET
import gen_demand as gd, nobuild2 as nb

HERE=nb.HERE; WORK=os.path.join(HERE,"tod"); os.makedirs(WORK,exist_ok=True)
SRC=nb.SRC
GRP_C=[["V_Varthur","S_Sarjapur"],["P_Panathur","K_Kundalahalli"]]
GRP_B=nb.GROUPS_B
FACTORS=[0.40,0.60,0.80,1.00]
CYCLES=[40,50,60,70,80,90,110,130,150]

def dem(factor):
    m={k:tuple(int(round(v*factor)) for v in vals) for k,vals in gd.PEAK.items()}
    t=gd.build_trips(m)
    p=os.path.join(WORK,f"d{int(factor*100)}.rou.xml")
    gd.write_routes(p,t,gd.MAPPINGS["nouturn"]); return p,len(t)

def job(a):
    gk,cyc,factor=a
    grp={"B":GRP_B,"C":GRP_C}[gk]
    txt,g=nb.make_program(open(SRC).read(),grp,cyc,"static")
    net=os.path.join(WORK,f"{gk}{cyc}.net.xml"); open(net,"w").write(txt)
    rou,n=dem(factor)
    r=nb.run(f"{gk}{cyc}-{int(factor*100)}",net,"peak",rou,keep=True)
    if r: r.update(grp=gk,cycle=cyc,factor=factor,demand=n,greens=g)
    return r

def losses(tripfile,routefile):
    """Which arm's trips failed to be served?"""
    got=set()
    for _,el in ET.iterparse(tripfile,events=("end",)):
        if el.tag=="tripinfo": got.add(el.get("id")); el.clear()
    want=collections.Counter(); lost=collections.Counter()
    for m in re.finditer(r'<trip id="([^"]+)"',open(routefile).read()):
        vid=m.group(1); arm=vid.split("_")[0][0]
        want[arm]+=1
        if vid not in got: lost[arm]+=1
    return want,lost

if __name__=="__main__":
    jobs=[(gk,c,f) for gk in ("B","C") for c in CYCLES for f in FACTORS]
    with mp.Pool(min(6,mp.cpu_count())) as pool:
        res=[r for r in pool.map(job,jobs) if r]
    json.dump(res,open(os.path.join(HERE,"tod_results.json"),"w"),indent=1)
    print("BEST CYCLE PER DEMAND LEVEL (structure, cycle, static)")
    print(f"{'demand':>8}{'veh':>7}  {'best':>10}{'%served':>9}{'travel':>9}"
          f"{'d2d':>9}{'stopped':>9}   runner-up")
    for f in FACTORS:
        sel=sorted([r for r in res if r["factor"]==f],
                   key=lambda r:(-r["served_pct"],r["door2door"]))
        b=sel[0]; u=sel[1]
        print(f"{f*100:>7.0f}%{b['demand']:>7}  {b['grp']+str(b['cycle']):>10}"
              f"{b['served_pct']:>9.1f}{b['duration']:>9.1f}{b['door2door']:>9.1f}"
              f"{b['waiting']:>9.1f}   {u['grp']+str(u['cycle'])} ({u['served_pct']:.1f}%)")
    print("\nFULL GRID (%served) — rows=cycle, cols=demand")
    print("      "+"".join(f"{int(f*100):>8}%" for f in FACTORS))
    for gk in ("B","C"):
        for c in CYCLES:
            row=[next((r for r in res if r["grp"]==gk and r["cycle"]==c
                       and r["factor"]==f),None) for f in FACTORS]
            print(f"{gk}{c:<5}"+"".join(f"{r['served_pct']:>9.1f}" if r else f"{'-':>9}"
                                       for r in row))
    print("\nWHERE ARE UNSERVED TRIPS LOST? (best plan per level)")
    for f in FACTORS:
        sel=sorted([r for r in res if r["factor"]==f],
                   key=lambda r:(-r["served_pct"],r["door2door"]))[0]
        tag=f"{sel['grp']}{sel['cycle']}-{int(f*100)}"
        tp=sel.get("_trip") or os.path.join(nb.WORK,f"{tag}-peak-trip.xml")
        rou=os.path.join(WORK,f"d{int(f*100)}.rou.xml")
        if not tp or not os.path.exists(tp): continue
        want,lost=losses(tp,rou)
        tot=sum(lost.values())
        s=", ".join(f"{k}: {lost[k]}/{want[k]} ({100*lost[k]/want[k]:.0f}%)"
                    for k in "ENWS" if want[k])
        print(f"  {f*100:>3.0f}% demand, plan {sel['grp']}{sel['cycle']}: "
              f"{tot} lost — {s}")
