#!/usr/bin/env python3
"""Find the best FAIR plan: all four arms served, no starvation.

Structure D (each approach its own fully-protected phase) is what the delivered
171 s plan already does. This sweeps D's cycle length and the lateral-filtering
model, and compares against the delivered plan on equal terms.
"""
import os,re,json,collections,multiprocessing as mp
import xml.etree.ElementTree as ET
import gen_demand as gd, nobuild2 as nb

HERE=nb.HERE; WORK=os.path.join(HERE,"fair2"); os.makedirs(WORK,exist_ok=True)
SRC=nb.SRC
D=[["V_Varthur"],["P_Panathur"],["K_Kundalahalli"],["S_Sarjapur"]]
# N is throttled by the 15.5 m -E6 link; try giving it extra green beyond its
# PCU share by inflating its weight.
CYCLES=[120,150,180,210,240]

def prep(factor,sub):
    m={k:tuple(int(round(v*factor)) for v in vals) for k,vals in gd.PEAK.items()}
    t=gd.build_trips(m)
    p=os.path.join(WORK,f"d{int(factor*100)}{'s' if sub else ''}.rou.xml")
    gd.write_routes(p,t,gd.MAPPINGS["nouturn"])
    if sub:
        s=open(p).read()
        def add(mo):
            vid=re.search(r'id="([^"]+)"',mo.group(0)).group(1)
            return mo.group(0)[:-2]+" "+nb.LAT.get(vid,"")+"/>"
        open(p,"w").write(re.sub(r'<vType id="[^"]+"[^>]*/>',add,s))
    want=collections.Counter()
    for mm in re.finditer(r'<trip id="([^"]+)"',open(p).read()): want[mm.group(1)[0]]+=1
    return p,len(t),dict(want)

def measure(tag,net,rou,want,sub):
    extra=["--lateral-resolution","0.8"] if sub else None
    r=nb.run(tag,net,"peak",rou,extra,keep=True)
    if not r: return None
    tp=r.get("_trip"); got=set()
    if tp and os.path.exists(tp):
        for _,el in ET.iterparse(tp,events=("end",)):
            if el.tag=="tripinfo": got.add(el.get("id")); el.clear()
        os.remove(tp)
    served=collections.Counter()
    for mm in re.finditer(r'<trip id="([^"]+)"',open(rou).read()):
        if mm.group(1) in got: served[mm.group(1)[0]]+=1
    arm={k:100.0*served[k]/want[k] for k in want}
    r.update(arm=arm,worst=min(arm.values()),
             spread=max(arm.values())-min(arm.values()))
    r.pop("_trip",None)
    return r

def job(a):
    kind,cyc,nboost,rou,want,sub,factor=a
    if kind=="delivered":
        net=SRC; g=[40,40,40,40]
    else:
        w=dict(nb.PCU); w["K_Kundalahalli"]=int(w["K_Kundalahalli"]*nboost)
        old=nb.PCU.copy(); nb.PCU.update(w)
        try: txt,g=nb.make_program(open(SRC).read(),D,cyc,"static")
        finally: nb.PCU.update(old)
        net=os.path.join(WORK,f"D{cyc}n{int(nboost*10)}.net.xml")
        open(net,"w").write(txt)
    tag=f"{kind}{cyc}n{int(nboost*10)}{'s' if sub else ''}-{int(factor*100)}"
    r=measure(tag,net,rou,want,sub)
    if r: r.update(kind=kind,cycle=cyc,nboost=nboost,sub=sub,factor=factor,greens=g)
    return r

if __name__=="__main__":
    allr=[]
    for factor in (1.00,0.60):
        for sub in (False,True):
            rou,ndem,want=prep(factor,sub)
            jobs=[("delivered",171,1.0,rou,want,sub,factor)]
            jobs+=[("D",c,nb_,rou,want,sub,factor)
                   for c in CYCLES for nb_ in (1.0,1.4,1.8)]
            with mp.Pool(min(6,mp.cpu_count())) as pool:
                res=[r for r in pool.map(job,jobs) if r]
            allr+=res
            res.sort(key=lambda r:(-r["worst"],-r["served_pct"]))
            print(f"\n{'='*116}\nBEST FAIR PLAN @ {factor*100:.0f}% peak ({ndem} veh)"
                  f"  lateral-filtering={'on' if sub else 'off'}\n{'='*116}")
            print(f"{'plan':<16}{'cyc':>5}{'N-boost':>9}{'total%':>8}"
                  f"{'worst':>8}{'spread':>8}   {'E':>5}{'N':>6}{'W':>6}{'S':>6}"
                  f"   {'travel':>8}{'stopped':>8}{'d2d':>9}")
            for r in res[:9]:
                a=r["arm"]
                print(f"{r['kind']:<16}{r['cycle']:>5}{r['nboost']:>9.1f}"
                      f"{r['served_pct']:>8.1f}{r['worst']:>8.1f}{r['spread']:>8.1f}   "
                      f"{a.get('E',0):>5.0f}{a.get('N',0):>6.0f}"
                      f"{a.get('W',0):>6.0f}{a.get('S',0):>6.0f}   "
                      f"{r['duration']:>8.1f}{r['waiting']:>8.1f}{r['door2door']:>9.1f}")
    json.dump(allr,open(os.path.join(HERE,"fair_best_results.json"),"w"),indent=1)
