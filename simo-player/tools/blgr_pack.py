#!/usr/bin/env python3
"""Shared BLGR binary packing logic.

Generalized from sim/video_pack.py for N scenarios / arbitrary frames.
Matches the BLGR format expected by TrafficSimEngine in app.js.
"""
import os
import struct
import xml.etree.ElementTree as ET

TYPES = ["passenger", "motorcycle", "bus", "truck", "auto"]
TIDX = {t: i for i, t in enumerate(TYPES)}

# SUMO vClass -> render-class index (app.js VEH_TYPES order).
# vType id matches TIDX first; vClass is the fallback for contributor ids
# (e.g. bangloreCar, schoolbus, water-tanker).
VCLASS_TO_IDX = {
    "passenger": 0, "private": 0, "emergency": 0, "authority": 0,
    "vip": 0, "armored": 0,
    "motorcycle": 1, "moped": 1, "scooter": 1, "e_scooter": 1,
    "bus": 2, "coach": 2,
    "truck": 3, "trailer": 3, "delivery": 3,
    "taxi": 4,
}


def read_demand(rou_path):
    """Sum contributor flow rates -> veh/hr.

    Counts <flow perHour> and the older <flow vehsPerHour> spelling.
    Standalone <vehicle> elements are one-off departures (not a rate) and
    period=/number= flow styles are not supported — both contribute 0.
    """
    total = 0.0
    for _ev, el in ET.iterparse(rou_path, events=("end",)):
        if el.tag == "flow":
            rate = el.get("perHour") or el.get("vehsPerHour")
            if rate:
                try:
                    total += float(rate)
                except ValueError:
                    pass
            el.clear()
    return total


def build_type_map(rou_path):
    """Parse a .rou.xml -> {vType id: render-class index}.

    Id match against TIDX wins (so id="auto" vClass="taxi" -> 4, the
    auto-rickshaw class); otherwise vClass lookup; otherwise 0 (passenger).
    """
    tmap = {}
    for _ev, el in ET.iterparse(rou_path, events=("end",)):
        if el.tag == "vType":
            vid = el.get("id")
            if vid:
                if vid in TIDX:
                    tmap[vid] = TIDX[vid]
                else:
                    tmap[vid] = VCLASS_TO_IDX.get(el.get("vClass"), 0)
            el.clear()
    return tmap


def build_header(n_scenarios, n_frames, bounds):
    """Build BLGR header: magic, version, nScenarios, nFrames, bounds (dm)."""
    return struct.pack("<4sBBHhhhh", b"BLGR", 1, n_scenarios, n_frames,
                       bounds[0], bounds[1], bounds[2], bounds[3])


def pack_fcd(frames):
    """Pack per-frame vehicle records into BLGR frame blobs.

    frames: list of frames; each frame is list of
    [id, x_dm, y_dm, angle_div2, speed_x8, type_idx]

    Returns: bytes blob (concatenated frames, each: u16 n + n * 9 bytes)
    """
    out = bytearray()
    for frame in frames:
        out.extend(struct.pack("<H", len(frame)))
        for v in frame:
            out.extend(struct.pack("<HhhBBB", *v))
    return bytes(out)


def pack_stats(stats_rows):
    """Pack per-frame stats into BLGR stats section.

    stats_rows: list of [through, moving, stopped, queued, gridlock] per frame

    Returns: bytes (nFrames * 5 * u16)
    """
    out = bytearray()
    for row in stats_rows:
        out.extend(struct.pack("<5H", *row))
    return bytes(out)


def read_fcd(tag, fcd_dir, n_frames, type_map=None):
    """Parse SUMO FCD XML for a scenario tag.

    type_map: {vType id: render-class index} from build_type_map; unknown
    types fall back to 0 (passenger)."""
    tmap = type_map or {}
    per = [[] for _ in range(n_frames)]
    ids = {}
    fcd_path = os.path.join(fcd_dir, f"{tag}-fcd.xml")
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


def read_summary(tag, fcd_dir, n_frames):
    """Parse SUMO summary XML for a scenario tag."""
    per = [(0, 0, 0, 0, 0)] * n_frames
    out = list(per)
    sum_path = os.path.join(fcd_dir, f"{tag}-sum.xml")
    for _ev, el in ET.iterparse(sum_path, events=("end",)):
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


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 4:
        print("usage: blgr_pack.py <n_scenarios> <n_frames> <bounds...>", file=sys.stderr)
        sys.exit(1)
    n_scenarios = int(sys.argv[1])
    n_frames = int(sys.argv[2])
    bounds = list(map(int, sys.argv[3:7]))
    hdr = build_header(n_scenarios, n_frames, bounds)
    sys.stdout.buffer.write(hdr)