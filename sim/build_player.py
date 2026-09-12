#!/usr/bin/env python3
"""Generate the browser-native side-by-side player.

No video file. Road geometry is embedded; vehicle positions stream from run.bin
and are interpolated between the 1 Hz samples, so the speed slider stays smooth
all the way down to 1x real time.

Additive mock-export mode:
    python3 build_player.py --export-mock OUT_PATH
writes the simo-player data bundle (geometry + stream + catalog) as data.js
to OUT_PATH instead of writing video/player.html. Fully deterministic.
"""
import base64, json, os, random, re, struct, sys

# Import shared geometry extraction from simo-player/tools
TOOLS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "simo-player", "tools")
sys.path.insert(0, TOOLS_DIR)
from sumo_geom import geom

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "video", "player.html")

NETS = [("current", os.path.join(HERE, "..", "networks", "BELAGERE.net.xml"),
          "TODAY", "no signal · two give-way U-turns"),
         ("proposed", os.path.join(HERE, "nets", "R2-paint180.net.xml"),
          "PROPOSED", "U-turns banned · signalised · two 3.0 m lanes")]


def load_scen():
    scen = [{"tag": t, "title": ti, "sub": sb, **geom(p)} for t, p, ti, sb in NETS]
    print("geometry:", ", ".join(f"{s['tag']} {len(s['lanes'])} lanes, "
                                 f"{len(s['phases'])} phases" for s in scen))
    return scen

CSS = """
*{box-sizing:border-box}
:root{--ground:#0B0B0C;--surface:#17171A;--surface2:#202027;--hair:rgba(245,245,247,.11);
--ink:#F5F5F7;--ink2:#B4B4BC;--ink3:#7C7C86;--accent:#E50914;--accent-ink:#FF5A60;
--green:#35C46B;--amber:#F0A02B;--red:#F5484F;
--body:"Helvetica Neue",Helvetica,Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--body);font-size:15px}
.wrap{max-width:1600px;margin:0 auto;padding:20px 22px 40px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;
border-bottom:1px solid var(--hair);padding-bottom:13px;margin-bottom:18px}
.mark{display:flex;align-items:center;gap:10px;font-weight:700;font-size:14px;letter-spacing:-.01em}
.mark i{width:5px;height:18px;background:var(--accent);border-radius:1px;display:block}
.clock{font-family:var(--mono);font-size:28px;font-weight:600;font-variant-numeric:tabular-nums}
.clock small{display:block;font-size:10px;letter-spacing:.14em;color:var(--ink3);font-family:var(--body);font-weight:600}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:1000px){.grid{grid-template-columns:1fr}}
.pane{background:var(--surface);border:1px solid var(--hair);border-radius:5px;overflow:hidden}
.pane h2{margin:0;padding:13px 16px 4px;font-size:19px;letter-spacing:-.02em}
.pane.b h2{color:var(--accent-ink)}
.pane p{margin:0;padding:0 16px 11px;font-size:12.5px;color:var(--ink3)}
canvas{display:block;width:100%;height:auto;background:var(--surface)}
.hud{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--hair);
border-top:1px solid var(--hair)}
.hud div{background:var(--surface);padding:9px 11px}
.hud b{display:block;font-size:9.5px;letter-spacing:.1em;color:var(--ink3);font-weight:600}
.hud span{font-family:var(--mono);font-size:18px;font-variant-numeric:tabular-nums}
.ctl{margin-top:18px;background:var(--surface);border:1px solid var(--hair);
border-radius:5px;padding:14px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
button{font-family:inherit;font-size:13px;font-weight:700;padding:9px 16px;border:none;
border-radius:3px;background:var(--accent);color:#fff;cursor:pointer;min-width:96px}
button:hover{filter:brightness(1.14)}
button.ghost{background:var(--surface2);color:var(--ink2)}
.fld{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--ink3)}
.fld label{letter-spacing:.08em;font-weight:600;font-size:10.5px}
input[type=range]{accent-color:var(--accent);height:22px}
#scrub{flex:1;min-width:220px}
#spd{width:190px}
.val{font-family:var(--mono);font-size:13px;color:var(--ink);min-width:52px;text-align:right;
font-variant-numeric:tabular-nums}
.legend{margin-top:12px;display:flex;gap:20px;flex-wrap:wrap;align-items:center;
font-size:11.5px;color:var(--ink3)}
.legend i{display:inline-block;width:15px;height:8px;border-radius:1px;margin-right:6px;vertical-align:1px}
.legend b{font-weight:600;letter-spacing:.09em;font-size:10px;margin-right:4px}
.note{margin-top:14px;font-size:12.5px;color:var(--ink3);border-left:2px solid var(--hair);padding-left:12px}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent-ink);outline-offset:2px}
"""

JS = r"""
const SCEN = __SCEN__, NF = 900, TYPES = [[4.5,1.8],[2.1,.8],[12,2.5],[7.5,2.4],[3.2,1.5]];
const GREEN=[53,196,107], AMBER=[240,160,43], RED=[245,72,79];
let B=null, frames=null, stats=null, simT=0, playing=false, speed=30, last=0;

function lerpC(a,b,t){return `rgb(${a.map((v,i)=>Math.round(v+(b[i]-v)*t)).join(',')})`}
function speedColor(v){
  if(v<=.4) return lerpC(RED,RED,0);
  if(v<3.5) return lerpC(RED,AMBER,(v-.4)/3.1);
  if(v<8)   return lerpC(AMBER,GREEN,(v-3.5)/4.5);
  return lerpC(GREEN,GREEN,0);
}
function parse(buf){
  const dv=new DataView(buf); let o=0;
  const tag=String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3));
  if(tag!=='BLGR') throw new Error('bad data file');
  o=4; const ver=dv.getUint8(o++), ns=dv.getUint8(o++), nf=dv.getUint16(o,true); o+=2;
  const x0=dv.getInt16(o,true),y0=dv.getInt16(o+2,true),
        x1=dv.getInt16(o+4,true),y1=dv.getInt16(o+6,true); o+=8;
  const F=[];
  for(let s=0;s<ns;s++){
    const len=dv.getUint32(o,true); o+=4; const fr=[];
    for(let f=0;f<nf;f++){
      const n=dv.getUint16(o,true); o+=2;
      const a=new Map();
      for(let i=0;i<n;i++){
        a.set(dv.getUint16(o,true),[dv.getInt16(o+2,true),dv.getInt16(o+4,true),
          dv.getUint8(o+6)*2, dv.getUint8(o+7)/8, dv.getUint8(o+8)]);
        o+=9;
      }
      fr.push(a);
    }
    F.push(fr);
  }
  const S=[];
  for(let s=0;s<ns;s++){const a=[];
    for(let f=0;f<nf;f++){a.push([dv.getUint16(o,true),dv.getUint16(o+2,true),
      dv.getUint16(o+4,true),dv.getUint16(o+6,true),dv.getUint16(o+8,true)]); o+=10;}
    S.push(a);}
  return {bounds:[x0,y0,x1,y1], frames:F, stats:S};
}
function phaseAt(ph,t){
  if(!ph.length) return null;
  const cyc=ph.reduce((s,p)=>s+p[0],0); let u=t%cyc, a=0;
  for(const [d,st] of ph){a+=d; if(u<a) return st;}
  return ph[ph.length-1][1];
}
const cvs=[...document.querySelectorAll('canvas')];
let SC=1,CX=0,CY=0,PW=0,PH=0;
function fit(){
  const [x0,y0,x1,y1]=B;
  PW=cvs[0].clientWidth; PH=Math.round(PW*(y1-y0+900)/(x1-x0+900));
  for(const c of cvs){const r=window.devicePixelRatio||1;
    c.width=PW*r; c.height=PH*r; c.style.height=PH+'px';
    c.getContext('2d').setTransform(r,0,0,r,0,0);}
  const m=26;
  SC=Math.min((PW-2*m)/(x1-x0),(PH-2*m)/(y1-y0));
  CX=(x0+x1)/2; CY=(y0+y1)/2;
}
function T(x,y){return [PW/2+(x-CX)*SC, PH/2-(y-CY)*SC]}
function drawPane(i,t){
  const s=SCEN[i], c=cvs[i], g=c.getContext('2d');
  g.fillStyle='#17171A'; g.fillRect(0,0,PW,PH);
  for(const pass of [0,1]){
    g.strokeStyle=pass?'#3A3A40':'#222227'; g.lineJoin='round'; g.lineCap='round';
    for(const L of s.lanes){
      g.lineWidth=Math.max(pass?2:3, L.w*10*SC+(pass?0:4));
      g.beginPath();
      L.p.forEach((p,k)=>{const [X,Y]=T(p[0],p[1]); k?g.lineTo(X,Y):g.moveTo(X,Y)});
      g.stroke();
    }
  }
  const st=phaseAt(s.phases,t);
  if(st){const rank={G:3,g:2,y:1,r:0}, col={3:'#35C46B',2:'#288C50',1:'#F0A02B',0:'#46464C'};
    for(const [frm,pos] of Object.entries(s.stops)){
      const idx=s.links[frm]||[]; let b=0;
      for(const k of idx) b=Math.max(b, rank[st[k]]??0);
      const [X,Y]=T(pos[0],pos[1]);
      g.fillStyle=col[b]; g.strokeStyle='#17171A'; g.lineWidth=2;
      g.beginPath(); g.arc(X,Y,6,0,6.2832); g.fill(); g.stroke();
    }}
  g.font='700 12px '+getComputedStyle(document.body).fontFamily;
  g.fillStyle='#9670C8'; g.textAlign='center';
  for(const [n,p] of Object.entries(s.arms)){
    let [X,Y]=T(p[0],p[1]); X=Math.min(Math.max(X,44),PW-44); Y=Math.min(Math.max(Y,14),PH-8);
    g.fillText(n,X,Y);
  }
  // interpolate between the 1 Hz samples so slow speeds stay smooth
  const f0=Math.min(NF-1,Math.floor(t)), f1=Math.min(NF-1,f0+1), a=t-f0;
  const A=frames[i][f0], Bm=frames[i][f1];
  for(const [id,v] of A){
    let x=v[0],y=v[1],ang=v[2];
    const w=Bm.get(id);
    if(w){x+= (w[0]-x)*a; y+=(w[1]-y)*a;
      let d=((w[2]-ang+540)%360)-180; ang=ang+d*a;}
    const [L,Wm]=TYPES[v[4]]||TYPES[0];
    const [X,Y]=T(x,y), r=(90-ang)*Math.PI/180;
    const hl=Math.max(2,L*10*SC/2), hw=Math.max(1.3,Wm*10*SC/2);
    g.save(); g.translate(X,Y); g.rotate(-r);
    g.fillStyle=speedColor(v[3]); g.fillRect(-hl,-hw,hl*2,hw*2); g.restore();
  }
}
const hudEls=[...document.querySelectorAll('.hud')].map(h=>[...h.querySelectorAll('span')]);
function draw(){
  const t=Math.max(0,Math.min(NF-1.001,simT));
  for(let i=0;i<SCEN.length;i++){
    drawPane(i,t);
    const s=stats[i][Math.floor(t)];
    hudEls[i].forEach((el,k)=>el.textContent=s[k].toLocaleString());
    hudEls[i][4].style.color=s[4]?'#F5484F':'#7C7C86';
  }
  const ss=Math.floor(t);
  document.getElementById('clk').textContent=
    String(Math.floor(ss/60)).padStart(2,'0')+':'+String(ss%60).padStart(2,'0');
  document.getElementById('scrub').value=t;
}
function tick(ts){
  if(playing){
    if(last) simT+=(ts-last)/1000*speed;
    last=ts;
    if(simT>=NF-1){simT=NF-1.001; setPlay(false);}
    draw();
  }
  requestAnimationFrame(tick);
}
function setPlay(p){
  playing=p; last=0;
  document.getElementById('play').textContent=p?'❙❙  Pause':'▶  Play';
}
document.getElementById('play').onclick=()=>{
  if(simT>=NF-1.01) simT=0;
  setPlay(!playing);
};
document.getElementById('rst').onclick=()=>{simT=0; setPlay(false); draw();};
document.getElementById('scrub').oninput=e=>{simT=+e.target.value; setPlay(false); draw();};
document.getElementById('spd').oninput=e=>{
  speed=+e.target.value; last=0;
  document.getElementById('spdv').textContent=speed+'×';
};
addEventListener('resize',()=>{if(B){fit(); draw();}});
addEventListener('keydown',e=>{
  if(e.key===' '){e.preventDefault(); document.getElementById('play').click();}
  if(e.key==='ArrowRight'){simT=Math.min(NF-1.001,simT+1); setPlay(false); draw();}
  if(e.key==='ArrowLeft'){simT=Math.max(0,simT-1); setPlay(false); draw();}
});
fetch('run.bin').then(r=>{
  if(!r.ok) throw new Error('run.bin missing ('+r.status+')');
  return r.arrayBuffer();
}).then(buf=>{
  const d=parse(buf); B=d.bounds; frames=d.frames; stats=d.stats;
  document.getElementById('scrub').max=NF-1;
  fit(); draw(); setPlay(true); requestAnimationFrame(tick);
}).catch(e=>{
  document.getElementById('err').textContent =
    'Could not load the run data: '+e.message+
    '  — serve this folder over HTTP (python3 -m http.server) rather than opening the file directly.';
});
"""

def build_html(scen):
    panes = "\n".join(f"""
  <div class="pane {'b' if i else 'a'}">
    <h2>{s['title']}</h2><p>{s['sub']}</p>
    <canvas></canvas>
    <div class="hud">
      <div><b>THROUGH</b><span style="color:var(--green)">0</span></div>
      <div><b>MOVING</b><span>0</span></div>
      <div><b>STOPPED</b><span style="color:var(--amber)">0</span></div>
      <div><b>QUEUED OUTSIDE</b><span style="color:var(--red)">0</span></div>
      <div><b>GRIDLOCKS</b><span>0</span></div>
    </div>
  </div>""" for i, s in enumerate(scen))

    payload = json.dumps([{k: s[k] for k in
                           ("title", "sub", "lanes", "arms", "phases", "stops", "links")}
                          for s in scen], separators=(",", ":"))

    return f"""<title>Balagere T Junction — Today vs Proposed</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>{CSS}</style>
<div class="wrap">
  <div class="top">
    <div class="mark"><i></i><span>BALAGERE T JUNCTION · PEAK HOUR · SUMO</span></div>
    <div class="clock"><small>ELAPSED</small><span id="clk">00:00</span></div>
  </div>
  <div class="grid">{panes}</div>
  <div class="ctl">
    <button id="play">▶  Play</button>
    <button id="rst" class="ghost">Restart</button>
    <div class="fld" style="flex:1"><label for="scrub">TIME</label>
      <input id="scrub" type="range" min="0" max="899" step="0.5" value="0"></div>
    <div class="fld"><label for="spd">SPEED</label>
      <input id="spd" type="range" min="1" max="120" step="1" value="30">
      <span class="val" id="spdv">30×</span></div>
  </div>
  <div class="legend">
    <span><b>VEHICLE</b>
      <i style="background:#F5484F"></i>stopped
      <i style="background:#F0A02B;margin-left:12px"></i>crawling
      <i style="background:#35C46B;margin-left:12px"></i>moving freely</span>
    <span><b>SIGNAL</b>
      <i style="background:#35C46B;border-radius:50%;width:9px;height:9px"></i>green
      <i style="background:#F0A02B;border-radius:50%;width:9px;height:9px;margin-left:12px"></i>amber
      <i style="background:#46464C;border-radius:50%;width:9px;height:9px;margin-left:12px"></i>red</span>
  </div>
  <p class="note">Both sides run the same 5,743 vehicles with the same departure
  times and the same random seed — only the junction differs. Positions are
  SUMO's own output, sampled once a second and interpolated for smooth playback.
  Space plays and pauses; arrow keys step one second.</p>
  <p class="note" id="err" style="color:var(--red);border-color:var(--red)"></p>
</div>
<script>{JS.replace('__SCEN__', payload)}</script>
"""


def write_player():
    html = build_html(load_scen())
    open(OUT, "w").write(html)
    print(f"wrote {OUT} ({len(html)/1024:.0f} KB)")


# ------------------------------------------------------------------ mock export

RUN_BIN = os.path.join(HERE, "video", "run.bin")

MOCK_CSS = """
*{box-sizing:border-box}
:root{--ground:#0B0B0C;--surface:#17171A;--surface2:#202027;--hair:rgba(245,245,247,.11);
--ink:#F5F5F7;--ink2:#B4B4BC;--ink3:#7C7C86;--accent:#E50914;--accent-ink:#FF5A60;
--green:#35C46B;--amber:#F0A02B;--red:#F5484F;--today:#4E8DD9;
--body:"Helvetica Neue",Helvetica,Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
html,body{margin:0;height:100%;background:var(--ground);color:var(--ink);
font-family:var(--body);font-size:15px}
#root{height:100%;display:flex;flex-direction:column}
/* top bar */
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;
border-bottom:1px solid var(--hair);padding:10px 18px;background:var(--surface)}
.mark{display:flex;align-items:center;gap:10px;font-weight:700;font-size:14px;letter-spacing:-.01em}
.mark i{width:5px;height:18px;background:var(--accent);border-radius:1px;display:block}
.mark small{color:var(--ink3);font-weight:600;font-size:10.5px;letter-spacing:.12em}
.viewtoggle{display:flex;border:1px solid var(--hair);border-radius:4px;overflow:hidden}
.viewtoggle button{min-width:0;border-radius:0;background:transparent;color:var(--ink2);
font-size:12px;padding:7px 14px}
.viewtoggle button.on{background:var(--accent);color:#fff}
.userbox{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--ink3)}
.userbox input{background:var(--surface2);border:1px solid var(--hair);border-radius:3px;
color:var(--ink);font:inherit;font-size:12.5px;padding:6px 9px;width:150px}
/* map */
.map-wrap{flex:1;position:relative}
.leaflet-container{background:var(--ground);font-family:var(--body);outline:none}
.leaflet-tile-pane{filter:brightness(.72) invert(1) contrast(3) hue-rotate(200deg)
saturate(.28) brightness(.9)}
.leaflet-overlay-pane{z-index:410}
.leaflet-shadow-pane{z-index:400}
.leaflet-marker-pane{z-index:620}
.leaflet-tooltip-pane{z-index:640}
.leaflet-popup-pane{z-index:660}
.leaflet-control-zoom{border:1px solid var(--hair)!important;box-shadow:none!important}
.leaflet-control-zoom a{background:var(--surface);color:var(--ink);
border-bottom:1px solid var(--hair)}
.leaflet-control-zoom a:hover{background:var(--surface2);color:var(--ink)}
.leaflet-control-attribution{background:rgba(23,23,26,.78);color:var(--ink3);font-size:10px}
.leaflet-control-attribution a{color:var(--ink2)}
/* divIcon pins + zone badges */
.sim-pin{background:transparent;border:none}
.sim-pin .dot{display:flex;align-items:center;gap:7px;transform:translate(-50%,-50%);
white-space:nowrap;cursor:pointer}
.sim-pin .pip{width:11px;height:11px;border-radius:50%;background:var(--accent);
border:2px solid var(--ground);box-shadow:0 0 0 1px var(--hair);flex:none}
.sim-pin.today .pip{background:var(--today)}
.sim-pin.proposed .pip{background:var(--green)}
.sim-pin .tag{font-family:var(--mono);font-size:10px;letter-spacing:.08em;color:var(--ink);
background:rgba(23,23,26,.9);border:1px solid var(--hair);border-radius:3px;padding:2px 6px}
.sim-pin.active .tag{border-color:var(--accent);color:#fff}
.zone-badge{background:transparent;border:none}
.zone-badge span{display:block;transform:translate(-50%,-50%);font-family:var(--mono);
font-size:9.5px;letter-spacing:.1em;color:var(--ink2);background:rgba(11,11,12,.72);
border:1px solid var(--hair);border-radius:3px;padding:2px 7px;white-space:nowrap}
/* detail sheet */
.sheet{position:absolute;top:0;right:0;height:100%;width:360px;background:var(--surface);
border-left:1px solid var(--hair);z-index:800;display:flex;flex-direction:column;
box-shadow:-18px 0 42px rgba(0,0,0,.45)}
.sheet h2{margin:0;padding:16px 18px 3px;font-size:18px;letter-spacing:-.02em}
.sheet .by{padding:0 18px 10px;font-size:12px;color:var(--ink3)}
.sheet .by b{color:var(--ink2);font-weight:600}
.statgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--hair);
border-top:1px solid var(--hair);border-bottom:1px solid var(--hair)}
.statgrid div{background:var(--surface);padding:9px 12px}
.statgrid b{display:block;font-size:9.5px;letter-spacing:.1em;color:var(--ink3);font-weight:600}
.statgrid span{font-family:var(--mono);font-size:17px;font-variant-numeric:tabular-nums}
.scen-toggle{display:flex;gap:8px;padding:12px 18px}
.scen-toggle button{flex:1}
.scen-toggle button.ghost{background:var(--surface2);color:var(--ink2)}
.sheet .actions{padding:12px 18px;border-top:1px solid var(--hair);margin-top:auto}
button{font-family:inherit;font-size:13px;font-weight:700;padding:9px 16px;border:none;
border-radius:3px;background:var(--accent);color:#fff;cursor:pointer;min-width:96px}
button:hover{filter:brightness(1.14)}
button.ghost{background:var(--surface2);color:var(--ink2)}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent-ink);outline-offset:2px}
/* submit modal */
.modal-veil{position:absolute;inset:0;background:rgba(11,11,12,.66);z-index:900;
display:flex;align-items:center;justify-content:center}
.modal{width:520px;max-height:86%;overflow:auto;background:var(--surface);
border:1px solid var(--hair);border-radius:6px;padding:20px 22px}
.modal h3{margin:0 0 4px;font-size:16px;letter-spacing:-.01em}
.modal .step{font-family:var(--mono);font-size:10px;letter-spacing:.14em;color:var(--ink3);
margin-bottom:12px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.chip{display:flex;align-items:center;gap:7px;background:var(--surface2);
border:1px solid var(--hair);border-radius:3px;padding:5px 9px;font-size:11.5px;color:var(--ink2)}
.chip b{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;color:var(--ink3)}
.chip.bad{border-color:var(--red);color:var(--red)}
.modal input[type=text]{width:100%;background:var(--surface2);border:1px solid var(--hair);
border-radius:3px;color:var(--ink);font:inherit;font-size:13px;padding:8px 10px;margin:6px 0}
.toast{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);z-index:950;
background:var(--surface);border:1px solid var(--accent);border-radius:4px;
padding:10px 18px;font-size:12.5px;color:var(--ink);box-shadow:0 10px 30px rgba(0,0,0,.5)}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
"""

LANES_PALETTE = ["#222227", "#3A3A40", "#46464C", "#35C46B", "#288C50",
                 "#F0A02B", "#F5484F", "#9670C8", "#4E8DD9"]

# ~40 m square around the Balagere anchor (catalog zone)
BALAGERE_ZONE = [[12.95152, 77.78922], [12.95152, 77.78958],
                 [12.95188, 77.78958], [12.95188, 77.78922]]

# ~0.004 deg BDA-owned corridor along Silk Board (storytelling exception:
# the only oversized zone polygon in the catalog)
SILK_BOARD_ZONE = [[12.9154, 77.6209], [12.9162, 77.6203],
                   [12.919, 77.6245], [12.9182, 77.6251]]

# signal plans carried by the two signalised fake sims (sums <= 180)
PH_MARATHAHALLI = [[42, "GGrr"], [4, "yyrr"], [62, "rrGG"], [12, "rryy"]]
PH_KUNDALAHALLI = [[35, "GGrr"], [5, "yyrr"], [50, "rrGG"], [10, "rryy"]]

FAKE_SPECS = [
    {"id": "silk-board-peak-baseline", "title": "Silk Board peak-baseline",
     "author": "balagere-traffic", "anchor": [12.9172, 77.6227], "rotation": 12,
     "demand": 9200, "peak": 2100, "nf": 900, "layout": "cross",
     "added": "2026-08-03", "zone": SILK_BOARD_ZONE,
     "scen": [("today", "Facebook/RedBus viral gridlock", None)]},
    {"id": "varthur-bridge-morning", "title": "Varthur bridge morning",
     "author": "rk-nest", "anchor": [12.941, 77.7462], "rotation": -15,
     "demand": 2950, "peak": 1300, "nf": 900, "layout": "road",
     "added": "2026-08-06",
     "scen": [("today", "single-file metering over the bridge", None)]},
    {"id": "hsr-27th-main-evening", "title": "HSR 27th main evening",
     "author": "cvramanxo", "anchor": [12.9116, 77.6474], "rotation": 90,
     "demand": 3400, "peak": 1600, "nf": 1000, "layout": "t",
     "added": "2026-08-09",
     "scen": [("today", "corridor observational run, evening peak", None)]},
    {"id": "marathahalli-bridge-uturn-ban", "title": "Marathahalli bridge U-turn ban",
     "author": "ananth-kumar", "anchor": [12.9591, 77.6974], "rotation": 0,
     "demand": 5100, "peak": 2350, "nf": 900, "layout": "cross",
     "added": "2026-08-12",
     "scen": [("today", "existing give-way U-turns", None),
              ("proposed", "U-turns banned · signalised", PH_MARATHAHALLI)]},
    {"id": "kundalahalli-signal-timing", "title": "Kundalahalli signal timing",
     "author": "preethi.s", "anchor": [12.9562, 77.7161], "rotation": 8,
     "demand": 2800, "peak": 1450, "nf": 900, "layout": "cross",
     "added": "2026-08-15",
     "scen": [("today", "fixed-time retime trial", PH_KUNDALAHALLI)]},
    {"id": "whitefield-itpl-bottleneck", "title": "Whitefield ITPL bottleneck",
     "author": "itpl.commuter", "anchor": [12.9698, 77.75], "rotation": -20,
     "demand": 15000, "peak": 3900, "nf": 900, "layout": "cross",
     "added": "2026-08-18",
     "scen": [("today", "main-gate spillback, tech-park peak", None)]},
    {"id": "sarjapur-44-acres", "title": "Sarjapur 44 acres",
     "author": "sr-layout", "anchor": [12.9012, 77.6987], "rotation": 45,
     "demand": 1100, "peak": 640, "nf": 900, "layout": "t",
     "added": "2026-08-21",
     "scen": [("today", "layout internal junction, school peak", None)]},
    {"id": "bellandur-east", "title": "Bellandur east",
     "author": "blr.east", "anchor": [12.926, 77.6762], "rotation": -5,
     "demand": 7800, "peak": 470, "nf": 900, "layout": "cross",
     "added": "2026-08-25", "gridlock": True,
     "scen": [("today", "saturated corridor, demand far exceeds capacity", None)]},
]


def read_run():
    raw = open(RUN_BIN, "rb").read()
    magic, _ver, ns, nf, x0, y0, x1, y1 = struct.unpack_from("<4sBBHhhhh", raw, 0)
    if magic != b"BLGR":
        raise ValueError("bad run.bin magic")
    o, frames, stats = 16, [], []
    for _ in range(ns):
        (bl,) = struct.unpack_from("<I", raw, o)
        o += 4
        frames.append(raw[o:o + bl])
        o += bl
    for _ in range(ns):
        stats.append(raw[o:o + nf * 10])
        o += nf * 10
    return nf, [x0, y0, x1, y1], frames, stats


def fake_lanes(layout, rng):
    """4-8 plausible junction polylines in a +/-250 dm box, widths 3.0-3.5 m."""
    off, R, J = 16, 250, 22
    arms = {
        "E": [[[R, -off], [J, -off]], [[J, off], [R, off]]],
        "W": [[[-R, off], [-J, off]], [[-J, -off], [-R, -off]]],
        "N": [[[off, R], [off, J]], [[-off, J], [-off, R]]],
        "S": [[[-off, -R], [-off, -J]], [[off, -J], [off, -R]]],
    }
    order = {"cross": "EWNS", "t": "EWN", "road": "EW"}[layout]
    return [{"p": [pt[:] for pt in pts], "w": round(rng.uniform(3.0, 3.5), 1)}
            for a in order for pts in arms[a]]


def zone_poly(anchor, rng, five=False):
    """Simple rectangle within the ~60 m safety bound (span < 0.0006 deg)."""
    lat, lng = anchor
    hx = rng.uniform(0.00012, 0.00025)
    hy = rng.uniform(0.00012, 0.00025)
    cx = lng + rng.uniform(-0.00005, 0.00005)
    cy = lat + rng.uniform(-0.00005, 0.00005)
    pts = [[cy - hy, cx - hx], [cy - hy, cx + hx],
           [cy + hy, cx + hx], [cy + hy, cx - hx]]
    if five:    # collinear midpoint on the right edge: still a simple polygon
        pts.insert(2, [cy, cx + hx])
    return [[round(a, 7), round(b, 7)] for a, b in pts]


def synth_stats(nf, peak, demand, seed, gridlock=False):
    """900ish x (through, moving, stopped, queuedOutside, gridlocks) u16 rows.
    through ramps linearly to exactly peak; queued stays strictly below demand."""
    rng = random.Random(seed)
    n1 = [rng.uniform(-1, 1) for _ in range(nf)]
    n2 = [rng.uniform(-1, 1) for _ in range(nf)]
    n3 = [rng.random() for _ in range(nf)]
    qpeak = min(demand - 1, max(60, demand // 3))
    rows = []
    for t in range(nf):
        through = (peak * (t + 1)) // nf
        ramp = min(1.0, t / 120)
        moving = max(0, int(ramp * (70 + 30 * n1[t])))
        stopped = max(0, int(ramp * (30 + 15 * n2[t])))
        q = min(demand - 1,
                int(qpeak * min(1.0, t / (nf * 0.55)) * (0.85 + 0.15 * n3[t])))
        g = 0
        if gridlock and t > nf * 2 // 3:
            g = (1 if n1[t] > 0.55 else 0) + (1 if n2[t] > 0.8 else 0)
        rows.append(struct.pack("<5H", through, moving, stopped, q, g))
    return b"".join(rows)


def fake_sims():
    out = []
    for si, spec in enumerate(FAKE_SPECS):
        rng = random.Random(1234 + si)
        lanes = fake_lanes(spec["layout"], rng)
        zone = spec.get("zone") or zone_poly(spec["anchor"], rng, five=bool(si % 2))
        scenarios = {}
        for ki, (key, sub, phases) in enumerate(spec["scen"]):
            stats = synth_stats(spec["nf"], spec["peak"], spec["demand"],
                                20260900 + 31 * si + ki,
                                gridlock=spec.get("gridlock", False))
            if phases:
                links = {"arm_e": [0, 1], "arm_w": [2, 3]}
                stops = {"arm_e": [22, -16], "arm_w": [-22, 16]}
            else:
                links, stops = {}, {}
            scenarios[key] = {"title": key.upper(), "sub": sub, "lanes": lanes,
                              "arms": {}, "phases": phases or [],
                              "stops": stops, "links": links,
                              "stats": base64.b64encode(stats).decode("ascii")}
        out.append({"id": spec["id"], "title": spec["title"],
                    "author": spec["author"], "anchor": spec["anchor"],
                    "rotation": spec["rotation"], "demand": spec["demand"],
                    "peakServed": spec["peak"], "zonePoly": zone,
                    "addedAt": spec["added"], "nFrames": spec["nf"],
                    "scenarios": scenarios})
    return out


def emit_const(name, obj):
    return f"const {name} = " + json.dumps(obj, separators=(",", ":")) + ";"


def build_mock():
    scen = load_scen()
    nf, bounds, frames_b, stats_b = read_run()
    b64 = lambda b: base64.b64encode(b).decode("ascii")

    def scen_geom(s):   # contract key order
        return {k: s[k] for k in ("title", "sub", "lanes", "arms",
                                  "phases", "stops", "links")}

    # run.bin scenario order: current -> today, proposed -> proposed
    geometry = {"latlngAnchor": [12.9517, 77.7894], "rotation": -8,
                "scenarios": {"today": scen_geom(scen[0]),
                              "proposed": scen_geom(scen[1])}}
    final_through = [struct.unpack_from("<5H", sb, (nf - 1) * 10)[0]
                     for sb in stats_b]
    bal_entry = {"id": "balagere-t-junction",
                 "title": "Balagere T Junction — peak hour",
                 "author": "balagere-traffic",
                 "anchor": [12.9517, 77.7894],
                 "rotation": -8,
                 "demand": 5743,
                 "peakServed": max(final_through),
                 "zonePoly": BALAGERE_ZONE,
                 "addedAt": "2026-08-27",
                 "nFrames": nf,
                 "scenarios": {
                     "today": {**scen_geom(scen[0]), "stats": b64(stats_b[0])},
                     "proposed": {**scen_geom(scen[1]),
                                  "stats": b64(stats_b[1])}}}
    others = fake_sims()
    catalog = [bal_entry] + others
    lines = ["// Generated by sim/build_player.py --export-mock. "
             "Deterministic output; do not edit by hand.",
             emit_const("BALAGERE_CSS_STYLE", MOCK_CSS.strip()),
             emit_const("LANES_PALETTE", LANES_PALETTE),
             emit_const("BALAGERE_GEOMETRY", geometry),
             emit_const("OTHER_SIMS", others),
             emit_const("CATALOG", catalog)]
    return "\n".join(lines) + "\n"


def build_stream():
    """The Balagere stream payload as a JSONP-style streams/<id>.js file.
    Loaded lazily by app.js (script injection) — keeps data.js small."""
    nf, bounds, frames_b, stats_b = read_run()
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    payload = {"nFrames": nf, "bounds": bounds,
               "scenarios": {"today": {"frames": b64(frames_b[0])},
                             "proposed": {"frames": b64(frames_b[1])}}}
    return ("window.__simoStreamCallback('balagere-t-junction',"
            + json.dumps(payload, separators=(",", ":")) + ");\n")


def export_mock(out_path):
    text = build_mock()
    open(out_path, "w").write(text)
    print(f"wrote {out_path} ({len(text)/1024:.0f} KB)")
    streams_dir = os.path.join(os.path.dirname(os.path.abspath(out_path)),
                               "streams")
    os.makedirs(streams_dir, exist_ok=True)
    spath = os.path.join(streams_dir, "balagere-t-junction.js")
    with open(spath, "w") as fh:
        fh.write(build_stream())
    print(f"wrote {spath} ({os.path.getsize(spath)/1024:.0f} KB)")


def main(argv):
    if "--export-mock" in argv:
        i = argv.index("--export-mock")
        if i + 1 >= len(argv):
            sys.exit("usage: build_player.py --export-mock OUT_PATH")
        export_mock(argv[i + 1])
    else:
        write_player()


if __name__ == "__main__":
    main(sys.argv[1:])
