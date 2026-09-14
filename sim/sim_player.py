#!/usr/bin/env python3
"""The side-by-side run player, as an embeddable fragment.

Everything is namespaced under .simplay / #sp2-* so it cannot collide with the
signal players already on the page, and it reuses the case study's own colour
tokens instead of declaring its own. run.bin is fetched lazily the first time the
player scrolls into view, so a 1.8 MB asset never delays first paint, and
playback starts paused.
"""
import os, re, json

HERE = os.path.dirname(os.path.abspath(__file__))

NETS = [("current", os.path.join(HERE, "..", "networks", "BELAGERE.net.xml"),
         "TODAY", "no signal · two give-way U-turns"),
        ("proposed", os.path.join(HERE, "nets", "R2-paint180.net.xml"),
         "PROPOSED", "U-turns banned · signalised · two 3.0 m lanes")]


def _geom(p):
    s = open(p).read()
    lanes = []
    for m in re.finditer(r'<lane id="([^:][^"]*)"([^>]*)>?', s):
        a = m.group(2)
        sh = re.search(r'shape="([^"]+)"', a)
        if not sh:
            continue
        w = re.search(r'width="([\d.]+)"', a)
        lanes.append({"p": [[round(float(v) * 10) for v in q.split(",")]
                            for q in sh.group(1).split()],
                      "w": float(w.group(1)) if w else 3.2})
    ends = {}
    for m in re.finditer(r'<junction id="([^:][^"]*)" type="dead_end" '
                         r'x="([-\d.]+)" y="([-\d.]+)"', s):
        ends[m.group(1)] = [round(float(m.group(2)) * 10),
                            round(float(m.group(3)) * 10)]
    arms = {}
    if ends:
        xs = sorted(ends.values(), key=lambda v: v[0])
        ys = sorted(ends.values(), key=lambda v: v[1])
        arms = {"Panathur": xs[0], "Varthur": xs[-1],
                "Sarjapur": ys[0], "Kundalahalli": ys[-1]}
    phases, stops, links = [], {}, {}
    if "<tlLogic" in s:
        phases = [[float(m.group(1)), m.group(2)] for m in
                  re.finditer(r'<phase duration="([\d.]+)" state="(\w+)"', s)]
        for m in re.finditer(r'<connection from="([^"]+)"[^>]*tl="[^"]*"'
                             r'[^>]*linkIndex="(\d+)"', s):
            frm, idx = m.group(1), int(m.group(2))
            links.setdefault(frm, []).append(idx)
            lm = re.search(rf'<lane id="{re.escape(frm)}_0"[^>]*shape="([^"]+)"', s)
            if lm:
                q = lm.group(1).split()[-1].split(",")
                stops[frm] = [round(float(q[0]) * 10), round(float(q[1]) * 10)]
    return {"lanes": lanes, "arms": arms, "phases": phases,
            "stops": stops, "links": links}


CSS = """
.simplay{margin:22px 0 6px}
.simplay .sp2-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:900px){.simplay .sp2-grid{grid-template-columns:1fr}}
.simplay .sp2-pane{background:var(--surface);border:1px solid var(--hair);
  border-radius:5px;overflow:hidden}
.simplay .sp2-pane h5{margin:0;padding:12px 14px 3px;font-family:var(--display);
  font-size:17px;font-weight:800;letter-spacing:-.02em;color:var(--ink)}
.simplay .sp2-pane.b h5{color:var(--accent-ink)}
.simplay .sp2-pane p{margin:0;padding:0 14px 10px;font-size:12px;color:var(--ink3);
  max-width:none}
.simplay canvas{display:block;width:100%;background:var(--surface)}
.simplay .sp2-hud{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;
  background:var(--hair);border-top:1px solid var(--hair)}
.simplay .sp2-hud div{background:var(--surface);padding:8px 10px}
.simplay .sp2-hud b{display:block;font-family:var(--mono);font-size:9px;
  letter-spacing:.09em;color:var(--ink3);font-weight:600}
.simplay .sp2-hud span{font-family:var(--mono);font-size:17px;
  font-variant-numeric:tabular-nums;color:var(--ink)}
.simplay .sp2-ctl{margin-top:12px;background:var(--surface);
  border:1px solid var(--hair);border-radius:5px;padding:12px 14px;display:flex;
  align-items:center;gap:14px;flex-wrap:wrap}
.simplay .sp2-ctl button{font-family:var(--body);font-size:12.5px;font-weight:700;
  padding:8px 15px;border:none;border-radius:3px;background:var(--accent);
  color:#fff;cursor:pointer;min-width:92px}
.simplay .sp2-ctl button:hover{filter:brightness(1.14)}
.simplay .sp2-ctl button.ghost{background:var(--surface-2);color:var(--ink-2)}
.simplay .fld{display:flex;align-items:center;gap:8px}
.simplay .fld label{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;
  color:var(--ink3);font-weight:600}
.simplay input[type=range]{accent-color:var(--accent);height:20px}
.simplay #sp2-scrub{flex:1;min-width:180px}
.simplay #sp2-spd{width:150px}
.simplay .val{font-family:var(--mono);font-size:12.5px;color:var(--ink);
  min-width:46px;text-align:right;font-variant-numeric:tabular-nums}
.simplay .sp2-clock{font-family:var(--mono);font-size:15px;font-weight:600;
  color:var(--ink);font-variant-numeric:tabular-nums}
.simplay .sp2-err{margin-top:10px;font-size:12.5px;color:var(--red)}
.simplay .sp2-legend{margin-top:10px;font-size:11.5px;color:var(--ink3);
  display:flex;gap:18px;flex-wrap:wrap}
.simplay .sp2-legend i{display:inline-block;width:14px;height:8px;border-radius:1px;
  margin-right:5px}
.simplay .sp2-legend b{font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;
  margin-right:4px}
@media print{
  .simplay .sp2-ctl,.simplay .sp2-err{display:none!important}
  .simplay .sp2-legend{color:var(--ink-3)}
}
"""

JS = r"""
(function(){
var SCEN=__SCEN__, NF=900, TYPES=[[4.5,1.8],[2.1,.8],[12,2.5],[7.5,2.4],[3.2,1.5]];
var GREEN=[62,124,79],AMBER=[184,119,31],RED=[190,68,54];
var B=null,frames=null,stats=null,simT=0,playing=false,speed=30,last=0,loaded=false;
var root=document.querySelector('.simplay'); if(!root) return;
var cvs=[].slice.call(root.querySelectorAll('canvas'));
var hudEls=[].slice.call(root.querySelectorAll('.sp2-hud')).map(function(h){
  return [].slice.call(h.querySelectorAll('span'));});
var $=function(id){return root.querySelector('#'+id)};
function mix(a,b,t){return 'rgb('+a.map(function(v,i){
  return Math.round(v+(b[i]-v)*t)}).join(',')+')'}
function sc(v){ if(v<=.4)return mix(RED,RED,0);
  if(v<3.5)return mix(RED,AMBER,(v-.4)/3.1);
  if(v<8)return mix(AMBER,GREEN,(v-3.5)/4.5); return mix(GREEN,GREEN,0);}
function parse(buf){
  var dv=new DataView(buf),o=0;
  var tag=String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3));
  if(tag!=='BLGR') throw new Error('unexpected data format');
  o=4; dv.getUint8(o++); var ns=dv.getUint8(o++), nf=dv.getUint16(o,true); o+=2;
  var bx0=dv.getInt16(o,true),by0=dv.getInt16(o+2,true),
      bx1=dv.getInt16(o+4,true),by1=dv.getInt16(o+6,true); o+=8;
  var F=[],i,s,f,n;
  for(s=0;s<ns;s++){ dv.getUint32(o,true); o+=4; var fr=[];
    for(f=0;f<nf;f++){ n=dv.getUint16(o,true); o+=2; var m=new Map();
      for(i=0;i<n;i++){ m.set(dv.getUint16(o,true),
        [dv.getInt16(o+2,true),dv.getInt16(o+4,true),dv.getUint8(o+6)*2,
         dv.getUint8(o+7)/8,dv.getUint8(o+8)]); o+=9;}
      fr.push(m);} F.push(fr);}
  var S=[];
  for(s=0;s<ns;s++){var a=[];
    for(f=0;f<nf;f++){a.push([dv.getUint16(o,true),dv.getUint16(o+2,true),
      dv.getUint16(o+4,true),dv.getUint16(o+6,true),dv.getUint16(o+8,true)]);o+=10;}
    S.push(a);}
  return {bounds:[bx0,by0,bx1,by1],frames:F,stats:S};
}
function phaseAt(ph,t){ if(!ph.length)return null;
  var cyc=ph.reduce(function(s,p){return s+p[0]},0),u=t%cyc,a=0;
  for(var i=0;i<ph.length;i++){a+=ph[i][0]; if(u<a)return ph[i][1];}
  return ph[ph.length-1][1];}
var SC=1,CX=0,CY=0,PW=0,PH=0;
function fit(){ var x0=B[0],y0=B[1],x1=B[2],y1=B[3];
  PW=cvs[0].clientWidth||600; PH=Math.round(PW*(y1-y0+700)/(x1-x0+700));
  cvs.forEach(function(c){var r=window.devicePixelRatio||1;
    c.width=PW*r; c.height=PH*r; c.style.height=PH+'px';
    c.getContext('2d').setTransform(r,0,0,r,0,0);});
  var m=22; SC=Math.min((PW-2*m)/(x1-x0),(PH-2*m)/(y1-y0));
  CX=(x0+x1)/2; CY=(y0+y1)/2;}
function T(x,y){return [PW/2+(x-CX)*SC, PH/2-(y-CY)*SC]}
function pane(i,t){
  var s=SCEN[i],g=cvs[i].getContext('2d'),k,L,p;
  g.fillStyle='#FFFDF8'; g.fillRect(0,0,PW,PH);
  [0,1].forEach(function(pass){
    g.strokeStyle=pass?'#B79E7C':'#D9C6A6'; g.lineJoin='round'; g.lineCap='round';
    for(k=0;k<s.lanes.length;k++){ L=s.lanes[k];
      g.lineWidth=Math.max(pass?2:3,L.w*10*SC+(pass?0:4)); g.beginPath();
      for(var q=0;q<L.p.length;q++){p=T(L.p[q][0],L.p[q][1]);
        q?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]);}
      g.stroke();}});
  var st=phaseAt(s.phases,t);
  if(st){var rank={G:3,g:2,y:1,r:0},col={3:'#3E7C4F',2:'#2F613C',1:'#B8771F',0:'#B9AA97'};
    Object.keys(s.stops).forEach(function(frm){
      var idx=s.links[frm]||[],b=0;
      idx.forEach(function(n){var v=rank[st[n]]; if(v!==undefined&&v>b)b=v;});
      var xy=T(s.stops[frm][0],s.stops[frm][1]);
      g.fillStyle=col[b]; g.strokeStyle='#FFFDF8'; g.lineWidth=2;
      g.beginPath(); g.arc(xy[0],xy[1],5.5,0,6.2832); g.fill(); g.stroke();});}
  g.font='700 11px '+getComputedStyle(document.body).fontFamily;
  g.fillStyle='#4E6E8E'; g.textAlign='center';
  Object.keys(s.arms).forEach(function(n){var xy=T(s.arms[n][0],s.arms[n][1]);
    g.fillText(n,Math.min(Math.max(xy[0],40),PW-40),
               Math.min(Math.max(xy[1],13),PH-7));});
  var f0=Math.min(NF-1,Math.floor(t)),f1=Math.min(NF-1,f0+1),a=t-f0;
  var A=frames[i][f0],Bm=frames[i][f1];
  A.forEach(function(v,id){
    var x=v[0],y=v[1],ang=v[2],w=Bm.get(id);
    if(w){x+=(w[0]-x)*a; y+=(w[1]-y)*a;
      ang+=(((w[2]-ang+540)%360)-180)*a;}
    var T2=TYPES[v[4]]||TYPES[0],xy=T(x,y),r=(90-ang)*Math.PI/180;
    var hl=Math.max(1.8,T2[0]*10*SC/2),hw=Math.max(1.2,T2[1]*10*SC/2);
    g.save(); g.translate(xy[0],xy[1]); g.rotate(-r);
    g.fillStyle=sc(v[3]); g.fillRect(-hl,-hw,hl*2,hw*2); g.restore();});
}
function draw(){
  var t=Math.max(0,Math.min(NF-1.001,simT)),i;
  for(i=0;i<SCEN.length;i++){ pane(i,t);
    var s=stats[i][Math.floor(t)];
    hudEls[i].forEach(function(el,k){el.textContent=s[k].toLocaleString();});
    hudEls[i][4].style.color=s[4]?'#BE4436':'#8A7A66';}
  var ss=Math.floor(t);
  $('sp2-clk').textContent=String(Math.floor(ss/60))+':'+('0'+(ss%60)).slice(-2);
  $('sp2-scrub').value=t;
}
function setPlay(p){playing=p; last=0;
  $('sp2-play').textContent=p?'❚❚  Pause':'▶  Play';}
function tick(ts){ if(playing&&loaded){
    if(last) simT+=(ts-last)/1000*speed;
    last=ts;
    if(simT>=NF-1){simT=NF-1.001; setPlay(false);}
    draw();}
  requestAnimationFrame(tick);}
$('sp2-play').addEventListener('click',function(){
  if(!loaded) return;
  if(simT>=NF-1.01) simT=0;
  setPlay(!playing);});
$('sp2-rst').addEventListener('click',function(){
  if(!loaded) return; simT=0; setPlay(false); draw();});
$('sp2-scrub').addEventListener('input',function(e){
  if(!loaded) return; simT=+e.target.value; setPlay(false); draw();});
$('sp2-spd').addEventListener('input',function(e){
  speed=+e.target.value; last=0; $('sp2-spdv').textContent=speed+'×';});
window.addEventListener('resize',function(){if(loaded){fit(); draw();}});
function load(){
  if(loaded) return; loaded='pending';
  fetch('run.bin').then(function(r){
    if(!r.ok) throw new Error('run.bin returned '+r.status);
    return r.arrayBuffer();
  }).then(function(buf){
    var d=parse(buf); B=d.bounds; frames=d.frames; stats=d.stats; loaded=true;
    $('sp2-scrub').max=NF-1; fit(); draw(); requestAnimationFrame(tick);
  }).catch(function(e){ loaded=false;
    $('sp2-err').textContent='Could not load the run data: '+e.message+
      ' — this player needs the page served over HTTP.';});
}
if('IntersectionObserver' in window){
  var io=new IntersectionObserver(function(es){
    es.forEach(function(en){ if(en.isIntersecting){ load(); io.disconnect(); }});
  },{rootMargin:'250px'});
  io.observe(root);
} else { load(); }
})();
"""


def fragment():
    scen = [{"title": ti, "sub": sb, **_geom(p)} for _t, p, ti, sb in NETS]
    payload = json.dumps([{k: s[k] for k in
                           ("title", "sub", "lanes", "arms", "phases", "stops", "links")}
                          for s in scen], separators=(",", ":"))
    panes = "\n".join(f"""
      <div class="sp2-pane {'b' if i else 'a'}">
        <h5>{s['title']}</h5><p>{s['sub']}</p>
        <canvas></canvas>
        <div class="sp2-hud">
          <div><b>THROUGH</b><span style="color:var(--green)">0</span></div>
          <div><b>MOVING</b><span>0</span></div>
          <div><b>STOPPED</b><span style="color:var(--amber)">0</span></div>
          <div><b>QUEUED OUT</b><span style="color:var(--red)">0</span></div>
          <div><b>GRIDLOCKS</b><span>0</span></div>
        </div>
      </div>""" for i, s in enumerate(scen))
    html = f"""
<div class="simplay">
  <div class="sp2-grid">{panes}</div>
  <div class="sp2-ctl">
    <button id="sp2-play">&#9654;&nbsp; Play</button>
    <button id="sp2-rst" class="ghost">Restart</button>
    <span class="sp2-clock" id="sp2-clk">0:00</span>
    <div class="fld" style="flex:1"><label for="sp2-scrub">TIME</label>
      <input id="sp2-scrub" type="range" min="0" max="899" step="0.5" value="0"></div>
    <div class="fld"><label for="sp2-spd">SPEED</label>
      <input id="sp2-spd" type="range" min="1" max="120" step="1" value="30">
      <span class="val" id="sp2-spdv">30&times;</span></div>
  </div>
  <div class="sp2-legend">
    <span><b>VEHICLE</b><i style="background:#BE4436"></i>stopped
      <i style="background:#B8771F;margin-left:10px"></i>crawling
      <i style="background:#3E7C4F;margin-left:10px"></i>moving freely</span>
    <span><b>SIGNAL</b>
      <i style="background:#3E7C4F;border-radius:50%;width:9px;height:9px"></i>green
      <i style="background:#B8771F;border-radius:50%;width:9px;height:9px;margin-left:10px"></i>amber
      <i style="background:#B9AA97;border-radius:50%;width:9px;height:9px;margin-left:10px"></i>red</span>
  </div>
  <div class="sp2-err" id="sp2-err"></div>
</div>
<script>{JS.replace('__SCEN__', payload)}</script>"""
    return CSS, html
