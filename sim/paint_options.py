#!/usr/bin/env python3
"""Re-marking options within the EXISTING 6 m carriageway. Paint only.

Every approach is 6 m of sealed surface currently marked as one lane. No
pavement is added, no link lengthened, no junction rebuilt -- only the lane
markings inside the existing 6 m change.

  M1  2 lanes x 3.0 m, every approach
  M2  1 general lane 4.0 m + 1 nearside filter lane 2.0 m, motorcycles only
      (left-hand traffic, so the filter lane is on the left/nearside)

Because two lanes give permissive movements somewhere to wait, the best phase
structure may differ from the single-lane case, so the structure and cycle
sweep is repeated on each marking option rather than assumed.
"""
import os,re,json,collections,subprocess,multiprocessing as mp
import xml.etree.ElementTree as ET
import gen_demand as gd, nobuild2 as nb

HERE=nb.HERE; WORK=os.path.join(HERE,"paint"); os.makedirs(WORK,exist_ok=True)
NETCONVERT=nb.NETCONVERT; SUMO_HOME=nb.SUMO_HOME

A=[["V_Varthur","P_Panathur"],["K_Kundalahalli","S_Sarjapur"]]
B=nb.GROUPS_B
C=[["V_Varthur","S_Sarjapur"],["P_Panathur","K_Kundalahalli"]]
D=[["V_Varthur"],["P_Panathur"],["K_Kundalahalli"],["S_Sarjapur"]]
E=[["V_Varthur","P_Panathur"],["K_Kundalahalli"],["S_Sarjapur"]]
STRUCT={"A 2ph EW|NS":A,"B 2ph VK|PS":B,"C 2ph VS|PK":C,
        "D 4ph each alone":D,"E 3ph EW|K|S":E}
CYCLES=[90,120,150,180]

def build_marking(name):
    """Rebuild the delivered triangle with new lane markings inside 6 m."""
    edg=open(os.path.join(HERE,"plain","base.edg.xml")).read()
    if name=="M1":
        def rep(m):
            return m.group(0).replace('numLanes="1"','numLanes="2"')
        edg=re.sub(r'<edge id="[^"]+"[^>]*?>',rep,edg)
        edg=edg.replace("<edges","<edges")  # widths set via netconvert default
        extra=["--default.lanewidth","3.0"]
        lanespec=None
    elif name=="M2":
        # two lanes, nearside restricted to motorcycles, asymmetric widths
        def rep(m):
            eid=re.search(r'id="([^"]+)"',m.group(0)).group(1)
            tag=m.group(0).replace('numLanes="1"','numLanes="2"')
            if tag.endswith("/>"):
                tag=tag[:-2]+">"
            return (tag+
                    '\n        <lane index="0" width="2.0" allow="motorcycle moped"/>'
                    '\n        <lane index="1" width="4.0"/>'
                    '\n    </edge>')
        edg=re.sub(r'<edge id="[^"]+"[^>]*?/>',rep,edg)
        extra=[]
        lanespec=True
    else:
        extra=[]; lanespec=None
    e2=os.path.join(WORK,f"{name}.edg.xml"); open(e2,"w").write(edg)
    out=os.path.join(WORK,f"{name}-raw.net.xml")
    cmd=[NETCONVERT,
         "--node-files",os.path.join(HERE,"plain","base.nod.xml"),
         "--edge-files",e2,"-o",out,
         "--lefthand","--no-turnarounds","true",
         "--tls.guess","false","--tls.default-type","static",
         "--offset.disable-normalization","true","--no-warnings"]+extra
    p=subprocess.run(cmd,capture_output=True,text=True,
                     env=dict(os.environ,SUMO_HOME=SUMO_HOME))
    if p.returncode!=0:
        print(f"  {name} netconvert FAILED:",p.stderr[-700:]); return None
    # the TLS node must still be a traffic light with a program to splice into
    if '<tlLogic' not in open(out).read():
        print(f"  {name}: no tlLogic generated"); return None
    return out

def prep(factor):
    m={k:tuple(int(round(v*factor)) for v in vals) for k,vals in gd.PEAK.items()}
    t=gd.build_trips(m)
    p=os.path.join(WORK,f"d{int(factor*100)}.rou.xml")
    gd.write_routes(p,t,gd.MAPPINGS["nouturn"])
    w=collections.Counter()
    for mm in re.finditer(r'<trip id="([^"]+)"',open(p).read()): w[mm.group(1)[0]]+=1
    return p,len(t),dict(w)

def job(a):
    mark,raw,sk,cyc,rou,ndem,want,factor=a
    try: txt,g=nb.make_program(open(raw).read(),STRUCT[sk],cyc,"static")
    except Exception as e: return None
    tag=f"{mark}-{sk.split()[0]}{cyc}-{int(factor*100)}"
    net=os.path.join(WORK,f"{tag}.net.xml"); open(net,"w").write(txt)
    r=nb.run(tag,net,"peak",rou,keep=True)
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
    r.update(mark=mark,struct=sk,cycle=cyc,factor=factor,demand=ndem,greens=g,
             arm=arm,worst=min(arm.values()),
             spread=max(arm.values())-min(arm.values()))
    r.pop("_trip",None); return r

if __name__=="__main__":
    marks={}
    for m in ("M1","M2"):
        b=build_marking(m)
        if b:
            marks[m]=b
            s=open(b).read()
            nl=len(re.findall(r'<lane id="[^:][^"]*"',s))
            print(f"  {m}: built, {nl} lanes total")
    rou,ndem,want=prep(1.00)
    jobs=[(m,raw,sk,c,rou,ndem,want,1.00)
          for m,raw in marks.items() for sk in STRUCT for c in CYCLES]
    print(f"evaluating {len(jobs)} marking x structure x cycle configs at peak...")
    with mp.Pool(min(6,mp.cpu_count())) as pool:
        res=[r for r in pool.map(job,jobs) if r]
    json.dump(res,open(os.path.join(HERE,"paint_results.json"),"w"),indent=1)
    res.sort(key=lambda r:(-r["worst"],-r["served_pct"]))
    print(f"\n{'='*122}\nRE-MARKING OPTIONS @ PEAK ({ndem} veh) — ranked by worst-served arm"
          f"\n{'='*122}")
    print(f"{'rank':<5}{'mark':>5}{'structure':>19}{'cyc':>5}{'total%':>8}"
          f"{'worst':>8}{'spread':>8}   {'E':>4}{'N':>5}{'W':>5}{'S':>5}   "
          f"{'travel':>8}{'stopped':>8}{'d2d':>9}{'tele':>6}")
    for i,r in enumerate(res[:16],1):
        a=r["arm"]
        print(f"{i:<5}{r['mark']:>5}{r['struct']:>19}{r['cycle']:>5}"
              f"{r['served_pct']:>8.1f}{r['worst']:>8.1f}{r['spread']:>8.1f}   "
              f"{a.get('E',0):>4.0f}{a.get('N',0):>5.0f}{a.get('W',0):>5.0f}"
              f"{a.get('S',0):>5.0f}   {r['duration']:>8.1f}{r['waiting']:>8.1f}"
              f"{r['door2door']:>9.1f}{r['teleports']:>6d}")
    b=res[0]
    print(f"\nBEST: {b['mark']} {b['struct']} cycle={b['cycle']} greens={b['greens']}"
          f" -> {b['served_pct']:.1f}% total, worst arm {b['worst']:.1f}%")
