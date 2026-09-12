#!/usr/bin/env python3
"""Charts and the interactive signal player for the report.

Palette: report tokens --purple #8725d6 and --blue #169ee9 for the 2-series
categorical case, validated with the data-viz checks (lightness band, chroma
floor, CVD separation deltaE 15.3 deutan, normal-vision 26.7, all PASS; contrast
vs surface WARNs below 3:1, so every mark carries a direct value label and the
underlying table is kept alongside as the table view). Status colors
(--green / --red) are reserved for the deadlock state and always ship with a
written count, never color alone.
"""

# state precedence: protected > permissive > yellow > red
_RANK = {"G": 3, "g": 2, "y": 1, "r": 0, "u": 1, "O": 3, "o": 2, "s": 1}
STATE_FILL = {
    "G": "var(--green)",
    "g": "rgba(63,172,85,0.42)",
    "y": "var(--amber)",
    "r": "rgba(0,0,0,0.13)",
}
STATE_WORD = {"G": "protected green", "g": "permissive green",
              "y": "amber", "r": "red"}


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ── grouped bar chart: total served + worst arm across configurations ─────
def bar_compare(rows, width=660, title=None):
    """rows: [(label, sublabel, total_pct, worst_pct)] -- 2 series, legend + labels."""
    n = len(rows)
    left, right, top = 208, 96, 34
    rowh, gap, barh = 46, 2, 17
    height = top + n * rowh + 16
    plot = width - left - right
    o = [f'<svg viewBox="0 0 {width} {height}" width="100%" '
         f'style="max-width:{width}px;height:auto;display:block;margin:4px auto" '
         f'role="img" aria-label="{_esc(title or "comparison")}">']
    o.append('<g font-family="Manrope,sans-serif">')

    # legend (2 series -> legend always present)
    o.append(f'<g font-size="11" font-weight="600">')
    o.append(f'<rect x="{left}" y="6" width="9" height="9" rx="2" fill="var(--purple)"/>'
             f'<text x="{left+14}" y="14.5" fill="rgba(0,0,0,0.7)">Total demand served</text>')
    o.append(f'<rect x="{left+150}" y="6" width="9" height="9" rx="2" fill="var(--blue)"/>'
             f'<text x="{left+164}" y="14.5" fill="rgba(0,0,0,0.7)">Worst-served arm</text>')
    o.append("</g>")

    # recessive gridlines at 25% steps
    for pct in (0, 25, 50, 75, 100):
        x = left + plot * pct / 100
        o.append(f'<line x1="{x:.1f}" y1="{top-4}" x2="{x:.1f}" y2="{height-14}" '
                 f'stroke="rgba(0,0,0,0.07)"/>')
        o.append(f'<text x="{x:.1f}" y="{height-3}" text-anchor="middle" '
                 f'font-size="9.5" font-weight="500" fill="rgba(0,0,0,0.45)">{pct}%</text>')

    for i, (label, sub, total, worst) in enumerate(rows):
        y = top + i * rowh
        o.append(f'<text x="{left-12}" y="{y+13}" text-anchor="end" font-size="11.5" '
                 f'font-weight="700" fill="rgba(0,0,0,0.82)">{_esc(label)}</text>')
        if sub:
            o.append(f'<text x="{left-12}" y="{y+26}" text-anchor="end" font-size="9.5" '
                     f'font-weight="500" fill="rgba(0,0,0,0.5)">{_esc(sub)}</text>')
        for k, (val, col) in enumerate(((total, "var(--purple)"),
                                        (worst, "var(--blue)"))):
            by = y + 2 + k * (barh + gap)
            w = max(1.5, plot * val / 100)
            # 4px rounded data-end, anchored to the baseline at x=left
            o.append(f'<path d="M{left} {by} H{left+w-4:.1f} a4 4 0 0 1 4 4 '
                     f'V{by+barh-4} a4 4 0 0 1 -4 4 H{left} Z" fill="{col}"/>')
            o.append(f'<text x="{left+w+7:.1f}" y="{by+barh-4.5}" font-size="11" '
                     f'font-weight="700" fill="rgba(0,0,0,0.75)">{val:.1f}%</text>')
    o.append("</g></svg>")
    return "\n".join(o)


# ── cliff chart: served % by cycle length, with deadlock state ────────────
def cliff_chart(rows, width=660):
    """rows: [(cycle, served_pct, worst_pct, teleports)] ordered by cycle."""
    n = len(rows)
    left, top = 52, 40
    height = 250
    plot_w = width - left - 18
    plot_h = height - top - 54
    slot = plot_w / n
    barw = min(58, slot - 16)
    o = [f'<svg viewBox="0 0 {width} {height}" width="100%" '
         f'style="max-width:{width}px;height:auto;display:block;margin:4px auto" '
         f'role="img" aria-label="demand served by cycle length">']
    # Deuteranopia collapses red against green (validated deltaE 3.8), so the
    # failing bars also carry a diagonal hatch and a written verdict. Never hue
    # alone for this distinction.
    o.append('<defs><pattern id="hatchfail" width="7" height="7" '
             'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
             '<rect width="7" height="7" fill="var(--red)"/>'
             '<line x1="0" y1="0" x2="0" y2="7" stroke="rgba(0,0,0,0.34)" '
             'stroke-width="3"/></pattern></defs>')
    o.append('<g font-family="Manrope,sans-serif">')

    for pct in (0, 25, 50, 75, 100):
        y = top + plot_h * (1 - pct / 100)
        o.append(f'<line x1="{left}" y1="{y:.1f}" x2="{width-18}" y2="{y:.1f}" '
                 f'stroke="rgba(0,0,0,0.07)"/>')
        o.append(f'<text x="{left-8}" y="{y+3.5:.1f}" text-anchor="end" font-size="9.5" '
                 f'font-weight="500" fill="rgba(0,0,0,0.45)">{pct}%</text>')

    for i, (cyc, served, worst, tele) in enumerate(rows):
        cx = left + slot * i + slot / 2
        h = plot_h * served / 100
        y = top + plot_h - h
        ok = tele == 0
        col = "var(--green)" if ok else "url(#hatchfail)"
        lab_col = "var(--green)" if ok else "var(--red)"
        o.append(f'<path d="M{cx-barw/2:.1f} {top+plot_h} V{y+4:.1f} '
                 f'a4 4 0 0 1 4 -4 H{cx+barw/2-4:.1f} a4 4 0 0 1 4 4 '
                 f'V{top+plot_h} Z" fill="{col}"/>')
        o.append(f'<text x="{cx:.1f}" y="{y-7:.1f}" text-anchor="middle" font-size="12" '
                 f'font-weight="700" fill="rgba(0,0,0,0.8)">{served:.1f}%</text>')
        o.append(f'<text x="{cx:.1f}" y="{top+plot_h+16}" text-anchor="middle" '
                 f'font-size="11" font-weight="700" fill="rgba(0,0,0,0.75)">{cyc} s</text>')
        # status ships with a written label, never color alone
        badge = "✓ no deadlock" if ok else f"✕ {tele} deadlocks"
        o.append(f'<text x="{cx:.1f}" y="{top+plot_h+31}" text-anchor="middle" '
                 f'font-size="9.5" font-weight="600" fill="{lab_col}">{badge}</text>')
        o.append(f'<text x="{cx:.1f}" y="{top+plot_h+44}" text-anchor="middle" '
                 f'font-size="9" font-weight="500" fill="rgba(0,0,0,0.45)">'
                 f'worst arm {worst:.0f}%</text>')

    o.append(f'<text x="{left}" y="18" font-size="11" font-weight="700" '
             f'fill="rgba(0,0,0,0.7)">Demand served at peak</text>')
    o.append(f'<text x="{width-18}" y="18" text-anchor="end" font-size="10" '
             f'font-weight="600" fill="rgba(0,0,0,0.45)">'
             f'2 × 3.0 m marking · 4-phase protected</text>')
    o.append("</g></svg>")
    return "\n".join(o)


# ── interactive signal player ─────────────────────────────────────────────
# Arms are placed to match the network's own orientation: Panathur is the
# westernmost node, Varthur the easternmost, Kundalahalli north, Sarjapur south.
# Left-hand traffic, so from an inbound heading h the left turn is h rotated
# +90 degrees in map coordinates and the right turn -90.
ARM_GEOM = {
    #  arm key          label            side   heading (map coords, y up)
    "P_Panathur":     ("Panathur",     "left",   (1, 0)),
    "V_Varthur":      ("Varthur TPS",  "right",  (-1, 0)),
    "K_Kundalahalli": ("Kundalahalli", "top",    (0, -1)),
    "S_Sarjapur":     ("Sarjapur",     "bottom", (0, 1)),
}
ARM_OF_IN = {"E5": "P_Panathur", "-E5": "V_Varthur",
             "-E6": "K_Kundalahalli", "E3": "S_Sarjapur",
             "E0": "P_Panathur", "-E2": "V_Varthur",
             "E4": "K_Kundalahalli"}


def signal_player(phases, links, uid, width=700):
    """phases: [(duration, state)]; links: {index: (from_edge, dir)}.

    Geometry notes, because the first attempt got both wrong:

    * An arm sits OPPOSITE its inbound heading. Panathur is the westernmost node
      and its traffic travels east, so heading is +x and the arm is drawn at -x.
    * Left-hand traffic: a vehicle keeps to the left of its direction of travel,
      so each movement is drawn offset to the left of the inbound arm, curves
      through the junction, and leaves offset to the left of the outbound
      direction. Left turns hug the near corner; right turns sweep across the
      junction, which is exactly why they conflict with opposing traffic.
    """
    cycle = sum(d for d, _ in phases)

    groups = {}
    for i, (frm, d) in links.items():
        arm = ARM_OF_IN.get(frm)
        if not arm or d not in ("l", "s", "r"):
            continue
        groups.setdefault((arm, d), []).append(i)

    mkeys = list(groups)
    seq = []
    for dur, st in phases:
        row = {}
        for k in mkeys:
            best = max((st[i] for i in groups[k] if i < len(st)),
                       key=lambda c: _RANK.get(c, 0), default="r")
            row[f"{k[0]}|{k[1]}"] = best
        seq.append({"dur": dur, "st": row})

    R, STEM, LANE = 46.0, 122.0, 11.0
    L = R + STEM
    cx, cy = width / 2, 232.0
    strip_y = 476.0
    height = 584.0

    def P(mx, my):
        return cx + mx, cy - my

    def rot90(v):                      # ccw in map coords = left of travel
        return (-v[1], v[0])

    def mul(v, k):
        return (v[0] * k, v[1] * k)

    def add(*vs):
        return (sum(v[0] for v in vs), sum(v[1] for v in vs))

    HEAD = {a: g[2] for a, g in ARM_GEOM.items()}

    def start_pt(a):
        h = HEAD[a]
        return add(mul(h, -L), mul(rot90(h), LANE))

    def end_pt(b):
        h = HEAD[b]
        return add(mul(h, -L), mul(rot90(h), -LANE))

    def dest_arm(a, d):
        """Arm reached by movement d from arm a.

        exit direction: through continues along h, left is h rotated +90 (the
        near side under left-hand traffic), right is the opposite. The
        destination arm's own inbound heading points the other way, so match
        against the negated exit direction.
        """
        h = HEAD[a]
        exit_dir = {"s": h, "l": rot90(h), "r": mul(rot90(h), -1)}[d]
        want = mul(exit_dir, -1)
        for b, hb in HEAD.items():
            if abs(hb[0] - want[0]) < 1e-6 and abs(hb[1] - want[1]) < 1e-6:
                return b
        return None

    o = [f'<div class="sigplay" id="sp-{uid}">']
    o.append(f'<svg viewBox="0 0 {width} {height:.0f}" width="100%" '
             f'style="max-width:{width}px;height:auto;display:block;margin:0 auto" '
             f'role="img" aria-label="signal phase player">')
    o.append(f'<defs><marker id="ah-{uid}" viewBox="0 0 10 10" refX="8" refY="5" '
             f'markerWidth="3.6" markerHeight="3.6" orient="auto">'
             f'<path d="M0 1 L9 5 L0 9 z" fill="context-stroke"/></marker></defs>')
    o.append('<g font-family="Manrope,sans-serif">')

    # carriageway per arm, drawn from the outer end to the junction edge
    for a, (label, _side, h) in ARM_GEOM.items():
        ox, oy = P(*mul(h, -L))
        ix, iy = P(*mul(h, -R))
        o.append(f'<line x1="{ox:.1f}" y1="{oy:.1f}" x2="{ix:.1f}" y2="{iy:.1f}" '
                 f'stroke="rgba(0,0,0,0.13)" stroke-width="{2*LANE+6:.0f}" '
                 f'stroke-linecap="butt"/>')
        o.append(f'<line x1="{ox:.1f}" y1="{oy:.1f}" x2="{ix:.1f}" y2="{iy:.1f}" '
                 f'stroke="rgba(0,0,0,0.22)" stroke-width="1" '
                 f'stroke-dasharray="6 7"/>')

    # junction box
    jx, jy = P(-R, R)
    o.append(f'<rect x="{jx:.1f}" y="{jy:.1f}" width="{2*R}" height="{2*R}" rx="7" '
             f'fill="rgba(135,37,214,0.07)" stroke="rgba(135,37,214,0.22)"/>')

    # movement paths: inbound offset -> corner control -> outbound offset
    for (a, d) in sorted(groups, key=lambda k: (k[0], {"l": 0, "s": 1, "r": 2}[k[1]])):
        b = dest_arm(a, d)
        if not b:
            continue
        sp, ep = start_pt(a), end_pt(b)
        ha, hb = HEAD[a], HEAD[b]
        if d == "s":
            ctrl = mul(add(sp, ep), 0.5)
        else:
            # Corner: cross the inbound lane centreline (through sp, along ha)
            # with the outbound one (through ep). A horizontal inbound line pins
            # y from sp and takes x from ep; a vertical one does the reverse.
            ctrl = ((ep[0], sp[1]) if abs(ha[1]) < 1e-6 else (sp[0], ep[1]))
        x1, y1 = P(*sp); xc, yc = P(*ctrl); x2, y2 = P(*ep)
        o.append(f'<path d="M{x1:.1f} {y1:.1f} Q{xc:.1f} {yc:.1f} {x2:.1f} {y2:.1f}" '
                 f'fill="none" stroke="rgba(0,0,0,0.10)" stroke-width="4" '
                 f'stroke-linecap="round" marker-end="url(#ah-{uid})" '
                 f'data-mv="{a}|{d}"/>')

    # signal head per arm, at its stop line
    for a, (label, side, h) in ARM_GEOM.items():
        hx, hy = P(*add(mul(h, -(R + 9)), mul(rot90(h), LANE)))
        o.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="6.5" '
                 f'fill="rgba(0,0,0,0.13)" stroke="#fff" stroke-width="1.6" '
                 f'data-head="{a}"/>')
        # arm name, outside the carriageway
        lx, ly = P(*mul(h, -(L + 20)))
        anchor = ("end" if side == "left" else
                  "start" if side == "right" else "middle")
        dy = -8 if side == "top" else (16 if side == "bottom" else 4)
        o.append(f'<text x="{lx:.1f}" y="{ly + dy:.1f}" text-anchor="{anchor}" '
                 f'font-size="12" font-weight="700" fill="var(--purple)">'
                 f'{_esc(label)}</text>')

    # legend
    lg = [("var(--green)", "protected — right of way"),
          ("rgba(63,172,85,0.42)", "permissive — give way"),
          ("rgba(0,0,0,0.10)", "stopped")]
    lx = 30
    for col, txt in lg:
        o.append(f'<line x1="{lx}" y1="30" x2="{lx+20}" y2="30" stroke="{col}" '
                 f'stroke-width="5" stroke-linecap="round"/>')
        o.append(f'<text x="{lx+26}" y="33.5" font-size="10" font-weight="600" '
                 f'fill="rgba(0,0,0,0.6)">{txt}</text>')
        lx += 34 + 6.0 * len(txt)

    # phase strip
    sl, sw = 34.0, width - 68.0
    o.append(f'<text x="{sl}" y="{strip_y-10}" font-size="10.5" font-weight="700" '
             f'fill="rgba(0,0,0,0.55)">One cycle · {cycle:.0f} s</text>')
    t = 0.0
    for dur, st in phases:
        x = sl + sw * t / cycle
        w = sw * dur / cycle
        isg = any(c in "Gg" for c in st)
        o.append(f'<rect x="{x:.1f}" y="{strip_y:.0f}" '
                 f'width="{max(w-2,1):.1f}" height="20" rx="3" '
                 f'fill="{"rgba(63,172,85,0.26)" if isg else "var(--amber)"}"/>')
        if w > 32:
            o.append(f'<text x="{x+w/2:.1f}" y="{strip_y+14:.0f}" text-anchor="middle" '
                     f'font-size="9.5" font-weight="700" fill="rgba(0,0,0,0.6)">'
                     f'{dur:.0f}s</text>')
        t += dur
    for tick in range(0, int(cycle) + 1, 30):
        x = sl + sw * tick / cycle
        o.append(f'<line x1="{x:.1f}" y1="{strip_y+20:.0f}" x2="{x:.1f}" '
                 f'y2="{strip_y+25:.0f}" stroke="rgba(0,0,0,0.25)"/>')
        o.append(f'<text x="{x:.1f}" y="{strip_y+36:.0f}" text-anchor="middle" '
                 f'font-size="9" font-weight="500" fill="rgba(0,0,0,0.45)">{tick}</text>')
    o.append(f'<line id="cur-{uid}" x1="{sl}" y1="{strip_y-5:.0f}" x2="{sl}" '
             f'y2="{strip_y+25:.0f}" stroke="var(--purple)" stroke-width="2"/>')
    o.append("</g></svg>")

    o.append(f"""<div class="sp-ctl">
  <button type="button" class="sp-btn" data-act="play" aria-label="Play or pause">\u25b6 Play</button>
  <input class="sp-scrub" type="range" min="0" max="{cycle:.0f}" step="1" value="0"
         aria-label="Scrub through the cycle">
  <span class="sp-time">0 s</span>
  <select class="sp-speed" aria-label="Playback speed">
    <option value="1">1\u00d7</option><option value="2" selected>2\u00d7</option>
    <option value="4">4\u00d7</option><option value="8">8\u00d7</option>
  </select>
</div>
<div class="sp-read"><span class="sp-now">\u2014</span></div>""")
    o.append("</div>")

    import json
    o.append(f"""<script>
(function(){{
  var root=document.getElementById("sp-{uid}");
  if(!root) return;
  var seq={json.dumps(seq)}, cycle={cycle:.0f};
  var FILL={json.dumps(STATE_FILL)};
  var ARMS={json.dumps({k: v[0] for k, v in ARM_GEOM.items()})};
  var DIRW={{l:"left",s:"through",r:"right"}};
  var svg=root.querySelector("svg"), cur=root.querySelector("#cur-{uid}");
  var scrub=root.querySelector(".sp-scrub"), tlab=root.querySelector(".sp-time");
  var btn=root.querySelector(".sp-btn"), now=root.querySelector(".sp-now");
  var spd=root.querySelector(".sp-speed");
  var paths=[].slice.call(svg.querySelectorAll("[data-mv]"));
  var heads=[].slice.call(svg.querySelectorAll("[data-head]"));
  var RANK={{G:3,g:2,y:1,r:0}}, SL=34, SW={width - 68};
  function stateAt(t){{
    var acc=0;
    for(var i=0;i<seq.length;i++){{ acc+=seq[i].dur; if(t<acc) return seq[i]; }}
    return seq[seq.length-1];
  }}
  function render(t){{
    var ph=stateAt(t), on=[], best={{}};
    paths.forEach(function(p){{
      var key=p.getAttribute("data-mv"), c=ph.st[key]||"r";
      p.setAttribute("stroke",FILL[c]||FILL.r);
      p.setAttribute("stroke-width",(c==="G"?6:c==="g"?5:3.5).toString());
      p.style.opacity = (c==="G"||c==="g") ? "1" : "0.55";
      var arm=key.split("|")[0];
      if(!(arm in best)||RANK[c]>RANK[best[arm]]) best[arm]=c;
      if(c==="G"||c==="g")
        on.push(ARMS[arm]+" "+DIRW[key.split("|")[1]]+(c==="g"?" (give way)":""));
    }});
    heads.forEach(function(h){{
      var c=best[h.getAttribute("data-head")]||"r";
      h.setAttribute("fill", c==="G"?"var(--green)":c==="g"?"rgba(63,172,85,0.55)":
                     c==="y"?"var(--amber)":"rgba(0,0,0,0.13)");
    }});
    var x=SL+SW*(t/cycle);
    cur.setAttribute("x1",x.toFixed(1)); cur.setAttribute("x2",x.toFixed(1));
    tlab.textContent=Math.round(t)+" s";
    now.textContent = on.length ? "Moving now \u2014 "+on.join(" \u00b7 ")
                                : "All approaches stopped (inter-green)";
  }}
  var t=0, timer=null;
  function stop(){{ if(timer){{clearInterval(timer); timer=null;}} btn.textContent="\u25b6 Play"; }}
  function go(){{
    stop();
    timer=setInterval(function(){{ t=(t+1)%cycle; scrub.value=t; render(t); }},
                      1000/parseFloat(spd.value));
    btn.textContent="\u275a\u275a Pause";
  }}
  btn.addEventListener("click",function(){{ timer?stop():go(); }});
  scrub.addEventListener("input",function(){{ stop(); t=+scrub.value; render(t); }});
  spd.addEventListener("change",function(){{ if(timer) go(); }});
  render(0);
}})();
</script>""")
    return "\n".join(o)


PLAYER_CSS = """
<style>
.sigplay { margin: 4px 0 2px; }
.sigplay .sp-ctl { display:flex; align-items:center; gap:10px; margin:10px auto 0;
  max-width:680px; padding:0 4px; }
.sigplay .sp-btn { padding:6px 13px; border-radius:10px; border:none; cursor:pointer;
  background:var(--cta-gradient); color:#fff; font-family:inherit; font-size:12px;
  font-weight:700; min-width:86px; }
.sigplay .sp-btn:hover { filter:brightness(1.07); }
.sigplay .sp-scrub { flex:1; accent-color:var(--purple); }
.sigplay .sp-time { font-family:ui-monospace,Menlo,monospace; font-size:12px;
  font-weight:600; min-width:46px; text-align:right; color:var(--text-75); }
.sigplay .sp-speed { font-family:inherit; font-size:12px; font-weight:600;
  padding:4px 6px; border-radius:8px; border:1px solid var(--border);
  background:#fff; color:var(--text-75); }
.sigplay .sp-read { max-width:680px; margin:8px auto 0; padding:9px 13px;
  border-radius:10px; background:var(--bg-card); font-size:12.5px;
  font-weight:600; color:var(--text-75); text-align:center; }
@media print {
  .sigplay .sp-ctl { display:none !important; }
  .sigplay .sp-read { background:var(--bg-card) !important; }
}
</style>
"""


# ── theme transfer for figures ────────────────────────────────────────────
def to_dark(svg, ink_boost=1.5, wash_boost=1.35):
    """Move a light-built figure onto a dark ground.

    Only the NEUTRAL scaffolding is inverted -- road casing, grid lines, ink,
    label chips. Every semantic colour (the signal greens and ambers, the data
    ramp, the accent) is left untouched and re-declared by the page's dark
    tokens, so the meaning-carrying palette stays a deliberate choice rather
    than an automatic flip. Alphas are lifted because a light mark on a dark
    ground reads weaker than the reverse at equal opacity.
    """
    import re

    def black_to_white(m):
        a = min(1.0, float(m.group(1)) * ink_boost)
        return f"rgba(245,245,247,{a:.3f})"

    def white_to_ground(m):
        a = min(1.0, float(m.group(1)) * wash_boost)
        return f"rgba(11,11,12,{a:.3f})"

    out = re.sub(r"rgba\(0,\s*0,\s*0,\s*([\d.]+)\)", black_to_white, svg)
    out = re.sub(r"rgba\(255,\s*255,\s*255,\s*([\d.]+)\)", white_to_ground, out)
    # opaque helpers used as label backgrounds / marker outlines
    out = out.replace('stroke="#fff"', 'stroke="var(--surface-2)"')
    out = out.replace('fill="#fff"', 'fill="var(--surface-2)"')
    return out


def ambient_signal(phases, links, uid, width=560):
    """Controls-free auto-cycling signal, for the hero. Honours reduced motion."""
    player = signal_player(phases, links, uid, width=width)
    # strip the control row and the readout: the hero is atmosphere, not a tool
    import re
    player = re.sub(r'<div class="sp-ctl">.*?</div>\s*', "", player, flags=re.S)
    player = re.sub(r'<div class="sp-read">.*?</div>\s*', "", player, flags=re.S)
    player = player.replace('class="sigplay"', 'class="sigplay sigplay-ambient"')
    # autostart, unless the reader asked for reduced motion
    player = player.replace(
        "  render(0);\n",
        "  render(0);\n"
        "  var rm=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)');\n"
        "  if(!(rm&&rm.matches)){ spd.value='8'; go(); }\n")
    return player
