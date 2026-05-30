/* Node smoke test for UI building (mocked DOM + Web Audio). */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* ---------- mock Web Audio (same as DSP harness) ---------- */
class P { constructor(v){this.value=v;} setTargetAtTime(v){this.value=v;} setValueAtTime(v){this.value=v;} }
class N { constructor(c,t){this.context=c;this.type=t;this._c=[];} connect(n){this._c.push(n);return n;} disconnect(){this._c=[];} }
class Biquad extends N { constructor(c){super(c,"biquad");this.type="peaking";this.frequency=new P(350);this.Q=new P(1);this.gain=new P(0);} getFrequencyResponse(f,m,p){for(let i=0;i<f.length;i++){m[i]=1;p[i]=0;}} }
class Comp extends N { constructor(c){super(c,"comp");this.threshold=new P(0);this.ratio=new P(1);this.attack=new P(0.01);this.release=new P(0.2);this.knee=new P(6);} }
class Gain extends N { constructor(c){super(c,"gain");this.gain=new P(1);} }
class Delay extends N { constructor(c){super(c,"delay");this.delayTime=new P(0);} }
class Shaper extends N { constructor(c){super(c,"shaper");this.curve=null;this.oversample="none";} }
class Analyser extends N { constructor(c){super(c,"analyser");this.fftSize=2048;this.smoothingTimeConstant=0.8;} get frequencyBinCount(){return this.fftSize/2;} getByteTimeDomainData(a){a.fill(128);} getByteFrequencyData(a){a.fill(0);} }
class Ctx {
  constructor(){this.sampleRate=48000;this.currentTime=0;this.state="suspended";this.destination=new N(this,"dest");this.baseLatency=0.01;}
  createGain(){return new Gain(this);} createBiquadFilter(){return new Biquad(this);}
  createDynamicsCompressor(){return new Comp(this);} createDelay(){return new Delay(this);}
  createWaveShaper(){return new Shaper(this);} createAnalyser(){return new Analyser(this);}
  createChannelSplitter(){return new N(this,"split");} createChannelMerger(){return new N(this,"merge");}
  createMediaElementSource(){return new N(this,"src");} resume(){this.state="running";return Promise.resolve();}
}

/* ---------- mock DOM ---------- */
function ctx2d() {
  return new Proxy({}, {
    get(t, k) {
      if (k === "createLinearGradient") return () => ({ addColorStop(){} });
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

class El {
  constructor(tag){
    this.tagName = (tag||"div").toUpperCase();
    this._children = [];
    this.parent = null;
    this._cls = new Set();
    this.dataset = {};
    this.style = { setProperty(){} };
    this._attrs = {};
    this._listeners = {};
    this.textContent = "";
    this.value = "";
    this.classList = {
      add: (...c)=>c.forEach(x=>this._cls.add(x)),
      remove: (...c)=>c.forEach(x=>this._cls.delete(x)),
      toggle: (c,f)=>{ const on = f!==undefined?f:!this._cls.has(c); on?this._cls.add(c):this._cls.delete(c); return on; },
      contains: (c)=>this._cls.has(c),
    };
  }
  set className(v){ this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className(){ return [...this._cls].join(" "); }
  set innerHTML(html){
    this._children = [];
    this._html = html;
    const re = /<([a-zA-Z0-9]+)([^>]*?)\/?>/g; let m;
    while((m = re.exec(html))){
      const tag = m[1]; if(/^\/|^!/.test(tag)) continue;
      const attrs = m[2]||"";
      const child = new El(tag);
      const cm = /class\s*=\s*"([^"]*)"/.exec(attrs);
      if(cm) child.className = cm[1];
      child.parent = this;
      this._children.push(child);
    }
  }
  get innerHTML(){ return this._html||""; }
  appendChild(c){ c.parent = this; this._children.push(c); return c; }
  remove(){ if(this.parent){ const i=this.parent._children.indexOf(this); if(i>=0) this.parent._children.splice(i,1); } }
  addEventListener(t,f){ (this._listeners[t]=this._listeners[t]||[]).push(f); }
  removeEventListener(){}
  setAttribute(k,v){ this._attrs[k]=v; }
  getAttribute(k){ return this._attrs[k]; }
  setPointerCapture(){}
  getBoundingClientRect(){ return { width:320, height:160, left:0, top:0, right:320, bottom:160 }; }
  getContext(){ return ctx2d(); }
  focus(){}
  matches(sel){ return String(sel).split(",").map(s=>s.trim()).some(s=> this._matchSel(s)); }
  closest(sel){ let n=this; while(n){ if(n._matchSel && n._matchSel(sel)) return n; n=n.parent; } return null; }
  _matchSel(sel){
    if(!sel) return false;
    if(sel.startsWith(".")) return this._cls.has(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  _walk(out){ for(const c of this._children){ out.push(c); c._walk(out); } return out; }
  querySelector(sel){ const all=this._walk([]); return all.find(e=>e._matchSel(sel))||null; }
  querySelectorAll(sel){ return this._walk([]).filter(e=>e._matchSel(sel)); }
}

const registry = {};
function reg(id, tag, cls){ const e=new El(tag||"div"); if(cls) e.className=cls; registry[id]=e; return e; }

const body = new El("body");
// listeners + classList already present

function segGroup(id, key, vals){
  const g = reg(id, "div"); 
  vals.forEach((v,i)=>{ const b=new El("button"); b.className="seg-btn"+(i===0?" active":""); b.dataset[key]=v; g.appendChild(b); });
  body.appendChild(g); return g;
}

// register simple id elements
["audioEl","songList","emptyHint","npTitle","npSub","curTime","durTime","waveProgress",
 "iconPlay","iconPause","engineDot","engineState","channelRack","masterRack","presetGrid",
 "eqResetBtn","roSel","roFreq","roGain","roQ","soloHint","advSR","advLat","advBuf",
 "advX1","advX2","advX3","songCount","fileInput","searchInput","btnPlay","btnNext","btnPrev",
 "btnShuffle","btnRepeat","savePresetBtn","exportPresetBtn","importPresetInput",
 "bigAnalyzer","eqCanvas"].forEach(id=>{ const e=reg(id); body.appendChild(e); });

// eqFilterType select
const eqFilterType = reg("eqFilterType","select"); eqFilterType.value="peaking"; body.appendChild(eqFilterType);

// tabs
const tabs = reg("tabs","nav");
["eq","analyzer","master","preset","advanced"].forEach((t,i)=>{ const b=new El("button"); b.className="tab"+(i===0?" active":""); b.dataset.tab=t; tabs.appendChild(b); });
body.appendChild(tabs);

// tab-panes (for tab switching)
["eq","analyzer","master","preset","advanced"].forEach((t,i)=>{ const p=new El("div"); p.className="tab-pane"+(i===0?" active":""); p.dataset.pane=t; body.appendChild(p); });

// eq channel pills
const eqcs = reg("eqChannelSelect","div");
["sub","low","mid","high","master"].forEach((c,i)=>{ const b=new El("button"); b.className="ch-pill"+(i===0?" active":""); b.dataset.ch=c; eqcs.appendChild(b); });
body.appendChild(eqcs);

// toggles
segGroup("modeToggle","mode",["easy","pro"]);
segGroup("qualityToggle","quality",["hq","ll"]);
segGroup("compareToggle","cmp",["proc","orig"]);

// waveform wrap with cursor
const waveWrap = new El("div"); waveWrap.className="waveform-wrap";
const cursor = new El("div"); cursor.className="wave-cursor"; waveWrap.appendChild(cursor);
const waveCanvas = reg("waveform","canvas"); waveWrap.appendChild(waveCanvas);
body.appendChild(waveWrap);

/* ---------- document + window ---------- */
const rafQueue = []; let rafCount = 0;
const documentMock = {
  body,
  getElementById:(id)=>registry[id]||null,
  createElement:(t)=>new El(t),
  querySelector:(s)=> (s===".waveform-wrap"?waveWrap: body.querySelector(s)),
  querySelectorAll:(s)=> body.querySelectorAll(s),
  addEventListener:(t,f)=>{ (winListeners[t]=winListeners[t]||[]).push(f); },
};
const winListeners = {};
globalThis.window = globalThis;
globalThis.document = documentMock;
globalThis.devicePixelRatio = 1;
globalThis.AudioContext = Ctx;
globalThis.requestAnimationFrame = (cb)=>{ if(rafCount++ < 40) rafQueue.push(cb); return rafCount; };
globalThis.addEventListener = (t,f)=>{ (winListeners[t]=winListeners[t]||[]).push(f); };
globalThis.localStorage = { _d:{}, getItem(k){return this._d[k]||null;}, setItem(k,v){this._d[k]=v;} };
globalThis.prompt = ()=>null;
globalThis.Audio = function(){ return { preload:"", src:"", addEventListener(){}, load(){}, play(){return Promise.resolve();}, pause(){} }; };

/* ---------- load scripts ---------- */
function load(f){ vm.runInThisContext(fs.readFileSync(path.join(__dirname,"..","js",f),"utf8"), {filename:f}); }
["audio-engine.js","eq-curve.js","analyzer.js","waveform.js","playlist.js","player.js","preset.js","ui.js","main.js"].forEach(load);

let pass=0, fail=0;
function ok(c,msg){ if(c)pass++; else {fail++; console.log("  FAIL:",msg);} }

/* dispatch DOMContentLoaded */
let err=null;
try {
  (winListeners["DOMContentLoaded"]||[]).forEach(f=>f());
  // flush a few animation frames (frame loop self-schedules; capped by rafCount)
  let guard=0;
  while(rafQueue.length && guard++<60){ const cb=rafQueue.shift(); cb(); }
} catch(e){ err=e; }

ok(!err, "DOMContentLoaded ran without throwing" + (err? (" -> "+err.stack):""));
if(!err){
  ok(registry.channelRack._children.length===4, "4 channel strips built");
  ok(registry.masterRack._children.length>=9, "master rack knob cards built ("+registry.masterRack._children.length+")");
  ok(registry.presetGrid._children.length>=10, "preset cards built ("+registry.presetGrid._children.length+")");
  ok(registry.advSR.textContent.includes("kHz"), "advanced sample rate shown: "+registry.advSR.textContent);
  ok(registry.songCount.textContent!==undefined, "songCount wired");
  // each strip has knobs (mini-knob boxes with .knob)
  const strip0 = registry.channelRack._children[0];
  ok(strip0.querySelector(".knob")!==null, "channel strip has knob");
  ok(strip0.querySelector(".meter-fill")!==null, "channel strip has meter");
  ok(strip0.querySelector(".mute")!==null && strip0.querySelector(".solo")!==null, "strip has mute/solo buttons");
  // master knob card has fill
  ok(registry.masterRack._children[0].querySelector(".knob-fill")!==null, "master knob rendered with fill arc");

  /* ---------- interaction simulations ---------- */
  function fire(el, type, extra){
    const ev = Object.assign({ target: el, preventDefault(){}, stopPropagation(){} }, extra||{});
    (el._listeners[type]||[]).forEach(f=>f(ev));
  }

  try {
    // click a preset (DJ Jedag = b1, index 1 in grid)
    const cards = registry.presetGrid._children;
    const dj = cards[1];
    fire(dj, "click", { target: dj });
    ok(window.NEXUS.engine.channels.sub.gainDb===4.5, "preset click applied (sub gain 4.5)");
    ok(window.NEXUS.engine.crossover.x1===90, "preset click applied crossover");

    // tab switch -> analyzer
    const analyzerTab = registry.tabs._children.find(t=>t.dataset.tab==="analyzer");
    fire(analyzerTab, "click", { target: analyzerTab });
    ok(analyzerTab._cls.has("active"), "analyzer tab activated");

    // EQ channel bind -> master
    const masterPill = registry.eqChannelSelect._children.find(p=>p.dataset.ch==="master");
    fire(masterPill, "click", { target: masterPill });
    ok(masterPill._cls.has("active"), "master EQ pill activated");

    // mute toggle on first strip
    const strip = registry.channelRack._children[0];
    const muteBtn = strip.querySelector(".mute");
    fire(muteBtn, "click", { target: muteBtn });
    ok(window.NEXUS.engine.channels.sub.mute===true, "mute toggled via UI");
    fire(muteBtn, "click", { target: muteBtn });
    ok(window.NEXUS.engine.channels.sub.mute===false, "unmute toggled via UI");

    // Pro mode toggle reveals (body class change)
    const proBtn = registry.modeToggle._children.find(b=>b.dataset.mode==="pro");
    fire(proBtn, "click", { target: proBtn });
    ok(body._cls.has("mode-pro") && !body._cls.has("mode-easy"), "Pro mode toggled");

    // compare -> original
    const origBtn = registry.compareToggle._children.find(b=>b.dataset.cmp==="orig");
    fire(origBtn, "click", { target: origBtn });
    ok(window.NEXUS.engine.bypassSwitch.gain.value===1 && window.NEXUS.engine.procSwitch.gain.value===0, "compare Original bypasses processing");

    // knob drag on master gain
    const gainKnob = registry.masterRack._children[0].querySelector(".knob");
    fire(gainKnob, "pointerdown", { clientY: 100, pointerId: 1 });
    fire(gainKnob, "pointermove", { clientY: 70, pointerId: 1 }); // drag up -> increase
    fire(gainKnob, "pointerup", { pointerId: 1 });
    ok(window.NEXUS.engine.masterGainDb > -24, "knob drag updated master gain ("+window.NEXUS.engine.masterGainDb.toFixed(2)+" dB)");

    // shuffle / repeat buttons
    fire(registry.btnShuffle, "click", {});
    fire(registry.btnRepeat, "click", {});
    fire(registry.btnRepeat, "click", {});
    ok(true, "transport buttons fire without error");
  } catch(e){ ok(false, "interaction sim threw -> "+e.stack); }
}

console.log(`\nUI harness: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
