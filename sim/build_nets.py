#!/usr/bin/env python3
"""Build improved network variants by applying the remediation tiers.

Ladder (each adds one change to the previous):
  V4  T1        retimed signal only - original triangle topology, 1 lane
  V5  T1+T2     three internal nodes joined into one 4-way signal, 1 lane
  V6  T1+T2+T3a joined 4-way, 2 lanes every approach
  V7  T1+T2+T3b joined 4-way, 3 lanes on the E-W corridor, 2 on N-S

T1 = replace the 171 s / 4-phase / fully-protected static plan with an
     actuated 2-phase plan serving opposing arms together.
T2 = join the internal nodes. The original models this junction as a triangle
     of three nodes 19.6 m and 37.0 m apart, joined by 15.5 m and 23.8 m
     micro-links that cannot store a queue - and it lets E0 -> E1 -> -E4 skip
     the signal entirely. balegare-data.txt describes a 4-way signalised
     intersection, so one node is the truer model as well as the faster one.
T3 = add lanes. Every approach is single-lane in all original variants.

Network is LEFT-HAND traffic (lefthand=1 in the source net), so a left turn is
the near-side non-conflicting movement and a right turn crosses opposing
traffic. Right turns are therefore permissive, not protected.
"""
import os, re, subprocess, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
NETS = os.path.join(HERE, "nets")
PLAIN = os.path.join(HERE, "plain")
os.makedirs(NETS, exist_ok=True)
os.makedirs(PLAIN, exist_ok=True)

SUMO_HOME = "/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo"
NETCONVERT = os.path.join(SUMO_HOME, "bin", "netconvert")
SRC_NET = os.path.join(HERE, "..", "networks", "balegere-no-uturn-traffic.net.xml")

# Arm identity, from the original route-file names (kundalahalli_panathur etc.)
#   arm: (boundary node, in-edge, out-edge, node x, node y)
ARMS = {
    "E_Panathur":     ("J0",  "E0",  "-E0.79.36", -131.59, -0.13),
    "W_Varthur":      ("J3",  "-E2", "E2",         115.03,  0.69),
    "N_Kundalahalli": ("J15", "E4",  "-E4",          0.64, 59.52),
    "S_Sarjapur":     ("J2",  "E3",  "-E3",         -5.43, -55.56),
}
CX, CY = -3.69, 3.03          # signalised node: the original traffic_light node
TLS_ID = "BalegereX"

# Green split from surveyed PCU per arm (balegare-data.txt):
#   E 1235 + W 1216 = 2451   N 1111 + S 916 = 2027   total 4478
# Webster-style proportional split of effective green.
CYCLE_TARGET = 90
LOST_PER_PHASE = 3            # yellow
N_PHASES = 2
EFFECTIVE = CYCLE_TARGET - N_PHASES * LOST_PER_PHASE
G_EW = round(EFFECTIVE * 2451 / 4478)
G_NS = EFFECTIVE - G_EW


def sh(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True,
                       env=dict(os.environ, SUMO_HOME=SUMO_HOME))
    if p.returncode != 0:
        raise SystemExit(f"netconvert failed:\n{' '.join(cmd)}\n{p.stderr[-2000:]}")
    return p.stdout + p.stderr


# ── V4: retime the original topology, nothing else ───────────────────────
def build_v4():
    """Original 11-link junction, new 2-phase actuated program.

    Link indices in the source net:
      0,1,2 = E3 (l,s,r)   3,4,5 = -E5 (l,s,r)
      6,7,8 = -E6 (l,s,r)  9,10  = E5 (s,r)
    Approach -> arm: E3 = Sarjapur, -E5 = Varthur, -E6 = Kundalahalli,
    E5 = Panathur. So opposing pairs are (-E5, E5) = W+E and (E3, -E6) = S+N.
    """
    src = open(SRC_NET).read()
    ew = ['r'] * 11
    for i in (3, 4, 5, 9, 10):
        ew[i] = 'G'
    ns = ['r'] * 11
    for i in (0, 1, 2, 6, 7, 8):
        ns[i] = 'G'

    def yellow(state):
        return "".join('y' if c in 'Gg' else c for c in state)

    ew_s, ns_s = "".join(ew), "".join(ns)
    prog = (
        f'<tlLogic id="clusterJ10_clusterJ4_J6_J7" type="actuated" programID="0" offset="0">\n'
        f'        <param key="max-gap" value="2.5"/>\n'
        f'        <param key="detector-gap" value="2.0"/>\n'
        f'        <param key="jam-threshold" value="10"/>\n'
        f'        <phase duration="{G_EW}" minDur="10" maxDur="{G_EW + 15}" state="{ew_s}"/>\n'
        f'        <phase duration="{LOST_PER_PHASE}" state="{yellow(ew_s)}"/>\n'
        f'        <phase duration="{G_NS}" minDur="10" maxDur="{G_NS + 15}" state="{ns_s}"/>\n'
        f'        <phase duration="{LOST_PER_PHASE}" state="{yellow(ns_s)}"/>\n'
        f'    </tlLogic>'
    )
    out = re.sub(r'<tlLogic id="clusterJ10_clusterJ4_J6_J7".*?</tlLogic>',
                 prog, src, flags=re.S)
    assert out != src, "tlLogic substitution failed"
    path = os.path.join(NETS, "V4-retimed.net.xml")
    open(path, "w").write(out)
    return path


# ── V5..V7: joined single 4-way signalised node ──────────────────────────
def write_plain(tag, lanes_for):
    nod = os.path.join(PLAIN, f"{tag}.nod.xml")
    edg = os.path.join(PLAIN, f"{tag}.edg.xml")
    with open(nod, "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<nodes>\n')
        for arm, (nid, _i, _o, x, y) in ARMS.items():
            f.write(f'    <node id="{nid}" x="{x}" y="{y}" type="dead_end"/>\n')
        f.write(f'    <node id="C" x="{CX}" y="{CY}" type="traffic_light"'
                f' tl="{TLS_ID}"/>\n')
        f.write("</nodes>\n")
    with open(edg, "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<edges>\n')
        for arm, (nid, ein, eout, _x, _y) in ARMS.items():
            n = lanes_for(arm)
            f.write(f'    <edge id="{ein}" from="{nid}" to="C"'
                    f' numLanes="{n}" speed="13.89" priority="-1"/>\n')
            f.write(f'    <edge id="{eout}" from="C" to="{nid}"'
                    f' numLanes="{n}" speed="13.89" priority="-1"/>\n')
        f.write("</edges>\n")
    return nod, edg


def synth_program(netpath, in_arm=None):
    """Read the netconvert-generated TLS link set, write a 2-phase program.

    Opposing pairs: E_Panathur + W_Varthur green together, then
    N_Kundalahalli + S_Sarjapur. Through and left (near-side, LHT) get 'G';
    right turns cross opposing traffic so they get permissive 'g'.
    """
    tree = ET.parse(netpath)
    root = tree.getroot()
    tl = root.find(f".//tlLogic[@id='{TLS_ID}']")
    if tl is None:
        raise SystemExit(f"no tlLogic {TLS_ID} in {netpath}")
    nlinks = len(tl.find("phase").get("state"))

    # link index -> (incoming edge, direction)
    link = {}
    for c in root.findall("connection"):
        if c.get("tl") == TLS_ID:
            link[int(c.get("linkIndex"))] = (c.get("from"), c.get("dir"))

    IN_ARM = in_arm if in_arm else {v[1]: k for k, v in ARMS.items()}
    GROUP = {"E_Panathur": "EW", "W_Varthur": "EW",
             "N_Kundalahalli": "NS", "S_Sarjapur": "NS"}

    def state_for(group):
        s = []
        for i in range(nlinks):
            frm, d = link.get(i, (None, None))
            arm = IN_ARM.get(frm)
            if arm and GROUP[arm] == group:
                # LHT: 'r' (right) crosses opposing traffic -> permissive
                s.append('g' if d == 'r' else 'G')
            else:
                s.append('r')
        return "".join(s)

    def yellow(s):
        return "".join('y' if c in 'Gg' else c for c in s)

    ew, ns = state_for("EW"), state_for("NS")

    lines = [f'<tlLogic id="{TLS_ID}" type="actuated" programID="0" offset="0">']
    for k, v in (("max-gap", "2.5"), ("detector-gap", "2.0"),
                 ("jam-threshold", "10")):
        lines.append(f'        <param key="{k}" value="{v}"/>')
    for st, dur in ((ew, G_EW), (yellow(ew), LOST_PER_PHASE),
                    (ns, G_NS), (yellow(ns), LOST_PER_PHASE)):
        if dur > LOST_PER_PHASE:
            lines.append(f'        <phase duration="{dur}" minDur="10"'
                         f' maxDur="{dur + 15}" state="{st}"/>')
        else:
            lines.append(f'        <phase duration="{dur}" state="{st}"/>')
    lines.append("    </tlLogic>")
    prog = "\n".join(lines)

    # Splice as text, not via ElementTree: ET drops the netconvert config
    # comment (which records --lefthand and the rest of the build options) and
    # rewrites unrelated nodes. A targeted regex leaves the net byte-identical
    # apart from the program itself.
    src = open(netpath).read()
    out, n = re.subn(rf'<tlLogic id="{re.escape(TLS_ID)}".*?</tlLogic>',
                     prog, src, flags=re.S)
    if n != 1:
        raise SystemExit(f"tlLogic splice matched {n} times in {netpath}")
    open(netpath, "w").write(out)
    return ew, ns


def build_joined(tag, lanes_for):
    nod, edg = write_plain(tag, lanes_for)
    out = os.path.join(NETS, f"{tag}.net.xml")
    sh([NETCONVERT,
        "--node-files", nod,
        "--edge-files", edg,
        "-o", out,
        "--lefthand",                    # India: drive on the left
        "--no-turnarounds", "true",      # keep the u-turn ban
        "--tls.guess", "true",
        "--tls.default-type", "actuated",
        "--default.lanewidth", "3.2",
        "--offset.disable-normalization", "true",
        "--no-warnings"])
    ew, ns = synth_program(out)
    return out, ew, ns


# ── V8: keep the triangle, retime it, and widen it ───────────────────────
# V5 showed that joining the nodes WITHOUT adding lanes is a regression: the
# triangle's E0 -> E1 -> -E4 leg carries Panathur->Kundalahalli around the
# signal, so collapsing it to one node removes parallel capacity. This variant
# tests whether the join is needed at all once lanes are added, since keeping
# the triangle means no junction reconstruction.
TRIANGLE_LANES = {
    # E-W corridor legs get 3, everything else 2
    "E0": 3, "-E0.79.36": 3, "-E2": 3, "E2": 3,
    "-E5": 3, "E5.36": 3, "E5": 3, "-E5.51": 3,
    "E4": 2, "-E4": 2, "E3": 2, "-E3": 2,
    "E1": 2, "E6": 2, "-E6": 2,
}


def build_v8():
    tag = "V8-triangle-wide"
    nod = os.path.join(PLAIN, f"{tag}.nod.xml")
    edg = os.path.join(PLAIN, f"{tag}.edg.xml")

    src_nod = open(os.path.join(PLAIN, "base.nod.xml")).read()
    # rename the TLS so synth_program can find it by a stable id
    src_nod = src_nod.replace('tl="clusterJ10_clusterJ4_J6_J7"', f'tl="{TLS_ID}"')
    src_nod = re.sub(r'id="clusterJ10_clusterJ4_J6_J7"', 'id="TL"', src_nod)
    open(nod, "w").write(src_nod)

    src_edg = open(os.path.join(PLAIN, "base.edg.xml")).read()
    src_edg = src_edg.replace("clusterJ10_clusterJ4_J6_J7", "TL")

    def bump(m):
        eid = m.group(1)
        n = TRIANGLE_LANES.get(eid, 1)
        return m.group(0).replace('numLanes="1"', f'numLanes="{n}"')

    src_edg = re.sub(r'<edge id="([^"]+)"[^>]*>', bump, src_edg)
    open(edg, "w").write(src_edg)

    out = os.path.join(NETS, f"{tag}.net.xml")
    sh([NETCONVERT,
        "--node-files", nod,
        "--edge-files", edg,
        "-o", out,
        "--lefthand",
        "--no-turnarounds", "true",
        "--tls.guess", "true",
        "--tls.default-type", "actuated",
        "--default.lanewidth", "3.2",
        "--offset.disable-normalization", "true",
        "--no-warnings"])
    # triangle approaches into the TLS: E3=Sarjapur, -E5=Varthur,
    # -E6=Kundalahalli, E5=Panathur
    ew, ns = synth_program(out, in_arm={"-E5": "W_Varthur", "E5": "E_Panathur",
                                        "E3": "S_Sarjapur", "-E6": "N_Kundalahalli"})
    return out, ew, ns


if __name__ == "__main__":
    print(f"green split from surveyed PCU: E+W={G_EW}s  N+S={G_NS}s  "
          f"cycle={G_EW + G_NS + 2 * LOST_PER_PHASE}s")

    p = build_v4()
    print(f"  V4-retimed        {os.path.basename(p)}")

    for tag, lanes_for, desc in [
        ("V5-joined",  lambda a: 1, "joined 4-way, 1 lane"),
        ("V6-2lane",   lambda a: 2, "joined 4-way, 2 lanes"),
        ("V7-3lane-ew",
         lambda a: 3 if a in ("E_Panathur", "W_Varthur") else 2,
         "joined 4-way, 3 lanes E-W / 2 lanes N-S"),
        ("V9-3lane-all", lambda a: 3, "joined 4-way, 3 lanes every approach"),
    ]:
        out, ew, ns = build_joined(tag, lanes_for)
        print(f"  {tag:<17} {desc}")
        print(f"      phase EW={ew}  NS={ns}")

    out, ew, ns = build_v8()
    print(f"  V8-triangle-wide  original triangle, retimed, 3 lanes E-W / 2 elsewhere")
    print(f"      phase EW={ew}  NS={ns}")
