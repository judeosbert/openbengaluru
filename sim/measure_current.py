#!/usr/bin/env python3
"""Measure the CURRENT system: unsignalised, two U-turns, median cut.

BELAGERE.net.xml is what is on the ground today -- no traffic light, every
junction give-way controlled, and two must-yield U-turns doing the work that a
signalised crossroads would otherwise do. Kundalahalli->Panathur and
Kundalahalli->Sarjapur both depend on the E0.75->-E0 U-turn; Sarjapur->Varthur
depends on -E0.79->E0.18.
"""
import os, re, json, collections
import xml.etree.ElementTree as ET
import gen_demand as gd, nobuild2 as nb

HERE = nb.HERE
WORK = os.path.join(HERE, "cur"); os.makedirs(WORK, exist_ok=True)
NET = os.path.join(HERE, "..", "networks", "BELAGERE.net.xml")

def prep(matrix, tag):
    trips = gd.build_trips(matrix)
    p = os.path.join(WORK, f"{tag}.rou.xml")
    gd.write_routes(p, trips, gd.MAPPINGS["baseline"])   # baseline edge mapping
    want = collections.Counter()
    for m in re.finditer(r'<trip id="([^"]+)"', open(p).read()):
        want[m.group(1)[0]] += 1
    return p, len(trips), dict(want)

def run(tag, rou, want):
    r = nb.run(tag, NET, "peak", rou, keep=True)
    if not r: return None
    tp = r.get("_trip"); got = set()
    if tp and os.path.exists(tp):
        for _, el in ET.iterparse(tp, events=("end",)):
            if el.tag == "tripinfo": got.add(el.get("id")); el.clear()
        os.remove(tp)
    sv = collections.Counter()
    for m in re.finditer(r'<trip id="([^"]+)"', open(rou).read()):
        if m.group(1) in got: sv[m.group(1)[0]] += 1
    arm = {k: 100.0 * sv[k] / want[k] for k in want}
    r.update(arm=arm, worst=min(arm.values()),
             spread=max(arm.values()) - min(arm.values()))
    r.pop("_trip", None)
    return r

if __name__ == "__main__":
    out = {}
    for name, mat in (("peak", gd.PEAK), ("offpeak", gd.OFFPEAK)):
        rou, n, want = prep(mat, name)
        r = run(f"current-{name}", rou, want)
        r["demand"] = n; out[name] = r
        a = r["arm"]
        print(f"=== CURRENT SYSTEM, {name} ({n} veh) ===")
        print(f"  served            {r['served_pct']:6.1f}%   ({r['inserted']} of {n})")
        print(f"  worst approach    {r['worst']:6.1f}%   spread {r['spread']:.1f} pts")
        print(f"  per approach      " + "  ".join(f"{k}:{a[k]:.0f}%" for k in "ENWS"))
        print(f"  travel time       {r['duration']:6.0f} s")
        print(f"  stopped per trip  {r['waiting']:6.0f} s")
        print(f"  wait to enter     {r['depdelay']/60:6.1f} min")
        print(f"  gridlock events   {r['teleports']:6d}")
        print(f"  clear time        {r['clear']/3600:6.2f} h")
        print()
    json.dump(out, open(os.path.join(HERE, "current_results.json"), "w"), indent=1)
