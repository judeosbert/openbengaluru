#!/usr/bin/env python3
"""Shared geometry extraction from SUMO .net.xml.

Extracted from sim/build_player.py:geom() so both the case-study build
and the contributor packer use identical logic.
"""
import os
import re
import sys


def find_sumo():
    """Discover SUMO binary: $SUMO_HOME -> macOS framework -> PATH."""
    for c in (
        os.environ.get("SUMO_HOME", "") + "/bin/sumo",
        "/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo/bin/sumo",
        "sumo",
    ):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def geo_lock(net_path):
    """<location> -> (latlngMap, utm), mirroring app.js parseNetXml.

    latlngMap: {"conv": convBoundary metres, "orig": origBoundary reordered to
    [minLat, minLng, maxLat, maxLng]}. utm: {"offX","offY","zone","south"}.
    Each is None when the net lacks usable provenance (hand nets write
    -1e10 sentinels)."""
    with open(net_path, encoding="utf-8") as f:
        s = f.read()
    m = re.search(r"<location\s[^>]*>", s)
    if not m:
        return None, None
    tag = m.group(0)

    def attr(name):
        mm = re.search(rf'{name}="([^"]+)"', tag)
        return mm.group(1) if mm else None

    def bbox4(v):
        if not v:
            return None
        f = [float(x) for x in v.split(",")]
        return f if len(f) == 4 else None

    def vec2(v):
        if not v:
            return None
        f = [float(x) for x in v.split(",")]
        return f if len(f) == 2 else None

    convB = bbox4(attr("convBoundary"))
    origB = bbox4(attr("origBoundary"))
    netOff = vec2(attr("netOffset"))
    proj = attr("projParameter") or ""

    latlng_map = None
    if (convB and origB and all(abs(v) <= 1000 for v in origB)
            and convB[2] > convB[0] and convB[3] > convB[1]
            and origB[2] > origB[0] and origB[3] > origB[1]):
        latlng_map = {"conv": convB,
                      "orig": [origB[1], origB[0], origB[3], origB[2]]}

    utm = None
    zm = re.search(r"\+zone=(\d+)", proj)
    if netOff and "+proj=utm" in proj and zm and 1 <= int(zm.group(1)) <= 60:
        utm = {"offX": netOff[0], "offY": netOff[1],
               "zone": int(zm.group(1)), "south": "+south" in proj}
    return latlng_map, utm


def geom(net_path):
    """Extract player geometry from a SUMO .net.xml.

    Returns dict with keys: lanes, arms, phases, stops, links.
    Lane coordinates converted to decimetres (dm) to match stream format.
    """
    with open(net_path, encoding="utf-8") as f:
        s = f.read()

    lanes = []
    for m in re.finditer(r'<lane id="([^:][^"]*)"([^>]*)>?', s):
        attrs = m.group(2)
        sh = re.search(r'shape="([^"]+)"', attrs)
        if not sh:
            continue
        w = re.search(r'width="([\d.]+)"', attrs)
        pts = [[round(float(v) * 10) for v in q.split(",")]
               for q in sh.group(1).split()]
        lanes.append({"p": pts, "w": float(w.group(1)) if w else 3.2})

    ends = {}
    for m in re.finditer(r'<junction id="([^:][^"]*)" type="dead_end" '
                         r'x="([-\d.]+)" y="([-\d.]+)"', s):
        ends[m.group(1)] = [round(float(m.group(2)) * 10),
                            round(float(m.group(3)) * 10)]

    arms = {}
    if ends:
        xs = sorted(ends.values(), key=lambda v: v[0])
        ys = sorted(ends.values(), key=lambda v: v[1])
        arms = {"Panathur": xs[0], "Varthur": xs[-1],
                "Sarjapur": ys[0], "Kundalahalli": ys[-1]}

    phases, stops, links = [], {}, {}

    if "<tlLogic" in s:
        phases = [[float(m.group(1)), m.group(2)] for m in
                  re.finditer(r'<phase duration="([\d.]+)" state="(\w+)"', s)]
        for m in re.finditer(r'<connection from="([^"]+)"[^>]*tl="[^"]*"'
                             r'[^>]*linkIndex="(\d+)"', s):
            frm, idx = m.group(1), int(m.group(2))
            links.setdefault(frm, []).append(idx)
            lm = re.search(rf'<lane id="{re.escape(frm)}_0"[^>]*shape="([^"]+)"', s)
            if lm:
                last = lm.group(1).split()[-1].split(",")
                stops[frm] = [round(float(last[0]) * 10), round(float(last[1]) * 10)]

    return {"lanes": lanes, "arms": arms, "phases": phases,
            "stops": stops, "links": links}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: sumo_geom.py <net.xml>", file=sys.stderr)
        sys.exit(1)
    import json
    print(json.dumps(geom(sys.argv[1]), separators=(",", ":")))