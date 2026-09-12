#!/usr/bin/env python3
"""How much demand CAN the delivered geometry serve, best-tuned?

No-construction constraint means peak cannot be served. The actionable question
becomes: what is the actual capacity, so we know how much demand has to move
out of the peak hour (or divert) for the junction to function.

Scales the canonical O-D matrix by a factor and finds where each configuration
stops coping.
"""
import os, re, json, multiprocessing as mp
import gen_demand as gd, nobuild2 as nb

HERE=nb.HERE; WORK=os.path.join(HERE,"env"); os.makedirs(WORK,exist_ok=True)
SRC=nb.SRC

FACTORS=[0.40,0.50,0.60,0.70,0.80,0.90,1.00]

def scaled_demand(factor, sublane):
    m={k:tuple(int(round(v*factor)) for v in vals) for k,vals in gd.PEAK.items()}
    trips=gd.build_trips(m)
    p=os.path.join(WORK,f"dem-{int(factor*100)}{'-sub' if sublane else ''}.rou.xml")
    gd.write_routes(p,trips,gd.MAPPINGS["nouturn"])
    if sublane:
        s=open(p).read()
        def add(mo):
            vid=re.search(r'id="([^"]+)"',mo.group(0)).group(1)
            return mo.group(0)[:-2]+" "+nb.LAT.get(vid,"")+"/>"
        open(p,"w").write(re.sub(r'<vType id="[^"]+"[^>]*/>',add,s))
    return p,len(trips)

CFG={
 "as-delivered": dict(net=None, sub=False),
 "retimed":      dict(net=("C",150,"static"), sub=False),
 "retimed+lat":  dict(net=("C",150,"static"), sub=True),
}

def job(a):
    name,factor=a
    c=CFG[name]
    if c["net"] is None:
        net=SRC
    else:
        gk,cyc,ctl=c["net"]
        grp={"B":nb.GROUPS_B,"C":[["V_Varthur","S_Sarjapur"],
                                  ["P_Panathur","K_Kundalahalli"]]}[gk]
        txt,_=nb.make_program(open(SRC).read(),grp,cyc,ctl)
        net=os.path.join(WORK,f"{name}.net.xml"); open(net,"w").write(txt)
    rou,n=scaled_demand(factor,c["sub"])
    extra=["--lateral-resolution","0.8"] if c["sub"] else None
    r=nb.run(f"{name}-{int(factor*100)}",net,"peak",rou,extra)
    if r: r.update(cfg=name,factor=factor,demand=n)
    return r

if __name__=="__main__":
    jobs=[(n,f) for n in CFG for f in FACTORS]
    with mp.Pool(min(6,mp.cpu_count())) as pool:
        res=[r for r in pool.map(job,jobs) if r]
    json.dump(res,open(os.path.join(HERE,"envelope_results.json"),"w"),indent=1)
    for name in CFG:
        sel=sorted([r for r in res if r["cfg"]==name],key=lambda r:r["factor"])
        print(f"\n=== {name} ===")
        print(f"{'% of peak':>10}{'veh/h':>8}{'%served':>9}{'travel':>9}"
              f"{'depdly':>9}{'d2d':>9}{'stopped':>9}{'halt%':>7}{'tele':>6}")
        for r in sel:
            print(f"{r['factor']*100:>10.0f}{r['demand']:>8d}{r['served_pct']:>9.1f}"
                  f"{r['duration']:>9.1f}{r['depdelay']:>9.1f}{r['door2door']:>9.1f}"
                  f"{r['waiting']:>9.1f}{r['halt_pct']:>7.1f}{r['teleports']:>6d}")
    print("\n--- highest demand served at >=95% and >=99% ---")
    for name in CFG:
        sel=sorted([r for r in res if r["cfg"]==name],key=lambda r:r["factor"])
        for thr in (99,95):
            ok=[r for r in sel if r["served_pct"]>=thr]
            best=max(ok,key=lambda r:r["factor"]) if ok else None
            print(f"  {name:<14} >={thr}%: "
                  + (f"{best['demand']} veh/h ({best['factor']*100:.0f}% of peak), "
                     f"d2d {best['door2door']:.0f}s" if best else "never"))
