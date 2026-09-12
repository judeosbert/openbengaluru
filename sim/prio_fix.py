#!/usr/bin/env python3
"""Right-of-way reassignment at the two unsignalised junctions.

Every edge in the delivered net carries priority="-1", i.e. all equal, so
netconvert assigned give-way by geometry alone. The result is backwards: traffic
LEAVING the signal toward Kundalahalli (E6 -> -E4) must yield to Kundalahalli's
own inbound stream, and E6 is only 15.5 m long -- 2.2 vehicles. The signal's
exit therefore blocks after two vehicles, back-pressures into the junction, and
starves Sarjapur's discharge as well (S->N routes over E3 -> E6).

Changing which approach yields is a give-way marking and sign change. No
pavement, no lane, no geometry. Tested here against the best timing plan.
"""
import os,re,json,subprocess,multiprocessing as mp
import nobuild2 as nb, gen_demand as gd

HERE=nb.HERE; WORK=os.path.join(HERE,"prio"); os.makedirs(WORK,exist_ok=True)
NETCONVERT=nb.NETCONVERT; SUMO_HOME=nb.SUMO_HOME
GRP_B=nb.GROUPS_B

# priority schemes: edge id -> priority value (absent = 1)
SCHEMES={
 "P0-as-delivered": None,
 "P1-exits-major":  {"E6":5,"-E5.51":5},
 "P2-E6-major":     {"E6":5},
 "P3-E551-major":   {"-E5.51":5},
 "P4-arms-major":   {"E4":5,"E1":5},
 "P5-exits-strong": {"E6":9,"-E5.51":9,"E5":5,"-E6":5},
}

def build(name,pri):
    if pri is None: return nb.SRC
    edg=open(os.path.join(HERE,"plain","base.edg.xml")).read()
    def setp(m):
        eid=re.search(r'id="([^"]+)"',m.group(0)).group(1)
        v=pri.get(eid,1)
        return re.sub(r'priority="-?\d+"',f'priority="{v}"',m.group(0))
    edg=re.sub(r'<edge id="[^"]+"[^>]*?>',setp,edg)
    e2=os.path.join(WORK,f"{name}.edg.xml"); open(e2,"w").write(edg)
    raw=os.path.join(WORK,f"{name}-raw.net.xml")
    p=subprocess.run([NETCONVERT,
        "--node-files",os.path.join(HERE,"plain","base.nod.xml"),
        "--edge-files",e2,
        "--connection-files",os.path.join(HERE,"plain","base.con.xml"),
        "--tllogic-files",os.path.join(HERE,"plain","base.tll.xml"),
        "-o",raw,"--lefthand","--no-turnarounds","true",
        "--offset.disable-normalization","true","--no-warnings"],
        capture_output=True,text=True,env=dict(os.environ,SUMO_HOME=SUMO_HOME))
    if p.returncode!=0:
        print(f"  {name} netconvert failed:",p.stderr[-400:]); return None
    return raw

def dem(factor):
    m={k:tuple(int(round(v*factor)) for v in vals) for k,vals in gd.PEAK.items()}
    t=gd.build_trips(m)
    p=os.path.join(WORK,f"d{int(factor*100)}.rou.xml")
    gd.write_routes(p,t,gd.MAPPINGS["nouturn"]); return p,len(t)

def job(a):
    name,raw,cyc,factor=a
    if not raw: return None
    txt,g=nb.make_program(open(raw).read(),GRP_B,cyc,"static")
    net=os.path.join(WORK,f"{name}-{cyc}.net.xml"); open(net,"w").write(txt)
    rou,n=dem(factor)
    r=nb.run(f"{name}-{cyc}-{int(factor*100)}",net,"peak",rou,keep=True)
    if r: r.update(scheme=name,cycle=cyc,factor=factor,demand=n)
    return r

if __name__=="__main__":
    built={}
    for k,v in SCHEMES.items():
        b=build(k,v)
        if b:
            built[k]=b
            # report resulting give-way at the two junctions
            s=open(b).read()
            out=[]
            for c in re.finditer(r'<connection\b([^/>]*)/?>',s):
                d=dict(re.findall(r'(\w+)="([^"]*)"',c.group(1)))
                if d.get('from','').startswith(':') or d.get('tl'): continue
                if d.get('state') in ('M','m','O','o'):
                    out.append(f"{d['from']}->{d['to']}:{d['state']}")
            print(f"  {k:<17} {' '.join(out)}")
    jobs=[(k,v,150,f) for k,v in built.items() for f in (1.00,0.60)]
    with mp.Pool(min(6,mp.cpu_count())) as pool:
        res=[r for r in pool.map(job,jobs) if r]
    json.dump(res,open(os.path.join(HERE,"prio_results.json"),"w"),indent=1)
    import collections
    import xml.etree.ElementTree as ET
    for f in (1.00,0.60):
        sel=sorted([r for r in res if r["factor"]==f],key=lambda r:-r["served_pct"])
        print(f"\n{'='*100}\nPRIORITY SCHEMES @ {f*100:.0f}% of peak "
              f"({sel[0]['demand']} veh), plan B150 static\n{'='*100}")
        print(f"{'scheme':<18}{'%served':>9}{'unsrvd':>8}{'travel':>9}{'depdly':>9}"
              f"{'d2d':>9}{'stopped':>9}{'halt%':>7}{'tele':>6}   losses by arm")
        for r in sel:
            tp=r.get("_trip"); byarm=""
            if tp and os.path.exists(tp):
                got=set()
                for _,el in ET.iterparse(tp,events=("end",)):
                    if el.tag=="tripinfo": got.add(el.get("id")); el.clear()
                want=collections.Counter(); lost=collections.Counter()
                for m in re.finditer(r'<trip id="([^"]+)"',open(os.path.join(WORK,f"d{int(f*100)}.rou.xml")).read()):
                    a=m.group(1)[0]; want[a]+=1
                    if m.group(1) not in got: lost[a]+=1
                byarm=" ".join(f"{k}:{100*lost[k]/want[k]:.0f}%" for k in "ENWS" if want[k])
            print(f"{r['scheme']:<18}{r['served_pct']:>9.1f}{r['unserved']:>8d}"
                  f"{r['duration']:>9.1f}{r['depdelay']:>9.1f}{r['door2door']:>9.1f}"
                  f"{r['waiting']:>9.1f}{r['halt_pct']:>7.1f}{r['teleports']:>6d}   {byarm}")
