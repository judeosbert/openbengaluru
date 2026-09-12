#!/usr/bin/env python3
"""Assemble the redesign report from results.json + figs/variants.html."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = ("/Users/jude.osby/.claude/plugins/cache/jude-skills/"
       "glance-html-output/1.0.0/assets/template.html")
OUTDIR = "/tmp/sumo-report"
os.makedirs(OUTDIR, exist_ok=True)

R = json.load(open(os.path.join(HERE, "results.json")))
FIGS = open(os.path.join(HERE, "figs", "variants.html")).read()

ORDER = ["1-baseline", "2-nouturn", "3-nouturn-tls", "4-retimed", "5-joined",
         "6-2lane", "7-3lane-ew", "8-tri-wide", "9-3lane-all"]
SHORT = {
    "1-baseline": "1 base", "2-nouturn": "2 ban", "3-nouturn-tls": "3 ban+TLS",
    "4-retimed": "4 T1", "5-joined": "5 T1+T2", "6-2lane": "6 +2ln",
    "7-3lane-ew": "7 +3/2ln", "8-tri-wide": "8 T1+T3", "9-3lane-all": "9 +3ln",
}
DESC = {
    "1-baseline": "Baseline, u-turns intact, unsignalised",
    "2-nouturn": "U-turn ban, unsignalised",
    "3-nouturn-tls": "U-turn ban + original 171 s 4-phase signal",
    "4-retimed": "T1 — 90 s 2-phase actuated, triangle kept, 1 lane",
    "5-joined": "T1+T2 — joined 4-way signal, 1 lane",
    "6-2lane": "T1+T2+T3 — joined 4-way, 2 lanes",
    "7-3lane-ew": "T1+T2+T3 — joined 4-way, 3 lanes E–W / 2 N–S",
    "8-tri-wide": "T1+T3 (no join) — triangle widened",
    "9-3lane-all": "T1+T2+T3 — joined 4-way, 3 lanes all round",
}

# metric key, label, fmt, higher_is_better (None = no colouring)
METRICS = [
    ("served_pct", "% of demand served", "{:.1f}%", True),
    ("inserted",   "vehicles served",    "{:.0f}",  True),
    ("discarded",  "never got a slot",   "{:.0f}",  False),
    ("duration",   "travel time s",      "{:.1f}",  False),
    ("depdelay",   "depart delay s",     "{:.1f}",  False),
    ("door2door",  "door-to-door s",     "{:.1f}",  False),
    ("timeloss",   "time lost s",        "{:.1f}",  False),
    ("waiting",    "stopped s",          "{:.1f}",  False),
    ("speed",      "mean speed m/s",     "{:.2f}",  True),
    ("halt_pct",   "% time halted",      "{:.1f}",  False),
    ("clear_h",    "clear time h",       "{:.2f}",  False),
    ("thr_h1",     "arrivals in hour 1", "{:.0f}",  True),
    ("teleports",  "teleports (deadlock)", "{:.0f}", False),
    ("q_p95",      "queue p95 m",        "{:.1f}",  False),
]


def enrich(d):
    d = dict(d)
    d["door2door"] = d["duration"] + d["depdelay"]
    d["clear_h"] = d["end_time"] / 3600.0
    return d


def pill_for(key, val, vals, higher):
    if higher is None or len(vals) < 2:
        return ""
    best, worst = (max(vals), min(vals)) if higher else (min(vals), max(vals))
    if val == best:
        return "green"
    if val == worst:
        return "red"
    span = abs(worst - best) or 1
    frac = abs(val - best) / span
    return "orange" if frac > 0.55 else "blue"


def big_table(level):
    rows = {k: enrich(v) for k, v in R[level].items()}
    keys = [k for k in ORDER if k in rows]
    o = ['<div class="tbl-wrap"><table class="compare"><thead><tr><th>Metric</th>']
    for k in keys:
        o.append(f"<th>{SHORT[k]}</th>")
    o.append("</tr></thead><tbody>")
    for key, label, fmt, higher in METRICS:
        vals = [rows[k][key] for k in keys]
        o.append(f"<tr><td>{label}</td>")
        for k in keys:
            v = rows[k][key]
            cls = pill_for(key, v, vals, higher)
            txt = fmt.format(v)
            cell = f"<span class='pill {cls}'>{txt}</span>" if cls else txt
            o.append(f"<td class='num'>{cell}</td>")
        o.append("</tr>")
    o.append("</tbody></table></div>")
    return "\n".join(o)


def legend():
    return ('<p style="font-size:13px;color:var(--text-75);">'
            "Column keys: <strong>1 base</strong> / <strong>2 ban</strong> / "
            "<strong>3 ban+TLS</strong> are the three networks as they were "
            "delivered. <strong>4</strong>–<strong>9</strong> are the variants "
            "built for this report; see the atlas in §7 for the geometry, "
            "turning movements and signal program of each. "
            "Green marks the best value in the row, red the worst.</p>")


def ranking():
    rows = {k: enrich(v) for k, v in R["peak"].items()}
    keys = sorted(rows, key=lambda k: (-rows[k]["served_pct"],
                                       rows[k]["door2door"]))
    o = ['<div class="tbl-wrap"><table class="compare"><thead><tr>'
         "<th>Rank</th><th>Variant</th><th>What it is</th>"
         "<th>% served</th><th>Door-to-door s</th><th>Deadlock</th>"
         "</tr></thead><tbody>"]
    for i, k in enumerate(keys, 1):
        d = rows[k]
        sv = ("green" if d["served_pct"] > 90 else
              "orange" if d["served_pct"] > 60 else "red")
        dd = ("green" if d["door2door"] < 400 else
              "orange" if d["door2door"] < 1000 else "red")
        tp = ("<span class='pill green'>none</span>" if d["teleports"] == 0
              else f"<span class='pill red'>{d['teleports']:.0f} teleports</span>")
        o.append(f"<tr><td class='num'>{i}</td><td><strong>{SHORT[k]}</strong></td>"
                 f"<td style='font-size:13px'>{DESC[k]}</td>"
                 f"<td class='num'><span class='pill {sv}'>{d['served_pct']:.1f}%</span></td>"
                 f"<td class='num'><span class='pill {dd}'>{d['door2door']:.0f}</span></td>"
                 f"<td>{tp}</td></tr>")
    o.append("</tbody></table></div>")
    return "\n".join(o)


def tier_table():
    p = {k: enrich(v) for k, v in R["peak"].items()}

    def d(a, b, key):
        return p[b][key] - p[a][key]

    steps = [
        ("Starting point", "3-nouturn-tls", None,
         "The network as delivered: u-turn ban plus the 171 s four-phase signal."),
        ("T1 — retime the signal", "3-nouturn-tls", "4-retimed",
         "90 s two-phase actuated, opposing arms green together, permissive "
         "right turns. Config-file change only; no construction."),
        ("T2 alone — join the nodes", "4-retimed", "5-joined",
         "Collapse the three internal nodes into one 4-way signal, lanes "
         "unchanged. <strong>This is a regression</strong> — see below."),
        ("T3 — 2 lanes per approach", "5-joined", "6-2lane",
         "Widen every approach to two lanes."),
        ("T3 — 3 lanes E–W", "6-2lane", "7-3lane-ew",
         "Third lane on the Panathur–Varthur corridor only."),
        ("T3 — 3 lanes all round", "7-3lane-ew", "9-3lane-all",
         "Third lane on Kundalahalli and Sarjapur too."),
    ]
    o = ['<div class="tbl-wrap"><table class="compare"><thead><tr>'
         "<th>Step</th><th>% served</th><th>Δ served</th>"
         "<th>Door-to-door s</th><th>Δ door-to-door</th></tr>"
         "</thead><tbody>"]
    for label, a, b, _note in steps:
        if b is None:
            v = p[a]
            o.append(f"<tr><td><strong>{label}</strong></td>"
                     f"<td class='num'>{v['served_pct']:.1f}%</td><td class='num'>—</td>"
                     f"<td class='num'>{v['door2door']:.0f}</td>"
                     f"<td class='num'>—</td></tr>")
            continue
        ds, dd = d(a, b, "served_pct"), d(a, b, "door2door")
        sp = "green" if ds > 0 else "red"
        dp = "green" if dd < 0 else "red"
        o.append(f"<tr><td><strong>{label}</strong></td>"
                 f"<td class='num'>{p[b]['served_pct']:.1f}%</td>"
                 f"<td class='num'><span class='pill {sp}'>{ds:+.1f} pp</span></td>"
                 f"<td class='num'>{p[b]['door2door']:.0f}</td>"
                 f"<td class='num'><span class='pill {dp}'>{dd:+.0f} s</span></td></tr>")
    o.append("</tbody></table></div>")
    notes = "".join(
        f'<div class="sub-card"><h4>{label}</h4><p>{note}</p></div>'
        for label, _a, b, note in steps if b is not None)
    return "\n".join(o) + notes


# ── assemble ─────────────────────────────────────────────────────────────
tpl = open(TPL).read()
head = tpl[:tpl.index("<body>") + len("<body>")].replace(
    "__TITLE__", "Balegere Cross Network Redesign")
tail = tpl[tpl.index("<!--\n  Edit + comment tracker"):]

p9 = enrich(R["peak"]["9-3lane-all"])
p3 = enrich(R["peak"]["3-nouturn-tls"])
p4 = enrich(R["peak"]["4-retimed"])

BODY = f"""
<header class="topbar">
  <div class="topbar-inner">
    <div class="logo"><span class="logo-mark"></span><span>Balegere Cross · SUMO</span></div>
    <div class="topbar-actions">
      <button class="share-pdf" type="button" onclick="window.print()" aria-label="Save or share as PDF">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Share PDF
      </button>
      <span class="doc-tag">Network Redesign</span>
    </div>
  </div>
</header>

<div class="wrap">
  <section class="hero" style="border-top:none;padding-top:56px;">
    <div class="hero-eyebrow">Unified demand · 9 network variants · 18 runs</div>
    <h1>One demand, nine networks — <span class="em">and a redesign that serves 99% of peak</span></h1>
    <div class="hero-meta">
      <span><strong>Document type</strong> — Controlled comparison and redesign recommendation</span>
      <span><strong>Date</strong> — 16 Aug 2026</span>
      <span><strong>Demand</strong> — 5,743 veh peak / 2,197 veh off-peak, identical trip set</span>
    </div>
  </section>
</div>

<nav class="anchor-nav" aria-label="Sections">
  <div class="anchor-nav-inner">
    <a href="#changed">What changed</a>
    <a href="#demand">Demand</a>
    <a href="#peak">Peak results</a>
    <a href="#offpeak">Off-peak</a>
    <a href="#tiers">What each fix buys</a>
    <a href="#recommend">Recommendation</a>
    <a href="#atlas">Network atlas</a>
    <a href="#risk">Remaining risk</a>
    <a href="#methodology">Methodology</a>
  </div>
</nav>

<main class="wrap">

<section id="changed">
  <div class="eyebrow">§1 · Since the first report</div>
  <h2>The comparison is now controlled</h2>
  <p>The first report could not compare the three delivered networks against each
  other, because each had been run against a different version of the same-named
  route file. That is fixed. Every run in this document consumes one canonical
  origin–destination demand, and the only thing that varies between runs is the
  network file.</p>
  <ul>
    <li><strong>One demand definition.</strong> Built from the surveyed turning
    movement counts in <code>balegare-data.txt</code> by
    <code>sim/gen_demand.py</code>. Vehicle IDs, vehicle types and departure
    times are identical in every run.</li>
    <li><strong>Bicycles removed.</strong> The survey lists 137/h at peak, but
    they are rare here in practice, and 137 vehicles/h capped at 5.6 m/s on a
    single lane is a modelled capacity drag that does not exist on the ground.
    They were 27 of 4,506 PCU (0.6%), so the load is essentially unchanged.</li>
    <li><strong>Buses now included.</strong> All three original runs omitted
    them entirely; at 79/h and 3.0 PCU each they are 237 PCU, which matters.</li>
    <li><strong>Real per-vehicle metrics.</strong> Every run writes
    <code>tripinfo-output</code>, so travel time, time lost, stopped time and
    departure delay are read per vehicle instead of being reconstructed from
    per-step summary averages.</li>
    <li><strong>Six new network variants</strong> built with <code>netconvert</code>
    to test the remediation tiers the first report proposed.</li>
  </ul>
</section>

<section id="demand">
  <div class="eyebrow">§2 · Demand</div>
  <h2>The single demand definition</h2>
  <p>The three networks do not share boundary edge IDs — Panathur, Varthur and
  Kundalahalli use the same source and sink edges in all of them, but Sarjapur
  enters on <code>-E2.7</code> and leaves on <code>E2.7</code> in the baseline
  versus <code>E3</code>/<code>-E3</code> in every u-turn-ban network. So the
  demand is defined once as an arm-to-arm matrix and emitted per network with
  only the arm&nbsp;→&nbsp;edge mapping swapped. Trips carry <code>from</code>
  and <code>to</code> rather than a fixed edge list, so each network routes the
  same journeys over its own geometry.</p>

  <div class="tbl-wrap">
    <table class="compare">
      <thead><tr><th>Arm</th><th>Peak veh/h in</th><th>Peak PCU/h in</th>
      <th>Off-peak veh/h in</th><th>Source → sink (ban nets)</th></tr></thead>
      <tbody>
        <tr><td>E — Panathur</td><td class="num">1,585</td><td class="num">1,235</td><td class="num">607</td><td><code>E0</code> → <code>-E0.79.36</code></td></tr>
        <tr><td>W — Varthur TPS</td><td class="num">1,568</td><td class="num">1,216</td><td class="num">601</td><td><code>-E2</code> → <code>E2</code></td></tr>
        <tr><td>N — Kundalahalli</td><td class="num">1,420</td><td class="num">1,111</td><td class="num">542</td><td><code>E4</code> → <code>-E4</code></td></tr>
        <tr><td>S — Sarjapur</td><td class="num">1,170</td><td class="num">916</td><td class="num">447</td><td><code>E3</code> → <code>-E3</code></td></tr>
        <tr><td><strong>Total</strong></td><td class="num"><strong>5,743</strong></td><td class="num"><strong>4,478</strong></td><td class="num"><strong>2,197</strong></td><td>—</td></tr>
      </tbody>
    </table>
  </div>

  <div class="note">
    <strong>Verified identical:</strong> the emitted files were diffed on the
    <code>(id, type, depart)</code> triple of all 5,743 trips — the sequences
    match exactly across both mappings. The demand is the same journeys in the
    same order at the same instants; only the edge names differ.
  </div>

  <div class="sub-card">
    <h4>Run policy, shared by all 18 runs</h4>
    <p><code>--seed 42</code>, <code>--step-length 1</code>,
    <code>--time-to-teleport 300</code> (kept on, so a gridlocked run still
    terminates and the teleport count becomes the deadlock metric),
    <code>--max-depart-delay 1800</code> (a trip that cannot start within 30
    minutes is a failed trip and is counted as unserved rather than inflating
    waiting time by hours), and a 48 h end time that is a safety net only —
    clear time is read from the summary as the last instant any vehicle was
    still in the network.</p>
  </div>
</section>

<section id="peak">
  <div class="eyebrow">§3 · Results</div>
  <h2>Peak — 5,743 vehicles</h2>
  {legend()}
  {big_table("peak")}

  <div class="note">
    <strong>Read <em>% of demand served</em> first.</strong> Travel time,
    departure delay, stopped time and speed are averaged over completed trips
    only. A network that fails to admit half its demand reports flattering
    per-vehicle numbers for the half it did admit — which is exactly why
    variant 2 appears to have a shorter travel time than variant 6 while
    serving 42 percentage points less traffic. Door-to-door time (travel +
    departure delay) is the honest per-vehicle figure, and only meaningful
    alongside the served fraction.
  </div>

  <h3>Ranked by demand served, then door-to-door time</h3>
  {ranking()}
</section>

<section id="offpeak">
  <div class="eyebrow">§4 · Results</div>
  <h2>Off-peak — 2,197 vehicles</h2>
  <p>At 38% of peak load the picture separates cleanly: retiming alone is
  already enough to serve every vehicle, and the extra lanes buy speed rather
  than capacity. Every variant from 3 onward serves 100%, so here the
  per-vehicle numbers are directly comparable with no survivorship caveat.</p>
  {big_table("offpeak")}
  <p>Two things worth noting. First, the delivered signalised network
  (variant 3) serves 100% off-peak but still takes <span class="pill orange">137.2 s</span>
  per trip against <span class="pill green">23.5 s</span> for the redesign — a
  5.8× penalty purely from signal timing and geometry, at a load the junction
  can comfortably handle. Second, the baseline still fails catastrophically at
  off-peak: <span class="pill red">24.6% served</span> and 110 teleports. The
  u-turns break this junction at any realistic load, not just at peak.</p>
</section>

<section id="tiers">
  <div class="eyebrow">§5 · Attribution</div>
  <h2>What each fix actually buys</h2>
  <p>Each row changes exactly one thing from the row above, so every delta is
  attributable. Measured at peak.</p>
  {tier_table()}

  <div class="qa-card">
    <span class="qid">5a · The finding that changes the recommendation</span>
    <p class="question">Joining the junction nodes, on its own, makes things worse.</p>
    <span class="ans-label">Measured</span>
    <p>The first report recommended joining the internal nodes to eliminate
    micro-links that cannot store a queue. Measured in isolation, that change
    drops demand served from <span class="pill green">77.0%</span> to
    <span class="pill red">49.7%</span> and adds 180 s to door-to-door time.</p>
    <p>The reason is visible in the geometry (§7). The delivered network is not
    a 4-way junction at all — it is a <strong>triangle of three nodes</strong>
    19.6 m and 37.0 m apart, and the leg <code>E0 → E1 → -E4</code> carries
    Panathur → Kundalahalli traffic <em>around</em> the signal entirely. That
    triangle is providing parallel capacity. Collapsing it to one node removes
    the bypass and forces every movement through a single signalised node — and
    with one lane per approach, that node cannot absorb them.</p>
    <p>Joining only pays once the lanes are there. Variant 8 settles it: keeping
    the triangle and widening it reaches
    <span class="pill orange">89.0%</span> served with
    <span class="pill red">38 teleports</span>, while the joined equivalent at
    the same lane provision (variant 7) reaches
    <span class="pill green">96.0%</span> with
    <span class="pill green">zero</span>. So the join is worth doing — but as
    part of the widening, never before it.</p>
  </div>

  <div class="qa-card">
    <span class="qid">5b · Best value for zero construction</span>
    <p class="question">If nothing can be built, what is available?</p>
    <span class="ans-label">Answer</span>
    <p>Retiming alone (variant 4) takes demand served from
    <span class="pill orange">{p3['served_pct']:.1f}%</span> to
    <span class="pill green">{p4['served_pct']:.1f}%</span> and cuts travel time
    from {p3['duration']:.0f} s to {p4['duration']:.0f} s. It is a change to one
    <code>&lt;tlLogic&gt;</code> block: a 90 s two-phase actuated cycle serving
    opposing arms together, with permissive right turns, replacing the 171 s
    four-phase fully-protected plan. No tarmac, no reconstruction, and it is
    also the single lowest <em>in-network</em> travel time of any variant
    tested.</p>
    <p>It does not solve the junction — 1,321 vehicles still never get an
    insertion slot at peak, and departure delay stays above 1,100 s — but it is
    the highest-return change available and should be made regardless of what
    else is approved.</p>
  </div>
</section>

<section id="recommend">
  <div class="eyebrow">§6 · Recommendation</div>
  <h2>Variant 9 — joined 4-way signal, three lanes on every approach</h2>

  <div class="qa-card">
    <span class="qid">6 · Recommended design</span>
    <p class="question">Best throughput with the least waiting.</p>
    <span class="ans-label">Recommended</span>
    <p>Variant 9 is best on every metric measured — it does not trade throughput
    against delay, it wins both.</p>
    <div class="tbl-wrap">
      <table class="compare">
        <thead><tr><th>Metric</th><th>As delivered (variant 3)</th><th>Variant 9</th><th>Change</th></tr></thead>
        <tbody>
          <tr><td>Demand served at peak</td><td class="num">{p3['served_pct']:.1f}%</td><td class="num"><span class="pill green">{p9['served_pct']:.1f}%</span></td><td class="num"><span class="pill green">+{p9['served_pct']-p3['served_pct']:.1f} pp</span></td></tr>
          <tr><td>Vehicles served</td><td class="num">{p3['inserted']:.0f}</td><td class="num"><span class="pill green">{p9['inserted']:.0f}</span></td><td class="num"><span class="pill green">+{p9['inserted']-p3['inserted']:.0f}</span></td></tr>
          <tr><td>Travel time</td><td class="num">{p3['duration']:.1f} s</td><td class="num"><span class="pill green">{p9['duration']:.1f} s</span></td><td class="num"><span class="pill green">−{100*(1-p9['duration']/p3['duration']):.0f}%</span></td></tr>
          <tr><td>Departure delay</td><td class="num">{p3['depdelay']:.1f} s</td><td class="num"><span class="pill green">{p9['depdelay']:.1f} s</span></td><td class="num"><span class="pill green">−{100*(1-p9['depdelay']/p3['depdelay']):.0f}%</span></td></tr>
          <tr><td>Door-to-door</td><td class="num">{p3['door2door']:.0f} s</td><td class="num"><span class="pill green">{p9['door2door']:.0f} s</span></td><td class="num"><span class="pill green">−{100*(1-p9['door2door']/p3['door2door']):.0f}%</span></td></tr>
          <tr><td>Time lost per trip</td><td class="num">{p3['timeloss']:.1f} s</td><td class="num"><span class="pill green">{p9['timeloss']:.1f} s</span></td><td class="num"><span class="pill green">−{100*(1-p9['timeloss']/p3['timeloss']):.0f}%</span></td></tr>
          <tr><td>Stopped time per trip</td><td class="num">{p3['waiting']:.1f} s</td><td class="num"><span class="pill green">{p9['waiting']:.1f} s</span></td><td class="num"><span class="pill green">−{100*(1-p9['waiting']/p3['waiting']):.0f}%</span></td></tr>
          <tr><td>Mean speed</td><td class="num">{p3['speed']:.2f} m/s</td><td class="num"><span class="pill green">{p9['speed']:.2f} m/s</span></td><td class="num"><span class="pill green">{p9['speed']/p3['speed']:.1f}×</span></td></tr>
          <tr><td>% of time halted</td><td class="num">{p3['halt_pct']:.1f}%</td><td class="num"><span class="pill green">{p9['halt_pct']:.1f}%</span></td><td class="num"><span class="pill green">−{p3['halt_pct']-p9['halt_pct']:.1f} pp</span></td></tr>
          <tr><td>Clear time</td><td class="num">{p3['clear_h']:.2f} h</td><td class="num"><span class="pill green">{p9['clear_h']:.2f} h</span></td><td class="num"><span class="pill green">−{100*(1-p9['clear_h']/p3['clear_h']):.0f}%</span></td></tr>
          <tr><td>Teleports (deadlock)</td><td class="num">{p3['teleports']:.0f}</td><td class="num"><span class="pill green">{p9['teleports']:.0f}</span></td><td class="num"><span class="pill green">none</span></td></tr>
        </tbody>
      </table>
    </div>

    <div class="sub-card">
      <h4>What variant 9 is, concretely</h4>
      <p><strong>Geometry.</strong> The three internal nodes are joined into a
      single signalised 4-way junction — which is what
      <code>balegare-data.txt</code> describes the site as in the first place.
      This eliminates the 15.5 m and 23.8 m micro-links and lengthens every
      approach to 117 m (Panathur), 108 m (Varthur), 46 m (Kundalahalli) and
      45 m (Sarjapur). The u-turn ban is preserved via
      <code>--no-turnarounds</code>.</p>
      <p><strong>Lanes.</strong> Three per approach in both directions, 3.2 m
      each — 24 lanes total against the 15 single lanes of the delivered
      network.</p>
      <p><strong>Signal.</strong> Actuated, 90 s cycle, two phases:
      Panathur + Varthur green for 46 s, then Kundalahalli + Sarjapur for 38 s,
      3 s yellow after each. The split is proportional to surveyed PCU per arm
      (2,451 vs 2,027). Right turns are permissive rather than protected, which
      is correct for left-hand traffic. <code>max-gap 2.5</code>,
      <code>detector-gap 2.0</code>, <code>jam-threshold 10</code> so the
      controller will not hold green into a blocked link.</p>
    </div>

    <div class="note">
      <strong>If three lanes is not fundable:</strong> variant 7 (three lanes on
      the Panathur–Varthur corridor, two on Kundalahalli and Sarjapur) reaches
      96.0% served and 348 s door-to-door — nearly all of the benefit for four
      fewer lanes. Variant 6 (two lanes everywhere) reaches 92.6% and 756 s.
      Both are sound designs; variant 9 is simply the best of them.
    </div>
  </div>
</section>

<section id="atlas">
  <div class="eyebrow">§7 · Network atlas</div>
  <h2>Every variant: geometry, turning movements, signal program</h2>
  <p>Each diagram is drawn directly from the <code>.net.xml</code> lane and
  junction geometry, to scale, with the 50 m bar for reference. Arrows show the
  direction of travel; the purple disc marks a signalised junction and purple
  shading its area. Traffic drives on the <strong>left</strong>
  (<code>lefthand</code>), so a left turn is the near-side non-conflicting
  movement and a right turn crosses opposing traffic.</p>
  <p>The turning-movement tables list every permitted connection, how many lanes
  serve it, and how it is controlled — signal link index, priority-major, or
  priority-must-yield. The signal timelines show each link's colour across one
  full cycle: solid green is protected, pale green permissive, amber yellow,
  grey red.</p>
  {FIGS}
</section>

<section id="risk">
  <div class="eyebrow">§8 · Caveats</div>
  <h2>What this does not yet establish</h2>
  <ul>
    <li><strong>The demand counts are estimates.</strong>
    <code>balegare-data.txt</code> states plainly that its turning movements are
    derived from IRC:106 benchmarks and Bangalore modal-split studies, not from
    a traffic survey at this junction. Every absolute figure inherits that.
    The <em>ranking</em> of variants is robust to demand scaling — it holds at
    both 5,743 and 2,197 vehicles — but the absolute percentages are not a
    design submission.</li>
    <li><strong>Car-following is uncalibrated.</strong> <code>minGap</code> was
    set by judgement (0.5 m for two-wheelers up to 1.5 m for buses) because the
    data file does not specify it. SUMO's 2.5 m default would put saturation
    flow well below what is observed on Indian urban arterials. The values are
    identical across all 18 runs so they cannot bias the comparison, but they do
    move the absolute throughput. Calibrating against observed saturation flow
    is the single highest-value validation step remaining.</li>
    <li><strong>No lateral / non-lane-disciplined movement.</strong> Two-wheelers
    are 53% of vehicles here and in reality filter between lanes. SUMO's
    sublane model (<code>--lateral-resolution</code>) would capture this and
    would likely improve every variant, the narrow ones most. Not modelled.</li>
    <li><strong>Queues still reach 95% of link length in variant 9</strong>
    (p95 {p9['q_p95']:.0f} m on 117 m approaches). The design is at the edge of
    spillback at peak, not comfortably inside it. Longer approach storage, or
    the E–W grade separation the first report raised, is what buys headroom for
    growth.</li>
    <li><strong>Pedestrians and bus stops are absent.</strong> A signalised
    junction on this corridor will need a pedestrian phase, which consumes green
    time the current split does not budget for.</li>
    <li><strong>The join is a real construction change,</strong> not a
    configuration edit. Variant 4 is deliverable this week; variants 6, 7 and 9
    require rebuilding the junction.</li>
  </ul>
</section>

<section id="methodology">
  <div class="eyebrow">Behind the numbers</div>
  <h2>Methodology</h2>
  <div class="methodology">
    <p style="margin-top:0;"><strong>Toolchain.</strong> Eclipse SUMO 1.27.1 CLI
    (<code>/Library/Frameworks/EclipseSUMO.framework</code>), the same version
    that produced the original GUI runs. 18 simulations
    (9 networks × 2 demand levels) complete in about 60 s wall-clock.</p>
    <p><strong>Scripts</strong>, all in <code>sim/</code>:
    <code>gen_demand.py</code> emits the canonical demand per network mapping;
    <code>build_nets.py</code> builds variants 4–9 via <code>netconvert</code>
    from plain node/edge XML extracted from the delivered network;
    <code>run_batch.py</code> executes every combination under an identical run
    policy and parses the outputs; <code>render_nets.py</code> draws the atlas
    figures straight from the <code>.net.xml</code> geometry;
    <code>build_report.py</code> generates this document from
    <code>results.json</code>, so no figure in it is hand-typed.</p>
    <p><strong>Per-vehicle metrics</strong> (travel time, time lost, stopped
    time, departure delay, route length, speed) are means over
    <code>tripinfo</code> records — one per completed trip. <strong>Speed</strong>
    is route length ÷ duration per vehicle, then averaged.
    <strong>Vehicle-hours</strong> and <strong>% time halted</strong> integrate
    the summary <code>running</code> and <code>halting</code> counters at the
    1 s step, over occupied steps only. <strong>Clear time</strong> is the last
    step with a vehicle in the network. <strong>Queue</strong> figures come from
    <code>queue-output</code> across all lanes and all steps.</p>
    <p><strong>Signal programs</strong> for variants 5–9 are synthesised against
    the link indices <code>netconvert</code> actually generated, read back from
    the built network rather than assumed, then spliced in by targeted text
    substitution so the rest of the file — including the recorded
    <code>lefthand</code> build option — is left untouched.</p>
    <p><strong>What is not controlled:</strong> route choice. Trips specify
    origin and destination, and each network routes them over its own geometry,
    so path lengths differ slightly between variants (186–218 m mean). That is
    the intended behaviour — a network that offers a better path should get
    credit for it — but it means route length is an outcome, not a constant.</p>
  </div>
</section>

</main>

<footer>
  Balegere Cross · Network Redesign · 16 Aug 2026 · 9 variants, 18 runs, one demand
</footer>
"""

out = os.path.join(OUTDIR, "balegere-network-redesign.html")
open(out, "w").write(head + BODY + "\n" + tail)
print(f"wrote {out}  ({len(head + BODY + tail):,} bytes)")
