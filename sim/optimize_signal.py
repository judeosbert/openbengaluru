#!/usr/bin/env python3
"""Find the best signal program for the DELIVERED geometry.

Hard constraint: no construction. The network file is not modified in any way
that changes geometry -- same nodes, same edges, same single lane per approach.
The ONLY thing that varies is the <tlLogic> block, which is a controller
configuration change.

Green states are derived from the junction's own <request> response matrix
rather than assumed, so every generated program is conflict-safe: a link is
protected ('G') only if nothing else green in that phase has priority over it,
and permissive ('g') otherwise. Two protected links are never allowed to target
the same lane.
"""
import os, re, itertools, subprocess, multiprocessing as mp
import xml.etree.ElementTree as ET, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "networks", "balegere-no-uturn-traffic.net.xml")
WORK = os.path.join(HERE, "opt")
os.makedirs(WORK, exist_ok=True)
SUMO_HOME = "/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo"
SUMO = os.path.join(SUMO_HOME, "bin", "sumo")
TLS = "clusterJ10_clusterJ4_J6_J7"

# approach -> link indices, read from the delivered net
APPROACH = {
    "P_Panathur":     [9, 10],      # E5
    "V_Varthur":      [3, 4, 5],    # -E5
    "K_Kundalahalli": [6, 7, 8],    # -E6
    "S_Sarjapur":     [0, 1, 2],    # E3
}
PCU = {"P_Panathur": 1235, "V_Varthur": 1216,
       "K_Kundalahalli": 1111, "S_Sarjapur": 916}

YELLOW = 3


def load_conflicts():
    """response[i] = set of links that i must yield to; target[i] = target lane."""
    s = open(SRC).read()
    j = re.search(rf'<junction id="{re.escape(TLS)}".*?</junction>', s, re.S).group(0)
    resp = {}
    for r in re.findall(r'<request\b([^/>]*)/?>', j):
        d = dict(re.findall(r'(\w+)="([^"]*)"', r))
        i = int(d["index"])
        # SUMO bitstrings are indexed right-to-left
        resp[i] = {k for k, c in enumerate(reversed(d.get("response", ""))) if c == "1"}
    target = {}
    for m in re.finditer(r'<connection\b([^/>]*)/?>', s):
        d = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        if d.get("tl") == TLS and "linkIndex" in d:
            target[int(d["linkIndex"])] = (d["to"], d["toLane"])
    return resp, target


RESP, TARGET = load_conflicts()
NLINKS = len(RESP)


def state_for(green_links):
    """Conflict-safe state string for a set of simultaneously-served links."""
    S = set(green_links)
    prot = {}
    for i in sorted(S):
        prot[i] = "G" if not (RESP[i] & S) else "g"
    # belt and braces: two protected links must never target the same lane
    seen = {}
    for i in sorted(S):
        if prot[i] != "G":
            continue
        t = TARGET.get(i)
        if t in seen:
            prot[i] = "g"          # demote the later one
        else:
            seen[t] = i
    return "".join(prot.get(i, "r") for i in range(NLINKS))


def yellow_of(state):
    return "".join("y" if c in "Gg" else c for c in state)


# ── phase structures: ordered list of approach groups ────────────────────
STRUCTURES = {
    "A 2ph V+P | K+S": [["V_Varthur", "P_Panathur"], ["K_Kundalahalli", "S_Sarjapur"]],
    "B 2ph V+K | P+S": [["V_Varthur", "K_Kundalahalli"], ["P_Panathur", "S_Sarjapur"]],
    "C 2ph V+S | P+K": [["V_Varthur", "S_Sarjapur"], ["P_Panathur", "K_Kundalahalli"]],
    "D 4ph single":    [["V_Varthur"], ["P_Panathur"], ["K_Kundalahalli"], ["S_Sarjapur"]],
    "E 3ph V+P|K|S":   [["V_Varthur", "P_Panathur"], ["K_Kundalahalli"], ["S_Sarjapur"]],
    "F 3ph V+P|S|K":   [["V_Varthur", "P_Panathur"], ["S_Sarjapur"], ["K_Kundalahalli"]],
    "G 3ph K+S|V|P":   [["K_Kundalahalli", "S_Sarjapur"], ["V_Varthur"], ["P_Panathur"]],
}
CYCLES = [50, 60, 70, 80, 90, 100, 120]
CONTROLS = ["actuated", "static"]


def build_program(struct, cycle, control):
    groups = STRUCTURES[struct]
    lost = YELLOW * len(groups)
    eff = cycle - lost
    if eff < 8 * len(groups):
        return None
    weights = [sum(PCU[a] for a in g) for g in groups]
    tot = sum(weights)
    greens = [max(8, round(eff * w / tot)) for w in weights]
    # correct rounding drift onto the largest group
    drift = eff - sum(greens)
    greens[weights.index(max(weights))] += drift

    lines = [f'<tlLogic id="{TLS}" type="{control}" programID="0" offset="0">']
    if control == "actuated":
        for k, v in (("max-gap", "2.5"), ("detector-gap", "2.0"),
                     ("jam-threshold", "10")):
            lines.append(f'        <param key="{k}" value="{v}"/>')
    for g, dur in zip(groups, greens):
        links = [i for a in g for i in APPROACH[a]]
        stt = state_for(links)
        if control == "actuated":
            lines.append(f'        <phase duration="{dur}" minDur="8"'
                         f' maxDur="{dur + 20}" state="{stt}"/>')
        else:
            lines.append(f'        <phase duration="{dur}" state="{stt}"/>')
        lines.append(f'        <phase duration="{YELLOW}" state="{yellow_of(stt)}"/>')
    lines.append("    </tlLogic>")
    return "\n".join(lines), greens


SRC_TEXT = open(SRC).read()


def write_net(tag, program):
    out = os.path.join(WORK, f"{tag}.net.xml")
    txt, n = re.subn(rf'<tlLogic id="{re.escape(TLS)}".*?</tlLogic>',
                     program, SRC_TEXT, flags=re.S)
    assert n == 1
    open(out, "w").write(txt)
    return out


def evaluate(args):
    struct, cycle, control, level = args
    built = build_program(struct, cycle, control)
    if built is None:
        return None
    program, greens = built
    tag = (f"{struct.split()[0]}_{cycle}_{control[:3]}_{level}"
           .replace(" ", "").replace("+", "").replace("|", ""))
    net = write_net(tag, program)
    rou = os.path.join(HERE, f"demand-{level}-nouturn.rou.xml")
    tp = os.path.join(WORK, f"{tag}-trip.xml")
    sm = os.path.join(WORK, f"{tag}-sum.xml")
    cmd = [SUMO, "-n", net, "-r", rou,
           "--tripinfo-output", tp, "--summary-output", sm,
           "--seed", "42", "--step-length", "1",
           "--time-to-teleport", "300", "--max-depart-delay", "1800",
           "--end", "172800", "--no-step-log", "--no-warnings"]
    p = subprocess.run(cmd, capture_output=True, text=True,
                       env=dict(os.environ, SUMO_HOME=SUMO_HOME))
    if p.returncode != 0:
        return None

    dur, wait, loss, dep = [], [], [], []
    for _, el in ET.iterparse(tp, events=("end",)):
        if el.tag == "tripinfo":
            dur.append(float(el.get("duration")))
            wait.append(float(el.get("waitingTime")))
            loss.append(float(el.get("timeLoss")))
            dep.append(float(el.get("departDelay")))
            el.clear()
    steps = []
    for _, el in ET.iterparse(sm, events=("end",)):
        if el.tag == "step":
            steps.append({k: float(v) for k, v in el.attrib.items()}); el.clear()
    if not dur or not steps:
        return None
    last = steps[-1]
    occ = [s for s in steps if s["running"] > 0]
    ndem = open(rou).read().count("<trip ")
    d = st.mean(dur); dd = st.mean(dep)
    return {
        "struct": struct, "cycle": cycle, "control": control, "level": level,
        "greens": greens,
        "served_pct": 100.0 * last["inserted"] / ndem,
        "inserted": int(last["inserted"]),
        "unserved": ndem - int(last["inserted"]),
        "duration": d, "depdelay": dd, "door2door": d + dd,
        "timeloss": st.mean(loss), "waiting": st.mean(wait),
        "halt_pct": 100.0 * sum(s["halting"] for s in occ) /
                    max(1, sum(s["running"] for s in occ)),
        "teleports": int(last["teleports"]),
        "clear": max((s["time"] for s in steps if s["running"] > 0), default=0),
    }


if __name__ == "__main__":
    jobs = [(s, c, k, "peak")
            for s in STRUCTURES for c in CYCLES for k in CONTROLS]
    print(f"evaluating {len(jobs)} signal programs on the delivered geometry "
          f"(peak, 5743 veh)...")
    with mp.Pool(min(6, mp.cpu_count())) as pool:
        res = [r for r in pool.map(evaluate, jobs) if r]
    res.sort(key=lambda r: (-r["served_pct"], r["door2door"]))

    print(f"\n{'='*112}")
    print(f"{'rank':<5}{'structure':<18}{'cyc':>5}{'ctrl':>10}"
          f"{'%served':>9}{'unserved':>10}{'travel':>9}{'depdly':>9}"
          f"{'door2door':>11}{'halt%':>8}{'tele':>6}")
    print("=" * 112)
    for i, r in enumerate(res[:22], 1):
        print(f"{i:<5}{r['struct']:<18}{r['cycle']:>5}{r['control']:>10}"
              f"{r['served_pct']:>9.1f}{r['unserved']:>10d}{r['duration']:>9.1f}"
              f"{r['depdelay']:>9.1f}{r['door2door']:>11.1f}"
              f"{r['halt_pct']:>8.1f}{r['teleports']:>6d}")

    import json
    json.dump(res, open(os.path.join(HERE, "opt_results.json"), "w"), indent=1)
    print(f"\nbest: {res[0]['struct']} cycle={res[0]['cycle']} "
          f"{res[0]['control']} greens={res[0]['greens']}")
