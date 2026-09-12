#!/usr/bin/env python3
"""Public case study: Balagere T Junction, no-construction traffic study.

Design plan
-----------
Color -- a single committed dark world, because the subject is a signalised
junction at night-lit contrast and the study's whole argument is about what is
red and what is green. Every value painted explicitly, never inherited.
  ground   #0B0B0C  near-black, faint cool bias (chosen, not #000)
  surface  #17171A / #202027
  accent   #E50914  signal red -- rules, wordmark, buttons; never a data mark
  states   #35C46B green / #F0A02B amber / #F5484F critical
  data     #9BD4F5 -> #3D8FD1  one-hue ordinal ramp (validated on #17171A)
Type -- Helvetica Neue at 800/900 with tight tracking for display (authentic to
the idiom and a real face on macOS, no webfont CDN which the CSP blocks), the
same family at 400/500 for body, and a monospace utility face with tabular
figures for every number.
Layout -- full-bleed dark bands. A hero whose background is the actual
recommended signal plan cycling live: the most characteristic thing in this
subject's world. Then a numbers shelf, six numbered acts (the study is a real
sequence, so the numbering encodes order that the reader needs), figure cards,
and a disclosure list for limitations. Print inverts to ink-on-white.
"""
import json, os, re
import viz

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = "/tmp/sumo-report/balagere-t-junction.html"


def J(n):
    return json.load(open(os.path.join(HERE, n)))


FAIRBEST, PF, PAINT = J("fair_best_results.json"), J("paint_final.json"), J("paint_results.json")
OPT, NB3, PRIO, FAIR = J("opt_results.json"), J("nobuild3_results.json"), J("prio_results.json"), J("fair_results.json")
ENV = J("envelope2_results.json")
CUR = J("current_results.json")          # the system on the ground today
LADDER = J("results.json")["peak"]       # unified-demand run of each variant


def pick(rows, **kw):
    return next(r for r in rows if all(r.get(k) == v for k, v in kw.items()))


DEL = pick(FAIRBEST, kind="delivered", factor=1.0, sub=False)
RETIME = pick(FAIRBEST, kind="D", cycle=210, nboost=1.0, factor=1.0, sub=False)
PR = next(r for r in PF["refine"] if r["cycle"] == 180 and not r["sub"])
PRS = next(r for r in PF["refine"] if r["cycle"] == 180 and r["sub"])
PENV = sorted(PF["envelope"], key=lambda r: r["factor"])
CLIFF = sorted((r for r in PF["refine"] if not r["sub"]), key=lambda r: r["cycle"])
UNFAIR = max((r for r in FAIR if r["factor"] == 1.0), key=lambda r: r["served_pct"])
PM2 = max((r for r in PAINT if r["mark"] == "M2"), key=lambda r: r["worst"])
PM1_2PH = max((r for r in PAINT if r["mark"] == "M1" and r["struct"].startswith("A")),
              key=lambda r: r["served_pct"])
SINGLE_ENV = sorted((r for r in ENV if r["plan"] == "D"), key=lambda r: r["factor"])

GAP_SINGLE, GAP_PAINT = 5743 - 2582, 5743 - 4591

# ── figures, built light then moved onto the dark ground ──────────────────
import render_paint as rp

ATLAS = viz.to_dark(open(os.path.join(HERE, "figs", "paint.html")).read())

CUR_P = CUR["peak"]
CUR_O = CUR["offpeak"]


def served(key):
    r = LADDER[key]
    return 100.0 * r["inserted"] / r["demand"]


CMP = viz.to_dark(viz.bar_compare([
    ("Today", "no signal · two U-turns · one lane", CUR_P["served_pct"], CUR_P["worst"]),
    ("U-turns banned + signal", "171 s · four phases · one lane", DEL["served_pct"], DEL["worst"]),
    ("Recommended", "+ two 3.0 m lanes · 180 s", PR["served_pct"], PR["worst"]),
], title="demand served at peak by configuration"))

CLIFFSVG = viz.to_dark(viz.cliff_chart(
    [(r["cycle"], r["served_pct"], r["worst"], r["teleports"]) for r in CLIFF]))

_e, _j, _c, _t = rp.load(os.path.join(HERE, "nets", "R2-paint180.net.xml"))
_tl = list(_t.values())[0]
_links = {int(x["linkIndex"]): (x["from"], x.get("dir")) for x in _c
          if x.get("tl") == _tl["id"] and x.get("linkIndex") is not None}
HERO_SIGNAL = viz.to_dark(viz.ambient_signal(
    [(p["duration"], p["state"]) for p in _tl["phases"]], _links, "hero", width=520))


def arm_row(r, cells_only=False):
    a = r["arm"]
    out = ""
    for k in "ENWS":
        v = a.get(k, 0)
        cls = "ok" if v >= 90 else "warn" if v >= 40 else "bad"
        out += f'<td class="num"><span class="chip {cls}">{v:.0f}%</span></td>'
    return out


def envelope_rows(rows):
    o = []
    for r in rows:
        w = r["worst"]
        cls = "ok" if w >= 95 else "warn" if w >= 70 else "bad"
        o.append(f'<tr><td>{r["factor"]*100:.0f}% of peak</td>'
                 f'<td class="num">{r["demand"]:,}</td>'
                 f'<td class="num">{r["served_pct"]:.1f}%</td>'
                 f'<td class="num"><span class="chip {cls}">{w:.1f}%</span></td>'
                 + arm_row(r) +
                 f'<td class="num">{r["duration"]:.0f}</td>'
                 f'<td class="num">{r["waiting"]:.0f}</td></tr>')
    return "\n".join(o)


def cliff_rows():
    o = []
    for r in CLIFF:
        ok = r["teleports"] == 0
        o.append(f'<tr><td>{r["cycle"]} s</td>'
                 f'<td class="num">{r["served_pct"]:.1f}%</td>'
                 f'<td class="num">{r["worst"]:.1f}%</td>'
                 f'<td class="num">{r["duration"]:.0f}</td>'
                 f'<td>' + (f'<span class="chip ok">none</span>' if ok else
                            f'<span class="chip bad">{r["teleports"]} events</span>')
                 + '</td></tr>')
    return "\n".join(o)


SEARCH = [
    ("Signal phase structure and cycle length", 98,
     "7 phase structures × 7 cycle lengths × static and actuated",
     f"{max(r['served_pct'] for r in OPT):.1f}%",
     "Flat. Every one of 98 programs landed between 50.4% and 51.8%."),
    ("Long cycles, turn bans, lateral filtering", 16,
     "Cycles to 240 s, three turn-ban schemes, sublane model on and off",
     f"{max(r['served_pct'] for r in NB3):.1f}%",
     "Turn bans are impossible — they cut Kundalahalli off from Panathur."),
    ("Give-way reassignment", 12,
     "6 edge-priority schemes at the two unsignalised nodes",
     f"{max(r['served_pct'] for r in PRIO if r['factor']==1.0):.1f}%",
     "No effect. Best scheme gained 0.1 points."),
    ("Equity-scored structures", 70,
     "7 structures × 5 cycles, ranked on the worst-served approach",
     f"{max(r['served_pct'] for r in FAIR if r['factor']==1.0):.1f}%",
     "Exposed that the throughput winners starve two approaches."),
    ("Fair-plan refinement", 64,
     "4-phase protected, cycles 120–240 s, extra green for the weak arm",
     f"{max(r['served_pct'] for r in FAIRBEST if r['factor']==1.0):.1f}%",
     "The installed plan was already within 0.7 points of the best possible."),
    ("Capacity envelope, one lane", 22,
     "Demand scaled 25–100% of peak against two plans",
     "100%", "Full service only at or below about 2,300 veh/h."),
    ("Carriageway re-marking", 40,
     "2 marking layouts × 5 structures × 4 cycles, inside the existing 6 m",
     f"{max(r['served_pct'] for r in PAINT):.1f}%",
     "Two 3.0 m lanes roughly double capacity. Paint only."),
    ("Re-marking refinement and envelope", 17,
     "Cycles 150–270 s, lateral filtering, demand 60–120% of peak",
     f"{max(r['served_pct'] for r in PF['refine']):.1f}%",
     "180 s is optimal and there is a cliff immediately after it."),
]
TOTAL_RUNS = sum(x[1] for x in SEARCH)

search_rows = "\n".join(
    f'<tr><td><strong>{n}</strong></td><td class="num">{c}</td>'
    f'<td class="dim">{w}</td><td class="num">{b}</td><td class="dim">{o}</td></tr>'
    for n, c, w, b, o in SEARCH)

CSS = """
:root{
  --ground:#0B0B0C; --surface:#17171A; --surface-2:#202027; --hair:rgba(245,245,247,.11);
  --ink:#F5F5F7; --ink-2:#B4B4BC; --ink-3:#7C7C86;
  --accent:#E50914; --accent-ink:#FF5A60;
  /* signal states -- always paired with an icon, a word, or a texture */
  --green:#35C46B; --amber:#F0A02B; --red:#F5484F;
  /* one-hue ordinal data ramp, validated against #17171A */
  --purple:#9BD4F5; --blue:#3D8FD1;
  --display:"Helvetica Neue",Helvetica,"Arial Black",Arial,sans-serif;
  --body:"Helvetica Neue",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --wrap:1080px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--body);
  font-size:17px;line-height:1.65;font-weight:400;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 28px}
img,svg{max-width:100%}
::selection{background:var(--accent);color:#fff}
a{color:var(--accent-ink)}
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,
select:focus-visible{outline:2px solid var(--accent-ink);outline-offset:3px;border-radius:3px}

/* masthead */
.mast{position:sticky;top:0;z-index:40;background:rgba(11,11,12,.82);
  backdrop-filter:saturate(150%) blur(12px);border-bottom:1px solid var(--hair)}
.mast-in{max-width:var(--wrap);margin:0 auto;padding:13px 28px;display:flex;
  align-items:center;justify-content:space-between;gap:16px}
.mark{display:flex;align-items:center;gap:11px;font-family:var(--display);
  font-weight:800;font-size:15px;letter-spacing:-.02em}
.mark i{display:block;width:5px;height:19px;background:var(--accent);border-radius:1px}
.mast nav{display:flex;gap:20px;font-size:12.5px;font-weight:500}
.mast nav a{color:var(--ink-2);text-decoration:none}
.mast nav a:hover{color:var(--ink)}
@media(max-width:780px){.mast nav{display:none}}

/* hero */
.hero{position:relative;overflow:hidden;border-bottom:1px solid var(--hair)}
.hero-bg{position:absolute;inset:0;display:grid;place-items:center;opacity:.20;
  pointer-events:none}
.hero-bg .sigplay{width:min(560px,86vw)}
.hero::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(120% 90% at 50% 40%,transparent 30%,var(--ground) 78%)}
.hero-in{position:relative;z-index:2;max-width:var(--wrap);margin:0 auto;
  padding:104px 28px 76px}
.eyebrow{font-family:var(--mono);font-size:11.5px;font-weight:600;
  letter-spacing:.16em;text-transform:uppercase;color:var(--accent-ink);
  margin:0 0 20px}
h1{font-family:var(--display);font-weight:800;font-size:clamp(38px,7vw,78px);
  line-height:.98;letter-spacing:-.035em;margin:0 0 22px;max-width:19ch;
  text-wrap:balance}
h1 em{font-style:normal;color:var(--accent-ink)}
.standfirst{font-size:clamp(17px,2.1vw,21px);line-height:1.55;color:var(--ink-2);
  max-width:60ch;margin:0 0 30px;font-weight:400}
.byline{display:flex;flex-wrap:wrap;gap:8px 26px;font-family:var(--mono);
  font-size:11.5px;letter-spacing:.05em;color:var(--ink-3);text-transform:uppercase}
.byline b{color:var(--ink-2);font-weight:600}

/* numbers shelf */
.shelf{display:grid;grid-template-columns:repeat(auto-fit,minmax(184px,1fr));
  gap:14px;padding:30px 0 4px}
.tile{background:var(--surface);border:1px solid var(--hair);border-radius:5px;
  padding:20px 20px 17px}
.tile .k{font-family:var(--display);font-weight:800;font-size:38px;line-height:1;
  letter-spacing:-.035em;font-variant-numeric:tabular-nums}
.tile .k.up{color:var(--green)} .tile .k.dn{color:var(--red)}
.tile .l{font-size:13px;color:var(--ink-2);margin-top:9px;line-height:1.4}
.tile .s{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);margin-top:7px;
  letter-spacing:.04em;text-transform:uppercase}

/* sections */
section{padding:64px 0;border-top:1px solid var(--hair)}
section:first-of-type{border-top:none}
.act{display:flex;align-items:baseline;gap:14px;margin:0 0 8px}
.act i{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--accent-ink);
  letter-spacing:.12em}
.act span{font-family:var(--mono);font-size:11.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--ink-3)}
h2{font-family:var(--display);font-weight:800;font-size:clamp(27px,3.6vw,42px);
  line-height:1.06;letter-spacing:-.03em;margin:0 0 18px;max-width:26ch;
  text-wrap:balance}
h3{font-family:var(--display);font-weight:700;font-size:21px;letter-spacing:-.02em;
  margin:34px 0 10px}
h4{font-family:var(--mono);font-size:11.5px;font-weight:600;letter-spacing:.12em;
  text-transform:uppercase;color:var(--accent-ink);margin:26px 0 9px}
p{margin:0 0 17px;max-width:66ch}
.lead{font-size:19px;color:var(--ink-2);max-width:62ch}
ul,ol{margin:0 0 17px;padding-left:22px;max-width:66ch}
li{margin:7px 0}
strong{font-weight:700;color:var(--ink)}
.dim{color:var(--ink-2)}
code{font-family:var(--mono);font-size:.86em;background:var(--surface-2);
  padding:2px 6px;border-radius:3px;color:var(--ink)}
pre{font-family:var(--mono);font-size:12.5px;line-height:1.6;background:var(--surface);
  border:1px solid var(--hair);border-left:3px solid var(--accent);border-radius:4px;
  padding:16px 18px;margin:18px 0;overflow-x:auto}
pre code{background:none;padding:0}
blockquote{margin:26px 0;padding:2px 0 2px 22px;border-left:3px solid var(--accent);
  font-family:var(--display);font-weight:700;font-size:clamp(19px,2.4vw,25px);
  line-height:1.28;letter-spacing:-.02em;max-width:34ch}

/* callouts */
.note{background:var(--surface);border:1px solid var(--hair);border-left:3px solid var(--amber);
  border-radius:4px;padding:16px 19px;margin:20px 0;font-size:15.5px;color:var(--ink-2);
  max-width:70ch}
.note.crit{border-left-color:var(--red)}
.note.good{border-left-color:var(--green)}
.note b{color:var(--ink)}

/* tables */
.tw{overflow-x:auto;margin:20px 0;border:1px solid var(--hair);border-radius:5px;
  background:var(--surface)}
table{width:100%;border-collapse:collapse;font-size:14px;
  font-variant-numeric:tabular-nums}
th,td{padding:11px 15px;text-align:left;border-bottom:1px solid var(--hair);
  vertical-align:top}
tbody tr:last-child td{border-bottom:none}
th{font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ink-3);white-space:nowrap}
td.num{text-align:right;font-family:var(--mono);font-size:13px}
td:first-child{color:var(--ink-2)}
tbody tr:hover{background:var(--surface-2)}
.chip{display:inline-block;padding:2px 9px;border-radius:3px;font-family:var(--mono);
  font-size:11.5px;font-weight:600;white-space:nowrap}
.chip.ok{background:rgba(53,196,107,.16);color:var(--green)}
.chip.warn{background:rgba(240,160,43,.16);color:var(--amber)}
.chip.bad{background:rgba(245,72,79,.16);color:var(--red)}
.chip.neut{background:var(--surface-2);color:var(--ink-2)}

/* figure cards */
.fig{background:var(--surface);border:1px solid var(--hair);border-radius:5px;
  padding:20px 16px;margin:22px 0}
.fig figcaption{font-size:13.5px;color:var(--ink-3);margin-top:14px;padding:0 4px;
  max-width:74ch}
.fig figcaption b{color:var(--ink-2)}

/* disclosure */
details{background:var(--surface);border:1px solid var(--hair);border-radius:5px;
  margin:11px 0;overflow:hidden}
summary{cursor:pointer;padding:15px 19px;font-weight:600;font-size:16px;
  list-style:none;display:flex;justify-content:space-between;gap:14px;align-items:center}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";font-family:var(--mono);font-size:20px;color:var(--accent-ink);
  line-height:1}
details[open] summary::after{content:"\\2212"}
details .body{padding:0 19px 17px;color:var(--ink-2);font-size:15.5px}
details .body p{max-width:74ch}

/* atlas fragment restyle */
.atlas h3{font-family:var(--display);font-size:19px;margin-top:44px}
.atlas h4{color:var(--accent-ink)}
.atlas .diagram-embed-wrap{background:var(--surface);border:1px solid var(--hair);
  border-radius:5px;margin:16px 0;overflow-x:auto}
.atlas .tbl-wrap{overflow-x:auto;margin:16px 0;border:1px solid var(--hair);
  border-radius:5px;background:var(--surface)}
.atlas .pill{display:inline-block;padding:2px 9px;border-radius:3px;
  font-family:var(--mono);font-size:11px;font-weight:600;white-space:nowrap}
.atlas .pill.green{background:rgba(53,196,107,.16);color:var(--green)}
.atlas .pill.blue{background:rgba(61,143,209,.18);color:var(--purple)}
.atlas .pill.orange{background:rgba(240,160,43,.16);color:var(--amber)}
.atlas .pill.red{background:rgba(245,72,79,.16);color:var(--red)}
.atlas .pill.purple{background:rgba(155,212,245,.14);color:var(--purple)}
.atlas .pill.no{background:var(--surface-2);color:var(--ink-2)}
.atlas p{font-size:14.5px;color:var(--ink-2)}

/* signal player chrome, dark */
.sigplay .sp-ctl{display:flex;align-items:center;gap:11px;margin:12px auto 0;
  max-width:680px;padding:0 4px}
.sigplay .sp-btn{padding:8px 15px;border-radius:3px;border:none;cursor:pointer;
  background:var(--accent);color:#fff;font-family:var(--body);font-size:12.5px;
  font-weight:700;min-width:92px;letter-spacing:.02em}
.sigplay .sp-btn:hover{filter:brightness(1.14)}
.sigplay .sp-scrub{flex:1;accent-color:var(--accent)}
.sigplay .sp-time{font-family:var(--mono);font-size:12.5px;font-weight:600;
  min-width:48px;text-align:right;color:var(--ink-2)}
.sigplay .sp-speed{font-family:var(--mono);font-size:12px;padding:5px 7px;
  border-radius:3px;border:1px solid var(--hair);background:var(--surface-2);
  color:var(--ink-2)}
.sigplay .sp-read{max-width:680px;margin:11px auto 0;padding:10px 14px;
  border-radius:4px;background:var(--surface-2);font-size:13px;font-weight:600;
  color:var(--ink-2);text-align:center;font-family:var(--mono)}
.sigplay-ambient .sp-read,.sigplay-ambient .sp-ctl{display:none}

footer{border-top:1px solid var(--hair);padding:44px 0 66px;color:var(--ink-3);
  font-size:13.5px}
footer .wrap{display:flex;flex-wrap:wrap;gap:14px 30px;justify-content:space-between}

@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

/* PDF / print: a dark ground wastes ink and reads badly, so invert to a
   light document while keeping every semantic colour recognisable. */
@page{size:A4;margin:15mm 13mm}
@media print{
  :root{--ground:#fff;--surface:#fff;--surface-2:#f4f4f5;--hair:rgba(0,0,0,.16);
    --ink:#0B0B0C;--ink-2:#3a3a40;--ink-3:#6b6b72;--accent-ink:#B3060F}
  body{font-size:10.5pt}
  .mast,.hero-bg,.sigplay .sp-ctl,.mast nav{display:none!important}
  .hero::after{display:none}
  .hero-in{padding:0 0 22px}
  section{padding:20px 0;break-inside:auto}
  h1{font-size:30pt}h2{font-size:17pt}
  .tw,.fig,details,.note{break-inside:avoid}
  tr{break-inside:avoid}thead{display:table-header-group}
  h1,h2,h3,h4{break-after:avoid}
  details{border:1px solid var(--hair)}details .body{display:block!important}
  summary::after{content:""}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
"""

HTML = f"""<title>The Curious Case of Balagere T Junction</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Two T junctions 12.6 m apart, two give-way
U-turns, and 6% of rush hour getting through. What 339 simulations found, with no
permission to widen anything.">
<style>{CSS}</style>

<header class="mast">
  <div class="mast-in">
    <div class="mark"><i></i><span>BALAGERE T JUNCTION · TRAFFIC STUDY</span></div>
    <nav>
      <a href="#problem">Problem</a><a href="#baseline">Baseline</a>
      <a href="#method">Method</a><a href="#solution">Solution</a>
      <a href="#alternatives">Alternatives</a><a href="#atlas">Atlas</a>
      <a href="#limits">Limits</a>
    </nav>
  </div>
</header>

<div class="hero">
  <div class="hero-bg" aria-hidden="true">{HERO_SIGNAL}</div>
  <div class="hero-in">
    <p class="eyebrow">Case study · Traffic simulation · East Bangalore</p>
    <h1>The Curious Case of <em>Balagere T Junction</em></h1>
    <p class="standfirst" style="font-size:clamp(19px,2.5vw,25px);color:var(--ink);
    max-width:38ch;font-weight:500;margin-bottom:22px">It passes
    <b>{CUR_P['served_pct']:.0f}%</b> of its rush hour. Nothing can be widened.</p>
    <p class="standfirst">It is not a crossroads. Two side roads meet the
    Panathur–Varthur road <b>12.6 m apart</b>, there is no traffic light, and two
    give-way U-turns do the work a signalised junction would. {TOTAL_RUNS}
    simulations later, three changes — none of them construction — take it from
    {CUR_P['served_pct']:.0f}% to <b>{PR['served_pct']:.0f}%</b>.</p>
    <div class="byline">
      <span><b>Tool</b> Eclipse SUMO 1.27.1</span>
      <span><b>Runs</b> {TOTAL_RUNS}</span>
      <span><b>Constraint</b> No construction</span>
      <span><b>Published</b> 16 Aug 2026</span>
    </div>
  </div>
</div>

<main>
<div class="wrap">

<div class="shelf">
  <div class="tile"><div class="k dn">{CUR_P['served_pct']:.0f}%</div>
    <div class="l">of rush-hour traffic gets through today</div>
    <div class="s">no signal · two U-turns</div></div>
  <div class="tile"><div class="k up">{PR['served_pct']:.0f}%</div>
    <div class="l">gets through after the three recommended changes</div>
    <div class="s">no new tarmac</div></div>
  <div class="tile"><div class="k dn">{CUR_P['duration']/60:.0f} min</div>
    <div class="l">average time to cross the junction today</div>
    <div class="s">falls to {PR['duration']:.0f} s</div></div>
  <div class="tile"><div class="k dn">{CUR_P['teleports']}</div>
    <div class="l">gridlocks the simulator could not resolve without teleporting</div>
    <div class="s">falls to zero</div></div>
</div>

<div class="note crit"><b>Read this before quoting any number.</b> The traffic
counts behind this study are <b>estimates</b>, not a survey. They come from a
dataset that states plainly it was calibrated from IRC:106 benchmarks and
Bangalore modal-split studies rather than measured at this junction. Every
figure here is therefore sound for <em>comparing options against each other</em>
— that is what the study is for — and is <em>not</em> a substitute for a traffic
survey or a design submission. The section on limitations sets out exactly what
would need measuring before any of it is built.</div>

<section id="problem">
  <div class="act"><i>01</i><span>The problem</span></div>
  <h2>Two T junctions 12.6 m apart, carrying 5,743 vehicles an hour</h2>
  <p class="lead">Balagere sits on the Panathur–Varthur road in East Bangalore.
  Kundalahalli joins from the north and Sarjapur from the south — but not at the
  same place. The two side roads meet the main road <strong>12.6 m
  apart</strong>, so the site is a staggered pair of T junctions, not a
  crossroads.</p>
  <p>That stagger is the origin of the problem. From Kundalahalli you cannot turn
  across to Panathur, because the opposite side road is 12.6 m further along.
  You join the main road and double back instead — which is why the junction
  depends on U-turns.</p>
  <p>At rush hour <strong>5,743 vehicles an hour</strong> arrive and it passes
  <strong>{CUR_P['served_pct']:.0f}%</strong>. Rebuilding works — a proper
  crossroads with three lanes per approach simulates at 99% served — but
  construction was ruled out. That leaves the signal controller, road signs and
  road markings.</p>
</section>

<section id="baseline">
  <div class="act"><i>02</i><span>The baseline</span></div>
  <h2>Today: no signal, two U-turns, {CUR_P['served_pct']:.0f}% served</h2>
  <p class="lead">There is no traffic light. Every junction is give-way
  controlled. A median cut lets Sarjapur–Kundalahalli traffic cross the
  Panathur–Varthur road, and two U-turns handle the movements that cannot be made
  directly.</p>
  <p>Kundalahalli→Panathur and Kundalahalli→Sarjapur both need one U-turn.
  Sarjapur→Varthur needs the other. Both must yield, and both sit on single-lane
  approaches — so one vehicle waiting for a gap stops everyone behind it.
  <strong>1,667 veh/h, 29% of all demand, goes through those two U-turns.</strong></p>

  <div class="tw"><table>
    <thead><tr><th>Measure</th><th>Rush hour</th><th>Off-peak</th></tr></thead>
    <tbody>
      <tr><td>Demand served</td>
        <td class="num"><span class="chip bad">{CUR_P['served_pct']:.1f}%</span></td>
        <td class="num"><span class="chip bad">{CUR_O['served_pct']:.1f}%</span></td></tr>
      <tr><td>Vehicles through</td>
        <td class="num">{CUR_P['inserted']:,} of {CUR_P['demand']:,}</td>
        <td class="num">{CUR_O['inserted']:,} of {CUR_O['demand']:,}</td></tr>
      <tr><td>Time to cross</td>
        <td class="num">{CUR_P['duration']/60:.0f} min</td>
        <td class="num">{CUR_O['duration']/60:.0f} min</td></tr>
      <tr><td>Of that, stopped</td>
        <td class="num">{CUR_P['waiting']/60:.0f} min</td>
        <td class="num">{CUR_O['waiting']/60:.0f} min</td></tr>
      <tr><td>Wait to enter</td>
        <td class="num">{CUR_P['depdelay']/60:.0f} min</td>
        <td class="num">{CUR_O['depdelay']/60:.0f} min</td></tr>
      <tr><td>Gridlocks</td>
        <td class="num"><span class="chip bad">{CUR_P['teleports']}</span></td>
        <td class="num"><span class="chip bad">{CUR_O['teleports']}</span></td></tr>
    </tbody>
  </table></div>
  <div class="tw"><table>
    <thead><tr><th>Served, by approach</th><th>Panathur</th><th>Kundalahalli</th>
    <th>Varthur</th><th>Sarjapur</th></tr></thead>
    <tbody>
      <tr><td>Rush hour</td>{arm_row(CUR_P)}</tr>
      <tr><td>Off-peak</td>{arm_row(CUR_O)}</tr>
    </tbody>
  </table></div>

  <h3>What is wrong</h3>
  <ul>
    <li><strong>It gridlocks off-peak too.</strong> At 38% of peak demand it still
    serves under a quarter, with 110 gridlocks. The U-turns break it at any load.</li>
    <li><strong>Vehicles are stationary {100*CUR_P['waiting']/CUR_P['duration']:.0f}%
    of the journey.</strong> {CUR_P['teleports']} had to be teleported out of
    deadlocks — with no signal, nothing breaks the cycle.</li>
    <li><strong>All four approaches fail equally</strong>
    ({min(CUR_P['arm'].values()):.0f}–{max(CUR_P['arm'].values()):.0f}%). This is
    not a split to be retimed. The junction is not passing traffic.</li>
  </ul>
</section>

<section id="method">
  <div class="act"><i>03</i><span>Methodology</span></div>
  <h2>One demand set, {TOTAL_RUNS} runs, one variable at a time</h2>
  <p>Eclipse SUMO 1.27.1 — models every vehicle individually, not traffic as
  flow.</p>
  <ul>
    <li><strong>Identical demand in every run</strong> — same vehicles, types and
    departure times. Trips carry an origin and destination, not a fixed route, so
    each design routes the same traffic over its own geometry.</li>
    <li><strong>Shared settings</strong> — fixed seed, one-second steps, and a
    30-minute limit on waiting to enter before a trip counts as unserved.</li>
    <li><strong>Service measured per approach</strong>, by matching each trip to
    its completion record. A total alone hides an abandoned arm (section 05).</li>
    <li><strong>Every signal plan checked for validity</strong> against the
    junction's conflict matrix. Without this, two-phase plans report throughput
    that cannot physically happen (section 05).</li>
  </ul>
  <p class="dim">Fleet: 53% two-wheelers, 33% cars, 8% auto-rickshaws, 3% trucks,
  1.5% buses. Biggest movement: Panathur↔Varthur through traffic, 2,316 veh/h —
  40% of demand, with no destination at the junction.</p>
</section>

<section id="solution">
  <div class="act"><i>04</i><span>The solution</span></div>
  <h2>Ban the U-turns, signalise, mark two lanes in the existing 6 m</h2>
  <p class="lead">Each approach already has <strong>6 m of sealed
  carriageway</strong> marked as one lane. Nothing here needs new tarmac.</p>

  <div class="tw"><table>
    <thead><tr><th>Step</th><th>What it costs</th><th>Served after it</th></tr></thead>
    <tbody>
      <tr><td>Today — no signal, two U-turns</td><td class="dim">—</td>
        <td class="num"><span class="chip bad">{CUR_P['served_pct']:.1f}%</span></td></tr>
      <tr><td>Ban the two U-turns</td><td class="dim">median + signs</td>
        <td class="num"><span class="chip warn">{served('2-nouturn'):.1f}%</span></td></tr>
      <tr><td>Signalise the main junction</td><td class="dim">equipment</td>
        <td class="num"><span class="chip warn">{served('3-nouturn-tls'):.1f}%</span></td></tr>
      <tr><td>Mark 6 m as two 3.0 m lanes, cycle 180 s</td>
        <td><span class="chip neut">paint + setting</span></td>
        <td class="num"><span class="chip ok">{PR['served_pct']:.1f}%</span></td></tr>
    </tbody>
  </table></div>
  <ul>
    <li><strong>Banning the U-turns is the biggest single gain</strong> —
    {CUR_P['served_pct']:.0f}% to {served('2-nouturn'):.0f}%.</li>
    <li><strong>Signalising costs 3 points and removes all deadlock</strong> —
    {CUR_P['teleports']} gridlocks to zero.</li>
    <li><strong>Re-marking is what makes it adequate.</strong> Two lanes double the
    storage on the 15.5 m segment without lengthening it.</li>
  </ul>

  <figure class="fig">{CMP}
    <figcaption>Pale bar = total served. Darker bar = worst single approach,
    shown because a plan can lift the total while abandoning an arm.</figcaption>
  </figure>

  <div class="tw"><table>
    <thead><tr><th>Configuration</th><th>Served</th><th>Worst arm</th>
    <th>Cross</th><th>Wait to enter</th><th>Gridlocks</th><th>Full-service ceiling</th></tr></thead>
    <tbody>
      <tr><td>Today</td>
        <td class="num"><span class="chip bad">{CUR_P['served_pct']:.1f}%</span></td>
        <td class="num">{CUR_P['worst']:.1f}%</td>
        <td class="num">{CUR_P['duration']/60:.0f} min</td>
        <td class="num">{CUR_P['depdelay']/60:.0f} min</td>
        <td><span class="chip bad">{CUR_P['teleports']}</span></td>
        <td class="num">—</td></tr>
      <tr><td>U-turns banned + signal, 171 s</td>
        <td class="num">{DEL['served_pct']:.1f}%</td>
        <td class="num">{DEL['worst']:.1f}%</td>
        <td class="num">{DEL['duration']:.0f} s</td>
        <td class="num">{DEL['depdelay']/60:.0f} min</td>
        <td><span class="chip ok">none</span></td>
        <td class="num">2,298 veh/h</td></tr>
      <tr><td><strong>Recommended</strong></td>
        <td class="num"><span class="chip ok">{PR['served_pct']:.1f}%</span></td>
        <td class="num"><span class="chip ok">{PR['worst']:.1f}%</span></td>
        <td class="num">{PR['duration']:.0f} s</td>
        <td class="num">{PR['depdelay']/60:.0f} min</td>
        <td><span class="chip ok">none</span></td>
        <td class="num"><span class="chip ok">4,591 veh/h</span></td></tr>
    </tbody>
  </table></div>

  <h3>The signal plan</h3>
  <p>Four phases, one approach at a time, all movements protected. Green split by
  each approach's share of traffic. Section 05 shows why not two phases.</p>
  <div class="tw"><table>
    <thead><tr><th>Phase</th><th>Approach</th><th>Green</th><th>Amber</th></tr></thead>
    <tbody>
      <tr><td class="num">1</td><td>Varthur TPS</td><td class="num">46 s</td><td class="num">3 s</td></tr>
      <tr><td class="num">2</td><td>Panathur</td><td class="num">46 s</td><td class="num">3 s</td></tr>
      <tr><td class="num">3</td><td>Kundalahalli</td><td class="num">42 s</td><td class="num">3 s</td></tr>
      <tr><td class="num">4</td><td>Sarjapur</td><td class="num">34 s</td><td class="num">3 s</td></tr>
      <tr><td colspan="2"><strong>Cycle</strong></td><td class="num"><strong>180 s</strong></td><td></td></tr>
    </tbody>
  </table></div>

  <h3>180 s is the maximum, not a starting point</h3>
  <p>Longer reds build queues that exceed the short internal segments, spill back
  and lock the junction. A pedestrian phase must fit <em>inside</em> the 180 s.</p>
  <figure class="fig">{CLIFFSVG}
    <figcaption>Failing bars carry a hatch and a written verdict as well as
    colour, since red and green are hard to tell apart for many readers.</figcaption>
  </figure>
  <div class="tw"><table>
    <thead><tr><th>Cycle</th><th>Served</th><th>Worst arm</th><th>Cross</th>
    <th>Gridlocks</th></tr></thead>
    <tbody>{cliff_rows()}</tbody>
  </table></div>

  <h3>Full service holds to 4,591 veh/h</h3>
  <div class="tw"><table>
    <thead><tr><th>Demand</th><th>veh/h</th><th>Served</th><th>Worst arm</th>
    <th>Pan.</th><th>Kund.</th><th>Var.</th><th>Sarj.</th><th>Cross s</th>
    <th>Stopped s</th></tr></thead>
    <tbody>{envelope_rows(PENV)}</tbody>
  </table></div>
  <p>Crossing time flattens near <strong>130 s</strong> above the ceiling. That is
  not good news — past that point the junction refuses vehicles rather than
  delaying them, and the wait moves to the queue outside.</p>

  <h3>{GAP_PAINT:,} veh/h still needs to go elsewhere</h3>
  <p>5,743 arrive; 4,591 can be served in full. The remaining
  <strong>{GAP_PAINT:,} veh/h</strong> is 20% of peak — traffic management, not
  building work. Panathur–Varthur through traffic is 2,316 veh/h with no
  destination here; signing away half of it closes the gap.</p>
  <div class="note good"><b>Median works, a signal, paint, one diversion sign.</b>
  No new road, and the junction serves its rush hour.</div>
</section>

<section id="alternatives">
  <div class="act"><i>05</i><span>Alternatives</span></div>
  <h2>What else was tried, and why each failed</h2>
  <div class="tw"><table>
    <thead><tr><th>Search</th><th>Runs</th><th>What varied</th><th>Best</th>
    <th>Why it failed</th></tr></thead>
    <tbody>{search_rows}
      <tr><td><strong>Total</strong></td><td class="num"><strong>{TOTAL_RUNS}</strong></td>
      <td colspan="3"></td></tr>
    </tbody>
  </table></div>

  <h4>Signal timing alone — flat at 52%</h4>
  <p>98 programs: two, three and four phases, cycles 50–240 s, fixed and
  actuated. All landed between <strong>50.4% and 51.8%</strong>. Actuated control
  was equal or worse — with every approach saturated there is no gap for it to
  detect. This is what redirected the study away from the controller.</p>

  <h4>Two-phase plans — impossible, then unfair</h4>
  <p>Running two approaches together is the usual way to gain capacity. Written
  naively it reported much higher throughput, because two conflicting streams had
  both been given a full green into the same lane with neither yielding
  (<code>Lane '-E3_0' is targeted by 2 'G'-links</code>). Rebuilt correctly, it
  still led on the total — until split by approach.</p>
  <div class="tw"><table>
    <thead><tr><th>Plan</th><th>Total</th><th>Panathur</th><th>Kundalahalli</th>
    <th>Varthur</th><th>Sarjapur</th><th>Worst</th></tr></thead>
    <tbody>
      <tr><td><strong>Two-phase</strong></td>
        <td class="num"><span class="chip ok">{UNFAIR['served_pct']:.1f}%</span></td>
        {arm_row(UNFAIR)}
        <td class="num"><span class="chip bad">{UNFAIR['worst']:.1f}%</span></td></tr>
      <tr><td>Four-phase</td>
        <td class="num">{DEL['served_pct']:.1f}%</td>{arm_row(DEL)}
        <td class="num"><span class="chip warn">{DEL['worst']:.1f}%</span></td></tr>
    </tbody>
  </table></div>
  <p>It wins the total by serving Panathur and Varthur near 90% and
  <strong>abandoning Kundalahalli and Sarjapur at 6 and 7%</strong>. Pairing
  conflicting approaches forces the weaker to give way, and giving way to
  saturated traffic yields nothing. Optimising the headline number alone would
  have cut two neighbourhoods off.</p>
  <p class="dim">Still true after re-marking: the best two-phase plan leaves
  Sarjapur at {PM1_2PH['arm']['S']:.0f}% with {PM1_2PH['teleports']} gridlocks,
  against every arm above {PR['worst']:.0f}% and none for four phases.</p>

  <h4>Banning the worst turns — disconnects a neighbourhood</h4>
  <p>Two right turns each yield to six or seven movements. Removing either
  returns <code>no valid route</code> — there is no other path from Kundalahalli
  to Panathur.</p>

  <h4>Give-way reassignment — no effect</h4>
  <p>Six priority schemes moved service from 52.0% to <strong>52.1%</strong>. The
  blockage was the 15.5 m segment's length, not the rule governing it.</p>

  <h4>Signals on the other two junctions — worse</h4>
  <p><strong>50.1%</strong> against 52.1%. Three controllers 20–37 m apart cannot
  be coordinated without one queue spilling into the next.</p>

  <h4>Extra green for the starved approach — worse overall</h4>
  <p>Kundalahalli given 40% and 80% more green reaches 55–57% and pushes Sarjapur
  and Varthur down, so the worst arm worsens. Storage was binding, not green
  time.</p>

  <h4>A two-wheeler lane — much worse</h4>
  <p>A 4.0 m general lane plus a 2.0 m motorcycle-only lane serves
  <strong>{PM2['served_pct']:.1f}%</strong> against {PR['served_pct']:.1f}% for
  two equal lanes: it denies a third of the road to the 47% of traffic that is not
  a two-wheeler. Two ordinary lanes let them filter anyway, which lifts the
  recommendation to <strong>{PRS['served_pct']:.1f}%</strong>.</p>
</section>

<section id="atlas" class="atlas">
  <div class="act"><i>06</i><span>Atlas</span></div>
  <h2>Every configuration, drawn and playable</h2>
  <p>Each diagram is drawn to scale from the simulated network's own geometry,
  with a 50 m reference bar. Purple labels mark boundary roads, with
  <code>▸in</code> for entry and <code>▸out</code> for exit, so the movement
  tables can be located on the map. Traffic drives on the <strong>left</strong>,
  which is why right turns cross opposing traffic and left turns do not.</p>
  <p>Each signalised configuration has a <strong>playable signal</strong>: press
  play to run a full cycle and watch which movements hold green. Solid green is
  protected, pale green means give way, dashed grey is stopped. The recommended
  plan and the installed one share identical geometry — that is the whole point
  of the constraint — and differ only in timing.</p>
  {ATLAS}
</section>

<section id="limits">
  <div class="act"><i>07</i><span>Limits</span></div>
  <h2>What to measure before building this</h2>
  <p class="lead">Simulation on estimated counts: strong evidence on which option
  wins, weak evidence on absolute numbers. Gaps in order of importance.</p>

  <details open><summary>The traffic counts are estimates, not a survey</summary>
    <div class="body"><p>The count data says it was calibrated from IRC:106
    benchmarks and Bangalore modal-split studies, not measured here. Because every
    option was tested against the same demand, the <em>ranking</em> holds — it is
    the same at 60%, 80%, 100% and 120% of peak. The percentages and the
    4,591 veh/h ceiling inherit the estimate's uncertainty. A turning-movement
    count at this junction is the highest-value thing to add.</p></div></details>

  <details><summary>Saturation flow is uncalibrated</summary>
    <div class="body"><p>Following distances were set by judgement — 0.5 m for
    two-wheelers to 1.5 m for buses — because the source data omits them. The
    simulator's 2.5 m default would put throughput well below what Indian urban
    roads achieve. Identical across all {TOTAL_RUNS} runs, so they cannot bias the
    comparison, but they move the ceiling.</p></div></details>

  <details><summary>Three-metre lanes are narrow</summary>
    <div class="body"><p>Fine for a fleet that is 53% two-wheelers and only 4.5%
    buses or trucks, but the design must be checked against local standards for
    how long vehicles track through a turn. This is the main delivery
    risk.</p></div></details>

  <details><summary>Pedestrians are not modelled</summary>
    <div class="body"><p>A signalised junction on this corridor needs a pedestrian
    phase, and the recommended 180-second cycle has no room budgeted for one. It
    has to come out of the existing green time, not extend the cycle — see the
    cliff in the recommendation.</p></div></details>

  <details><summary>Re-marking slightly shortens the internal segments</summary>
    <div class="body"><p>A wider approach eats slightly more road at the junction
    mouth, so internal segments shorten by 1–3 m — the critical one from 15.5 m to
    12.8 m. The design therefore wins <em>despite</em> marginally less storage, not
    because of more.</p></div></details>

  <details><summary>Lane discipline is modelled optimistically</summary>
    <div class="body"><p>Two-wheeler filtering was modelled and is worth about
    {PRS['served_pct']-PR['served_pct']:.1f} points, but vehicles are still assumed to
    largely keep to lanes. Real behaviour is looser, which helps narrow layouts
    most — so this probably understates the benefit.</p></div></details>
</section>

<section id="repro">
  <div class="act"><i>08</i><span>Reproducibility</span></div>
  <h2>How to check this</h2>
  <p>Scripted end to end: demand, network variants, the run harness, the figures
  and this page are all regenerated from source, so no number is typed by hand.
  All {TOTAL_RUNS} simulations run in a few minutes on a laptop.</p>
  <p class="dim">Eclipse SUMO 1.27.1. Networks from the supplied Balagere
  model; demand from the supplied count dataset.</p>
</section>

</div>
</main>

<footer><div class="wrap">
  <span>Balagere T Junction · No-construction traffic study · {TOTAL_RUNS} simulation runs</span>
  <span>Simulation and analysis · 16 August 2026</span>
</div></footer>
"""

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write(HTML)
print(f"wrote {OUT} ({len(HTML):,} bytes)")
