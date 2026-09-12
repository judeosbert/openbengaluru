#!/usr/bin/env python3
"""Pack the floating-car data into a compact binary the browser can animate.

Layout, little-endian:
  header : 'BLGR', u8 version, u8 nScenarios, u16 nFrames, i16 x0,y0,x1,y1 (dm)
  then per scenario: u32 byteLength, then per frame:
      u16 nVehicles, then per vehicle:
        u16 vehicleIndex, i16 x (dm), i16 y (dm), u8 angle/2,
        u8 speed*8 (capped), u8 type

The vehicle index lets the player match a vehicle across consecutive samples and
interpolate between them, so motion stays smooth even at 1x speed where the raw
1 Hz sampling would otherwise look like a slideshow.
  then per scenario per frame: u16 through, u16 moving, u16 stopped,
      u16 queuedOutside, u16 gridlocks

Positions are decimetres, which is finer than a pixel at any zoom the player
uses, and keeps a coordinate inside an int16.
"""
import os, struct, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
VID = os.path.join(HERE, "video")
FRAMES = 900
TYPES = ["passenger", "motorcycle", "bus", "truck", "auto"]
TIDX = {t: i for i, t in enumerate(TYPES)}
SCEN = ["current", "proposed"]


def read_fcd(tag):
    per = [[] for _ in range(FRAMES)]
    ids = {}
    for _ev, el in ET.iterparse(os.path.join(VID, f"{tag}-fcd.xml"), events=("end",)):
        if el.tag == "timestep":
            t = int(float(el.get("time")))
            if 0 <= t < FRAMES:
                per[t] = [(ids.setdefault(v.get("id"), len(ids)),
                           round(float(v.get("x")) * 10),
                           round(float(v.get("y")) * 10),
                           int(float(v.get("angle")) / 2) % 180,
                           min(255, int(float(v.get("speed")) * 8)),
                           TIDX.get(v.get("type"), 0)) for v in el]
            el.clear()
    return per, len(ids)


def read_summary(tag):
    per = [(0, 0, 0, 0, 0)] * FRAMES
    out = list(per)
    for _ev, el in ET.iterparse(os.path.join(VID, f"{tag}-sum.xml"), events=("end",)):
        if el.tag == "step":
            t = int(float(el.get("time")))
            if 0 <= t < FRAMES:
                run, halt = int(el.get("running")), int(el.get("halting"))
                out[t] = (min(65535, int(el.get("arrived"))),
                          min(65535, max(0, run - halt)), min(65535, halt),
                          min(65535, int(el.get("waiting"))),
                          min(65535, int(el.get("teleports"))))
            el.clear()
    return out


if __name__ == "__main__":
    loaded = {t: read_fcd(t) for t in SCEN}
    fcd = {t: loaded[t][0] for t in SCEN}
    nveh = {t: loaded[t][1] for t in SCEN}
    summ = {t: read_summary(t) for t in SCEN}
    xs = [v[1] for t in SCEN for f in fcd[t] for v in f]
    ys = [v[2] for t in SCEN for f in fcd[t] for v in f]
    hdr = struct.pack("<4sBBHhhhh", b"BLGR", 1, len(SCEN), FRAMES,
                      min(xs), min(ys), max(xs), max(ys))
    body = b""
    for t in SCEN:
        blob = b"".join(
            struct.pack("<H", len(f)) +
            b"".join(struct.pack("<HhhBBB", *v) for v in f) for f in fcd[t])
        body += struct.pack("<I", len(blob)) + blob
    for t in SCEN:
        body += b"".join(struct.pack("<HHHHH", *s) for s in summ[t])
    out = os.path.join(VID, "run.bin")
    open(out, "wb").write(hdr + body)
    n = sum(len(f) for t in SCEN for f in fcd[t])
    print(f"packed {n:,} vehicle-frames -> {os.path.getsize(out)/1e6:.2f} MB")
    print(f"  bounds (dm): x {min(xs)}..{max(xs)}  y {min(ys)}..{max(ys)}")
    print(f"  distinct vehicles: " + ", ".join(f"{t} {nveh[t]:,}" for t in SCEN))
