#!/usr/bin/env python3
"""Generate data.html from the files actually present, so the index cannot
drift from the folder. Run from inside the web root."""
import os, re, html

_here = os.path.dirname(os.path.abspath(__file__))
# lives in scripts/, generates the index for the site root one level up
WEB = os.path.dirname(_here) if os.path.basename(_here) == "scripts" else _here
CS = open(os.path.join(WEB, "index.html")).read()
CSS = re.search(r"<style>(.*?)</style>", CS, re.S).group(1)

DESC = {
 "data/turning-movement-counts.txt":
   "Source turning-movement counts and vehicle parameters. Peak and off-peak, "
   "per movement, per vehicle class. States that it is estimated from IRC:106 "
   "benchmarks and Bangalore modal-split studies, not surveyed at this junction.",
 "networks/BELAGERE.net.xml":
   "The junction as it is today: no traffic light, give-way control throughout, "
   "two U-turns, staggered T layout.",
 "networks/balegere-no-uturn.net.xml": "U-turns removed, still unsignalised.",
 "networks/balegere-no-uturn-traffic.net.xml":
   "U-turns removed and the main node signalised, 171 s four-phase.",
 "networks/balegere-no-uturn.rou.xml":
   "The original supplied route file. Kept for the record — it cannot run on the "
   "no-U-turn networks, which is how the demand mismatch was found.",
 "networks/built/R2-paint180.net.xml":
   "RECOMMENDED. U-turns banned, signalised, 6 m marked as two 3.0 m lanes, "
   "180 s four-phase cycle.",
 "networks/built/R1-fair210.net.xml":
   "Signal-only fallback: one lane, 210 s four-phase.",
 "networks/built/V4-retimed.net.xml":
   "Two-phase retiming attempt. Superseded — it has unsafe conflicting greens.",
 "networks/built/V5-joined.net.xml": "Junction consolidated, one lane. Needs construction.",
 "networks/built/V6-2lane.net.xml": "Consolidated, two lanes. Needs construction.",
 "networks/built/V7-3lane-ew.net.xml": "Consolidated, three lanes E–W. Needs construction.",
 "networks/built/V8-triangle-wide.net.xml": "Widened without consolidating. Needs construction.",
 "networks/built/V9-3lane-all.net.xml":
   "Consolidated, three lanes everywhere — 99% served, but construction.",
 "demand/demand-peak-baseline.rou.xml":
   "Peak demand, 5,743 trips, edge names for the current network.",
 "demand/demand-peak-nouturn.rou.xml":
   "The same 5,743 trips, edge names for the no-U-turn networks. Identical "
   "vehicle IDs, types and departure times.",
 "demand/demand-offpeak-baseline.rou.xml": "Off-peak demand, 2,197 trips, current network.",
 "demand/demand-offpeak-nouturn.rou.xml": "Off-peak demand, no-U-turn networks.",
 "results/current_results.json": "The system on the ground today, peak and off-peak, per approach.",
 "results/results.json": "All original variants under the unified demand.",
 "results/opt_results.json": "98-program signal sweep.",
 "results/fair_results.json": "Structures scored on the worst-served approach.",
 "results/fair_best_results.json": "Four-phase refinement, cycle and green-split search.",
 "results/paint_results.json": "Re-marking layouts against structures and cycles.",
 "results/paint_final.json": "Recommended plan: cycle refinement and capacity envelope.",
 "results/prio_results.json": "Give-way reassignment schemes.",
 "results/nobuild_results.json": "No-construction option set, first pass.",
 "results/nobuild3_results.json": "Long cycles, turn bans, lateral filtering.",
 "results/envelope_results.json": "Capacity envelope, early pass.",
 "results/envelope2_results.json": "Capacity envelope with per-approach equity.",
 "results/tod_results.json": "Best cycle per demand level.",
 "scripts/gen_demand.py": "Builds the one canonical demand set, emitted per network.",
 "scripts/run_batch.py": "Runs every network against it and parses the outputs.",
 "scripts/build_nets.py": "Constructs the network variants with netconvert.",
 "scripts/optimize_signal.py": "The 98-program sweep. Derives conflict-safe green states.",
 "scripts/nobuild2.py": "Conflict-safe program generation from any network's foe matrix.",
 "scripts/paint_options.py": "Re-marking layouts inside the existing 6 m.",
 "scripts/paint_final.py": "Cycle refinement and the capacity envelope.",
 "scripts/measure_current.py": "Measures the current system per approach.",
 "scripts/viz.py": "Charts, the signal player, and the dark-theme transfer.",
 "scripts/build_casestudy.py": "Generates the case study page from the result JSON.",
}

GROUPS = [
 ("The study", "The case study, as a page and as a PDF.", [
   ("index.html", "The case study."),
   ("balagere-t-junction.pdf", "The same, as a PDF."),
 ]),
 ("Source data", "What everything else is derived from.", None),
 ("Networks", "SUMO network files. Open with netedit or sumo-gui.", None),
 ("Demand", "Trip files. Identical journeys, per-network edge names.", None),
 ("Results", "Raw measurements. Every figure in the study comes from these.", None),
 ("Scripts", "Python. Regenerates all of the above from source.", None),
]
PREFIX = {"Source data": "data/", "Networks": "networks/",
          "Demand": "demand/", "Results": "results/", "Scripts": "scripts/"}


def size(p):
    n = os.path.getsize(os.path.join(WEB, p))
    return f"{n/1048576:.1f} MB" if n >= 1048576 else f"{n/1024:.0f} KB"


def rows(items):
    out = []
    for rel, desc in items:
        out.append(
            f'<tr><td><a href="{rel}">{html.escape(rel)}</a></td>'
            f'<td class="dim">{html.escape(desc)}</td>'
            f'<td class="num">{size(rel)}</td></tr>')
    return "\n".join(out)


def collect(prefix):
    found = []
    base = os.path.join(WEB, prefix.rstrip("/"))
    for dirpath, _dirs, files in os.walk(base):
        for f in sorted(files):
            rel = os.path.relpath(os.path.join(dirpath, f), WEB)
            found.append((rel, DESC.get(rel, "")))
    return sorted(found, key=lambda r: (r[0].count("/"), r[0]))


sections = []
for title, blurb, items in GROUPS:
    if items is None:
        items = collect(PREFIX[title])
    sections.append(f"""
<section>
  <div class="act"><i></i><span>{html.escape(title)}</span></div>
  <h2>{html.escape(title)}</h2>
  <p class="lead">{html.escape(blurb)}</p>
  <div class="tw"><table>
    <thead><tr><th>File</th><th>What it is</th><th>Size</th></tr></thead>
    <tbody>{rows(items)}</tbody>
  </table></div>
</section>""")

total = sum(os.path.getsize(os.path.join(dp, f))
            for dp, _d, fs in os.walk(WEB) for f in fs)
count = sum(len(fs) for _dp, _d, fs in os.walk(WEB))

OUT = f"""<title>Balagere T Junction — Data</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Every network, demand, result and script behind
the Balagere T Junction traffic study.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>{CSS}
.act i:empty{{display:none}}
td a{{font-family:var(--mono);font-size:13px;color:var(--accent-ink);
  text-decoration:none;word-break:break-all}}
td a:hover{{text-decoration:underline}}
</style>
<header class="mast"><div class="mast-in">
  <div class="mark"><i></i><span>BALAGERE T JUNCTION · DATA</span></div>
  <nav><a href="/">The case study</a></nav>
</div></header>
<div class="hero"><div class="hero-in">
  <p class="eyebrow">Open data · {count} files · {total/1048576:.1f} MB</p>
  <h1>Everything behind <em>the study</em></h1>
  <p class="standfirst">Every network, demand file, raw result and script. The
  study is regenerated from these, so anything in it can be checked or
  rerun.</p>
</div></div>
<main><div class="wrap">
<div class="note crit"><b>The counts are estimates.</b> The turning-movement data
states it was calibrated from IRC:106 benchmarks and Bangalore modal-split
studies, not surveyed at this junction. Sound for comparing options; not a
substitute for a survey.</div>
{''.join(sections)}
<section>
  <div class="act"><i></i><span>Rerunning it</span></div>
  <h2>Rerunning it</h2>
  <p>Requires Eclipse SUMO 1.27.1 and Python 3. Put the scripts beside the
  networks and demand, then:</p>
  <pre><code>export SUMO_HOME=/path/to/sumo
python3 gen_demand.py        # build the demand set
python3 build_nets.py        # build the network variants
python3 run_batch.py         # run every variant, both demand levels
python3 measure_current.py   # measure the current system per approach
python3 build_casestudy.py   # regenerate the page</code></pre>
  <p class="dim">All {count - 1} data files and the full run set complete in a few
  minutes on a laptop.</p>
</section>
</div></main>
<footer><div class="wrap">
  <span>Balagere T Junction · No-construction traffic study</span>
  <span><a href="/">Back to the study</a></span>
</div></footer>
"""
open(os.path.join(WEB, "data.html"), "w").write(OUT)
print(f"wrote data.html — {count} files indexed, {total/1048576:.1f} MB")
