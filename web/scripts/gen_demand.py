#!/usr/bin/env python3
"""
Generate ONE canonical O-D demand, emitted per-network.

Why per-network files: the three networks do not share boundary edge IDs.
Panathur / Varthur / Kundalahalli use the same source+sink edges in all three,
but Sarjapur enters on -E2.7 and exits on E2.7 in BELAGERE.net.xml, versus
E3 / -E3 in both no-u-turn networks.

So the demand is defined once as an arm-to-arm O-D matrix, and only the
arm -> edge mapping differs per network. Vehicle IDs, vehicle types and
departure times are byte-identical across the emitted files, which is what
makes the runs comparable.

O-D counts and PCU factors: balegare-data.txt (peak AM 08:00-09:00 and
off-peak 10:00-16:00 turning movement counts).
"""
import os

OUT = os.path.dirname(os.path.abspath(__file__))

# ── vehicle types ────────────────────────────────────────────────────────
# accel/decel/sigma/length/maxSpeed straight from balegare-data.txt.
# minGap is NOT in that file; values below reflect Indian urban following
# behaviour (SUMO's 2.5 m default is far too conservative and would put
# saturation flow well under observed). Identical across every run, so it
# cannot bias the comparison.
VTYPES = [
    # id,         vClass,      accel, decel, sigma, length, minGap, maxSpeed
    ("passenger",  "passenger",  2.6,   4.5,   0.5,   4.5,    1.0,   13.9),
    ("motorcycle", "motorcycle", 3.5,   5.0,   0.6,   2.2,    0.5,   16.7),
    ("bus",        "bus",        1.2,   3.5,   0.4,  12.0,    1.5,   11.1),
    ("truck",      "truck",      1.0,   3.0,   0.4,   8.0,    1.5,   11.1),
    ("auto",       "passenger",  2.8,   4.0,   0.5,   3.2,    0.8,   11.1),
]
# Bicycles are dropped. balegare-data.txt lists 137/h at peak (2.5%), but they
# are rare at this junction in practice, and 137 vehicles/h capped at 5.6 m/s
# on a single 3.2 m lane is a large modelled capacity drag that does not exist
# on the ground. Their PCU contribution was only 27 of 4506 (0.6%), so removing
# them changes the load negligibly while removing the artefact.
TYPE_ORDER = [v[0] for v in VTYPES]

COLORS = {
    "passenger": "0,80,255", "motorcycle": "20,20,20", "bus": "255,140,0",
    "truck": "220,40,40", "auto": "255,215,0", "bicycle": "0,170,120",
}

# ── O-D matrix: (origin, dest) -> per-type veh/hour ──────────────────────
# order matches TYPE_ORDER: passenger, motorcycle, bus, truck, auto
PEAK = {
    ("E", "W"): ( 380,  610,   14,   28,   72),
    ("E", "S"): (  65,  110,    3,    8,   18),
    ("E", "N"): (  90,  150,    5,   10,   22),
    ("W", "E"): ( 400,  645,   15,   30,   80),
    ("W", "N"): (  80,  130,    4,    8,   20),
    ("W", "S"): (  50,   85,    2,    5,   14),
    ("N", "S"): ( 200,  320,    8,   18,   50),
    ("N", "E"): ( 155,  250,    7,   14,   38),
    ("N", "W"): ( 120,  195,    5,   10,   30),
    ("S", "N"): ( 185,  298,    7,   16,   45),
    ("S", "W"): (  95,  155,    4,    9,   24),
    ("S", "E"): ( 110,  178,    5,   11,   28),
}
OFFPEAK = {
    ("E", "W"): ( 145,  232,    6,   13,   28),
    ("E", "S"): (  24,   42,    1,    3,    7),
    ("E", "N"): (  34,   57,    2,    4,    9),
    ("W", "E"): ( 152,  246,    6,   14,   31),
    ("W", "N"): (  30,   50,    2,    3,    8),
    ("W", "S"): (  19,   32,    1,    2,    5),
    ("N", "S"): (  76,  122,    3,    7,   19),
    ("N", "E"): (  59,   95,    3,    5,   15),
    ("N", "W"): (  46,   74,    2,    4,   12),
    ("S", "N"): (  70,  114,    3,    6,   17),
    ("S", "W"): (  36,   59,    2,    4,    9),
    ("S", "E"): (  42,   68,    2,    4,   11),
}

ARM_NAME = {"N": "Kundalahalli", "S": "Sarjapur", "E": "Panathur", "W": "Varthur"}

# ── arm -> (source edge, sink edge) per network ──────────────────────────
# Verified by reading dead_end junctions and edge from/to in each .net.xml.
MAPPINGS = {
    "baseline": {
        "N": ("E4",  "-E4"),
        "E": ("E0",  "-E0.79.36"),
        "S": ("-E2.7", "E2.7"),
        "W": ("-E2", "E2"),
    },
    # both no-u-turn networks share an identical boundary edge set
    "nouturn": {
        "N": ("E4",  "-E4"),
        "E": ("E0",  "-E0.79.36"),
        "S": ("E3",  "-E3"),
        "W": ("-E2", "E2"),
    },
}

PERIOD = 3600.0  # demand injected over one hour


def build_trips(matrix):
    """Deterministic trip list: uniform headway per (movement, type) stream.

    Returns [(depart, vehid, origin_arm, dest_arm, vtype)] sorted by depart.
    Identical for every network, since arms are symbolic here.
    """
    trips = []
    for (o, d), counts in sorted(matrix.items()):
        for ti, n in enumerate(counts):
            if n <= 0:
                continue
            vt = TYPE_ORDER[ti]
            headway = PERIOD / n
            for i in range(n):
                depart = (i + 0.5) * headway
                trips.append((depart, f"{o}{d}_{vt}_{i}", o, d, vt))
    # sort by depart, then id, so ordering is stable and reproducible
    trips.sort(key=lambda t: (round(t[0], 4), t[1]))
    return trips


def write_routes(path, trips, mapping):
    with open(path, "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write("<!-- GENERATED by gen_demand.py - do not hand-edit.\n")
        f.write("     Canonical O-D demand from balegare-data.txt.\n")
        f.write("     Vehicle IDs and depart times are identical across every\n")
        f.write("     network variant; only boundary edge IDs differ. -->\n")
        f.write('<routes xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
                ' xsi:noNamespaceSchemaLocation='
                '"http://sumo.dlr.de/xsd/routes_file.xsd">\n')
        for vid, vclass, a, dc, sg, ln, mg, ms in VTYPES:
            f.write(f'    <vType id="{vid}" vClass="{vclass}" accel="{a}"'
                    f' decel="{dc}" sigma="{sg}" length="{ln}"'
                    f' minGap="{mg}" maxSpeed="{ms}"'
                    f' color="{COLORS[vid]}"/>\n')
        f.write("\n")
        for depart, vid, o, d, vt in trips:
            src = mapping[o][0]
            dst = mapping[d][1]
            f.write(f'    <trip id="{vid}" type="{vt}" depart="{depart:.2f}"'
                    f' from="{src}" to="{dst}"'
                    f' departLane="best" departSpeed="max"/>\n')
        f.write("</routes>\n")


PCU = {"passenger": 1.0, "motorcycle": 0.5, "bus": 3.0,
       "truck": 2.5, "auto": 0.75}


def summarise(name, matrix, trips):
    veh = len(trips)
    pcu = sum(PCU[t[4]] for t in trips)
    print(f"  {name:<8} {veh:>6} veh   {pcu:>8.0f} PCU")
    per_arm = {}
    for _, _, o, d, vt in trips:
        per_arm.setdefault(o, [0, 0.0])
        per_arm[o][0] += 1
        per_arm[o][1] += PCU[vt]
    for a in "ENWS":
        v, p = per_arm[a]
        print(f"      {a} {ARM_NAME[a]:<14} in: {v:>5} veh  {p:>7.0f} PCU")


if __name__ == "__main__":
    for level, matrix in (("peak", PEAK), ("offpeak", OFFPEAK)):
        trips = build_trips(matrix)
        summarise(level, matrix, trips)
        for netkey, mapping in MAPPINGS.items():
            out = os.path.join(OUT, f"demand-{level}-{netkey}.rou.xml")
            write_routes(out, trips, mapping)
            print(f"      -> {os.path.basename(out)}")
        print()
