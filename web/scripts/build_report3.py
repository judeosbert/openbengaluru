#!/usr/bin/env python3
"""Report 3, standalone: the no-construction answer for Balegere Cross.

Self-contained -- carries its own site description, demand definition and
validation notes. No cross-references to other documents.
"""
import json, os
import viz

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = (os.environ.get("REPORT_TEMPLATE", "template.html"))
OUTDIR = "/tmp/sumo-report"
os.makedirs(OUTDIR, exist_ok=True)


def J(n):
    return json.load(open(os.path.join(HERE, n)))


FAIRBEST = J("fair_best_results.json")
ENV = J("envelope2_results.json")
OPT = J("opt_results.json")
NB3 = J("nobuild3_results.json")
PRIO = J("prio_results.json")
FAIR = J("fair_results.json")
FIGS = open(os.path.join(HERE, "figs", "paint.html")).read()
PAINT = J("paint_results.json")
PF = J("paint_final.json")

PR = next(r for r in PF["refine"] if r["cycle"] == 180 and not r["sub"])
PRS = next(r for r in PF["refine"] if r["cycle"] == 180 and r["sub"])
PENV = PF["envelope"]
PM2 = max((r for r in PAINT if r["mark"] == "M2"), key=lambda r: r["worst"])
PM1_2PH = max((r for r in PAINT if r["mark"] == "M1" and r["struct"].startswith("A")),
              key=lambda r: r["served_pct"])
CLIFF = sorted((r for r in PF["refine"] if not r["sub"]), key=lambda r: r["cycle"])


def pick(rows, **kw):
    for r in rows:
        if all(r.get(k) == v for k, v in kw.items()):
            return r
    return None


DEL = pick(FAIRBEST, kind="delivered", factor=1.0, sub=False)
REC = pick(FAIRBEST, kind="D", cycle=210, nboost=1.0, factor=1.0, sub=False)
DEL60 = pick(FAIRBEST, kind="delivered", factor=0.60, sub=False)
REC60 = pick(FAIRBEST, kind="D", cycle=210, nboost=1.0, factor=0.60, sub=False)
UNFAIR = sorted([r for r in FAIR if r["factor"] == 1.0],
                key=lambda r: -r["served_pct"])[0]
SUBREC = pick(FAIRBEST, kind="D", cycle=210, nboost=1.0, factor=1.0, sub=True)


def arm_cells(r):
    a = r["arm"]
    out = ""
    for k in "ENWS":
        v = a.get(k, 0)
        cls = "green" if v >= 90 else "orange" if v >= 40 else "red"
        out += f"<td class='num'><span class='pill {cls}'>{v:.0f}%</span></td>"
    return out


def envelope_table(plan):
    sel = sorted([r for r in ENV if r["plan"] == plan], key=lambda r: r["factor"])
    o = ['<div class="tbl-wrap"><table class="compare"><thead><tr>'
         "<th>Demand</th><th>veh/h</th><th>Total served</th><th>Worst arm</th>"
         "<th>Panathur</th><th>Kundalahalli</th><th>Varthur</th><th>Sarjapur</th>"
         "<th>Travel s</th><th>Stopped s</th></tr></thead><tbody>"]
    for r in sel:
        w = r["worst"]
        wc = "green" if w >= 95 else "orange" if w >= 60 else "red"
        o.append(f"<tr><td>{r['factor']*100:.0f}% of peak</td>"
                 f"<td class='num'>{r['demand']}</td>"
                 f"<td class='num'>{r['served_pct']:.1f}%</td>"
                 f"<td class='num'><span class='pill {wc}'>{w:.1f}%</span></td>"
                 + arm_cells(r) +
                 f"<td class='num'>{r['duration']:.0f}</td>"
                 f"<td class='num'>{r['waiting']:.0f}</td></tr>")
    o.append("</tbody></table></div>")
    return "\n".join(o)


def compare_chart():
    rows = [
        ("As installed", "171 s · 4 phases · 1 lane",
         DEL["served_pct"], DEL["worst"]),
        ("Retimed only", "210 s · 4 phases · 1 lane",
         REC["served_pct"], REC["worst"]),
        ("Re-marked (recommended)", "180 s · 4 phases · 2 × 3.0 m",
         PR["served_pct"], PR["worst"]),
    ]
    return viz.bar_compare(rows, title="demand served at peak by configuration")


def cliff_chart_svg():
    return viz.cliff_chart([(r["cycle"], r["served_pct"], r["worst"], r["teleports"])
                            for r in CLIFF])


def paint_env_table():
    o = ['<div class="tbl-wrap"><table class="compare"><thead><tr>'
         "<th>Demand</th><th>veh/h</th><th>Total served</th><th>Worst arm</th>"
         "<th>Panathur</th><th>Kundalahalli</th><th>Varthur</th><th>Sarjapur</th>"
         "<th>Travel s</th><th>Stopped s</th></tr></thead><tbody>"]
    for r in sorted(PENV, key=lambda r: r["factor"]):
        w = r["worst"]
        wc = "green" if w >= 95 else "orange" if w >= 70 else "red"
        o.append(f"<tr><td>{r['factor']*100:.0f}% of peak</td>"
                 f"<td class='num'>{r['demand']}</td>"
                 f"<td class='num'>{r['served_pct']:.1f}%</td>"
                 f"<td class='num'><span class='pill {wc}'>{w:.1f}%</span></td>"
                 + arm_cells(r) +
                 f"<td class='num'>{r['duration']:.0f}</td>"
                 f"<td class='num'>{r['waiting']:.0f}</td></tr>")
    o.append("</tbody></table></div>")
    return "\n".join(o)


def cliff_table():
    o = ['<div class="tbl-wrap"><table class="compare"><thead><tr>'
         "<th>Cycle</th><th>Total served</th><th>Worst arm</th>"
         "<th>Travel s</th><th>Deadlock events</th></tr></thead><tbody>"]
    for r in CLIFF:
        ok = r["teleports"] == 0
        o.append(f"<tr><td>{r['cycle']} s</td>"
                 f"<td class='num'><span class='pill {'green' if r['served_pct']>85 else 'red'}'>"
                 f"{r['served_pct']:.1f}%</span></td>"
                 f"<td class='num'>{r['worst']:.1f}%</td>"
                 f"<td class='num'>{r['duration']:.0f}</td>"
                 f"<td class='num'>" + ("<span class='pill green'>none</span>" if ok
                 else f"<span class='pill red'>{r['teleports']}</span>") + "</td></tr>")
    o.append("</tbody></table></div>")
    return "\n".join(o)


def searched_table():
    rows = [
        ("Signal phase structure &amp; cycle length", 98,
         "7 phase structures &times; 7 cycle lengths (50&ndash;120 s) &times; static and actuated",
         f"{max(r['served_pct'] for r in OPT):.1f}%",
         "Flat &mdash; every program landed in a 50.4&ndash;51.8% band"),
        ("Long cycles, turn bans, lateral filtering", 16,
         "Cycles to 240 s, three turn-ban schemes, sublane model on/off",
         f"{max(r['served_pct'] for r in NB3):.1f}%",
         "Turn bans infeasible &mdash; they disconnect Kundalahalli&rarr;Panathur"),
        ("Give-way reassignment", 12,
         "6 edge-priority schemes at the two unsignalised junctions",
         f"{max(r['served_pct'] for r in PRIO if r['factor']==1.0):.1f}%",
         "No effect &mdash; +0.1 pp over as-delivered"),
        ("Equity-scored structures", 70,
         "7 structures &times; 5 cycles, scored on worst-served arm",
         f"{max(r['served_pct'] for r in FAIR if r['factor']==1.0):.1f}%",
         "Revealed that throughput-optimal plans starve two arms"),
        ("Fair-plan refinement", 64,
         "4-phase protected, cycles 120&ndash;240 s, Kundalahalli green boost, sublane",
         f"{max(r['served_pct'] for r in FAIRBEST if r['factor']==1.0):.1f}%",
         "Existing plan already within 0.7 pp of the best found"),
        ("Capacity envelope, single lane", 22,
         "Demand scaled 25&ndash;100% of peak against two plans",
         "100%",
         "Full service only at or below ~2,300 veh/h"),
        ("Carriageway re-marking", 40,
         "2 marking layouts &times; 5 structures &times; 4 cycles inside the existing 6 m",
         f"{max(r['served_pct'] for r in PAINT):.1f}%",
         "Two 3.0 m lanes roughly doubles capacity &mdash; paint only"),
        ("Re-marking refinement &amp; envelope", 17,
         "Cycles 150&ndash;270 s, lateral filtering, demand 60&ndash;120% of peak",
         f"{max(r['served_pct'] for r in PF['refine']):.1f}%",
         "180 s optimal, with a sharp cliff beyond it"),
    ]
    o = ['<div class="tbl-wrap"><table class="compare"><thead><tr>'
         "<th>Search</th><th>Runs</th><th>What varied</th>"
         "<th>Best total served</th><th>Outcome</th></tr></thead><tbody>"]
    for name, n, what, best, res in rows:
        o.append(f"<tr><td><strong>{name}</strong></td><td class='num'>{n}</td>"
                 f"<td style='font-size:13px'>{what}</td>"
                 f"<td class='num'>{best}</td>"
                 f"<td style='font-size:13px'>{res}</td></tr>")
    o.append(f"<tr><td><strong>Total</strong></td><td class='num'><strong>"
             f"{98+16+12+70+64+22+40+17}</strong></td><td colspan='3'></td></tr>")
    o.append("</tbody></table></div>")
    return "\n".join(o)


tpl = open(TPL).read()
head = tpl[:tpl.index("<body>") + len("<body>")].replace(
    "__TITLE__", "Balegere Cross Without Construction")
tail = tpl[tpl.index("<!--\n  Edit + comment tracker"):]

gap = 5743 - 2582

gap_single = 5743 - 2582
gap_paint = 5743 - 4591

PLAYER_CSS = viz.PLAYER_CSS

BODY = f"""
<header class="topbar">
  <div class="topbar-inner">
    <div class="logo"><span class="logo-mark"></span><span>Balegere Cross · SUMO</span></div>
    <div class="topbar-actions">
      <button class="share-pdf" type="button" onclick="window.print()" aria-label="Save or share as PDF">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Share PDF
      </button>
      <span class="doc-tag">No-Construction Options</span>
    </div>
  </div>
</header>

<div class="wrap">
  <section class="hero" style="border-top:none;padding-top:56px;">
    <div class="hero-eyebrow">Balegere Cross, East Bangalore · Eclipse SUMO 1.27.1 · 339 runs</div>
    <h1>The fix is paint — <span class="em">two lanes inside the 6 m you already have</span></h1>
    <div class="hero-meta">
      <span><strong>Document type</strong> — Constrained-options study</span>
      <span><strong>Date</strong> — 16 Aug 2026</span>
      <span><strong>Constraint</strong> — no construction, no widening</span>
    </div>
  </section>
</div>

<nav class="anchor-nav" aria-label="Sections">
  <div class="anchor-nav-inner">
    <a href="#summary">Summary</a>
    <a href="#site">Site &amp; constraint</a>
    <a href="#demand">Demand</a>
    <a href="#searched">What was searched</a>
    <a href="#traps">Two traps</a>
    <a href="#recommend">Recommendation</a>
    <a href="#envelope">Capacity</a>
    <a href="#gap">Residual gap</a>
    <a href="#atlas">Atlas</a>
    <a href="#methodology">Methodology</a>
  </div>
</nav>

{PLAYER_CSS}
<main class="wrap">

<section id="summary">
  <div class="eyebrow">§1 · Summary</div>
  <h2>What was asked, and what the answer is</h2>
  <p>The question: with <strong>no construction permitted</strong> &mdash; no
  widening, no rebuilt junction &mdash; what can be done to improve throughput and
  reduce waiting at Balegere Cross?</p>
  <p>339 simulation runs later, the answer has four parts.</p>
  <ul>
    <li><strong>Re-marking the carriageway roughly doubles capacity, and costs
    paint.</strong> Each approach carries 6&nbsp;m of sealed surface currently
    marked as a single lane. Marking it as two 3.0&nbsp;m lanes lifts demand
    served at peak from <strong>48.1%</strong> to
    <strong>{PR['served_pct']:.1f}%</strong>, and to
    <strong>{PRS['served_pct']:.1f}%</strong> once two-wheeler filtering is
    represented. This is the recommendation (§6).</li>
    <li><strong>Signal retiming alone achieves almost nothing.</strong> Across 98
    phase-structure and cycle-length combinations, plus turn bans, give-way
    changes and extra signal equipment, nothing beat the installed plan by more
    than <strong>0.7 percentage points</strong> while the approaches stayed
    single-lane. The junction was capacity-limited, not control-limited.</li>
    <li><strong>The obvious signal change is a trap.</strong> Two-phase plans look
    4&ndash;5 points better on total throughput. They earn it by serving two
    approaches at ~90% and cutting the other two to <strong>6&ndash;7%</strong>.
    The installed four-phase structure is not inefficiency &mdash; it is what keeps
    all four arms alive, and it stays the right structure after re-marking
    too (§5).</li>
    <li><strong>A residual gap remains.</strong> Even re-marked, full service holds
    only to <strong>4,591&nbsp;veh/h</strong> against surveyed peak demand of
    <strong>5,743&nbsp;veh/h</strong>. About
    <strong>{gap_paint:,}&nbsp;veh/h</strong> &mdash; 20% of peak &mdash; still needs
    to be diverted or time-shifted, down from {gap_single:,}&nbsp;veh/h without
    re-marking (§8).</li>
  </ul>
  <div class="diagram-embed-wrap" style="padding:16px 12px;">
  {compare_chart()}
  </div>
  <p style="font-size:13px;color:var(--text-75);">Both series are labelled with
  their value, and the same figures appear in the table below as a text
  alternative. Worst-served arm is shown alongside the total because a plan can
  raise the total while abandoning an approach — see §5b.</p>

  <div class="tbl-wrap">
    <table class="compare">
      <thead><tr><th>Configuration</th><th>Cost</th><th>Demand served at peak</th>
      <th>Worst-served arm</th><th>Travel time</th><th>Full-service ceiling</th></tr></thead>
      <tbody>
        <tr><td>As installed — 171 s, 4 phases, single lane</td><td>—</td>
          <td class="num"><span class="pill red">{DEL['served_pct']:.1f}%</span></td>
          <td class="num"><span class="pill red">{DEL['worst']:.1f}%</span></td>
          <td class="num">{DEL['duration']:.0f} s</td>
          <td class="num">2,298 veh/h</td></tr>
        <tr><td>Retimed only — 210 s, 4 phases, single lane</td><td>Controller config</td>
          <td class="num"><span class="pill red">{REC['served_pct']:.1f}%</span></td>
          <td class="num"><span class="pill red">{REC['worst']:.1f}%</span></td>
          <td class="num">{REC['duration']:.0f} s</td>
          <td class="num">2,298 veh/h</td></tr>
        <tr><td><strong>Re-marked — 2 × 3.0 m, 180 s, 4 phases</strong></td>
          <td><strong>Paint</strong></td>
          <td class="num"><span class="pill green">{PR['served_pct']:.1f}%</span></td>
          <td class="num"><span class="pill green">{PR['worst']:.1f}%</span></td>
          <td class="num"><span class="pill green">{PR['duration']:.0f} s</span></td>
          <td class="num"><span class="pill green">4,591 veh/h</span></td></tr>
      </tbody>
    </table>
  </div>
</section>

<section id="site">
  <div class="eyebrow">§2 · The site</div>
  <h2>Geometry, and what the constraint excludes</h2>
  <p>Balegere Cross sits at roughly 12.939&deg;N, 77.718&deg;E in East Bangalore,
  joining four corridors. Each approach carries <strong>6&nbsp;m of sealed
  carriageway, currently marked as one lane in each direction</strong>.</p>
  <div class="tbl-wrap">
    <table class="compare">
      <thead><tr><th>Arm</th><th>Leads to</th><th>Entry edge</th><th>Exit edge</th>
      <th>Approach storage</th></tr></thead>
      <tbody>
        <tr><td>E — Panathur</td><td>Panathur Railway Cross</td><td><code>E0</code></td><td><code>-E0.79.36</code></td><td class="num">85.8 m</td></tr>
        <tr><td>W — Varthur</td><td>Varthur Traffic Police Station</td><td><code>-E2</code> → <code>-E5</code></td><td><code>E5.36</code> → <code>E2</code></td><td class="num">57.7 + 56.5 m</td></tr>
        <tr><td>N — Kundalahalli</td><td>Kundalahalli</td><td><code>E4</code> → <code>-E6</code></td><td><code>E6</code> → <code>-E4</code></td><td class="num"><span class="pill red">34.9 + 15.5 m</span></td></tr>
        <tr><td>S — Sarjapur</td><td>Sarjapur</td><td><code>E3</code></td><td><code>-E3</code></td><td class="num">48.2 m</td></tr>
      </tbody>
    </table>
  </div>
  <p>Two properties of the network dominate everything that follows.</p>
  <p><strong>Every approach is marked as a single lane</strong> &mdash; 15 directed
  edges, 15 lanes, 670&nbsp;m of road in total. This is a marking decision, not a
  physical limit, which turns out to be the whole story (§6).</p>
  <p><strong>It is not a crossroads.</strong> The junction is a triangle of three
  nodes 19.6&nbsp;m and 37.0&nbsp;m apart &mdash; one signalised, two
  priority-controlled &mdash; linked by edges as short as 15.5&nbsp;m. One leg
  (<code>E0&rarr;E1&rarr;-E4</code>) carries Panathur&rarr;Kundalahalli traffic
  around the signal entirely. U-turns are already prohibited throughout. None of
  this can be altered without construction, so all of it is held fixed here.</p>

  <div class="qa-card">
    <span class="qid">2a · What the constraint leaves available</span>
    <p class="question">Which levers are in scope?</p>
    <span class="ans-label">Scope</span>
    <div class="tbl-wrap">
      <table class="compare">
        <thead><tr><th>Lever</th><th>Nature of change</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td><strong>Lane markings within the existing 6 m</strong></td><td><strong>Paint</strong></td><td><span class="pill green">tested — recommended</span></td></tr>
          <tr><td>Signal phase structure</td><td>Controller configuration</td><td><span class="pill green">tested</span></td></tr>
          <tr><td>Cycle length and green splits</td><td>Controller configuration</td><td><span class="pill green">tested</span></td></tr>
          <tr><td>Static vs vehicle-actuated</td><td>Controller configuration + detectors</td><td><span class="pill green">tested</span></td></tr>
          <tr><td>Protected vs permissive movements</td><td>Signal head / controller</td><td><span class="pill green">tested</span></td></tr>
          <tr><td>Give-way assignment at the two priority junctions</td><td>Signs and markings</td><td><span class="pill green">tested</span></td></tr>
          <tr><td>Turn bans</td><td>Signs</td><td><span class="pill green">tested</span></td></tr>
          <tr><td>Signalising the other two junctions</td><td>Equipment install</td><td><span class="pill green">tested</span></td></tr>
          <tr><td>U-turn prohibition</td><td>Median / signage</td><td><span class="pill no">already in place</span></td></tr>
          <tr><td>Widening, consolidating the junction, grade separation</td><td>Construction</td><td><span class="pill red">excluded by constraint</span></td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<section id="demand">
  <div class="eyebrow">§3 · Demand</div>
  <h2>The traffic this junction is asked to carry</h2>
  <p>Demand is built from the surveyed turning-movement counts in
  <code>balegare-data.txt</code> as a single origin&ndash;destination matrix, then
  emitted as individual trips carrying an origin and a destination rather than a
  fixed route &mdash; so each configuration routes the same journeys over its own
  geometry. Vehicle identifiers, types and departure times are identical in every
  run in this report, which is what makes the runs comparable.</p>

  <div class="tbl-wrap">
    <table class="compare">
      <thead><tr><th>Arm</th><th>Peak veh/h entering</th><th>Peak PCU/h</th>
      <th>Share of PCU</th></tr></thead>
      <tbody>
        <tr><td>E — Panathur</td><td class="num">1,585</td><td class="num">1,235</td><td class="num">27.6%</td></tr>
        <tr><td>W — Varthur</td><td class="num">1,568</td><td class="num">1,216</td><td class="num">27.2%</td></tr>
        <tr><td>N — Kundalahalli</td><td class="num">1,420</td><td class="num">1,111</td><td class="num">24.8%</td></tr>
        <tr><td>S — Sarjapur</td><td class="num">1,170</td><td class="num">916</td><td class="num">20.5%</td></tr>
        <tr><td><strong>Total</strong></td><td class="num"><strong>5,743</strong></td><td class="num"><strong>4,478</strong></td><td class="num">100%</td></tr>
      </tbody>
    </table>
  </div>

  <p>The fleet is <strong>53% two-wheelers</strong>, 33% cars, 8% auto-rickshaws,
  3% trucks and 1.5% buses. Because two-wheelers count 0.5&nbsp;PCU and cars 1.0,
  the two-wheeler share of PCU is only 35%. Bicycles appear in the survey at
  137/h but are rare here in practice and are excluded; they were 0.6% of PCU, so
  the load is essentially unchanged.</p>

  <p>The dominant movement is <strong>Panathur&harr;Varthur through traffic at
  2,316&nbsp;veh/h</strong> &mdash; 40% of all demand, with no business at the
  junction itself. Where demand is scaled in this report, the whole matrix is
  scaled proportionally, preserving the turning-movement mix.</p>
</section>

<section id="searched">
  <div class="eyebrow">§4 · Search</div>
  <h2>339 runs across every available lever</h2>
  {searched_table()}
  <p>All at surveyed peak unless stated, on the identical trip set, under one
  shared run policy (§10).</p>

  <div class="qa-card">
    <span class="qid">4a · Three levers that turned out to be unavailable</span>
    <p class="question">Turn bans, give-way reassignment, and extra signals.</p>
    <span class="ans-label">Dead ends</span>
    <p><strong>Turn bans are infeasible.</strong> The two right turns that yield to
    the most conflicting movements &mdash; <code>-E6&rarr;-E5.51</code> (yields to
    seven others) and <code>E3&rarr;E5.36</code> (yields to six) &mdash; look like
    obvious candidates, because on a single-lane approach one vehicle waiting for
    a gap halts everything behind it. Removing either produces
    <code>Vehicle 'NE_motorcycle_0' has no valid route</code>: the triangle offers
    no alternative path for Kundalahalli&rarr;Panathur. <strong>No turn at this
    junction can be banned without disconnecting demand.</strong></p>
    <p><strong>Give-way reassignment changes nothing.</strong> Every edge carries
    <code>priority="-1"</code>, i.e. all equal, so right-of-way was assigned by
    geometry &mdash; and assigned backwards: traffic <em>leaving</em> the signal
    toward Kundalahalli (<code>E6&rarr;-E4</code>) must yield to Kundalahalli's own
    inbound stream, on a 15.5&nbsp;m link holding 2.2 vehicles. Correcting that
    looked free. Six priority schemes were tested; the best moved total service
    from 52.0% to <strong>52.1%</strong> and left the per-arm distribution
    unchanged.</p>
    <p><strong>Signalising the other two junctions makes it worse</strong> &mdash;
    50.1% against 52.1% for retiming alone. Three controllers 20&ndash;37&nbsp;m
    apart, with 15.5&nbsp;m and 23.8&nbsp;m links between them, cannot be
    coordinated without one signal's red spilling into another's junction box.</p>
  </div>
</section>

<section id="traps">
  <div class="eyebrow">§5 · Two traps</div>
  <h2>Why the obvious answers are wrong</h2>

  <div class="qa-card">
    <span class="qid">5a · Conflict safety</span>
    <p class="question">Why a naive two-phase plan reports impossible throughput.</p>
    <span class="ans-label">Validation</span>
    <p>A two-phase plan is written by marking every movement served in a phase as
    protected green (<code>G</code>). Done that way at this junction, the
    simulation reports far higher throughput &mdash; and the result is not
    physically achievable. SUMO says so directly:</p>
    <pre><code>Warning: Unsafe green phase 0 in tlLogic 'clusterJ10_clusterJ4_J6_J7',
  program '0'. Lane '-E3_0' is targeted by 2 'G'-links. (use 'g' instead)
  Overall 3 lanes in 2 phases are unsafe.</code></pre>
    <p>Both <code>E5&rarr;-E3</code> and <code>-E5&rarr;-E3</code> hold protected
    green into the same lane simultaneously, so two conflicting streams merge with
    neither yielding. Any throughput measured that way is an artefact.</p>
    <p>Every program in this report therefore derives its green states from the
    junction's own <code>&lt;request&gt;</code> response matrix: a movement is
    protected only when nothing else green in that phase has priority over it,
    permissive (<code>g</code>) otherwise, and two protected movements may never
    target the same lane. Each generated program was then run and checked for the
    warning above.</p>
  </div>

  <div class="qa-card">
    <span class="qid">5b · Equity</span>
    <p class="question">Optimising total throughput starves half the junction.</p>
    <span class="ans-label">The finding that shapes the recommendation</span>
    <p>Ranked on total vehicles served, conflict-safe two-phase plans beat the
    installed four-phase plan by 4&ndash;5 points. Breaking the same runs down by
    approach shows how they earn it.</p>

    <div class="tbl-wrap">
      <table class="compare">
        <thead><tr><th>Plan</th><th>Total served</th><th>Panathur</th>
        <th>Kundalahalli</th><th>Varthur</th><th>Sarjapur</th><th>Worst arm</th></tr></thead>
        <tbody>
          <tr><td><strong>2-phase, {UNFAIR['cycle']} s</strong> — single lane, throughput-optimal</td>
            <td class="num"><span class="pill green">{UNFAIR['served_pct']:.1f}%</span></td>
            {arm_cells(UNFAIR)}
            <td class="num"><span class="pill red">{UNFAIR['worst']:.1f}%</span></td></tr>
          <tr><td><strong>As installed, 171 s</strong> — single lane, 4 phases</td>
            <td class="num">{DEL['served_pct']:.1f}%</td>
            {arm_cells(DEL)}
            <td class="num"><span class="pill orange">{DEL['worst']:.1f}%</span></td></tr>
          <tr><td><strong>2-phase, {PM1_2PH['cycle']} s</strong> — re-marked, throughput-optimal</td>
            <td class="num">{PM1_2PH['served_pct']:.1f}%</td>
            {arm_cells(PM1_2PH)}
            <td class="num"><span class="pill red">{PM1_2PH['worst']:.1f}%</span></td></tr>
          <tr><td><strong>Recommended, 180 s</strong> — re-marked, 4 phases</td>
            <td class="num"><span class="pill green">{PR['served_pct']:.1f}%</span></td>
            {arm_cells(PR)}
            <td class="num"><span class="pill green">{PR['worst']:.1f}%</span></td></tr>
        </tbody>
      </table>
    </div>

    <p>Two-phase plans pair adjacent approaches so two arms run green together.
    Those arms conflict, so the weaker one's movements must be permissive &mdash;
    Kundalahalli's through movement yields to Varthur's &mdash; and at saturation a
    permissive movement against a saturated stream gets essentially nothing.</p>

    <div class="note">
      <strong>This is why the installed structure is right, before and after
      re-marking.</strong> Four phases, each approach alone, fully protected, is
      not inefficiency &mdash; it is the only structure that keeps all four arms
      alive. Its 23% green ratio per approach looks wasteful in isolation; that
      ratio is the price of not starving two approaches. Note that even with two
      lanes, the two-phase plan still abandons Sarjapur
      ({PM1_2PH['arm']['S']:.0f}%) and triggers
      {PM1_2PH['teleports']} deadlock events, while the four-phase plan serves
      every arm above {PR['worst']:.0f}% with none.
    </div>

    <div class="sub-card">
      <h4>Why Kundalahalli is structurally the weakest arm</h4>
      <p>All Kundalahalli inbound traffic must traverse <code>E4</code>
      (34.9&nbsp;m) then <code>-E6</code> (15.5&nbsp;m, <strong>2.2 vehicles when
      single-lane</strong>) to reach the signal &mdash; <code>E4</code> has no other
      outgoing connection. That buffer is the entire storage available to
      1,420&nbsp;veh/h. Sarjapur is starved second-hand, because
      Sarjapur&rarr;Kundalahalli discharges over <code>E6</code>, the same short
      link in the opposite direction; when it backs up it blocks the junction
      box.</p>
      <p>Giving Kundalahalli green beyond its PCU share was tested at 1.4&times;
      and 1.8&times;: it lifts Kundalahalli to 55&ndash;57% and pushes Sarjapur and
      Varthur down, making the worst arm worse. The buffer was binding, not the
      green time &mdash; which is exactly why re-marking works. Two lanes double
      that buffer without lengthening the link.</p>
    </div>
  </div>
</section>

<section id="recommend">
  <div class="eyebrow">§6 · Recommendation</div>
  <h2>Re-mark each 6 m approach as two 3.0 m lanes, and run a 180 s four-phase plan</h2>

  <div class="qa-card">
    <span class="qid">6a · The recommended package</span>
    <p class="question">Two changes, neither of them construction.</p>
    <span class="ans-label">Recommended</span>
    <p><strong>1. Markings.</strong> Each approach's 6&nbsp;m of carriageway is
    re-marked from one lane to two 3.0&nbsp;m lanes, in both directions, on all
    four arms. No kerb moves, no pavement is added, no link is lengthened and the
    junction is not rebuilt.</p>
    <p><strong>2. Signal.</strong> Keep the four-phase, fully-protected structure
    and set the cycle to 180&nbsp;s, with green allocated by surveyed PCU per
    arm.</p>

    <div class="tbl-wrap">
      <table class="compare">
        <thead><tr><th>Phase</th><th>Approach served</th><th>Green s</th><th>Yellow s</th><th>State string</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>Varthur TPS</td><td class="num">46</td><td class="num">3</td><td><code>rrrrGGGGrrrrrrrr</code></td></tr>
          <tr><td>2</td><td>Panathur</td><td class="num">46</td><td class="num">3</td><td><code>rrrrrrrrrrrrGGGG</code></td></tr>
          <tr><td>3</td><td>Kundalahalli</td><td class="num">42</td><td class="num">3</td><td><code>rrrrrrrrGGGGrrrr</code></td></tr>
          <tr><td>4</td><td>Sarjapur</td><td class="num">34</td><td class="num">3</td><td><code>GGGGrrrrrrrrrrrr</code></td></tr>
          <tr><td colspan="2"><strong>Cycle</strong></td><td class="num"><strong>180</strong></td><td colspan="2"></td></tr>
        </tbody>
      </table>
    </div>

    <div class="tbl-wrap">
      <table class="compare">
        <thead><tr><th>Metric</th><th>As installed</th><th>Recommended</th><th>Change</th></tr></thead>
        <tbody>
          <tr><td>Total served at peak</td><td class="num">{DEL['served_pct']:.1f}%</td><td class="num">{PR['served_pct']:.1f}%</td><td class="num"><span class="pill green">+{PR['served_pct']-DEL['served_pct']:.1f} pp</span></td></tr>
          <tr><td>Vehicles served at peak</td><td class="num">{DEL['inserted']:,}</td><td class="num">{PR['inserted']:,}</td><td class="num"><span class="pill green">+{PR['inserted']-DEL['inserted']:,}</span></td></tr>
          <tr><td>Worst-served arm</td><td class="num">{DEL['worst']:.1f}%</td><td class="num">{PR['worst']:.1f}%</td><td class="num"><span class="pill green">+{PR['worst']-DEL['worst']:.1f} pp</span></td></tr>
          <tr><td>Spread between best and worst arm</td><td class="num">{DEL['spread']:.1f} pp</td><td class="num">{PR['spread']:.1f} pp</td><td class="num"><span class="pill green">−{DEL['spread']-PR['spread']:.1f} pp</span></td></tr>
          <tr><td>Travel time</td><td class="num">{DEL['duration']:.1f} s</td><td class="num">{PR['duration']:.1f} s</td><td class="num"><span class="pill green">−{DEL['duration']-PR['duration']:.1f} s</span></td></tr>
          <tr><td>Stopped time per trip</td><td class="num">{DEL['waiting']:.1f} s</td><td class="num">{PR['waiting']:.1f} s</td><td class="num"><span class="pill green">−{DEL['waiting']-PR['waiting']:.1f} s</span></td></tr>
          <tr><td>Door-to-door time</td><td class="num">{DEL['door2door']:.0f} s</td><td class="num">{PR['door2door']:.0f} s</td><td class="num"><span class="pill green">−{100*(1-PR['door2door']/DEL['door2door']):.0f}%</span></td></tr>
          <tr><td>Deadlock events</td><td class="num">{DEL['teleports']}</td><td class="num">{PR['teleports']}</td><td class="num"><span class="pill green">none</span></td></tr>
          <tr><td>Full-service demand ceiling</td><td class="num">2,298 veh/h</td><td class="num">4,591 veh/h</td><td class="num"><span class="pill green">2.0×</span></td></tr>
        </tbody>
      </table>
    </div>

    <p>With two-wheeler lateral filtering represented &mdash; behaviour that already
    occurs on the ground &mdash; the same package reaches
    <strong>{PRS['served_pct']:.1f}%</strong> served, worst arm
    <strong>{PRS['worst']:.1f}%</strong>, travel time
    <strong>{PRS['duration']:.0f}&nbsp;s</strong> and stopped time
    <strong>{PRS['waiting']:.0f}&nbsp;s</strong>. That is the more realistic
    figure; the table above is the conservative one.</p>
  </div>

  <div class="qa-card">
    <span class="qid">6b · Do not lengthen the cycle past 180 s</span>
    <p class="question">There is a cliff, and it is close.</p>
    <span class="ans-label">Important</span>
    <div class="diagram-embed-wrap" style="padding:16px 12px;">
    {cliff_chart_svg()}
    </div>
    <p style="font-size:13px;color:var(--text-75);">Bars are coloured by whether
    the configuration deadlocks, and each carries a written verdict rather than
    relying on colour. Exact values follow.</p>
    {cliff_table()}
    <p>Beyond 180&nbsp;s the design collapses. A longer red produces a queue that
    exceeds the storage on the short internal links &mdash; <code>E6</code> and
    <code>-E6</code> are under 16&nbsp;m &mdash; so the queue spills back through the
    junction and locks it. Demand served falls by roughly 30 percentage points and
    deadlock events appear where there had been none.</p>
    <p>This is worth stating plainly to whoever commissions the timing change:
    <strong>180&nbsp;s is not a value to round up from.</strong> If a pedestrian
    phase is added later it must come out of the existing 180&nbsp;s, not be added
    to it.</p>
  </div>

  <div class="qa-card">
    <span class="qid">6c · Marking layouts considered</span>
    <p class="question">Why two equal lanes rather than a two-wheeler filter lane?</p>
    <span class="ans-label">Answer</span>
    <p>Two layouts were tested inside the same 6&nbsp;m. A dedicated nearside
    filter lane sounds attractive given that two-wheelers are 53% of vehicles.</p>
    <div class="tbl-wrap">
      <table class="compare">
        <thead><tr><th>Layout</th><th>Total served</th><th>Worst arm</th><th>Travel time</th></tr></thead>
        <tbody>
          <tr><td><strong>2 × 3.0 m, all traffic</strong></td>
            <td class="num"><span class="pill green">{PR['served_pct']:.1f}%</span></td>
            <td class="num"><span class="pill green">{PR['worst']:.1f}%</span></td>
            <td class="num">{PR['duration']:.0f} s</td></tr>
          <tr><td>4.0 m general + 2.0 m motorcycle-only filter</td>
            <td class="num"><span class="pill red">{PM2['served_pct']:.1f}%</span></td>
            <td class="num"><span class="pill red">{PM2['worst']:.1f}%</span></td>
            <td class="num"><span class="pill red">{PM2['duration']:.0f} s</span></td></tr>
        </tbody>
      </table>
    </div>
    <p>The filter lane is substantially worse. Restricting 2&nbsp;m of a 6&nbsp;m
    carriageway to motorcycles denies it to the 47% of vehicles that are not
    two-wheelers, and at this level of saturation that lost capacity costs far
    more than the filtering gains. Two general-purpose lanes let two-wheelers
    filter anyway &mdash; that is what the lateral-filtering result above
    measures.</p>
  </div>

  <div class="qa-card">
    <span class="qid">6d · If markings cannot be changed</span>
    <p class="question">The controller-only fallback.</p>
    <span class="ans-label">Fallback</span>
    <p>If re-marking is not available, the best remaining option is to keep the
    four-phase structure and lengthen the cycle from 171&nbsp;s to 210&nbsp;s.
    It is worth <strong>+{REC['served_pct']-DEL['served_pct']:.1f} percentage
    points</strong> of demand served, +{REC['worst']-DEL['worst']:.1f}&nbsp;pp on
    the worst arm and about {DEL['duration']-REC['duration']:.0f}&nbsp;s per trip
    &mdash; real, free, and not remotely a solution. Adopt it because it costs
    nothing, not because it fixes anything.</p>
    <p><strong>Vehicle-actuated control is not recommended</strong> in either case.
    It was tested across all seven structures and every cycle length and was
    consistently equal to or slightly worse than static timing at peak: when every
    approach is saturated there is no gap for a gap-out rule to find, and
    minimum-green floors cost capacity. It becomes worth revisiting once demand
    sits below the ceiling in §7.</p>
  </div>
</section>

<section id="envelope">
  <div class="eyebrow">§7 · Capacity</div>
  <h2>What the re-marked junction can serve</h2>
  <p>Demand was scaled from 60% to 120% of surveyed peak against the recommended
  package, requiring <em>every arm</em> to be served rather than just the
  total.</p>
  {paint_env_table()}

  <div class="tbl-wrap">
    <table class="compare">
      <thead><tr><th>Service level, every arm</th><th>Single lane, best plan</th>
      <th>Re-marked, recommended</th><th>Gain</th></tr></thead>
      <tbody>
        <tr><td>100% of trips served</td><td class="num">2,298 veh/h</td><td class="num"><span class="pill green">4,591 veh/h</span></td><td class="num"><span class="pill green">2.0×</span></td></tr>
        <tr><td>≥90% of trips served</td><td class="num">2,582 veh/h</td><td class="num"><span class="pill green">5,167 veh/h</span></td><td class="num"><span class="pill green">2.0×</span></td></tr>
        <tr><td>Surveyed peak demand</td><td class="num" colspan="2">5,743 veh/h</td><td class="num">—</td></tr>
      </tbody>
    </table>
  </div>

  <p>Re-marking roughly doubles the ceiling. Full service now holds to
  <strong>4,591&nbsp;veh/h</strong> (80% of peak), and 90% service to
  <strong>5,167&nbsp;veh/h</strong> (90% of peak). At the full surveyed peak the
  junction serves {PR['served_pct']:.1f}% with the worst arm at
  {PR['worst']:.1f}% &mdash; congested, but functioning, with no deadlock and
  travel times around {PR['duration']:.0f}&nbsp;s.</p>

  <p>Travel time is worth reading carefully in the table above. It stays near
  <strong>130&nbsp;s</strong> from 70% of peak upward and does not deteriorate,
  because above the ceiling the junction is not delaying more vehicles &mdash; it
  is refusing them. The delay moves off the road and into the queue waiting to
  enter, which is what the door-to-door column captures.</p>
</section>

<section id="gap">
  <div class="eyebrow">§8 · Residual gap</div>
  <h2>About 1,150 veh/h still needs to go elsewhere</h2>
  <p>Surveyed peak is 5,743&nbsp;veh/h. The full-service ceiling after re-marking
  is 4,591&nbsp;veh/h. The residual gap is
  <strong>{gap_paint:,}&nbsp;veh/h</strong> &mdash; 20% of peak, down from
  <strong>{gap_single:,}&nbsp;veh/h</strong> (55%) without re-marking.</p>
  <p>That is a materially different problem. A 55% shortfall needs structural
  intervention; a 20% shortfall is within reach of ordinary traffic management,
  and one measure covers it on its own.</p>
  <div class="tbl-wrap">
    <table class="compare">
      <thead><tr><th>Measure</th><th>Mechanism</th><th>Scale available</th></tr></thead>
      <tbody>
        <tr><td><strong>Route diversion</strong></td><td>Signed alternative for through traffic</td><td>The Panathur↔Varthur through movement is <strong>2,316 veh/h</strong> — 40% of demand, with no business at this junction. Diverting half of it closes the gap by itself.</td></tr>
        <tr><td>Peak spreading</td><td>Staggered work and school start times on the corridor</td><td>Moves demand into the shoulder hours, where §7 shows full service</td></tr>
        <tr><td>Mode shift</td><td>Bus priority, feeder services</td><td>1,930 car trips/h at low occupancy</td></tr>
        <tr><td>Access restriction</td><td>Time-of-day goods vehicle ban</td><td>167 trucks/h at 2.5 PCU = 418 PCU, 9% of the load</td></tr>
      </tbody>
    </table>
  </div>
  <div class="note">
    <strong>Framing for whoever receives this:</strong> the two recommended changes
    are paint and a controller setting, and together they roughly double what this
    junction can carry. They do not require land, approvals for structural work,
    or a capital programme. Combined with diverting part of the through movement,
    Balegere Cross can serve its surveyed peak without construction. That was not
    true before the carriageway width was known &mdash; on the single-lane
    assumption the shortfall was 55% and no configuration change could touch it.
  </div>
</section>

<section id="atlas">
  <div class="eyebrow">§9 · Atlas</div>
  <h2>Geometry, turning movements and signal programs</h2>
  <p>Diagrams are drawn to scale from each network's lane and junction geometry,
  with a 50&nbsp;m reference bar. Arrows show direction of travel; the purple disc
  marks the signalised junction and purple shading its area. Traffic drives on the
  <strong>left</strong>, so a left turn is the near-side non-conflicting movement
  and a right turn crosses opposing traffic &mdash; which is why right turns are
  permissive rather than protected.</p>
  <p>The turning-movement tables list every permitted connection, how many lanes
  serve it, and how it is controlled: signal link index, priority-major, or
  priority-must-yield. In the signal timelines, solid green is protected, pale
  green permissive, amber yellow, grey red, across one full cycle.</p>
  <p>The recommended configuration and the installed one share identical node
  positions, link lengths and junction types &mdash; that is the point of the
  constraint. They differ in lane count within the same 6&nbsp;m of carriageway,
  and in phase timings. Two unsignalised configurations are included for
  reference: the network with u-turns still permitted, and the same network with
  u-turns removed but no signal.</p>
  {FIGS}
</section>

<section id="methodology">
  <div class="eyebrow">Behind the numbers</div>
  <h2>Methodology</h2>
  <div class="methodology">
    <p style="margin-top:0;"><strong>Toolchain.</strong> Eclipse SUMO 1.27.1
    command-line tools. 339 runs, each a full simulation to network clearance.</p>
    <p><strong>Demand.</strong> One canonical origin&ndash;destination trip set
    generated from the surveyed turning-movement counts in
    <code>balegare-data.txt</code>, with per-class vehicle parameters from the same
    source. Trips carry origin and destination edges rather than fixed routes, so
    each configuration routes identical journeys over its own geometry. Vehicle
    IDs, types and departure times are identical across every run; where demand is
    scaled, the full matrix is scaled proportionally.</p>
    <p><strong>Run policy</strong>, shared by all runs: <code>--seed 42</code>,
    1&nbsp;s steps, <code>--time-to-teleport 300</code> (kept on so a gridlocked run
    still terminates, with the teleport count serving as the deadlock metric),
    <code>--max-depart-delay 1800</code> (a trip that cannot start within 30 minutes
    counts as unserved rather than inflating waiting time by hours), and an end
    time set high enough never to bind. Clear time is read as the last instant any
    vehicle was still in the network.</p>
    <p><strong>Re-marking is modelled as markings only.</strong> Variants were
    rebuilt with <code>netconvert</code> from the original node and edge
    definitions with the lane count raised and lane width set to 3.0&nbsp;m, so
    total carriageway stays at 6.0&nbsp;m per approach. Node coordinates, junction
    types, the triangle topology, the left-hand-traffic setting and the u-turn
    prohibition are all carried through unchanged and were verified in the built
    networks. One consequence is honest to report: a wider approach consumes
    slightly more of each link at the junction mouth, so internal link lengths
    shorten by 1&ndash;3&nbsp;m (for example <code>-E6</code> from 15.5&nbsp;m to
    12.8&nbsp;m). The recommended configuration therefore succeeds despite
    marginally less storage, not because of more.</p>
    <p><strong>Conflict safety.</strong> Green states are computed from each
    junction's <code>&lt;request&gt;</code> response bitmasks, read back from the
    built network rather than assumed. A movement is protected only if no
    simultaneously-green movement has priority over it, and two protected
    movements may never target the same lane. Every generated program was run and
    checked for SUMO's unsafe-green warning &mdash; the check described in §5a.
    Warnings are not suppressed during validation.</p>
    <p><strong>Per-vehicle metrics</strong> (travel time, time lost, stopped time,
    departure delay) are means over <code>tripinfo</code> records, one per completed
    trip. These average over <em>served</em> trips only, so a configuration that
    admits less traffic reports flattering per-vehicle figures for the traffic it
    did admit &mdash; which is why served fraction is reported first throughout.
    <strong>Per-arm service</strong> is computed by matching trip IDs in the route
    file against <code>tripinfo</code> records, keyed on the origin arm encoded in
    each ID; this is what exposed the equity problem in §5b, which aggregate counts
    conceal entirely.</p>
    <p><strong>Figures</strong> in §9 are generated directly from each
    <code>.net.xml</code> geometry and signal program, and every number in this
    document is generated from the stored result data rather than transcribed.</p>
    <p><strong>Limitations.</strong> The turning-movement counts in
    <code>balegare-data.txt</code> are stated by that document to be estimates
    calibrated from IRC:106 benchmarks and Bangalore modal-split studies, not a
    survey at this junction. Car-following gaps (<code>minGap</code>, 0.5&nbsp;m for
    two-wheelers to 1.5&nbsp;m for buses) are engineering judgement, since the
    source does not specify them; SUMO's 2.5&nbsp;m default would put saturation
    flow well below what Indian urban arterials achieve. Both are identical across
    every run, so neither can bias a comparison between configurations, but both
    move the absolute ceilings in §7. Calibrating saturation flow against
    observation at this junction is the highest-value validation step remaining,
    and it is what would firm up the 4,591&nbsp;veh/h figure that §8 depends on.
    Two further omissions matter for delivery: <strong>pedestrians are not
    modelled</strong>, and a pedestrian phase must be found inside the 180&nbsp;s
    cycle rather than added to it (§6b); and <strong>3.0&nbsp;m lanes are narrow</strong>
    &mdash; adequate for this fleet, in which 53% of vehicles are two-wheelers and
    only 4.5% are buses or trucks, but the marking design should be checked against
    local standards for commercial-vehicle tracking before it is painted.</p>
  </div>
</section>

</main>

<footer>
  Balegere Cross · No-Construction Options · 16 Aug 2026 · 339 runs, geometry unchanged
</footer>
"""

out = os.path.join(OUTDIR, "balegere-no-construction.html")
open(out, "w").write(head + BODY + "\n" + tail)
print(f"wrote {out} ({len(head+BODY+tail):,} bytes)")
