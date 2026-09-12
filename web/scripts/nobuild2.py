#!/usr/bin/env python3
"""No-construction options, take 2.

Fixes over the first pass:
  * sublane vTypes are written as a separate DEMAND file (with lateral
    attributes) instead of an additional-file that collided with the ids
    already defined in the route file.
  * programs are generated from each net's OWN <request> foe matrix and
    connection set, so banning a turn (which renumbers link indices) still
    produces a conflict-safe program.

Nothing here adds pavement, lengthens a link, or adds a lane.
"""
import os, re, subprocess, json
import xml.etree.ElementTree as ET, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "networks", "balegere-no-uturn-traffic.net.xml")
WORK = os.path.join(HERE, "nobuild")
os.makedirs(WORK, exist_ok=True)
SUMO_HOME = "/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo"
SUMO = os.path.join(SUMO_HOME, "bin", "sumo")
NETCONVERT = os.path.join(SUMO_HOME, "bin", "netconvert")

# incoming edge -> arm, for the delivered triangle
ARM_OF_IN = {"E5": "P_Panathur", "-E5": "V_Varthur",
             "-E6": "K_Kundalahalli", "E3": "S_Sarjapur"}
PCU = {"P_Panathur": 1235, "V_Varthur": 1216,
       "K_Kundalahalli": 1111, "S_Sarjapur": 916}
YELLOW = 3


def net_tls_id(txt):
    m = re.search(r'<tlLogic id="([^"]+)"', txt)
    return m.group(1) if m else None


def read_junction(txt, tls):
    """response sets, target lanes, and arm per link index -- from the net."""
    j = re.search(rf'<junction id="{re.escape(tls)}".*?</junction>', txt, re.S)
    resp = {}
    if j:
        for r in re.findall(r'<request\b([^/>]*)/?>', j.group(0)):
            d = dict(re.findall(r'(\w+)="([^"]*)"', r))
            resp[int(d["index"])] = {
                k for k, c in enumerate(reversed(d.get("response", ""))) if c == "1"}
    target, arm = {}, {}
    for m in re.finditer(r'<connection\b([^/>]*)/?>', txt):
        d = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        if d.get("tl") == tls and "linkIndex" in d:
            i = int(d["linkIndex"])
            target[i] = (d["to"], d["toLane"])
            arm[i] = ARM_OF_IN.get(d["from"])
    return resp, target, arm


def make_program(txt, groups, cycle, control):
    """Conflict-safe program for `groups` (ordered list of arm-name lists)."""
    tls = net_tls_id(txt)
    resp, target, arm = read_junction(txt, tls)
    nlinks = max(max(resp or {0: 0}), max(arm or {0: 0})) + 1

    def state_for(S):
        S = set(S)
        prot = {i: ("G" if not (resp.get(i, set()) & S) else "g") for i in S}
        seen = {}
        for i in sorted(S):
            if prot[i] != "G":
                continue
            t = target.get(i)
            if t in seen:
                prot[i] = "g"
            else:
                seen[t] = i
        return "".join(prot.get(i, "r") for i in range(nlinks))

    lost = YELLOW * len(groups)
    eff = cycle - lost
    w = [sum(PCU[a] for a in g) for g in groups]
    greens = [max(8, round(eff * x / sum(w))) for x in w]
    greens[w.index(max(w))] += eff - sum(greens)

    out = [f'<tlLogic id="{tls}" type="{control}" programID="0" offset="0">']
    if control == "actuated":
        for k, v in (("max-gap", "2.5"), ("detector-gap", "2.0"),
                     ("jam-threshold", "10")):
            out.append(f'        <param key="{k}" value="{v}"/>')
    for g, dur in zip(groups, greens):
        links = [i for i, a in arm.items() if a in g]
        s = state_for(links)
        if control == "actuated":
            out.append(f'        <phase duration="{dur}" minDur="8"'
                       f' maxDur="{dur + 20}" state="{s}"/>')
        else:
            out.append(f'        <phase duration="{dur}" state="{s}"/>')
        out.append(f'        <phase duration="{YELLOW}" '
                   f'state="{"".join("y" if c in "Gg" else c for c in s)}"/>')
    out.append("    </tlLogic>")
    prog = "\n".join(out)
    new, n = re.subn(rf'<tlLogic id="{re.escape(tls)}".*?</tlLogic>',
                     prog, txt, flags=re.S)
    assert n == 1
    return new, greens


GROUPS_B = [["V_Varthur", "K_Kundalahalli"], ["P_Panathur", "S_Sarjapur"]]


# ── sublane demand files (vTypes gain lateral attributes) ────────────────
LAT = {
    "passenger":  ('latAlignment="compact" minGapLat="0.35" maxSpeedLat="0.7"'),
    "motorcycle": ('latAlignment="compact" minGapLat="0.12" maxSpeedLat="1.4"'),
    "bus":        ('latAlignment="compact" minGapLat="0.40" maxSpeedLat="0.4"'),
    "truck":      ('latAlignment="compact" minGapLat="0.40" maxSpeedLat="0.4"'),
    "auto":       ('latAlignment="compact" minGapLat="0.20" maxSpeedLat="1.0"'),
}


def sublane_demand(level):
    src = open(os.path.join(HERE, f"demand-{level}-nouturn.rou.xml")).read()

    def add(m):
        vid = re.search(r'id="([^"]+)"', m.group(0)).group(1)
        return m.group(0)[:-2] + " " + LAT.get(vid, "") + "/>"

    out = re.sub(r'<vType id="[^"]+"[^>]*/>', add, src)
    p = os.path.join(WORK, f"demand-{level}-sublane.rou.xml")
    open(p, "w").write(out)
    return p


# ── ban the two worst right turns (signage), rebuild via netconvert ──────
def net_ban_rights():
    """Drop -E6->-E5.51 and E3->E5.36 from the connection file and rebuild.

    Those two right turns each yield to 6-7 other movements. On a single-lane
    approach a vehicle waiting for such a gap blocks everything behind it, so
    removing them is a signage change with an outsized effect. The demand
    re-routes over the triangle's other legs.
    """
    con = open(os.path.join(HERE, "plain", "base.con.xml")).read()
    for f, t in (("-E6", "-E5.51"), ("E3", "E5.36")):
        con, n = re.subn(
            rf'\s*<connection from="{re.escape(f)}" to="{re.escape(t)}"[^>]*/>',
            "", con)
        if n == 0:
            print(f"    warn: no connection {f}->{t} to drop")
    c2 = os.path.join(WORK, "ban.con.xml")
    open(c2, "w").write(con)
    out = os.path.join(WORK, "banright-raw.net.xml")
    p = subprocess.run([NETCONVERT,
                        "--node-files", os.path.join(HERE, "plain", "base.nod.xml"),
                        "--edge-files", os.path.join(HERE, "plain", "base.edg.xml"),
                        "--connection-files", c2,
                        "--tllogic-files", os.path.join(HERE, "plain", "base.tll.xml"),
                        "-o", out, "--lefthand", "--no-turnarounds", "true",
                        "--offset.disable-normalization", "true", "--no-warnings"],
                       capture_output=True, text=True,
                       env=dict(os.environ, SUMO_HOME=SUMO_HOME))
    if p.returncode != 0:
        print("    ban netconvert failed:", p.stderr[-800:])
        return None
    return out


def run(tag, net, level, rou=None, extra=None, keep=False):
    rou = rou or os.path.join(HERE, f"demand-{level}-nouturn.rou.xml")
    tp = os.path.join(WORK, f"{tag}-{level}-trip.xml")
    sm = os.path.join(WORK, f"{tag}-{level}-sum.xml")
    cmd = [SUMO, "-n", net, "-r", rou,
           "--tripinfo-output", tp, "--summary-output", sm,
           "--seed", "42", "--step-length", "1",
           "--time-to-teleport", "300", "--max-depart-delay", "1800",
           "--end", "20000", "--no-step-log", "--no-warnings"] + (extra or [])
    p = subprocess.run(cmd, capture_output=True, text=True,
                       env=dict(os.environ, SUMO_HOME=SUMO_HOME))
    if p.returncode != 0:
        print(f"    {tag}/{level} FAILED: {(p.stderr or p.stdout)[-500:]}")
        return None
    dur, dep, loss, wait = [], [], [], []
    for _, el in ET.iterparse(tp, events=("end",)):
        if el.tag == "tripinfo":
            dur.append(float(el.get("duration")))
            dep.append(float(el.get("departDelay")))
            loss.append(float(el.get("timeLoss")))
            wait.append(float(el.get("waitingTime")))
            el.clear()
    steps = []
    for _, el in ET.iterparse(sm, events=("end",)):
        if el.tag == "step":
            steps.append({k: float(v) for k, v in el.attrib.items()}); el.clear()
    if not dur:
        return None
    last = steps[-1]
    occ = [s for s in steps if s["running"] > 0]
    ndem = open(rou).read().count("<trip ")
    d, dd = st.mean(dur), st.mean(dep)
    if not keep:
        for f in (tp, sm):
            try: os.remove(f)
            except OSError: pass
    return {"tag": tag, "level": level,
            "served_pct": 100.0 * last["inserted"] / ndem,
            "inserted": int(last["inserted"]), "demand": ndem,
            "unserved": ndem - int(last["inserted"]),
            "duration": d, "depdelay": dd, "door2door": d + dd,
            "timeloss": st.mean(loss), "waiting": st.mean(wait),
            "halt_pct": 100.0 * sum(s["halting"] for s in occ) /
                        max(1, sum(s["running"] for s in occ)),
            "teleports": int(last["teleports"]),
            "clear": max((s["time"] for s in steps if s["running"] > 0), default=0),
            "_trip": tp if keep else None}


if __name__ == "__main__":
    src = open(SRC).read()

    nets = {"base": SRC}

    for label, cyc, ctl in (("timing", 120, "static"),
                            ("timing-act", 70, "actuated")):
        txt, g = make_program(src, GROUPS_B, cyc, ctl)
        p = os.path.join(WORK, f"{label}.net.xml")
        open(p, "w").write(txt)
        nets[label] = p
        print(f"  {label}: cycle={cyc} {ctl} greens={g}")

    banraw = net_ban_rights()
    if banraw:
        txt, g = make_program(open(banraw).read(), GROUPS_B, 120, "static")
        p = os.path.join(WORK, "banright.net.xml")
        open(p, "w").write(txt)
        nets["banright"] = p
        print(f"  banright: cycle=120 static greens={g}")

    SUB = ["--lateral-resolution", "0.8"]
    rows = []
    for level in ("peak", "offpeak"):
        subrou = sublane_demand(level)
        cases = [(k, v, None, None) for k, v in nets.items()]
        cases.append(("sublane", nets["timing"], subrou, SUB))
        cases.append(("sublane-base", SRC, subrou, SUB))
        if "banright" in nets:
            cases.append(("combo", nets["banright"], subrou, SUB))
        for tag, net, rou, extra in cases:
            r = run(tag, net, level, rou, extra)
            if r:
                rows.append(r)

    json.dump(rows, open(os.path.join(HERE, "nobuild_results.json"), "w"), indent=1)
    for level in ("peak", "offpeak"):
        sel = sorted([r for r in rows if r["level"] == level],
                     key=lambda r: (-r["served_pct"], r["door2door"]))
        print(f"\n{'='*104}\nNO-CONSTRUCTION OPTIONS -- {level.upper()} "
              f"({sel[0]['demand']} veh)\n{'='*104}")
        print(f"{'option':<14}{'%served':>9}{'unserved':>10}{'travel':>9}"
              f"{'depdly':>9}{'door2door':>11}{'timeloss':>10}{'stopped':>9}"
              f"{'halt%':>8}{'tele':>6}")
        for r in sel:
            print(f"{r['tag']:<14}{r['served_pct']:>9.1f}{r['unserved']:>10d}"
                  f"{r['duration']:>9.1f}{r['depdelay']:>9.1f}"
                  f"{r['door2door']:>11.1f}{r['timeloss']:>10.1f}"
                  f"{r['waiting']:>9.1f}{r['halt_pct']:>8.1f}{r['teleports']:>6d}")
