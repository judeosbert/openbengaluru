#!/usr/bin/env python3
"""Re-run the signal sweep scoring EQUITY, not just total throughput.

The delivered network and every plan tuned for total throughput starve
Kundalahalli and Sarjapur (>90% of their trips never get a slot) while serving
Panathur and Varthur at ~90%. Total-served hides this completely.

All Kundalahalli inbound must traverse E4 -> -E6, and -E6 is 15.5 m long: a
2.2-vehicle buffer for 1,420 veh/h. It cannot be lengthened without
construction. What CAN be changed is whether its movements are protected or
permissive -- i.e. the phase structure. Under a V+K pairing, Kundalahalli's
through movement must yield to Varthur's, so it gets almost nothing.

Scored on worst-arm service, then total.
"""
import os,re,json,collections,multiprocessing as mp
import xml.etree.ElementTree as ET
import gen_demand as gd, nobuild2 as nb

HERE=nb.HERE; WORK=os.path.join(HERE,"fair"); os.makedirs(WORK,exist_ok=True)
SRC=nb.SRC
A=[["V_Varthur","P_Panathur"],["K_Kundalahalli","S_Sarjapur"]]
B=[["V_Varthur","K_Kundalahalli"],["P_Panathur","S_Sarjapur"]]
C=[["V_Varthur","S_Sarjapur"],["P_Panathur","K_Kundalahalli"]]
D=[["V_Varthur"],["P_Panathur"],["K_Kundalahalli"],["S_Sarjapur"]]
E=[["V_Varthur","P_Panathur"],["K_Kundalahalli"],["S_Sarjapur"]]
F=[["K_Kundalahalli"],["V_Varthur","P_Panathur"],["S_Sarjapur"]]
G=[["K_Kundalahalli","S_Sarjapur"],["V_Varthur"],["P_Panathur"]]
STRUCT={"A 2ph EW|NS":A,"B 2ph VK|PS":B,"C 2ph VS|PK":C,
        "D 4ph each alone":D,"E 3ph EW|K|S":E,"F 3ph K|EW|S":F,"G 3ph NS|V|P":G}
CYCLES=[60,80,100,120,150]

# pre-generate demand once, serially (avoids a write race in the pool)
def prep(factor):
    m={k:tuple(int(round(v*factor)) for v in vals) for k,vals in gd.PEAK.items()}
    t=gd.build_trips(m)
    p=os.path.join(WORK,f"d{int(factor*100)}.rou.xml")
    gd.write_routes(p,t,gd.MAPPINGS["nouturn"])
    want=collections.Counter()
    for mm in re.finditer(r'<trip id="([^"]+)"',open(p).read()): want[mm.group(1)[0]]+=1
    return p,len(t),dict(want)

def job(a):
    sk,cyc,rou,ndem,want,factor=a
    try: txt,g=nb.make_program(open(SRC).read(),STRUCT[sk],cyc,"static")
    except Exception: return None
    tag=f"{sk.split()[0]}{cyc}-{int(factor*100)}"
    net=os.path.join(WORK,f"{tag}.net.xml"); open(net,"w").write(txt)
    r=nb.run(tag,net,"peak",rou,keep=True)
    if not r: return None
    tp=r.get("_trip")
    got=set()
    if tp and os.path.exists(tp):
        for _,el in ET.iterparse(tp,events=("end",)):
            if el.tag=="tripinfo": got.add(el.get("id")); el.clear()
        os.remove(tp)
    served=collections.Counter()
    for mm in re.finditer(r'<trip id="([^"]+)"',open(rou).read()):
        if mm.group(1) in got: served[mm.group(1)[0]]+=1
    arm={k:100.0*served[k]/want[k] for k in want}
    r.update(struct=sk,cycle=cyc,factor=factor,demand=ndem,greens=g,
             arm=arm,worst=min(arm.values()),spread=max(arm.values())-min(arm.values()))
    r.pop("_trip",None)
    return r

if __name__=="__main__":
    out=[]
    for factor in (1.00,0.60):
        rou,ndem,want=prep(factor)
        jobs=[(sk,c,rou,ndem,want,factor) for sk in STRUCT for c in CYCLES]
        with mp.Pool(min(6,mp.cpu_count())) as pool:
            res=[r for r in pool.map(job,jobs) if r]
        out+=res
        res.sort(key=lambda r:(-r["worst"],-r["served_pct"]))
        print(f"\n{'='*118}\nRANKED BY WORST-SERVED ARM @ {factor*100:.0f}% of peak "
              f"({ndem} veh)\n{'='*118}")
        print(f"{'rank':<5}{'structure':<19}{'cyc':>5}{'total%':>8}{'worst arm':>11}"
              f"{'spread':>8}   {'E':>5}{'N':>6}{'W':>6}{'S':>6}   "
              f"{'travel':>8}{'d2d':>9}")
        for i,r in enumerate(res[:14],1):
            a=r["arm"]
            print(f"{i:<5}{r['struct']:<19}{r['cycle']:>5}{r['served_pct']:>8.1f}"
                  f"{r['worst']:>11.1f}{r['spread']:>8.1f}   "
                  f"{a.get('E',0):>5.0f}{a.get('N',0):>6.0f}"
                  f"{a.get('W',0):>6.0f}{a.get('S',0):>6.0f}   "
                  f"{r['duration']:>8.1f}{r['door2door']:>9.1f}")
    json.dump(out,open(os.path.join(HERE,"fair_results.json"),"w"),indent=1)
