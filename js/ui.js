/* ============================================================
   ui.js — UI components & wiring
   - createKnob : SVG rotary knob (drag / wheel / dblclick reset)
   - UI         : channel strips, master rack, preset grid, tabs,
                  Easy/Pro, compare, quality, EQ binding, meters
   ============================================================ */

(function () {
  "use strict";

  const C = 2 * Math.PI * 40;
  const ARC = 0.75 * C;

  function createKnob(opt) {
    const min = opt.min, max = opt.max;
    const def = opt.default != null ? opt.default : (opt.value != null ? opt.value : min);
    let val = opt.value != null ? opt.value : def;
    const color = opt.color || "#22D3EE";

    const wrap = document.createElement("div");
    wrap.className = "knob";
    wrap.style.setProperty("--knob-c", color);
    wrap.innerHTML =
      '<svg viewBox="0 0 100 100">' +
        '<g transform="rotate(135 50 50)">' +
          '<circle class="knob-track" cx="50" cy="50" r="40" stroke-dasharray="' + ARC + ' ' + C + '"></circle>' +
          '<circle class="knob-fill" cx="50" cy="50" r="40" stroke-dasharray="0 ' + C + '"></circle>' +
        '</g>' +
        '<circle class="knob-cap" cx="50" cy="50" r="24"></circle>' +
        '<line class="knob-ind" x1="50" y1="50" x2="50" y2="18"></line>' +
      '</svg>';

    const fill = wrap.querySelector(".knob-fill");
    const ind = wrap.querySelector(".knob-ind");

    function frac() { return Math.max(0, Math.min(1, (val - min) / (max - min))); }
    function paint() {
      const f = frac();
      fill.setAttribute("stroke-dasharray", (ARC * f) + " " + C);
      ind.setAttribute("transform", "rotate(" + (-135 + f * 270) + " 50 50)");
    }
    function set(v, emit) {
      val = Math.max(min, Math.min(max, v));
      if (opt.step) val = Math.round(val / opt.step) * opt.step;
      paint();
      if (opt.onDisplay) opt.onDisplay(val);
      if (emit && opt.onInput) opt.onInput(val);
    }

    let drag = null;
    wrap.addEventListener("pointerdown", (e) => { drag = { y: e.clientY, v: val }; try { wrap.setPointerCapture(e.pointerId); } catch (x) {} });
    wrap.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dy = drag.y - e.clientY;
      set(drag.v + (dy / 150) * (max - min), true);
    });
    wrap.addEventListener("pointerup", () => { drag = null; });
    wrap.addEventListener("dblclick", () => set(def, true));
    wrap.addEventListener("wheel", (e) => { e.preventDefault(); set(val + (e.deltaY < 0 ? 1 : -1) * (max - min) * 0.03, true); }, { passive: false });

    paint();
    if (opt.onDisplay) opt.onDisplay(val);
    return { el: wrap, set: (v) => set(v, false), get: () => val };
  }
  window.createKnob = createKnob;

  // ---------- formatters ----------
  const fmt = {
    db: (v) => (v > 0 ? "+" : "") + v.toFixed(1) + " dB",
    db0: (v) => (v > 0 ? "+" : "") + v.toFixed(0) + " dB",
    ratio: (v) => v.toFixed(1) + ":1",
    pct: (v) => v.toFixed(0) + "%",
    ms: (v) => v.toFixed(1) + " ms",
    x: (v) => v.toFixed(2) + "x",
    hz: (v) => v >= 1000 ? (v / 1000).toFixed(2) + " kHz" : v.toFixed(0) + " Hz",
  };

  class UI {
    constructor(opts) {
      this.engine = opts.engine;
      this.presets = opts.presets;
      this.eqEditor = opts.eqEditor;
      this.analyzer = opts.analyzer;
      this.els = opts.els;

      this.chKnobs = {};
      this.chBtns = {};
      this.meters = {};
      this.masterKnobs = {};
      this.eqChannel = "sub";
      this.activeTab = "eq";
      this.mode = "easy";
    }

    init() {
      document.body.classList.add("mode-easy");
      this._buildChannelRack();
      this._buildMasterRack();
      this._buildPresetGrid();
      this._wireTabs();
      this._wireEQ();
      this._wireToggles();
      // advanced info
      const ctx = this.engine.ctx;
      this.els.advSR.textContent = (ctx.sampleRate / 1000).toFixed(1) + " kHz";
      this.els.advLat.textContent = (ctx.baseLatency ? (ctx.baseLatency * 1000).toFixed(1) + " ms" : "—");
      this.bindEQChannel("sub");
    }

    // ---------------- channel rack ----------------
    _miniKnob(label, opt, proOnly) {
      const box = document.createElement("div");
      box.className = "mini-knob" + (proOnly ? " pro-only" : "");
      const lab = document.createElement("label"); lab.textContent = label;
      const valEl = document.createElement("span"); valEl.className = "mk-val";
      opt.onDisplay = (v) => { valEl.textContent = (opt.format || ((x) => x))(v); };
      const k = createKnob(opt);
      box.appendChild(k.el); box.appendChild(lab); box.appendChild(valEl);
      return { box, knob: k };
    }

    _buildChannelRack() {
      const rack = this.els.channelRack;
      rack.innerHTML = "";
      this.engine.CHANNEL_DEFS.forEach((def) => {
        const ch = this.engine.channels[def.id];
        const strip = document.createElement("div");
        strip.className = "strip";
        strip.style.setProperty("--c", def.color);

        const head = document.createElement("div");
        head.className = "strip-head";
        head.innerHTML =
          '<div><div class="strip-title">' + def.label + '</div><div class="strip-range">' + def.range + '</div></div>' +
          '<div class="strip-btns"><button class="sb solo">S</button><button class="sb mute">M</button></div>';
        strip.appendChild(head);

        const body = document.createElement("div");
        body.className = "strip-body";
        const meter = document.createElement("div");
        meter.className = "meter";
        meter.innerHTML = '<div class="meter-fill"></div>';
        const knobs = document.createElement("div");
        knobs.className = "strip-knobs";
        body.appendChild(meter); body.appendChild(knobs);
        strip.appendChild(body);

        this.meters[def.id] = meter.querySelector(".meter-fill");

        const kGain = this._miniKnob("Gain", { min: -24, max: 12, value: 0, default: 0, color: def.color, format: fmt.db, onInput: (v) => this.engine.setChannelGain(def.id, v) });
        const kSat = this._miniKnob("Sat", { min: 0, max: 100, value: 0, default: 0, color: def.color, format: fmt.pct, onInput: (v) => this.engine.setSaturation(def.id, v) });
        const kThr = this._miniKnob("Comp", { min: -60, max: 0, value: 0, default: 0, color: def.color, format: fmt.db0, onInput: (v) => this.engine.setComp(def.id, { threshold: v }) }, true);
        const kRatio = this._miniKnob("Ratio", { min: 1, max: 20, value: 1, default: 1, color: def.color, format: fmt.ratio, onInput: (v) => this.engine.setComp(def.id, { ratio: v }) }, true);
        const kDelay = this._miniKnob("Delay", { min: 0, max: 30, value: 0, default: 0, color: def.color, format: fmt.ms, onInput: (v) => this.engine.setDelay(def.id, v) }, true);

        knobs.appendChild(kGain.box); knobs.appendChild(kSat.box);
        knobs.appendChild(kThr.box); knobs.appendChild(kRatio.box); knobs.appendChild(kDelay.box);

        const foot = document.createElement("div");
        foot.className = "strip-foot";
        foot.innerHTML =
          '<button class="phase pro-only">Phase Ø</button>' +
          '<button class="editeq">Edit EQ</button>';
        strip.appendChild(foot);

        // wire buttons
        const muteBtn = head.querySelector(".mute");
        const soloBtn = head.querySelector(".solo");
        const phaseBtn = foot.querySelector(".phase");
        const editBtn = foot.querySelector(".editeq");

        muteBtn.addEventListener("click", () => {
          ch.mute = !ch.mute; muteBtn.classList.toggle("on", ch.mute);
          this.engine.setMute(def.id, ch.mute); this._updateSoloDim();
        });
        soloBtn.addEventListener("click", () => {
          ch.solo = !ch.solo; soloBtn.classList.toggle("on", ch.solo);
          this.engine.setSolo(def.id, ch.solo); this._updateSoloDim();
        });
        phaseBtn.addEventListener("click", () => {
          ch.phaseInvert = !ch.phaseInvert; phaseBtn.classList.toggle("on", ch.phaseInvert);
          this.engine.setPhase(def.id, ch.phaseInvert);
        });
        editBtn.addEventListener("click", () => {
          this._switchTab("eq"); this.bindEQChannel(def.id);
        });

        rack.appendChild(strip);
        this.chKnobs[def.id] = { gain: kGain.knob, sat: kSat.knob, thr: kThr.knob, ratio: kRatio.knob, delay: kDelay.knob };
        this.chBtns[def.id] = { mute: muteBtn, solo: soloBtn, phase: phaseBtn, strip };
      });
    }

    _updateSoloDim() {
      const anySolo = this.engine.CHANNEL_DEFS.some((d) => this.engine.channels[d.id].solo);
      const soloed = this.engine.CHANNEL_DEFS.filter((d) => this.engine.channels[d.id].solo).map((d) => d.label);
      this.els.soloHint.textContent = anySolo ? ("SOLO: " + soloed.join(", ")) : "—";
      this.engine.CHANNEL_DEFS.forEach((d) => {
        const c = this.engine.channels[d.id];
        this.chBtns[d.id].strip.classList.toggle("dim", anySolo && !c.solo && !c.mute);
      });
    }

    // ---------------- master rack ----------------
    _masterCard(title, opt) {
      const card = document.createElement("div");
      card.className = "knob-card" + (opt.pro ? " pro-only" : "");
      const h = document.createElement("h4"); h.textContent = title;
      const valEl = document.createElement("span"); valEl.className = "knob-val";
      opt.onDisplay = (v) => { valEl.textContent = (opt.format || ((x) => x))(v); };
      const k = createKnob(opt);
      card.appendChild(h); card.appendChild(k.el); card.appendChild(valEl);
      this.els.masterRack.appendChild(card);
      return k;
    }

    _buildMasterRack() {
      this.els.masterRack.innerHTML = "";
      const g = "#34D399";
      this.masterKnobs.gain = this._masterCard("Master Gain", { min: -24, max: 12, value: 0, default: 0, color: g, format: fmt.db, onInput: (v) => this.engine.setMasterGain(v) });
      this.masterKnobs.loud = this._masterCard("Loudness", { min: -12, max: 12, value: 0, default: 0, color: g, format: fmt.db, onInput: (v) => this.engine.setLoudness(v) });
      this.masterKnobs.width = this._masterCard("Stereo Width", { min: 0, max: 2, value: 1, default: 1, color: g, format: fmt.x, onInput: (v) => this.engine.setStereoWidth(v) });
      this.masterKnobs.limiter = this._masterCard("Limiter Thr", { min: -24, max: 0, value: -1, default: -1, color: g, format: fmt.db0, onInput: (v) => this.engine.setLimiter(v) });
      this.masterKnobs.mThr = this._masterCard("Comp Thr", { min: -60, max: 0, value: 0, default: 0, color: g, format: fmt.db0, pro: true, onInput: (v) => this.engine.setComp("master", { threshold: v }) });
      this.masterKnobs.mRatio = this._masterCard("Comp Ratio", { min: 1, max: 20, value: 1, default: 1, color: g, format: fmt.ratio, pro: true, onInput: (v) => this.engine.setComp("master", { ratio: v }) });
      // crossover
      this.masterKnobs.x1 = this._masterCard("X-over SUB|LOW", { min: 40, max: 160, value: 80, default: 80, color: "#7C5CFF", format: fmt.hz, pro: true, onInput: (v) => { this.engine.setCrossover({ x1: v }); this.els.advX1.textContent = Math.round(v); } });
      this.masterKnobs.x2 = this._masterCard("X-over LOW|MID", { min: 160, max: 600, value: 250, default: 250, color: "#22D3EE", format: fmt.hz, pro: true, onInput: (v) => { this.engine.setCrossover({ x2: v }); this.els.advX2.textContent = Math.round(v); } });
      this.masterKnobs.x3 = this._masterCard("X-over MID|HIGH", { min: 1500, max: 8000, value: 4000, default: 4000, color: "#FF8A3D", format: fmt.hz, pro: true, onInput: (v) => { this.engine.setCrossover({ x3: v }); this.els.advX3.textContent = Math.round(v); } });
    }

    // ---------------- preset grid ----------------
    _buildPresetGrid() {
      const grid = this.els.presetGrid;
      grid.innerHTML = "";
      this.presets.all().forEach((p) => {
        const card = document.createElement("div");
        card.className = "preset-card" + (p.builtin ? "" : " user") + (p.id === this.presets.activeId ? " active" : "");
        card.style.setProperty("--pc", this._a(p.color, 0.15));
        card.innerHTML =
          '<h4>' + this._esc(p.name) + '</h4>' +
          '<p>' + this._esc(p.desc || "") + '</p>' +
          '<span class="pc-tag">' + this._esc(p.tag || "") + '</span>' +
          (p.builtin ? "" : '<button class="pc-del" title="Hapus">&times;</button>');
        card.addEventListener("click", (e) => {
          if (e.target.closest(".pc-del")) { this.presets.remove(p.id); return; }
          this.presets.apply(p.id);
          this.toast("Preset: " + p.name, "ok");
        });
        grid.appendChild(card);
      });
    }

    // ---------------- tabs ----------------
    _wireTabs() {
      this.els.tabs.querySelectorAll(".tab").forEach((t) => {
        t.addEventListener("click", () => this._switchTab(t.dataset.tab));
      });
    }
    _switchTab(name) {
      this.activeTab = name;
      this.els.tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
      if (name === "eq") this.eqEditor.resize();
      if (name === "analyzer") this.analyzer.resize();
    }

    // ---------------- EQ ----------------
    _wireEQ() {
      this.els.eqChannelSelect.querySelectorAll(".ch-pill").forEach((pill) => {
        pill.addEventListener("click", () => this.bindEQChannel(pill.dataset.ch));
      });
      this.els.eqFilterType.addEventListener("change", () => { this.eqEditor.newType = this.els.eqFilterType.value; });
      this.els.eqResetBtn.addEventListener("click", () => {
        const eq = this._currentEQ();
        eq.clear(); this.eqEditor.selected = null; this._updateReadout(null);
      });
      this.eqEditor.onSelect = (b) => this._updateReadout(b);
      this.eqEditor.onChange = (b) => this._updateReadout(b);
    }

    _currentEQ() {
      return this.eqChannel === "master" ? this.engine.masterEQ : this.engine.channels[this.eqChannel].eq;
    }

    bindEQChannel(name) {
      this.eqChannel = name;
      this.els.eqChannelSelect.querySelectorAll(".ch-pill").forEach((p) => p.classList.toggle("active", p.dataset.ch === name));
      let eq, analyser, color;
      if (name === "master") { eq = this.engine.masterEQ; analyser = this.engine.outAnalyser; color = "#34D399"; }
      else { const c = this.engine.channels[name]; eq = c.eq; analyser = c.analyser; color = c.color; }
      this.eqEditor.newType = this.els.eqFilterType.value;
      this.eqEditor.bind(eq, analyser, color);
      this._updateReadout(null);
    }

    _updateReadout(b) {
      if (!b) { this.els.roSel.textContent = "–"; this.els.roFreq.textContent = "–"; this.els.roGain.textContent = "–"; this.els.roQ.textContent = "–"; return; }
      this.els.roSel.textContent = b.type;
      this.els.roFreq.textContent = fmt.hz(b.freq);
      this.els.roGain.textContent = ["peaking", "lowshelf", "highshelf"].includes(b.type) ? fmt.db(b.gain) : "—";
      this.els.roQ.textContent = b.q.toFixed(2);
    }

    // ---------------- toggles ----------------
    _wireToggles() {
      // Easy / Pro
      this.els.modeToggle.querySelectorAll(".seg-btn").forEach((b) => {
        b.addEventListener("click", () => {
          this.mode = b.dataset.mode;
          this.els.modeToggle.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
          document.body.classList.toggle("mode-easy", this.mode === "easy");
          document.body.classList.toggle("mode-pro", this.mode === "pro");
        });
      });
      // quality
      this.els.qualityToggle.querySelectorAll(".seg-btn").forEach((b) => {
        b.addEventListener("click", () => {
          this.els.qualityToggle.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
          this.engine.setQuality(b.dataset.quality);
          this.els.advBuf.textContent = b.dataset.quality === "ll" ? "Low Latency" : "High Quality";
          this.toast(b.dataset.quality === "ll" ? "Mode Low Latency aktif untuk lagu berikutnya" : "Mode High Quality aktif");
        });
      });
      // compare
      this.els.compareToggle.querySelectorAll(".seg-btn").forEach((b) => {
        b.addEventListener("click", () => {
          this.els.compareToggle.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
          this.engine.setCompare(b.dataset.cmp);
        });
      });
    }

    // ---------------- meters ----------------
    updateMeters() {
      this.engine.CHANNEL_DEFS.forEach((d) => {
        const lin = this.engine.channelLevel(d.id);
        const db = 20 * Math.log10(Math.max(1e-4, lin));
        const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        const el = this.meters[d.id];
        if (el) el.style.height = pct + "%";
      });
    }

    // ---------------- sync after preset ----------------
    syncFromEngine() {
      const s = this.engine.getState();
      this.engine.CHANNEL_DEFS.forEach((d) => {
        const cs = s.channels[d.id]; const k = this.chKnobs[d.id]; const btn = this.chBtns[d.id];
        k.gain.set(cs.gainDb); k.sat.set(cs.satAmount);
        k.thr.set(cs.comp.threshold); k.ratio.set(cs.comp.ratio); k.delay.set(cs.delayMs);
        btn.mute.classList.toggle("on", cs.mute);
        btn.solo.classList.toggle("on", cs.solo);
        btn.phase.classList.toggle("on", cs.phaseInvert);
      });
      const m = s.master;
      this.masterKnobs.gain.set(m.gainDb); this.masterKnobs.loud.set(m.loudnessDb);
      this.masterKnobs.width.set(m.width); this.masterKnobs.limiter.set(m.limiterThreshold);
      this.masterKnobs.mThr.set(m.comp.threshold); this.masterKnobs.mRatio.set(m.comp.ratio);
      this.masterKnobs.x1.set(s.crossover.x1); this.masterKnobs.x2.set(s.crossover.x2); this.masterKnobs.x3.set(s.crossover.x3);
      this.els.advX1.textContent = Math.round(s.crossover.x1);
      this.els.advX2.textContent = Math.round(s.crossover.x2);
      this.els.advX3.textContent = Math.round(s.crossover.x3);
      this._updateSoloDim();
      this._buildPresetGrid();
    }

    // ---------------- toast ----------------
    toast(msg, type) {
      let wrap = document.querySelector(".toast-wrap");
      if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; document.body.appendChild(wrap); }
      const t = document.createElement("div");
      t.className = "toast " + (type || "");
      t.textContent = msg;
      wrap.appendChild(t);
      setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 1800);
    }

    _a(hex, a) { const h = hex.replace("#", ""); return "rgba(" + parseInt(h.substr(0,2),16) + "," + parseInt(h.substr(2,2),16) + "," + parseInt(h.substr(4,2),16) + "," + a + ")"; }
    _esc(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }
  }

  window.UI = UI;
})();
