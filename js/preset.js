/* ============================================================
   preset.js — built-in + user presets (save/load/export/import)
   ============================================================ */

(function () {
  "use strict";

  const LS_KEY = "nexusdsp_user_presets_v1";

  function flat() {
    const ch = {};
    ["sub", "low", "mid", "high"].forEach((id) => {
      ch[id] = { gainDb: 0, mute: false, solo: false, phaseInvert: false, delayMs: 0, satAmount: 0, comp: { threshold: 0, ratio: 1 }, eq: [] };
    });
    return {
      crossover: { x1: 80, x2: 250, x3: 4000 },
      channels: ch,
      master: { gainDb: 0, loudnessDb: 0, width: 1, limiterThreshold: -1, comp: { threshold: 0, ratio: 1 }, eq: [] },
    };
  }

  // deep-ish merge of a partial preset onto a flat base
  function build(partial) {
    const base = flat();
    if (partial.crossover) Object.assign(base.crossover, partial.crossover);
    if (partial.channels) {
      Object.keys(partial.channels).forEach((id) => {
        const p = partial.channels[id];
        Object.assign(base.channels[id], p);
        if (p.comp) base.channels[id].comp = Object.assign({ threshold: 0, ratio: 1 }, p.comp);
        if (p.eq) base.channels[id].eq = p.eq;
      });
    }
    if (partial.master) {
      Object.assign(base.master, partial.master);
      if (partial.master.comp) base.master.comp = Object.assign({ threshold: 0, ratio: 1 }, partial.master.comp);
      if (partial.master.eq) base.master.eq = partial.master.eq;
    }
    return base;
  }

  const BUILTIN = [
    { name: "Studio Clean", color: "#34D399", tag: "flat", desc: "Netral, tanpa pewarnaan", state: flat() },
    { name: "DJ Jedag", color: "#7C5CFF", tag: "party", desc: "Bass nendang, attack cepat", state: build({
      crossover: { x1: 90 },
      channels: {
        sub: { gainDb: 4.5, satAmount: 20, comp: { threshold: -16, ratio: 4 }, eq: [{ type: "peaking", freq: 55, gain: 5, q: 1.2 }] },
        low: { gainDb: -1, eq: [{ type: "peaking", freq: 180, gain: -3, q: 1 }] },
        mid: { gainDb: 0, eq: [{ type: "peaking", freq: 2500, gain: 2, q: 1 }] },
        high: { gainDb: 2, eq: [{ type: "highshelf", freq: 9000, gain: 3, q: 0.7 }] },
      },
      master: { loudnessDb: 2, width: 1.15, comp: { threshold: -12, ratio: 3 } },
    }) },
    { name: "Hajatan", color: "#FF8A3D", tag: "outdoor", desc: "Lantang, vokal maju, bass tebal", state: build({
      channels: {
        sub: { gainDb: 3, satAmount: 12, eq: [{ type: "peaking", freq: 60, gain: 3, q: 1 }] },
        low: { gainDb: 1.5 },
        mid: { gainDb: 2.5, eq: [{ type: "peaking", freq: 3000, gain: 3, q: 1.1 }] },
        high: { gainDb: 1.5 },
      },
      master: { loudnessDb: 3, width: 1.1, comp: { threshold: -14, ratio: 3.5 } },
    }) },
    { name: "Indoor", color: "#22D3EE", tag: "room", desc: "Halus untuk ruangan kecil", state: build({
      channels: {
        sub: { gainDb: -2, eq: [{ type: "peaking", freq: 70, gain: -2, q: 1 }] },
        low: { gainDb: -1.5, eq: [{ type: "peaking", freq: 200, gain: -3, q: 1.2 }] },
        mid: { gainDb: 0.5 },
        high: { gainDb: 0.5 },
      },
      master: { width: 1.0, comp: { threshold: -18, ratio: 2 } },
    }) },
    { name: "Outdoor", color: "#FFD34E", tag: "open", desc: "Proyeksi jauh, sub kuat", state: build({
      channels: {
        sub: { gainDb: 4, satAmount: 10, eq: [{ type: "peaking", freq: 50, gain: 4, q: 1 }] },
        low: { gainDb: 1 },
        mid: { gainDb: 2, eq: [{ type: "peaking", freq: 3500, gain: 2.5, q: 1 }] },
        high: { gainDb: 3, eq: [{ type: "highshelf", freq: 8000, gain: 4, q: 0.7 }] },
      },
      master: { loudnessDb: 2.5, width: 1.2, comp: { threshold: -12, ratio: 4 } },
    }) },
    { name: "Bass Kendor", color: "#7C5CFF", tag: "loose", desc: "Bass empuk & longgar", state: build({
      crossover: { x1: 70 },
      channels: {
        sub: { gainDb: 3, eq: [{ type: "peaking", freq: 45, gain: 4, q: 0.8 }], comp: { threshold: -24, ratio: 2 } },
        low: { gainDb: 2, eq: [{ type: "peaking", freq: 120, gain: 2, q: 0.7 }] },
        mid: { gainDb: 0 }, high: { gainDb: 0.5 },
      },
      master: { width: 1.05 },
    }) },
    { name: "Bass Tight", color: "#7C5CFF", tag: "tight", desc: "Bass rapat & cepat", state: build({
      crossover: { x1: 95 },
      channels: {
        sub: { gainDb: 2, satAmount: 16, comp: { threshold: -14, ratio: 6 }, eq: [{ type: "peaking", freq: 65, gain: 3, q: 1.6 }, { type: "highpass", freq: 28, gain: 0, q: 0.7 }] },
        low: { gainDb: -1, eq: [{ type: "peaking", freq: 160, gain: -2, q: 1.2 }] },
        mid: { gainDb: 0 }, high: { gainDb: 1 },
      },
      master: { comp: { threshold: -12, ratio: 4 } },
    }) },
    { name: "Smooth High", color: "#FFD34E", tag: "soft", desc: "Treble lembut tidak nusuk", state: build({
      channels: {
        sub: { gainDb: 0 }, low: { gainDb: 0 },
        mid: { gainDb: 0 },
        high: { gainDb: -1.5, eq: [{ type: "peaking", freq: 6500, gain: -3, q: 1.4 }, { type: "highshelf", freq: 12000, gain: -2, q: 0.7 }] },
      },
    }) },
    { name: "Vocal Jernih", color: "#FF8A3D", tag: "vocal", desc: "Vokal jelas & maju", state: build({
      channels: {
        sub: { gainDb: -1 },
        low: { gainDb: -2, eq: [{ type: "peaking", freq: 250, gain: -3, q: 1.2 }] },
        mid: { gainDb: 2.5, eq: [{ type: "peaking", freq: 1800, gain: 2, q: 1 }, { type: "peaking", freq: 3500, gain: 3, q: 1.2 }] },
        high: { gainDb: 1.5, eq: [{ type: "highshelf", freq: 10000, gain: 2, q: 0.7 }] },
      },
      master: { comp: { threshold: -16, ratio: 2.5 } },
    }) },
    { name: "Night Mode", color: "#34D399", tag: "quiet", desc: "Pelan, sub & high diredam", state: build({
      channels: {
        sub: { gainDb: -4, eq: [{ type: "peaking", freq: 60, gain: -4, q: 1 }] },
        low: { gainDb: -1 }, mid: { gainDb: 1 },
        high: { gainDb: -3, eq: [{ type: "highshelf", freq: 9000, gain: -3, q: 0.7 }] },
      },
      master: { loudnessDb: -2, comp: { threshold: -22, ratio: 3 } },
    }) },
  ];

  class Presets {
    constructor(engine) {
      this.engine = engine;
      this.builtin = BUILTIN.map((p, i) => ({ id: "b" + i, builtin: true, ...p }));
      this.user = this._load();
      this.activeId = "b0";
      this.onChange = null; // () => {} after apply or list change
    }

    _load() {
      try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch (e) { return []; }
    }
    _save() { try { localStorage.setItem(LS_KEY, JSON.stringify(this.user)); } catch (e) {} }

    all() { return this.builtin.concat(this.user); }
    find(id) { return this.all().find((p) => p.id === id); }

    apply(id) {
      const p = this.find(id);
      if (!p) return;
      this.engine.setState(p.state);
      this.activeId = id;
      if (this.onChange) this.onChange();
    }

    saveCurrent(name) {
      const p = { id: "u" + Date.now(), builtin: false, name: name || ("Preset " + (this.user.length + 1)), color: "#22D3EE", tag: "custom", desc: "Preset buatan kamu", state: this.engine.getState() };
      this.user.push(p);
      this._save();
      this.activeId = p.id;
      if (this.onChange) this.onChange();
      return p;
    }

    remove(id) {
      const i = this.user.findIndex((p) => p.id === id);
      if (i < 0) return;
      this.user.splice(i, 1);
      this._save();
      if (this.activeId === id) this.activeId = null;
      if (this.onChange) this.onChange();
    }

    exportActive() {
      const p = this.find(this.activeId) || { name: "preset", state: this.engine.getState() };
      const blob = new Blob([JSON.stringify({ name: p.name, state: p.state }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (p.name || "preset").replace(/\s+/g, "_") + ".nexusdsp.json";
      a.click();
      URL.revokeObjectURL(a.href);
    }

    importFile(file) {
      return file.text().then((txt) => {
        const data = JSON.parse(txt);
        if (!data.state) throw new Error("invalid");
        const p = { id: "u" + Date.now(), builtin: false, name: data.name || "Imported", color: "#22D3EE", tag: "import", desc: "Preset di-import", state: data.state };
        this.user.push(p);
        this._save();
        this.activeId = p.id;
        if (this.onChange) this.onChange();
        return p;
      });
    }
  }

  window.Presets = Presets;
})();
