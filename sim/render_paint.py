#!/usr/bin/env python3
"""Render each network variant as an inline SVG diagram, a turn matrix and a
signal phase timeline, as self-contained HTML fragments.

Inline SVG rather than sumo-gui screenshots: it embeds in the report with no
external files, prints cleanly to PDF, scales to any width, and inherits the
reader's light/dark theme.
"""
import os, re, math, xml.etree.ElementTree as ET
import viz

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "figs")
os.makedirs(OUT, exist_ok=True)

# arm identity by boundary node
ARM_OF_NODE = {
    "J0":  ("Panathur",     "E"),
    "J3":  ("Varthur TPS",  "W"),
    "J15": ("Kundalahalli", "N"),
    "J2":  ("Sarjapur",     "S"),
}
DIR_NAME = {"s": "through", "l": "left", "r": "right", "t": "u-turn",
            "L": "left", "R": "right", "T": "u-turn", "i": "internal",
            "invalid": "invalid"}
DIR_COLOR = {"s": "var(--blue)", "l": "var(--green)", "r": "var(--orange)",
             "t": "var(--red)", "T": "var(--red)", "L": "var(--green)",
             "R": "var(--orange)"}


def pts(s):
    return [tuple(float(v) for v in p.split(",")[:2]) for p in s.split()] if s else []


def load(netpath):
    root = ET.parse(netpath).getroot()
    edges, junctions, conns, tls = {}, {}, [], {}
    for e in root.findall("edge"):
        eid = e.get("id")
        if e.get("function") == "internal":
            continue
        lanes = []
        for l in e.findall("lane"):
            lanes.append({"id": l.get("id"),
                          "shape": pts(l.get("shape")),
                          "width": float(l.get("width", 3.2)),
                          "length": float(l.get("length", 0))})
        edges[eid] = {"id": eid, "from": e.get("from"), "to": e.get("to"),
                      "lanes": lanes}
    for j in root.findall("junction"):
        if j.get("id", "").startswith(":"):
            continue
        junctions[j.get("id")] = {"id": j.get("id"), "type": j.get("type"),
                                  "x": float(j.get("x")), "y": float(j.get("y")),
                                  "shape": pts(j.get("shape"))}
    for c in root.findall("connection"):
        if c.get("from", "").startswith(":"):
            continue
        conns.append({k: c.get(k) for k in
                      ("from", "to", "fromLane", "toLane", "dir", "state",
                       "tl", "linkIndex", "via")})
    for t in root.findall("tlLogic"):
        tls[t.get("id")] = {
            "id": t.get("id"), "type": t.get("type"),
            "params": {p.get("key"): p.get("value") for p in t.findall("param")},
            "phases": [{"duration": float(p.get("duration")),
                        "minDur": p.get("minDur"), "maxDur": p.get("maxDur"),
                        "state": p.get("state")} for p in t.findall("phase")],
        }
    return edges, junctions, conns, tls


# ── SVG network diagram ──────────────────────────────────────────────────
def svg_network(edges, junctions, conns, tls, width=640):
    allpts = [p for e in edges.values() for l in e["lanes"] for p in l["shape"]]
    allpts += [p for j in junctions.values() for p in j["shape"]]
    if not allpts:
        return "<p>no geometry</p>"
    xs = [p[0] for p in allpts]; ys = [p[1] for p in allpts]
    pad = 16
    minx, maxx, miny, maxy = min(xs) - pad, max(xs) + pad, min(ys) - pad, max(ys) + pad
    w, h = maxx - minx, maxy - miny
    height = max(200, int(width * h / w))
    scale = width / w

    def T(p):
        # SUMO y is up, SVG y is down
        return ((p[0] - minx) * scale, (maxy - p[1]) * scale)

    o = [f'<svg viewBox="0 0 {width:.0f} {height:.0f}" width="100%" '
         f'style="max-width:{width}px;height:auto;display:block;margin:0 auto" '
         f'role="img" aria-label="network diagram">']
    o.append('<g fill="none" stroke-linecap="round" stroke-linejoin="round">')

    # junction areas
    for j in junctions.values():
        if len(j["shape"]) >= 3:
            d = " ".join(f"{x:.1f},{y:.1f}" for x, y in map(T, j["shape"]))
            fill = ("rgba(135,37,214,0.13)" if j["type"] == "traffic_light"
                    else "rgba(0,0,0,0.07)")
            o.append(f'<polygon points="{d}" fill="{fill}" stroke="none"/>')

    # lanes: grey casing + centreline
    for e in edges.values():
        for l in e["lanes"]:
            if len(l["shape"]) < 2:
                continue
            d = " ".join(f"{x:.1f},{y:.1f}" for x, y in map(T, l["shape"]))
            sw = max(2.0, l["width"] * scale)
            o.append(f'<polyline points="{d}" stroke="rgba(0,0,0,0.30)" '
                     f'stroke-width="{sw:.1f}"/>')
            o.append(f'<polyline points="{d}" stroke="rgba(255,255,255,0.55)" '
                     f'stroke-width="{max(0.6, sw*0.10):.1f}" '
                     f'stroke-dasharray="5 6"/>')

    # direction arrow at the midpoint of each edge's first lane
    for e in edges.values():
        l = e["lanes"][0]
        if len(l["shape"]) < 2:
            continue
        a, b = T(l["shape"][len(l["shape"]) // 2 - 1]), T(l["shape"][len(l["shape"]) // 2])
        ang = math.atan2(b[1] - a[1], b[0] - a[0])
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        s = 5
        p1 = (mx + s * math.cos(ang), my + s * math.sin(ang))
        p2 = (mx - s * .7 * math.cos(ang) + s * .6 * math.sin(ang),
              my - s * .7 * math.sin(ang) - s * .6 * math.cos(ang))
        p3 = (mx - s * .7 * math.cos(ang) - s * .6 * math.sin(ang),
              my - s * .7 * math.sin(ang) + s * .6 * math.cos(ang))
        d = " ".join(f"{x:.1f},{y:.1f}" for x, y in (p1, p2, p3))
        o.append(f'<polygon points="{d}" fill="rgba(0,0,0,0.55)" stroke="none"/>')

    o.append("</g>")

    # edge id labels, so the turning-movement tables can be located on the map
    o.append('<g font-family="ui-monospace,Menlo,monospace" font-size="8.5" '
             'font-weight="600">')
    for e in edges.values():
        l = e["lanes"][0]
        if len(l["shape"]) < 2:
            continue
        mid = l["shape"][len(l["shape"]) // 2]
        a, b = l["shape"][0], l["shape"][-1]
        x, y = T(mid)
        # nudge the label off the centreline, perpendicular to the edge
        dx, dy = (b[0] - a[0]), (b[1] - a[1])
        n = (dx * dx + dy * dy) ** 0.5 or 1
        ox, oy = (-dy / n) * 9, (dx / n) * 9
        tx, ty = x + ox, y + oy
        bound = (e["from"] in ARM_OF_NODE) or (e["to"] in ARM_OF_NODE)
        tag = e["id"]
        if e["from"] in ARM_OF_NODE:
            tag += " ▸in"
        elif e["to"] in ARM_OF_NODE:
            tag += " ▸out"
        w = 5.4 * len(tag) + 6
        o.append(f'<rect x="{tx-w/2:.1f}" y="{ty-6.5:.1f}" width="{w:.1f}" '
                 f'height="12" rx="3" fill="rgba(255,255,255,0.86)" '
                 f'stroke="rgba(0,0,0,0.10)"/>')
        col = "var(--purple)" if bound else "rgba(0,0,0,0.62)"
        o.append(f'<text x="{tx:.1f}" y="{ty+3:.1f}" text-anchor="middle" '
                 f'fill="{col}">{tag}</text>')
    o.append("</g>")

    # arm labels + lane counts
    o.append('<g font-family="Manrope,sans-serif" font-size="11" font-weight="700">')
    for nid, j in junctions.items():
        if nid not in ARM_OF_NODE:
            continue
        name, compass = ARM_OF_NODE[nid]
        x, y = T((j["x"], j["y"]))
        inc = [e for e in edges.values() if e["to"] == nid]
        out_ = [e for e in edges.values() if e["from"] == nid]
        nl = out_[0]["lanes"] if out_ else (inc[0]["lanes"] if inc else [])
        ax = min(max(x, 46), width - 46)
        ay = min(max(y, 14), height - 6)
        o.append(f'<text x="{ax:.0f}" y="{ay:.0f}" text-anchor="middle" '
                 f'fill="var(--purple)">{compass} · {name}</text>')
        o.append(f'<text x="{ax:.0f}" y="{ay + 12:.0f}" text-anchor="middle" '
                 f'font-size="9.5" font-weight="500" fill="rgba(0,0,0,0.55)">'
                 f'{len(nl)} lane{"s" if len(nl) != 1 else ""} each way</text>')
    # signal marker
    for j in junctions.values():
        if j["type"] == "traffic_light":
            x, y = T((j["x"], j["y"]))
            o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" '
                     f'fill="var(--purple)" stroke="#fff" stroke-width="1.5"/>')
    o.append("</g>")

    # scale bar
    bar_m = 50.0
    bl = bar_m * scale
    o.append(f'<g font-family="Manrope,sans-serif" font-size="9" font-weight="600">'
             f'<line x1="10" y1="{height-10}" x2="{10+bl:.1f}" y2="{height-10}" '
             f'stroke="rgba(0,0,0,0.6)" stroke-width="2"/>'
             f'<text x="{10+bl/2:.1f}" y="{height-14}" text-anchor="middle" '
             f'fill="rgba(0,0,0,0.6)">{bar_m:.0f} m</text></g>')
    o.append(f'<g font-family="Manrope,sans-serif" font-size="9" font-weight="600">'
             f'<text x="{width-10}" y="{height-24}" text-anchor="end" '
             f'fill="rgba(0,0,0,0.5)">purple label = boundary edge · '
             f'\u25b8in = entry, \u25b8out = exit</text>'
             f'<text x="{width-10}" y="{height-12}" text-anchor="end" '
             f'fill="rgba(0,0,0,0.5)">grey label = internal edge · '
             f'arrow = direction of travel</text></g>')
    o.append("</svg>")
    return "\n".join(o)


# ── signal phase timeline ────────────────────────────────────────────────
STATE_COLOR = {"G": "var(--green)", "g": "rgba(63,172,85,0.45)",
               "y": "var(--amber)", "r": "rgba(0,0,0,0.14)",
               "u": "var(--orange)", "o": "rgba(234,100,53,0.5)",
               "O": "var(--orange)", "s": "var(--blue)"}


def svg_phases(tl, conns, width=660):
    if not tl:
        return ""
    phases = tl["phases"]
    cycle = sum(p["duration"] for p in phases)
    nlinks = len(phases[0]["state"])
    # link -> label
    lab = {}
    for c in conns:
        if c.get("tl") == tl["id"] and c.get("linkIndex") is not None:
            i = int(c["linkIndex"])
            arm = arm_for_edge(c["from"], conns)
            lab[i] = f'{c["from"]} {DIR_NAME.get(c.get("dir"), "?")}'
    rowh, top, left = 15, 26, 168
    height = top + nlinks * rowh + 30
    plot = width - left - 12
    o = [f'<svg viewBox="0 0 {width} {height}" width="100%" '
         f'style="max-width:{width}px;height:auto;display:block" role="img" '
         f'aria-label="signal phase timeline">']
    o.append('<g font-family="Manrope,sans-serif" font-size="9.5" font-weight="600">')
    # time axis
    step = 10
    t = 0
    while t <= cycle:
        x = left + plot * t / cycle
        o.append(f'<line x1="{x:.1f}" y1="{top-6}" x2="{x:.1f}" y2="{height-24}" '
                 f'stroke="rgba(0,0,0,0.08)"/>')
        o.append(f'<text x="{x:.1f}" y="{top-10}" text-anchor="middle" '
                 f'fill="rgba(0,0,0,0.5)">{t}</text>')
        t += step
    for i in range(nlinks):
        y = top + i * rowh
        o.append(f'<text x="{left-8}" y="{y+10}" text-anchor="end" '
                 f'font-size="9" font-weight="500" fill="rgba(0,0,0,0.68)">'
                 f'{lab.get(i, "link " + str(i))}</text>')
        t0 = 0
        for p in phases:
            ch = p["state"][i]
            x = left + plot * t0 / cycle
            w = plot * p["duration"] / cycle
            o.append(f'<rect x="{x:.1f}" y="{y+1.5:.1f}" width="{w:.1f}" '
                     f'height="{rowh-4}" rx="2" '
                     f'fill="{STATE_COLOR.get(ch, "rgba(0,0,0,0.14)")}"/>')
            t0 += p["duration"]
    o.append(f'<text x="{left}" y="{height-8}" font-size="9.5" '
             f'font-weight="700" fill="var(--purple)">'
             f'cycle {cycle:.0f} s · {tl["type"]}'
             + (" · " + ", ".join(f"{k}={v}" for k, v in tl["params"].items())
                if tl["params"] else "") + "</text>")
    o.append("</g></svg>")
    return "\n".join(o)


def arm_for_edge(eid, conns):
    return eid


# ── turn matrix ──────────────────────────────────────────────────────────
def turn_table(edges, junctions, conns, tls):
    """Approach -> exit, with direction, lanes serving it, and signal control."""
    # map edge -> arm (by tracing to a boundary node where possible)
    def arm_in(eid):
        e = edges.get(eid)
        if e and e["from"] in ARM_OF_NODE:
            return ARM_OF_NODE[e["from"]][1]
        return None

    def arm_out(eid):
        e = edges.get(eid)
        if e and e["to"] in ARM_OF_NODE:
            return ARM_OF_NODE[e["to"]][1]
        return None

    rows = {}
    for c in conns:
        key = (c["from"], c["to"], c.get("dir"))
        r = rows.setdefault(key, {"lanes": 0, "tl": c.get("tl"),
                                  "idx": [], "state": c.get("state")})
        r["lanes"] += 1
        if c.get("linkIndex") is not None:
            r["idx"].append(int(c["linkIndex"]))

    out = ['<div class="tbl-wrap"><table class="compare"><thead><tr>'
           '<th>From</th><th>To</th><th>Movement</th><th>Lanes</th>'
           '<th>Control</th></tr></thead><tbody>']
    for (f, t, d), r in sorted(rows.items()):
        ai, ao = arm_in(f), arm_out(t)
        fl = f + (f" <span class='pill purple'>{ai} in</span>" if ai else "")
        tl_ = t + (f" <span class='pill purple'>{ao} out</span>" if ao else "")
        dn = DIR_NAME.get(d, d or "?")
        col = DIR_COLOR.get(d, "")
        st = r["state"]
        if r["tl"]:
            ctrl = f"<span class='pill green'>signal</span> link {min(r['idx'])}" \
                if len(r["idx"]) == 1 else \
                f"<span class='pill green'>signal</span> links {min(r['idx'])}–{max(r['idx'])}"
        elif st in ("M", "O"):
            ctrl = "<span class='pill blue'>priority — major</span>"
        elif st in ("m", "o"):
            ctrl = "<span class='pill orange'>priority — must yield</span>"
        else:
            ctrl = f"<span class='pill no'>{st}</span>"
        badge = "green" if d in ("l", "L") else \
                "blue" if d == "s" else \
                "orange" if d in ("r", "R") else "red"
        out.append(f"<tr><td>{fl}</td><td>{tl_}</td>"
                   f"<td><span class='pill {badge}'>{dn}</span></td>"
                   f"<td class='num'>{r['lanes']}</td><td>{ctrl}</td></tr>")
    out.append("</tbody></table></div>")
    return "\n".join(out)


VARIANTS = [
    ("R2-paint180",   "nets/R2-paint180.net.xml",
     "RECOMMENDED — U-turns banned, signalised, 6 m marked as two 3.0 m lanes, 180 s cycle"),
    ("R1-fair210",    "nets/R1-fair210.net.xml",
     "Signal-only option — U-turns banned, signalised, one lane, 210 s cycle"),
    ("3-delivered",   "../networks/balegere-no-uturn-traffic.net.xml",
     "U-turns banned + signal, one lane, 171 s cycle"),
    ("1-baseline",    "../networks/BELAGERE.net.xml",
     "TODAY — no signal, two give-way U-turns, median cut"),
    ("2-nouturn",     "../networks/balegere-no-uturn.net.xml",
     "U-turns banned, still no signal"),
]

if __name__ == "__main__":
    frags = {}
    for tag, path, desc in VARIANTS:
        p = os.path.join(HERE, path)
        edges, junctions, conns, tls = load(p)
        tl = list(tls.values())[0] if tls else None
        n_lanes = {e["id"]: len(e["lanes"]) for e in edges.values()}
        frag = []
        frag.append(f'<h3>{tag} — {desc}</h3>')
        frag.append('<div class="diagram-embed-wrap" style="padding:14px 10px;">')
        frag.append(svg_network(edges, junctions, conns, tls))
        frag.append("</div>")
        frag.append(f'<p style="font-size:13px;color:var(--text-75);">'
                    f'{len(edges)} directed edges, '
                    f'{sum(n_lanes.values())} lanes total, '
                    f'{len([j for j in junctions.values() if j["type"] not in ("dead_end",)])}'
                    f' internal junction(s), '
                    f'{"signalised" if tl else "unsignalised"}.</p>')
        frag.append("<h4>Allowed turning movements</h4>")
        frag.append(turn_table(edges, junctions, conns, tls))
        if tl:
            frag.append("<h4>Signal program — interactive</h4>")
            frag.append('<p style="font-size:13px;color:var(--text-75);">'
                        'Press play to step through one full cycle. Each arrow is a '
                        'permitted movement: solid green is protected, pale green is '
                        'permissive (give way to opposing traffic), grey is stopped. '
                        'Scrub the slider to inspect any instant.</p>')
            links_for_player = {}
            for c in conns:
                if c.get("tl") == tl["id"] and c.get("linkIndex") is not None:
                    links_for_player[int(c["linkIndex"])] = (c["from"], c.get("dir"))
            frag.append('<div class="diagram-embed-wrap" style="padding:14px 10px;">')
            frag.append(viz.signal_player(
                [(p["duration"], p["state"]) for p in tl["phases"]],
                links_for_player, tag.replace(".", "-")))
            frag.append("</div>")
            frag.append("<h4>Signal program — phase timeline</h4>")
            frag.append('<div class="diagram-embed-wrap" style="padding:14px 10px;">')
            frag.append(svg_phases(tl, conns))
            frag.append("</div>")
            rows = "".join(
                f"<tr><td>{i+1}</td><td class='num'>{p['duration']:.0f}</td>"
                f"<td class='num'>{p['minDur'] or '—'}</td>"
                f"<td class='num'>{p['maxDur'] or '—'}</td>"
                f"<td><code>{p['state']}</code></td></tr>"
                for i, p in enumerate(tl["phases"]))
            frag.append(
                '<div class="tbl-wrap"><table class="compare"><thead><tr>'
                '<th>Phase</th><th>Duration s</th><th>minDur</th><th>maxDur</th>'
                '<th>State</th></tr></thead><tbody>' + rows +
                "</tbody></table></div>")
        frags[tag] = "\n".join(frag)
        print(f"  rendered {tag}: {len(edges)} edges, "
              f"{sum(n_lanes.values())} lanes, "
              f"tls={'yes' if tl else 'no'}")

    with open(os.path.join(OUT, "paint.html"), "w") as f:
        f.write(viz.PLAYER_CSS)
        for tag, _p, _d in VARIANTS:
            f.write(f'<section id="net-{tag}">\n{frags[tag]}\n</section>\n')
    print(f"\nwrote {os.path.join(OUT, 'variants.html')}")
