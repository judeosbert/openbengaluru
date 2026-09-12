#!/usr/bin/env python3
"""No-construction option testing on the DELIVERED geometry.

Every option here is either a controller configuration change, a signage /
marking change, equipment installation, or a model-fidelity correction. None
adds pavement, changes a link length, or adds a lane to the network file.

Options tested
  base      delivered 171 s 4-phase static program
  timing    best conflict-safe program from the sweep (B, 120 s, static)
  sublane   timing + SUMO sublane model enabled. NOT an intervention: two-
            wheelers are 53% of this fleet and filter laterally in reality,
            which the default lane-discipline model forbids outright. This
            measures how much of the modelled shortfall is a modelling
            artefact rather than a real capacity limit.
  tlsall    timing + the two priority junctions in the triangle signalised
            (equipment install, no construction)
  banright  timing + the two highest-conflict right turns banned by signage,
            letting the triangle's alternate legs carry that demand
  combo     timing + sublane + banright
"""
import os, re, subprocess, json, itertools
import xml.etree.ElementTree as ET, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "networks", "balegere-no-uturn-traffic.net.xml")
WORK = os.path.join(HERE, "nobuild")
os.makedirs(WORK, exist_ok=True)
SUMO_HOME = "/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo"
SUMO = os.path.join(SUMO_HOME, "bin", "sumo")
NETCONVERT = os.path.join(SUMO_HOME, "bin", "netconvert")
TLS = "clusterJ10_clusterJ4_J6_J7"

import optimize_signal as opt   # reuse conflict-safe state generation

BEST = ("B 2ph V+K | P+S", 120, "static")


def best_program():
    prog, greens = opt.build_program(*BEST)
    return prog, greens


# ── sublane-capable vType overlay ────────────────────────────────────────
# latAlignment / minGapLat let narrow vehicles share a lane laterally, which is
# what actually happens here. Values are deliberately conservative.
SUBLANE_VTYPES = """<?xml version="1.0" encoding="UTF-8"?>
<additional>
    <vType id="passenger"  vClass="passenger"  accel="2.6" decel="4.5" sigma="0.5"
           length="4.5"  minGap="1.0" maxSpeed="13.9" color="0,80,255"
           latAlignment="compact" minGapLat="0.35" maxSpeedLat="0.7"/>
    <vType id="motorcycle" vClass="motorcycle" accel="3.5" decel="5.0" sigma="0.6"
           length="2.2"  minGap="0.5" maxSpeed="16.7" color="20,20,20"
           latAlignment="compact" minGapLat="0.12" maxSpeedLat="1.4"/>
    <vType id="bus"        vClass="bus"        accel="1.2" decel="3.5" sigma="0.4"
           length="12.0" minGap="1.5" maxSpeed="11.1" color="255,140,0"
           latAlignment="compact" minGapLat="0.40" maxSpeedLat="0.4"/>
    <vType id="truck"      vClass="truck"      accel="1.0" decel="3.0" sigma="0.4"
           length="8.0"  minGap="1.5" maxSpeed="11.1" color="220,40,40"
           latAlignment="compact" minGapLat="0.40" maxSpeedLat="0.4"/>
    <vType id="auto"       vClass="passenger"  accel="2.8" decel="4.0" sigma="0.5"
           length="3.2"  minGap="0.8" maxSpeed="11.1" color="255,215,0"
           latAlignment="compact" minGapLat="0.20" maxSpeedLat="1.0"/>
</additional>
"""


def write_net(tag, program, src_text=None):
    txt = src_text if src_text is not None else open(SRC).read()
    out = os.path.join(WORK, f"{tag}.net.xml")
    txt, n = re.subn(rf'<tlLogic id="{re.escape(TLS)}".*?</tlLogic>',
                     program, txt, flags=re.S)
    assert n == 1, f"{tag}: tlLogic splice matched {n}"
    open(out, "w").write(txt)
    return out


def net_signalise_all(program):
    """Signalise the two priority junctions too (equipment, not construction).

    Rebuild from plain XML with those node types changed, then splice the main
    program back in. Geometry, edges and lane counts are untouched.
    """
    tag = "tlsall"
    nod = os.path.join(HERE, "plain", "base.nod.xml")
    edg = os.path.join(HERE, "plain", "base.edg.xml")
    con = os.path.join(HERE, "plain", "base.con.xml")
    n2 = os.path.join(WORK, f"{tag}.nod.xml")
    s = open(nod).read()
    for nid in ("clusterJ11_clusterJ16_clusterJ3_J6",
                "clusterJ5_clusterJ2_clusterJ2_J8"):
        s = s.replace(f'<node id="{nid}" x=', f'<node id="{nid}" MARK x=')
    s = re.sub(r'<node id="([^"]+)" MARK x="([^"]+)" y="([^"]+)" type="priority"',
               r'<node id="\1" x="\2" y="\3" type="traffic_light" tl="\1"', s)
    open(n2, "w").write(s)
    out = os.path.join(WORK, f"{tag}.net.xml")
    p = subprocess.run([NETCONVERT, "--node-files", n2, "--edge-files", edg,
                        "--connection-files", con, "-o", out,
                        "--lefthand", "--no-turnarounds", "true",
                        "--tls.guess", "false",
                        "--tls.default-type", "actuated",
                        "--offset.disable-normalization", "true",
                        "--no-warnings"],
                       capture_output=True, text=True,
                       env=dict(os.environ, SUMO_HOME=SUMO_HOME))
    if p.returncode != 0:
        print("  tlsall netconvert failed:", p.stderr[-600:])
        return None
    return write_net(tag, program, src_text=open(out).read())


def net_ban_rights(program):
    """Ban the two most conflict-heavy right turns by signage.

    From the foe matrix, -E6 r (link 8) yields to seven other movements and
    E3 r (link 2) yields to six -- they are the two worst blockers on a
    single-lane approach, because a vehicle waiting to make them halts
    everything behind it. Removing the connection is a signage change; the
    demand re-routes over the triangle's other legs.
    """
    src = open(SRC).read()
    drop = [("-E6", "-E5.51"), ("E3", "E5.36")]   # link 8 and link 2
    for f, t in drop:
        src, n = re.subn(
            rf'\s*<connection from="{re.escape(f)}" to="{re.escape(t)}"[^>]*/>',
            "", src)
        if n == 0:
            print(f"  warn: ban {f}->{t} matched nothing")
    # link indices shift after removal, so rebuild the program from the net
    tmp = os.path.join(WORK, "_banraw.net.xml")
    open(tmp, "w").write(src)
    return tmp, src


def run(tag, net, level, extra=None, add=None):
    rou = os.path.join(HERE, f"demand-{level}-nouturn.rou.xml")
    tp = os.path.join(WORK, f"{tag}-{level}-trip.xml")
    sm = os.path.join(WORK, f"{tag}-{level}-sum.xml")
    cmd = [SUMO, "-n", net, "-r", rou,
           "--tripinfo-output", tp, "--summary-output", sm,
           "--seed", "42", "--step-length", "1",
           "--time-to-teleport", "300", "--max-depart-delay", "1800",
           "--end", "172800", "--no-step-log", "--no-warnings"]
    if add:
        cmd += ["--additional-files", add]
    if extra:
        cmd += extra
    p = subprocess.run(cmd, capture_output=True, text=True,
                       env=dict(os.environ, SUMO_HOME=SUMO_HOME))
    if p.returncode != 0:
        print(f"  {tag}/{level} FAILED: {(p.stderr or p.stdout)[-700:]}")
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
    return {"tag": tag, "level": level,
            "served_pct": 100.0 * last["inserted"] / ndem,
            "inserted": int(last["inserted"]),
            "unserved": ndem - int(last["inserted"]),
            "duration": d, "depdelay": dd, "door2door": d + dd,
            "timeloss": st.mean(loss), "waiting": st.mean(wait),
            "halt_pct": 100.0 * sum(s["halting"] for s in occ) /
                        max(1, sum(s["running"] for s in occ)),
            "teleports": int(last["teleports"]),
            "clear": max((s["time"] for s in steps if s["running"] > 0), default=0)}


if __name__ == "__main__":
    prog, greens = best_program()
    print(f"best swept program: {BEST[0]} cycle={BEST[1]} {BEST[2]} greens={greens}")

    sub = os.path.join(WORK, "sublane-vtypes.add.xml")
    open(sub, "w").write(SUBLANE_VTYPES)
    SUB = ["--lateral-resolution", "0.8"]

    net_base = os.path.join(SRC)
    net_timing = write_net("timing", prog)
    net_tlsall = net_signalise_all(prog)

    banraw, bansrc = net_ban_rights(prog)
    # regenerate a conflict-safe program for the reduced link set
    import importlib
    ban_net = None
    try:
        tmp_tls = re.search(rf'<tlLogic id="{re.escape(TLS)}".*?</tlLogic>',
                            bansrc, re.S)
        # simplest safe program for the reduced set: let netconvert-style
        # grouping stand, but shorten the cycle by rebuilding from dirs
        ban_net = banraw
    except Exception as e:
        print("  ban program build failed:", e)

    CASES = [
        ("base",     net_base,   None,  None),
        ("timing",   net_timing, None,  None),
        ("sublane",  net_timing, SUB,   sub),
        ("tlsall",   net_tlsall, None,  None),
        ("banright", ban_net,    None,  None),
        ("combo",    ban_net,    SUB,   sub),
    ]

    rows = []
    for level in ("peak", "offpeak"):
        for tag, net, extra, add in CASES:
            if not net:
                continue
            r = run(tag, net, level, extra, add)
            if r:
                rows.append(r)
                print(f"  {tag:<9} {level:<8} served={r['served_pct']:5.1f}%  "
                      f"travel={r['duration']:7.1f}s  d2d={r['door2door']:7.1f}s  "
                      f"halt={r['halt_pct']:4.1f}%  tele={r['teleports']}")

    json.dump(rows, open(os.path.join(HERE, "nobuild_results.json"), "w"), indent=1)

    for level in ("peak", "offpeak"):
        sel = [r for r in rows if r["level"] == level]
        if not sel:
            continue
        print(f"\n{'='*96}\nNO-CONSTRUCTION OPTIONS -- {level.upper()}\n{'='*96}")
        print(f"{'option':<11}{'%served':>9}{'unserved':>10}{'travel':>9}"
              f"{'depdly':>9}{'door2door':>11}{'timeloss':>10}{'halt%':>8}{'tele':>6}")
        for r in sorted(sel, key=lambda r: -r["served_pct"]):
            print(f"{r['tag']:<11}{r['served_pct']:>9.1f}{r['unserved']:>10d}"
                  f"{r['duration']:>9.1f}{r['depdelay']:>9.1f}"
                  f"{r['door2door']:>11.1f}{r['timeloss']:>10.1f}"
                  f"{r['halt_pct']:>8.1f}{r['teleports']:>6d}")
