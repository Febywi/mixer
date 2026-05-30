/* ============================================================
   eq-curve.js
   - EQ        : DSP class managing a chain of BiquadFilterNodes
   - EQEditor  : FabFilter-style interactive canvas (draggable nodes
                 + realtime spectrum behind the curve)
   ============================================================ */

(function () {
  "use strict";

  let _uid = 1;
  const FMIN = 20, FMAX = 20000;
  const DB_RANGE = 18; // +/- dB shown

  const GAIN_TYPES = ["peaking", "lowshelf", "highshelf"];

  // ---------------- EQ (DSP) ----------------
  class EQ {
    constructor(ctx) {
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.output = ctx.createGain();
      this.bands = [];
      this._rebuild();
    }
    _rebuild() {
      try { this.input.disconnect(); } catch (e) {}
      this.bands.forEach((b) => { try { b.filter.disconnect(); } catch (e) {} });
      if (!this.bands.length) { this.input.connect(this.output); return; }
      let node = this.input;
      this.bands.forEach((b) => { node.connect(b.filter); node = b.filter; });
      node.connect(this.output);
    }
    _makeFilter(b) {
      const f = this.ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      f.Q.value = b.q;
      f.gain.value = GAIN_TYPES.includes(b.type) ? b.gain : 0;
      return f;
    }
    addBand(opts) {
      const b = {
        id: _uid++,
        type: opts.type || "peaking",
        freq: opts.freq || 1000,
        gain: opts.gain != null ? opts.gain : 0,
        q: opts.q != null ? opts.q : 1,
      };
      b.filter = this._makeFilter(b);
      this.bands.push(b);
      this._rebuild();
      return b;
    }
    removeBand(id) {
      const i = this.bands.findIndex((b) => b.id === id);
      if (i < 0) return;
      try { this.bands[i].filter.disconnect(); } catch (e) {}
      this.bands.splice(i, 1);
      this._rebuild();
    }
    updateBand(id, p) {
      const b = this.bands.find((x) => x.id === id);
      if (!b) return;
      const t = this.ctx.currentTime;
      if (p.type && p.type !== b.type) { b.type = p.type; b.filter.type = p.type; }
      if (p.freq != null) { b.freq = p.freq; b.filter.frequency.setTargetAtTime(p.freq, t, 0.01); }
      if (p.q != null) { b.q = p.q; b.filter.Q.setTargetAtTime(p.q, t, 0.01); }
      if (p.gain != null) {
        b.gain = p.gain;
        b.filter.gain.setTargetAtTime(GAIN_TYPES.includes(b.type) ? p.gain : 0, t, 0.01);
      }
    }
    clear() {
      this.bands.forEach((b) => { try { b.filter.disconnect(); } catch (e) {} });
      this.bands = [];
      this._rebuild();
    }
    getBands() { return this.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })); }
    setBands(arr) { this.clear(); (arr || []).forEach((b) => this.addBand(b)); }

    // combined magnitude response in dB for given frequency array
    getResponse(freqArr, outDb) {
      const n = freqArr.length;
      const mag = new Float32Array(n);
      const phase = new Float32Array(n);
      for (let i = 0; i < n; i++) outDb[i] = 0;
      this.bands.forEach((b) => {
        b.filter.getFrequencyResponse(freqArr, mag, phase);
        for (let i = 0; i < n; i++) outDb[i] += 20 * Math.log10(Math.max(1e-6, mag[i]));
      });
    }
  }

  // ---------------- EQEditor (canvas UI) ----------------
  class EQEditor {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx2d = canvas.getContext("2d");
      this.eq = null;
      this.analyser = null;
      this.accent = "#22D3EE";
      this.newType = "peaking";
      this.selected = null;       // band id
      this.dragging = null;
      this.onChange = null;       // (band) => {}
      this.onSelect = null;       // (band|null) => {}

      this._freqArr = null;
      this._dbArr = null;
      this._specBuf = null;

      this._bind();
      this.resize();
    }

    bind(eq, analyser, accent) {
      this.eq = eq; this.analyser = analyser; this.accent = accent || this.accent;
      if (analyser) this._specBuf = new Uint8Array(analyser.frequencyBinCount);
      this.selected = null;
      if (this.onSelect) this.onSelect(null);
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.W = Math.max(10, r.width); this.H = Math.max(10, r.height);
      this.canvas.width = this.W * dpr; this.canvas.height = this.H * dpr;
      this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      // sample frequencies along width (log)
      const n = Math.min(512, Math.max(128, Math.floor(this.W)));
      this._freqArr = new Float32Array(n);
      this._dbArr = new Float32Array(n);
      for (let i = 0; i < n; i++) this._freqArr[i] = this._xToFreqNorm(i / (n - 1));
    }

    // mapping helpers
    _freqToX(f) { return (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * this.W; }
    _xToFreq(x) { return this._xToFreqNorm(x / this.W); }
    _xToFreqNorm(t) { return FMIN * Math.pow(FMAX / FMIN, t); }
    _gainToY(g) { return this.H / 2 - (g / DB_RANGE) * (this.H / 2 - 14); }
    _yToGain(y) { return -((y - this.H / 2) / (this.H / 2 - 14)) * DB_RANGE; }

    _bind() {
      const c = this.canvas;
      c.addEventListener("pointerdown", (e) => this._onDown(e));
      window.addEventListener("pointermove", (e) => this._onMove(e));
      window.addEventListener("pointerup", () => this._onUp());
      c.addEventListener("dblclick", (e) => this._onDbl(e));
      c.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
      c.addEventListener("contextmenu", (e) => e.preventDefault());
    }

    _pos(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    _hit(x, y) {
      if (!this.eq) return null;
      let best = null, bd = 14;
      this.eq.bands.forEach((b) => {
        const bx = this._freqToX(b.freq);
        const by = GAIN_TYPES.includes(b.type) ? this._gainToY(b.gain) : this._gainToY(0);
        const d = Math.hypot(bx - x, by - y);
        if (d < bd) { bd = d; best = b; }
      });
      return best;
    }

    _onDown(e) {
      if (!this.eq) return;
      const { x, y } = this._pos(e);
      const b = this._hit(x, y);
      if (b) {
        this.selected = b.id; this.dragging = b;
        if (this.onSelect) this.onSelect(b);
      } else {
        this.selected = null;
        if (this.onSelect) this.onSelect(null);
      }
    }
    _onMove(e) {
      if (!this.dragging) return;
      const { x, y } = this._pos(e);
      const b = this.dragging;
      const freq = Math.max(FMIN, Math.min(FMAX, this._xToFreq(x)));
      const p = { freq };
      if (GAIN_TYPES.includes(b.type)) p.gain = Math.max(-DB_RANGE, Math.min(DB_RANGE, this._yToGain(y)));
      this.eq.updateBand(b.id, p);
      if (this.onChange) this.onChange(b);
    }
    _onUp() { this.dragging = null; }

    _onDbl(e) {
      if (!this.eq) return;
      const { x, y } = this._pos(e);
      const b = this._hit(x, y);
      if (b) {
        this.eq.removeBand(b.id);
        this.selected = null;
        if (this.onSelect) this.onSelect(null);
        if (this.onChange) this.onChange(null);
      } else {
        const freq = Math.max(FMIN, Math.min(FMAX, this._xToFreq(x)));
        const gain = GAIN_TYPES.includes(this.newType) ? Math.max(-DB_RANGE, Math.min(DB_RANGE, this._yToGain(y))) : 0;
        const nb = this.eq.addBand({ type: this.newType, freq, gain, q: 1 });
        this.selected = nb.id;
        if (this.onSelect) this.onSelect(nb);
        if (this.onChange) this.onChange(nb);
      }
    }
    _onWheel(e) {
      if (!this.eq) return;
      const { x, y } = this._pos(e);
      const b = this._hit(x, y) || (this.selected && this.eq.bands.find((z) => z.id === this.selected));
      if (!b) return;
      e.preventDefault();
      const q = Math.max(0.1, Math.min(18, b.q * (e.deltaY < 0 ? 1.12 : 0.89)));
      this.eq.updateBand(b.id, { q });
      if (this.onChange) this.onChange(b);
    }

    draw() {
      const g = this.ctx2d;
      if (!g) return;
      const W = this.W, H = this.H;
      g.clearRect(0, 0, W, H);

      // bg
      g.fillStyle = "#12161c"; g.fillRect(0, 0, W, H);

      // grid (freq lines)
      g.lineWidth = 1; g.font = "9px monospace"; g.textBaseline = "bottom";
      const marks = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
      marks.forEach((f) => {
        const x = this._freqToX(f);
        g.strokeStyle = "rgba(255,255,255,0.045)"; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
        g.fillStyle = "rgba(255,255,255,0.22)";
        g.fillText(f >= 1000 ? (f / 1000) + "k" : f, x + 2, H - 2);
      });
      // dB grid
      for (let db = -DB_RANGE; db <= DB_RANGE; db += 6) {
        const y = this._gainToY(db);
        g.strokeStyle = db === 0 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.045)";
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      }

      // spectrum behind
      if (this.analyser && this._specBuf) {
        this.analyser.getByteFrequencyData(this._specBuf);
        const sr = this.analyser.context.sampleRate;
        const bins = this._specBuf.length;
        g.beginPath(); g.moveTo(0, H);
        const steps = Math.floor(W);
        for (let i = 0; i <= steps; i++) {
          const f = this._xToFreqNorm(i / steps);
          const bin = Math.min(bins - 1, Math.round((f / (sr / 2)) * bins));
          const v = this._specBuf[bin] / 255;
          const y = H - v * H * 0.96;
          g.lineTo(i, y);
        }
        g.lineTo(W, H); g.closePath();
        const grad = g.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, this._hexA(this.accent, 0.28));
        grad.addColorStop(1, this._hexA(this.accent, 0.02));
        g.fillStyle = grad; g.fill();
      }

      // EQ curve
      if (this.eq) {
        this.eq.getResponse(this._freqArr, this._dbArr);
        g.beginPath();
        for (let i = 0; i < this._freqArr.length; i++) {
          const x = (i / (this._freqArr.length - 1)) * W;
          const y = this._gainToY(Math.max(-DB_RANGE, Math.min(DB_RANGE, this._dbArr[i])));
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.strokeStyle = this.accent; g.lineWidth = 2;
        g.shadowColor = this.accent; g.shadowBlur = 8;
        g.stroke(); g.shadowBlur = 0;

        // nodes
        this.eq.bands.forEach((b) => {
          const bx = this._freqToX(b.freq);
          const by = GAIN_TYPES.includes(b.type) ? this._gainToY(b.gain) : this._gainToY(0);
          const sel = b.id === this.selected;
          g.beginPath(); g.arc(bx, by, sel ? 7 : 5, 0, Math.PI * 2);
          g.fillStyle = sel ? "#fff" : this.accent;
          g.shadowColor = this.accent; g.shadowBlur = sel ? 12 : 6;
          g.fill(); g.shadowBlur = 0;
          if (sel) { g.strokeStyle = this.accent; g.lineWidth = 2; g.beginPath(); g.arc(bx, by, 11, 0, Math.PI * 2); g.stroke(); }
        });
      }
    }

    _hexA(hex, a) {
      const h = hex.replace("#", "");
      const r = parseInt(h.substr(0, 2), 16), gg = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
      return `rgba(${r},${gg},${b},${a})`;
    }
  }

  window.EQ = EQ;
  window.EQEditor = EQEditor;
})();
