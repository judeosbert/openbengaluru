#!/usr/bin/env python3
"""Dev injector: bridge a .simo.json pack into the player without Phase 3.

Writes simo-player/streams/<id>.js (JSONP stream payload) and patches the
CATALOG const in simo-player/data.js with a catalog entry for the pack
(idempotent: same id replaces). Geo-lock provenance is read from the source
.net.xml (<location> tag) when --net is given, mirroring parseNetXml.

Usage:
  dev_inject.py pack.simo.json --net n.xml --title "My run" --author me
"""
import argparse
import base64
import datetime
import json
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLAYER = os.path.join(HERE, "..")
DATA = os.path.join(PLAYER, "data.js")


def slug(title):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s or "sim"


sys.path.insert(0, HERE)
from sumo_geom import geo_lock as parse_location


def stats_derive(stats_b64):
    """(final arrived, max queued) from a packed stats blob."""
    raw = base64.b64decode(stats_b64)
    n = len(raw) // 10
    arrived = struct.unpack_from("<H", raw, (n - 1) * 10)[0]
    qmax = max(struct.unpack_from("<H", raw, i * 10 + 6)[0] for i in range(n))
    return arrived, qmax


def read_catalog(src):
    m = re.search(r"^const CATALOG = (.*);\s*$", src, re.M)
    return json.loads(m.group(1))


def write_catalog(src, catalog):
    line = "const CATALOG = " + json.dumps(catalog, separators=(",", ":")) + ";"
    return re.sub(r"^const CATALOG = .*;\s*$", lambda _: line, src,
                  count=1, flags=re.M)


def main():
    ap = argparse.ArgumentParser(description="Inject a .simo.json pack into the player")
    ap.add_argument("pack", help=".simo.json from pack_run.py")
    ap.add_argument("--net", help="source .net.xml (geo-lock provenance)")
    ap.add_argument("--title", required=True)
    ap.add_argument("--author", default="dev")
    ap.add_argument("--id", help="catalog id (default: slug of title)")
    args = ap.parse_args()

    pack = json.load(open(args.pack, encoding="utf-8"))
    eid = args.id or slug(args.title)

    # geo provenance: pack-carried per scenario (new packer) wins; --net is
    # the fallback for old packs
    net_geo = parse_location(args.net) if args.net else (None, None)

    scenarios = {}
    peak_served, qmax_all = 0, 0
    latlngMap = None
    for key, sc in pack["scenarios"].items():
        arrived, qmax = stats_derive(sc["stats"])
        peak_served = max(peak_served, arrived)
        qmax_all = max(qmax_all, qmax)
        s_lat = sc.get("latlngMap") or net_geo[0]
        s_utm = sc.get("utm") or net_geo[1]
        latlngMap = latlngMap or s_lat
        entry = {"title": key.upper(), "sub": "packed run · dev inject",
                 "lanes": sc["lanes"], "arms": sc.get("arms", {}),
                 "phases": sc.get("phases", []),
                 "stops": sc.get("stops", {}),
                 "links": sc.get("links", {}),
                 "stats": sc["stats"]}
        if s_lat:
            entry["latlngMap"] = s_lat
            entry["geoLocked"] = True
        if s_utm:
            entry["utm"] = s_utm
            entry["geoLocked"] = True
        scenarios[key] = entry

    if latlngMap:
        o = latlngMap["orig"]
        anchor = [(o[0] + o[2]) / 2, (o[1] + o[3]) / 2]
        zone = [[o[0], o[1]], [o[0], o[3]], [o[2], o[3]], [o[2], o[1]]]
        bounds = [[o[0], o[1]], [o[2], o[3]]]
    else:
        anchor = [12.9517, 77.7894]
        d = 20 / 111320
        zone = [[anchor[0] - d, anchor[1] - d], [anchor[0] - d, anchor[1] + d],
                [anchor[0] + d, anchor[1] + d], [anchor[0] + d, anchor[1] - d]]
        bounds = None

    # demand/peakServed: pack-carried (contributor flow rates) preferred;
    # stats-derived fallback for old packs
    demand = pack.get("demand")
    if demand is None:
        demand = peak_served + qmax_all
    peak_out = pack.get("peakServed") or peak_served

    entry = {"id": eid, "title": args.title, "author": args.author,
             "anchor": anchor, "rotation": 0,
             "demand": round(demand),
             "peakServed": peak_out,
             "zonePoly": zone,
             "addedAt": datetime.date.today().isoformat(),
             "nFrames": pack["nFrames"],
             "scenarios": scenarios}
    if bounds:
        entry["bounds"] = bounds

    # 1) stream file (frames only; stats ride inline in the catalog entry)
    os.makedirs(os.path.join(PLAYER, "streams"), exist_ok=True)
    payload = {"nFrames": pack["nFrames"], "bounds": pack["bounds"],
               "scenarios": {k: {"frames": sc["frames"]}
                             for k, sc in pack["scenarios"].items()}}
    spath = os.path.join(PLAYER, "streams", eid + ".js")
    with open(spath, "w") as fh:
        fh.write("window.__simoStreamCallback('" + eid + "',"
                 + json.dumps(payload, separators=(",", ":")) + ");\n")

    # 2) catalog patch (idempotent on id)
    src = open(DATA, encoding="utf-8").read()
    catalog = [e for e in read_catalog(src) if e.get("id") != eid]
    catalog.append(entry)
    with open(DATA, "w") as fh:
        fh.write(write_catalog(src, catalog))

    print(f"entry '{eid}' -> data.js CATALOG ({len(catalog)} entries)")
    print(f"stream -> {spath} ({os.path.getsize(spath)/1024:.0f} KB)")
    print(f"geo-locked: {bool(latlngMap)}  demand: {entry['demand']}  "
          f"peakServed: {peak_served}")


if __name__ == "__main__":
    main()