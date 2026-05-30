/* Node smoke test for DSP core (mocked Web Audio API). */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- mock Web Audio ----
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

// ---- globals ----
globalThis.window = globalThis;
globalThis.AudioContext = Ctx;
globalThis.localStorage = { _d:{}, getItem(k){return this._d[k]||null;}, setItem(k,v){this._d[k]=v;} };

function load(f){ vm.runInThisContext(fs.readFileSync(path.join(__dirname,"..","js",f),"utf8"), {filename:f}); }
load("eq-curve.js"); load("audio-engine.js"); load("preset.js");

let pass=0, fail=0;
function ok(c,msg){ if(c){pass++;} else {fail++; console.log("  FAIL:",msg);} }

// ---- engine ----
const engine = new window.AudioEngine({});
engine.init();
ok(Object.keys(engine.channels).length===4, "4 channels built");
ok(!!engine.masterEQ && !!engine.outAnalyser, "master + outAnalyser built");
ok(engine.channels.sub.xfilters.length===2, "SUB crossover = 2 filters (LR4)");
ok(engine.channels.low.xfilters.length===4, "LOW crossover = 4 filters");
ok(engine.channels.high.xfilters.length===2, "HIGH crossover = 2 filters");

// EQ add/remove/response
const eq = engine.channels.sub.eq;
const b = eq.addBand({type:"peaking",freq:60,gain:5,q:1.2});
ok(eq.bands.length===1, "EQ addBand");
const fa = new Float32Array(64), da = new Float32Array(64);
for(let i=0;i<64;i++) fa[i]=20*Math.pow(1000,i/63);
eq.getResponse(fa, da);
ok(da.length===64 && isFinite(da[0]), "EQ getResponse runs");
eq.removeBand(b.id);
ok(eq.bands.length===0, "EQ removeBand");

// gain / mute / solo
engine.setChannelGain("low", -6);
ok(engine.channels.low.gainDb===-6, "setChannelGain mirror");
engine.setMute("low", true);
ok(engine.channels.low.gain.gain.value===0, "mute -> gain 0");
engine.setMute("low", false);
engine.setSolo("sub", true);
ok(engine.channels.mid.gain.gain.value===0 && engine.channels.sub.gain.gain.value>0, "solo isolates");
engine.setSolo("sub", false);

// crossover
engine.setCrossover({x1:90,x2:300,x3:5000});
ok(engine.channels.sub.xfilters[0].frequency.value===90, "crossover x1 applied");
ok(engine.channels.mid.xfilters[2].frequency.value===5000, "crossover x3 applied to mid lowpass");

// comp mirror
engine.setComp("sub",{threshold:-18,ratio:4});
ok(engine.channels.sub.compState.threshold===-18 && engine.channels.sub.compState.ratio===4, "comp mirror stored");

// master setters
engine.setMasterGain(-3); engine.setStereoWidth(1.2); engine.setLimiter(-2); engine.setLoudness(2);
ok(engine.masterGainDb===-3 && engine.widthVal===1.2 && engine.limiterThr===-2 && engine.loudnessDb===2, "master mirrors stored");

// saturation
engine.setSaturation("sub", 50);
ok(engine.channels.sub.sat.curve && engine.channels.sub.sat.curve.length>0, "saturation curve built");
engine.setSaturation("sub", 0);
ok(engine.channels.sub.sat.curve===null, "saturation 0 -> bypass (null curve)");

// ---- state round trip ----
engine.setChannelGain("high", 3);
engine.channels.high.eq.addBand({type:"highshelf",freq:9000,gain:4,q:0.7});
const st = engine.getState();
ok(st.channels.high.gainDb===3, "getState channel gain");
ok(st.channels.high.eq.length===1, "getState channel eq bands");
ok(st.master.gainDb===-3, "getState master gain mirror");

// reset then restore
engine.setChannelGain("high", 0);
engine.channels.high.eq.clear();
engine.setState(st);
ok(engine.channels.high.gainDb===3, "setState restores channel gain");
ok(engine.channels.high.eq.bands.length===1, "setState restores channel eq");

// ---- presets ----
const presets = new window.Presets(engine);
ok(presets.builtin.length>=10, "10+ builtin presets");
presets.builtin.forEach(p=>{
  try { engine.setState(p.state); } catch(e){ ok(false, "apply preset "+p.name+": "+e.message); }
});
engine.setState(presets.find("b1").state); // DJ Jedag
ok(engine.channels.sub.gainDb===4.5, "DJ Jedag sub gain applied");
ok(engine.crossover.x1===90, "DJ Jedag crossover applied");

// save user preset
const up = presets.saveCurrent("Test");
ok(presets.user.length===1 && up.state.channels.sub.gainDb===4.5, "saveCurrent captures live state");

console.log(`\nDSP harness: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
