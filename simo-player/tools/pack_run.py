#!/usr/bin/env python3
"""Contributor packer: run SUMO, pack FCD+summary to BLGR, emit .simo.json.

Single scenario:
    pack_run.py --net n.xml --rou r.xml --scenario today -o out.simo.json

A/B (each scenario has its own net + routes):
    pack_run.py --scenario today=t.net.xml:t.rou.xml \
                --scenario proposed=p.net.xml:p.rou.xml -o out.simo.json
"""
import argparse
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile

# Add tools to path for imports
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS_DIR)

import sumo_geom
import blgr_pack


SUMO_FLAGS = [
    "--fcd-output", "{fcd}",
    "--fcd-output.geo", "false",
    "--summary-output", "{summ}",
    "--seed", "42",
    "--step-length", "1",
    "--time-to-teleport", "300",
    "--max-depart-delay", "1800",
    "-e", "{end}",
    "--no-step-log", "--no-warnings"
]


def parse_args():
    p = argparse.ArgumentParser(description="Pack SUMO run into .simo.json")
    p.add_argument("--net", help="SUMO network file (single-scenario form)")
    p.add_argument("--rou", help="SUMO routes file (single-scenario form)")
    p.add_argument("--cfg", help="SUMO config (.sumocfg) supplying net/rou")
    p.add_argument("--scenario", required=True, action="append",
                   help="Scenario key, or key=net.xml:rou.xml for A/B. "
                        "Repeatable.")
    p.add_argument("-o", "--output", required=True, help="Output .simo.json path")
    p.add_argument("--end", type=int, default=900,
                   help="Simulation end time (seconds)")
    p.add_argument("--sumo", help="Path to sumo binary (auto-discovered if omitted)")
    return p.parse_args()


def parse_scenario_specs(scenario_args, net, rou):
    """Normalize --scenario values into [(key, net_path, rou_path), ...].

    Two forms, never mixed:
      bare keys        -> global --net/--rou (single scenario only)
      key=net:rou      -> per-scenario inputs (A/B)
    """
    specs = []
    keyed = ["=" in s for s in scenario_args]
    if any(keyed) and not all(keyed):
        raise ValueError("mixing bare scenario keys and key=net:rou specs")
    if all(keyed):
        for s in scenario_args:
            key, _, paths = s.partition("=")
            n, _, r = paths.rpartition(":")
            if not key or not n or not r:
                raise ValueError(f"bad --scenario spec: {s!r} "
                                 "(want key=net.xml:rou.xml)")
            specs.append((key, n, r))
    else:
        if not net or not rou:
            raise ValueError("bare --scenario keys require --net and --rou")
        if len(scenario_args) > 1:
            raise ValueError(
                "multiple scenarios share one net/rou — an A/B run needs "
                "per-scenario specs: --scenario today=t.net.xml:t.rou.xml "
                "--scenario proposed=p.net.xml:p.rou.xml")
        specs.append((scenario_args[0], net, rou))
    keys = [k for k, _n, _r in specs]
    if len(set(keys)) != len(keys):
        raise ValueError(f"duplicate scenario keys: {keys}")
    return specs


def find_sumo(sumo_arg):
    if sumo_arg:
        return sumo_arg
    return sumo_geom.find_sumo()


def run_sumo(sumo, net, rou, fcd_out, summ_out, end_time, sumo_home):
    """Run SUMO with exact flags from video_capture.py:34-38."""
    cmd = [sumo, "-n", net, "-r", rou]
    for flag in SUMO_FLAGS:
        if flag == "{fcd}":
            cmd.append(fcd_out)
        elif flag == "{summ}":
            cmd.append(summ_out)
        elif flag == "{end}":
            cmd.append(str(end_time))
        else:
            cmd.append(flag)
    env = dict(os.environ, SUMO_HOME=sumo_home) if sumo_home else os.environ
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise RuntimeError(f"SUMO failed: {result.stderr[-800:]}")
    return True


def read_fcd(fcd_path, n_frames, type_map=None):
    """Parse FCD XML into per-frame vehicle lists."""
    import xml.etree.ElementTree as ET
    tmap = type_map or {}
    per = [[] for _ in range(n_frames)]
    ids = {}
    for _ev, el in ET.iterparse(fcd_path, events=("end",)):
        if el.tag == "timestep":
            t = int(float(el.get("time")))
            if 0 <= t < n_frames:
                per[t] = [(ids.setdefault(v.get("id"), len(ids)),
                           round(float(v.get("x")) * 10),
                           round(float(v.get("y")) * 10),
                           int(float(v.get("angle")) / 2) % 180,
                           min(255, int(float(v.get("speed")) * 8)),
                           tmap.get(v.get("type"), 0)) for v in el]
            el.clear()
    return per, len(ids)


def read_summary(summ_path, n_frames):
    """Parse summary XML into per-frame stat rows."""
    import xml.etree.ElementTree as ET
    per = [(0, 0, 0, 0, 0)] * n_frames
    out = list(per)
    for _ev, el in ET.iterparse(summ_path, events=("end",)):
        if el.tag == "step":
            t = int(float(el.get("time")))
            if 0 <= t < n_frames:
                run, halt = int(el.get("running")), int(el.get("halting"))
                out[t] = (min(65535, int(el.get("arrived"))),
                          min(65535, max(0, run - halt)), min(65535, halt),
                          min(65535, int(el.get("waiting"))),
                          min(65535, int(el.get("teleports"))))
            el.clear()
    return out


def build_pack(scenarios_data, n_frames):
    """Assemble the .simo.json dict.

    scenarios_data: {key: {"frames": per-frame vehicle lists,
                           "stats": per-frame [5] rows,
                           "geometry": sumo_geom.geom() dict,
                           "geo": (latlngMap, utm) or None,
                           "demand": veh/hr from read_demand, or None}}
    Scenario entries follow the catalog shape: lanes/arms/phases/stops/links
    + frames/stats (base64) + latlngMap/utm/geoLocked when provenance exists.
    Top level adds demand (max scenario rate) and peakServed (max final
    arrived across scenarios) — matching build_mock's catalog semantics.
    """
    out_scenarios = {}
    xs, ys, anchor = [], [], None
    demands, peak_served = [], 0
    for key, d in scenarios_data.items():
        if d.get("demand") is not None:
            demands.append(d["demand"])
        if d["stats"]:
            peak_served = max(peak_served, d["stats"][-1][0])
        geom = d["geometry"]
        geo = d.get("geo")
        latlng_map, utm = geo if geo else (None, None)
        frames_blob = blgr_pack.pack_fcd(d["frames"])
        stats_blob = blgr_pack.pack_stats(d["stats"])
        sc = {"title": key.upper(),
              "lanes": geom["lanes"], "arms": geom.get("arms", {}),
              "phases": geom.get("phases", []),
              "stops": geom.get("stops", {}), "links": geom.get("links", {}),
              "frames": base64.b64encode(frames_blob).decode("ascii"),
              "stats": base64.b64encode(stats_blob).decode("ascii")}
        if latlng_map:
            sc["latlngMap"] = latlng_map
            sc["geoLocked"] = True
            if anchor is None:
                o = latlng_map["orig"]
                anchor = [(o[0] + o[2]) / 2, (o[1] + o[3]) / 2]
        if utm:
            sc["utm"] = utm
            sc["geoLocked"] = True
        out_scenarios[key] = sc
        for frame in d["frames"]:
            for v in frame:
                xs.append(v[1])
                ys.append(v[2])
    bounds = [min(xs), min(ys), max(xs), max(ys)] if xs else [0, 0, 1, 1]
    return {"nFrames": n_frames, "bounds": bounds, "anchor": anchor,
            "demand": max(demands) if demands else None,
            "peakServed": peak_served,
            "scenarios": out_scenarios}


def main():
    args = parse_args()

    net, rou = args.net, args.rou
    if args.cfg:
        import xml.etree.ElementTree as ET
        root = ET.parse(args.cfg).getroot()
        cfg_dir = os.path.dirname(os.path.abspath(args.cfg))
        nf = root.find(".//net-file")
        rf = root.find(".//route-files")
        if nf is None or rf is None:
            sys.exit("error: net-file/route-files missing in config")
        net = os.path.join(cfg_dir, nf.get("value"))
        rou = os.path.join(cfg_dir, rf.get("value"))

    try:
        specs = parse_scenario_specs(args.scenario, net, rou)
    except ValueError as e:
        sys.exit(f"error: {e}")

    sumo = find_sumo(args.sumo)
    if not sumo:
        sys.exit("error: sumo not found. Set --sumo or $SUMO_HOME")

    sumo_home = None
    if os.environ.get("SUMO_HOME"):
        sumo_home = os.environ["SUMO_HOME"]
    elif sumo.startswith("/Library/Frameworks/EclipseSUMO.framework/"):
        sumo_home = ("/Library/Frameworks/EclipseSUMO.framework/"
                     "Versions/Current/EclipseSUMO/share/sumo")

    scenarios_data = {}
    with tempfile.TemporaryDirectory() as td:
        for key, net_path, rou_path in specs:
            fcd_out = os.path.join(td, f"{key}-fcd.xml")
            summ_out = os.path.join(td, f"{key}-sum.xml")
            print(f"  Running SUMO for '{key}' ({os.path.basename(net_path)})...")
            run_sumo(sumo, net_path, rou_path, fcd_out, summ_out,
                     args.end, sumo_home)
            tmap = blgr_pack.build_type_map(rou_path)
            frames, n_veh = read_fcd(fcd_out, args.end, tmap)
            stats = read_summary(summ_out, args.end)
            print(f"    {n_veh} vehicles, {len(frames)} frames, "
                  f"{len(tmap)} vTypes")
            scenarios_data[key] = {
                "frames": frames, "stats": stats,
                "geometry": sumo_geom.geom(net_path),
                "geo": sumo_geom.geo_lock(net_path),
                "demand": blgr_pack.read_demand(rou_path),
            }

    out = build_pack(scenarios_data, args.end)
    with open(args.output, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"Wrote {args.output} ({os.path.getsize(args.output)/1024:.1f} KB)"
          + (" [geo-locked]" if out["anchor"] else ""))


if __name__ == "__main__":
    main()