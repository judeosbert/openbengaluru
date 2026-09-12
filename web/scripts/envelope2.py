#!/usr/bin/env python3
"""Capacity envelope with equity: what demand can this junction serve with ALL
four arms above a service threshold, using the best no-construction plan?

Signal optimisation is exhausted (delivered 171 s 4-phase ~= best found). The
actionable number is therefore the demand ceiling, because demand management is
the only remaining lever that does not require construction.
"""
import os,re,json,collections,multiprocessing as mp
import xml.etree.ElementTree as ET
import gen_demand as gd, nobuild2 as nb

HERE=nb.HERE; WORK=os.path.join(HERE,"env2"); os.makedirs(WORK,exist_ok=True)
SRC=nb.SRC
D=[["V_Varthur"],["P_Panathur"],["K_Kundalahalli"],["S_Sarjapur"]]
FACTORS=[0.25,0.30,0.35,0.40,0.45,0.50,0.55,0.60,0.70,0.85,1.00]

def prep(factor):
    m={k:tuple(int(round(v*factor)) for v in vals) for k,vals in gd.PEAK.items()}
    t=gd.build_trips(m)
    p=os.path.join(WORK,f"d{int(factor*100)}.rou.xml")
    gd.write_routes(p,t,gd.MAPPINGS["nouturn"])
    w=collections.Counter()
    for mm in re.finditer(r'<trip id="([^"]+)"',open(p).read()): w[mm.group(1)[0]]+=1
    return p,len(t),dict(w)

def job(a):
    plan,cyc,rou,ndem,want,factor=a
    if plan=="delivered": net=SRC
    else:
        txt,_=nb.make_program(open(SRC).read(),D,cyc,"static")
        net=os.path.join(WORK,f"D{cyc}.net.xml"); open(net,"w").write(txt)
    r=nb.run(f"{plan}{cyc}-{int(factor*100)}",net,"peak",rou,keep=True)
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
    r.update(plan=plan,cycle=cyc,factor=factor,demand=ndem,arm=arm,
             worst=min(arm.values()))
    r.pop("_trip",None); return r

if __name__=="__main__":
    prepped={f:prep(f) for f in FACTORS}
    jobs=[(p,c,*prepped[f],f) for f in FACTORS
          for (p,c) in (("delivered",171),("D",210))]
    with mp.Pool(min(6,mp.cpu_count())) as pool:
        res=[r for r in pool.map(job,jobs) if r]
    json.dump(res,open(os.path.join(HERE,"envelope2_results.json"),"w"),indent=1)
    for plan,cyc in (("delivered",171),("D",210)):
        sel=sorted([r for r in res if r["plan"]==plan],key=lambda r:r["factor"])
        print(f"\n{'='*104}\n{plan} (cycle {cyc}) — capacity envelope\n{'='*104}")
        print(f"{'% peak':>7}{'veh/h':>8}{'total%':>8}{'worst arm':>11}"
              f"   {'E':>4}{'N':>5}{'W':>5}{'S':>5}   {'travel':>8}{'stopped':>8}{'d2d':>9}")
        for r in sel:
            a=r["arm"]
            print(f"{r['factor']*100:>7.0f}{r['demand']:>8d}{r['served_pct']:>8.1f}"
                  f"{r['worst']:>11.1f}   {a.get('E',0):>4.0f}{a.get('N',0):>5.0f}"
                  f"{a.get('W',0):>5.0f}{a.get('S',0):>5.0f}   "
                  f"{r['duration']:>8.1f}{r['waiting']:>8.1f}{r['door2door']:>9.1f}")
    print(f"\n{'='*104}\nDEMAND CEILING (highest demand meeting each threshold on EVERY arm)\n{'='*104}")
    for plan,cyc in (("delivered",171),("D",210)):
        sel=sorted([r for r in res if r["plan"]==plan],key=lambda r:r["factor"])
        for thr in (99,95,90):
            ok=[r for r in sel if r["worst"]>=thr]
            b=max(ok,key=lambda r:r["factor"]) if ok else None
            msg=(f"{b['demand']:>5} veh/h ({b['factor']*100:>3.0f}% of peak) "
                 f"travel {b['duration']:.0f}s, stopped {b['waiting']:.0f}s"
                 if b else "not reached at any tested level")
            print(f"  {plan:<10} cyc {cyc}  all arms >= {thr}%: {msg}")
