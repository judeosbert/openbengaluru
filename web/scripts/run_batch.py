#!/usr/bin/env python3
"""Run every (network x demand-level) combination and tabulate results.

All runs share: demand (see gen_demand.py), seed, step length, teleport policy,
depart-delay cap and end time. The only thing that varies is the .net.xml.
"""
import os, subprocess, sys, xml.etree.ElementTree as ET, statistics as st, collections

HERE = os.path.dirname(os.path.abspath(__file__))
NETS = os.path.join(HERE, "..", "networks")
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

SUMO_HOME = "/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo"
SUMO = os.path.join(SUMO_HOME, "bin", "sumo")

# label -> (net file, demand mapping key)
NETWORKS = [
    # label,           net path (relative to this file),                    demand mapping
    ("1-baseline",     "../networks/BELAGERE.net.xml",                  "baseline"),
    ("2-nouturn",      "../networks/balegere-no-uturn.net.xml",         "nouturn"),
    ("3-nouturn-tls",  "../networks/balegere-no-uturn-traffic.net.xml", "nouturn"),
    ("4-retimed",      "nets/V4-retimed.net.xml",                      "nouturn"),
    ("5-joined",       "nets/V5-joined.net.xml",                       "nouturn"),
    ("6-2lane",        "nets/V6-2lane.net.xml",                        "nouturn"),
    ("7-3lane-ew",     "nets/V7-3lane-ew.net.xml",                     "nouturn"),
    ("8-tri-wide",     "nets/V8-triangle-wide.net.xml",                 "nouturn"),
    ("9-3lane-all",    "nets/V9-3lane-all.net.xml",                    "nouturn"),
]

# Shared, explicit run policy -- nothing left to defaults that matters.
#   time-to-teleport 300 : SUMO default. Kept ON so gridlocked runs terminate;
#                          teleport count is then the deadlock metric.
#   max-depart-delay 1800: a trip that cannot start within 30 min is a failed
#                          trip and is discarded rather than inflating waiting
#                          time by hours. Discarded count = unserved demand.
#   end 172800           : 48 h safety net only -- never the binding
#                          constraint. Real clear time is read from the summary
#                          as the last step with running > 0.
COMMON = [
    "--seed", "42",
    "--step-length", "1",
    "--time-to-teleport", "300",
    "--max-depart-delay", "1800",
    "--end", "172800",
    "--duration-log.statistics",
    "--no-step-log",
    "--no-warnings",
]


def run(label, netfile, mapkey, level):
    tag = f"{label}-{level}"
    net = os.path.join(HERE, netfile)
    rou = os.path.join(HERE, f"demand-{level}-{mapkey}.rou.xml")
    cmd = [SUMO, "-n", net, "-r", rou,
           "--tripinfo-output", os.path.join(OUT, f"{tag}-tripinfo.xml"),
           "--summary-output",  os.path.join(OUT, f"{tag}-summary.xml"),
           "--queue-output",    os.path.join(OUT, f"{tag}-queue.xml")] + COMMON
    env = dict(os.environ, SUMO_HOME=SUMO_HOME)
    print(f"  running {tag} ...", flush=True)
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if p.returncode != 0:
        print(f"    FAILED rc={p.returncode}")
        print("    " + (p.stderr or p.stdout)[-1500:])
        return None
    return tag


def parse(tag, n_demand):
    """Real per-vehicle metrics from tripinfo + integrals from summary."""
    tp = os.path.join(OUT, f"{tag}-tripinfo.xml")
    dur, wait, loss, rlen, depdelay, speed = [], [], [], [], [], []
    for _, el in ET.iterparse(tp, events=("end",)):
        if el.tag == "tripinfo":
            d = float(el.get("duration")); L = float(el.get("routeLength"))
            dur.append(d); wait.append(float(el.get("waitingTime")))
            loss.append(float(el.get("timeLoss"))); rlen.append(L)
            depdelay.append(float(el.get("departDelay")))
            if d > 0:
                speed.append(L / d)
            el.clear()

    sm = os.path.join(OUT, f"{tag}-summary.xml")
    steps = []
    for _, el in ET.iterparse(sm, events=("end",)):
        if el.tag == "step":
            steps.append({k: float(v) for k, v in el.attrib.items()}); el.clear()
    last = steps[-1]
    vehs = sum(s["running"] for s in steps)
    halts = sum(s["halting"] for s in steps)
    # --end is a safety cap, so last["time"] is not the clear time. The real
    # clear time is the last instant any vehicle was still in the network.
    clear = max((s["time"] for s in steps if s["running"] > 0), default=0.0)
    # Integrate only over steps where the network was actually occupied.
    occupied = [s for s in steps if s["running"] > 0]
    vehs = sum(s["running"] for s in occupied)
    halts = sum(s["halting"] for s in occupied)

    q = os.path.join(OUT, f"{tag}-queue.xml")
    ql = []
    if os.path.exists(q):
        for _, el in ET.iterparse(q, events=("end",)):
            if el.tag == "lane":
                ql.append(float(el.get("queueing_length", 0))); el.clear()

    arrived = len(dur)
    return {
        "tag": tag,
        "demand": n_demand,
        "inserted": int(last["inserted"]),
        "arrived": arrived,
        "discarded": n_demand - int(last["inserted"]),
        "served_pct": 100.0 * arrived / n_demand,
        "end_time": clear,
        "teleports": int(last["teleports"]),
        "collisions": int(last["collisions"]),
        "duration": st.mean(dur) if dur else float("nan"),
        "waiting": st.mean(wait) if wait else float("nan"),
        "timeloss": st.mean(loss) if loss else float("nan"),
        "routelen": st.mean(rlen) if rlen else float("nan"),
        "depdelay": st.mean(depdelay) if depdelay else float("nan"),
        "speed": st.mean(speed) if speed else float("nan"),
        "veh_h": vehs / 3600.0,
        "halt_pct": 100.0 * halts / vehs if vehs else float("nan"),
        "thr_h1": max((s["arrived"] for s in steps if s["time"] <= 3600), default=0),
        "q_mean": st.mean(ql) if ql else float("nan"),
        "q_p95": sorted(ql)[int(0.95 * len(ql))] if ql else float("nan"),
    }


def table(rows, title):
    print(f"\n{'='*118}\n{title}\n{'='*118}")
    FIELDS = [
        ("demand",    "demand veh",    "{:>10.0f}"),
        ("inserted",  "inserted",      "{:>10.0f}"),
        ("discarded", "unserved",      "{:>10.0f}"),
        ("served_pct","% served",      "{:>10.1f}"),
        ("end_time",  "clear time s",  "{:>10.0f}"),
        ("thr_h1",    "arrivals h1",   "{:>10.0f}"),
        ("duration",  "travel time s", "{:>10.1f}"),
        ("timeloss",  "time lost s",   "{:>10.1f}"),
        ("waiting",   "stopped s",     "{:>10.1f}"),
        ("depdelay",  "dep delay s *", "{:>10.1f}"),
        ("speed",     "speed m/s",     "{:>10.2f}"),
        ("routelen",  "route len m",   "{:>10.1f}"),
        ("veh_h",     "veh-hours",     "{:>10.1f}"),
        ("halt_pct",  "% time halted", "{:>10.1f}"),
        ("teleports", "teleports",     "{:>10.0f}"),
        ("q_mean",    "queue mean m",  "{:>10.1f}"),
        ("q_p95",     "queue p95 m",   "{:>10.1f}"),
    ]
    W = 14
    print(f"{'metric':<16}" + "".join(
        f"{r['tag'].replace('-peak','').replace('-offpeak',''):>{W}}" for r in rows))
    print("-" * (16 + W * len(rows)))
    for key, label, fmt in FIELDS:
        line = f"{label:<16}"
        for r in rows:
            line += f"{fmt.format(r[key]).strip():>{W}}"
        print(line)


if __name__ == "__main__":
    import re
    levels = sys.argv[1:] or ["peak", "offpeak"]
    for level in levels:
        counts = {}
        for mapkey in ("baseline", "nouturn"):
            f = os.path.join(HERE, f"demand-{level}-{mapkey}.rou.xml")
            counts[mapkey] = open(f).read().count("<trip ")
        rows = []
        print(f"\n### demand level: {level}  ({counts['baseline']} vehicles)")
        for label, netfile, mapkey in NETWORKS:
            tag = run(label, netfile, mapkey, level)
            if tag:
                rows.append(parse(tag, counts[mapkey]))
        if rows:
            table(rows, f"UNIFIED DEMAND -- {level.upper()}  "
                        f"({counts['baseline']} vehicles, identical trip set)")
            print("\n* depart delay, travel time, time lost, stopped time and speed are")
            print("  averaged over COMPLETED trips only. Vehicles that never got an")
            print("  insertion slot within 1800 s are counted in 'unserved' and are")
            print("  absent from those averages -- so a network with high 'unserved'")
            print("  flatters its own per-vehicle numbers. Read % served first.")
