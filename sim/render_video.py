#!/usr/bin/env python3
"""Render the two scenarios side by side into video frames.

Both panels share one world bounding box and one scale, so the geometries are
directly comparable. Vehicles are drawn from floating-car data as oriented
rectangles sized by class, coloured by speed. The proposed panel also shows the
live signal state at each stop line. Counters come from SUMO's own summary
output, so nothing on screen is inferred.
"""
import os, re, math, xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
VID = os.path.join(HERE, "video")
FRAMES = os.path.join(VID, "frames")
os.makedirs(FRAMES, exist_ok=True)

END = 900
PANEL_W, PANEL_H = 940, 448   # ~world aspect (247 x 116 m), so no dead space
GAP, PAD = 20, 20
HEAD_H, FOOT_H = 104, 62
W = PAD * 2 + PANEL_W * 2 + GAP
H = HEAD_H + PANEL_H + FOOT_H

GROUND = (11, 11, 12)
SURFACE = (23, 23, 26)
HAIR = (44, 44, 50)
INK = (245, 245, 247)
INK2 = (180, 180, 188)
INK3 = (124, 124, 134)
ACCENT = (229, 9, 20)
GREEN = (53, 196, 107)
AMBER = (240, 160, 43)
RED = (245, 72, 79)
ROAD = (58, 58, 64)
ROAD_EDGE = (34, 34, 39)

FONT = "/System/Library/Fonts/HelveticaNeue.ttc"
MONO = "/System/Library/Fonts/Menlo.ttc"


def font(sz, bold=False):
    try:
        return ImageFont.truetype(FONT, sz, index=1 if bold else 0)
    except Exception:
        return ImageFont.load_default()


def mono(sz):
    try:
        return ImageFont.truetype(MONO, sz, index=0)
    except Exception:
        return font(sz)


F_TITLE, F_SUB = font(25, True), font(13)
F_HUD, F_HUDV = font(11), mono(19)
F_ARM, F_LEG, F_CLK = font(12, True), font(11), mono(30)
F_HUDV2 = mono(21)

# vehicle footprint in metres: length, width
SHAPE = {"passenger": (4.5, 1.8), "motorcycle": (2.1, 0.8), "bus": (12.0, 2.5),
         "truck": (7.5, 2.4), "auto": (3.2, 1.5)}


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def speed_color(v):
    if v <= 0.4:
        return RED
    if v < 3.5:
        return lerp(RED, AMBER, (v - 0.4) / 3.1)
    if v < 8.0:
        return lerp(AMBER, GREEN, (v - 3.5) / 4.5)
    return GREEN


# ── network geometry ──────────────────────────────────────────────────────
def load_net(p):
    s = open(p).read()
    lanes, wid = [], {}
    for m in re.finditer(r'<lane id="([^:][^"]*)"[^>]*?width="([\d.]+)"[^>]*?shape="([^"]+)"', s):
        pts = [tuple(map(float, q.split(","))) for q in m.group(3).split()]
        lanes.append((pts, float(m.group(2))))
    for m in re.finditer(r'<lane id="([^:][^"]*)"(?![^>]*width=)[^>]*?shape="([^"]+)"', s):
        pts = [tuple(map(float, q.split(","))) for q in m.group(2).split()]
        lanes.append((pts, 3.2))
    ends = {}
    for m in re.finditer(r'<junction id="([^:][^"]*)" type="dead_end" x="([-\d.]+)" y="([-\d.]+)"', s):
        ends[m.group(1)] = (float(m.group(2)), float(m.group(3)))
    # stop lines: last point of each edge feeding the traffic light
    stops = {}
    tl = re.search(r'<tlLogic id="([^"]+)"', s)
    if tl:
        for m in re.finditer(r'<connection from="([^"]+)"[^>]*tl="[^"]*"[^>]*linkIndex="(\d+)"', s):
            frm = m.group(1)
            lm = re.search(rf'<lane id="{re.escape(frm)}_0"[^>]*shape="([^"]+)"', s)
            if lm:
                pts = [tuple(map(float, q.split(","))) for q in lm.group(1).split()]
                stops[frm] = pts[-1]
    phases = [(float(m.group(1)), m.group(2)) for m in
              re.finditer(r'<phase duration="([\d.]+)" state="(\w+)"', s)] if tl else []
    links = {}
    if tl:
        for m in re.finditer(r'<connection from="([^"]+)"[^>]*tl="[^"]*"[^>]*linkIndex="(\d+)"', s):
            links.setdefault(m.group(1), []).append(int(m.group(2)))
    return lanes, ends, stops, phases, links


def arm_labels(ends):
    """Classify the boundary nodes by position into the four named approaches."""
    if not ends:
        return {}
    xs = sorted(ends.items(), key=lambda kv: kv[1][0])
    ys = sorted(ends.items(), key=lambda kv: kv[1][1])
    return {"Panathur": xs[0][1], "Varthur": xs[-1][1],
            "Sarjapur": ys[0][1], "Kundalahalli": ys[-1][1]}


# ── data ──────────────────────────────────────────────────────────────────
def load_fcd(p):
    per = {}
    for _ev, el in ET.iterparse(p, events=("end",)):
        if el.tag == "timestep":
            t = int(float(el.get("time")))
            if t <= END:
                per[t] = [(float(v.get("x")), float(v.get("y")),
                           float(v.get("angle")), v.get("type"),
                           float(v.get("speed"))) for v in el]
            el.clear()
    return per


def load_summary(p):
    per = {}
    for _ev, el in ET.iterparse(p, events=("end",)):
        if el.tag == "step":
            t = int(float(el.get("time")))
            if t <= END:
                per[t] = dict(arrived=int(el.get("arrived")),
                              running=int(el.get("running")),
                              halting=int(el.get("halting")),
                              waiting=int(el.get("waiting")),
                              teleports=int(el.get("teleports")))
            el.clear()
    return per


def phase_at(phases, t):
    if not phases:
        return None
    cyc = sum(d for d, _ in phases)
    u, acc = t % cyc, 0.0
    for d, st in phases:
        acc += d
        if u < acc:
            return st
    return phases[-1][1]


SCEN = [
    ("current", os.path.join(HERE, "..", "networks", "BELAGERE.net.xml"),
     "TODAY", "no signal · two give-way U-turns"),
    ("proposed", os.path.join(HERE, "nets", "R2-paint180.net.xml"),
     "PROPOSED", "U-turns banned · signalised · two 3.0 m lanes"),
]

print("loading networks and run data...")
DATA = []
for tag, net, title, sub in SCEN:
    lanes, ends, stops, phases, links = load_net(net)
    DATA.append(dict(tag=tag, title=title, sub=sub, lanes=lanes,
                     arms=arm_labels(ends), stops=stops, phases=phases,
                     links=links,
                     fcd=load_fcd(os.path.join(VID, f"{tag}-fcd.xml")),
                     summ=load_summary(os.path.join(VID, f"{tag}-sum.xml"))))
    print(f"  {tag}: {len(lanes)} lanes, {len(DATA[-1]['fcd'])} timesteps, "
          f"{len(phases)} phases")

# one world box for both panels, so the two views are directly comparable
allpts = [p for d in DATA for sh, _w in d["lanes"] for p in sh]
x0, x1 = min(p[0] for p in allpts), max(p[0] for p in allpts)
y0, y1 = min(p[1] for p in allpts), max(p[1] for p in allpts)
mx, my = 26, 26
SCALE = min((PANEL_W - 2 * mx) / (x1 - x0), (PANEL_H - 2 * my) / (y1 - y0))
CX, CY = (x0 + x1) / 2, (y0 + y1) / 2
print(f"  world {x1-x0:.0f} × {y1-y0:.0f} m -> {SCALE:.2f} px/m")


def T(x, y):
    return (PANEL_W / 2 + (x - CX) * SCALE, PANEL_H / 2 - (y - CY) * SCALE)


def draw_panel(d, t):
    im = Image.new("RGB", (PANEL_W, PANEL_H), SURFACE)
    dr = ImageDraw.Draw(im)
    for sh, wm in d["lanes"]:
        pts = [T(*p) for p in sh]
        if len(pts) < 2:
            continue
        dr.line(pts, fill=ROAD_EDGE, width=max(3, int(wm * SCALE) + 4),
                joint="curve")
    for sh, wm in d["lanes"]:
        pts = [T(*p) for p in sh]
        if len(pts) < 2:
            continue
        dr.line(pts, fill=ROAD, width=max(2, int(wm * SCALE)), joint="curve")

    st = phase_at(d["phases"], t)
    if st:
        rank = {"G": 3, "g": 2, "y": 1, "r": 0}
        col = {3: GREEN, 2: (40, 140, 80), 1: AMBER, 0: (70, 70, 76)}
        for frm, pos in d["stops"].items():
            idx = d["links"].get(frm, [])
            best = max((rank.get(st[i], 0) for i in idx if i < len(st)), default=0)
            x, y = T(*pos)
            r = 6
            dr.ellipse([x - r, y - r, x + r, y + r], fill=col[best],
                       outline=SURFACE, width=2)

    for name, pos in d["arms"].items():
        x, y = T(*pos)
        x = min(max(x, 40), PANEL_W - 40)
        y = min(max(y, 12), PANEL_H - 18)
        w = dr.textlength(name, font=F_ARM)
        dr.text((x - w / 2, y - 6), name, font=F_ARM, fill=(150, 110, 200))

    for x, y, ang, vt, spd in d["fcd"].get(t, ()):
        L, Wm = SHAPE.get(vt, (4.5, 1.8))
        px, py = T(x, y)
        a = math.radians(90 - ang)
        dx, dy = math.cos(a), -math.sin(a)
        hl, hw = L * SCALE / 2, max(1.3, Wm * SCALE / 2)
        nx, ny = -dy, dx
        quad = [(px + dx * hl + nx * hw, py + dy * hl + ny * hw),
                (px + dx * hl - nx * hw, py + dy * hl - ny * hw),
                (px - dx * hl - nx * hw, py - dy * hl - ny * hw),
                (px - dx * hl + nx * hw, py - dy * hl + ny * hw)]
        dr.polygon(quad, fill=speed_color(spd))

    dr.rectangle([0, 0, PANEL_W - 1, PANEL_H - 1], outline=HAIR)
    return im


def hud(dr, ox, oy, d, t):
    s = d["summ"].get(t, dict(arrived=0, running=0, halting=0, waiting=0,
                              teleports=0))
    moving = max(0, s["running"] - s["halting"])
    cells = [("THROUGH", f"{s['arrived']:,}", GREEN),
             ("MOVING", f"{moving:,}", INK),
             ("STOPPED", f"{s['halting']:,}", AMBER),
             ("QUEUED OUTSIDE", f"{s['waiting']:,}", RED),
             ("GRIDLOCKS", f"{s['teleports']:,}",
              RED if s["teleports"] else INK3)]
    x = ox
    for label, val, col in cells:
        dr.text((x, oy), label, font=F_HUD, fill=INK3)
        dr.text((x, oy + 15), val, font=F_HUDV2, fill=col)
        x += 152


def legend(dr, y):
    x = PAD
    dr.text((x, y), "VEHICLE COLOUR", font=F_HUD, fill=INK3)
    x += 108
    for col, lab in ((RED, "stopped"), (AMBER, "crawling"), (GREEN, "moving freely")):
        dr.rectangle([x, y + 1, x + 16, y + 9], fill=col)
        dr.text((x + 22, y - 1), lab, font=F_LEG, fill=INK2)
        x += 34 + dr.textlength(lab, font=F_LEG)
    x += 18
    dr.text((x, y), "SIGNAL", font=F_HUD, fill=INK3)
    x += 52
    for col, lab in ((GREEN, "green"), (AMBER, "amber"), ((70, 70, 76), "red")):
        dr.ellipse([x, y - 1, x + 11, y + 10], fill=col)
        dr.text((x + 17, y - 1), lab, font=F_LEG, fill=INK2)
        x += 29 + dr.textlength(lab, font=F_LEG)
    note = "same 5,743 vehicles · same departure times · 30× real time"
    dr.text((W - PAD - dr.textlength(note, font=F_LEG), y - 1), note,
            font=F_LEG, fill=INK3)


def frame(t):
    im = Image.new("RGB", (W, H), GROUND)
    dr = ImageDraw.Draw(im)

    dr.rectangle([0, 0, W, 4], fill=ACCENT)
    dr.text((PAD, 17), "BALAGERE T JUNCTION", font=font(13, True), fill=INK)
    dr.text((PAD, 35), "peak hour · SUMO microsimulation", font=F_LEG, fill=INK3)
    clock = f"{t // 60:02d}:{t % 60:02d}"
    cw = dr.textlength(clock, font=F_CLK)
    dr.text((W - PAD - cw, 20), clock, font=F_CLK, fill=INK)
    dr.text((W - PAD - cw - 76, 32), "ELAPSED", font=F_HUD, fill=INK3)

    for i, d in enumerate(DATA):
        ox = PAD + i * (PANEL_W + GAP)
        dr.text((ox, 60), d["title"], font=F_TITLE,
                fill=ACCENT if i else INK)
        dr.text((ox + dr.textlength(d["title"], font=F_TITLE) + 12, 71),
                d["sub"], font=F_SUB, fill=INK3)
        im.paste(draw_panel(d, t), (ox, HEAD_H))
        hud(dr, ox, HEAD_H + PANEL_H + 14, d, t)

    legend(dr, H - 20)
    return im


if __name__ == "__main__":
    print(f"rendering {END} frames at {W}×{H} ...")
    for t in range(END):
        frame(t).save(os.path.join(FRAMES, f"f{t:05d}.png"))
        if t % 150 == 0:
            print(f"  {t}/{END}")
    print("done")
