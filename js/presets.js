// ============================================================
//  presets.js — Preset persistence (localStorage) + import/export
// ============================================================

import { LS_PRESET_KEY, LS_LAST_STATE_KEY } from './constants.js';

export class PresetStore {
  constructor() {
    this.presets = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(LS_PRESET_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  _persist() {
    try {
      localStorage.setItem(LS_PRESET_KEY, JSON.stringify(this.presets));
    } catch (e) {
      console.warn('Preset save failed', e);
    }
  }

  list() {
    return Object.keys(this.presets).sort();
  }

  save(name, state) {
    if (!name) return false;
    this.presets[name] = { savedAt: Date.now(), state };
    this._persist();
    return true;
  }

  get(name) {
    return this.presets[name] ? this.presets[name].state : null;
  }

  remove(name) {
    delete this.presets[name];
    this._persist();
  }

  // ---- last-session autosave ----
  saveLast(state) {
    try {
      localStorage.setItem(LS_LAST_STATE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  loadLast() {
    try {
      const raw = localStorage.getItem(LS_LAST_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // ---- file import/export (download/upload .json) ----
  exportToFile(name, state) {
    const blob = new Blob([JSON.stringify({ name, state }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(name || 'preset').replace(/\s+/g, '_')}.dlmsmixer.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async importFromFile(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data && data.state) {
      const name = data.name || file.name.replace(/\.json$/, '');
      this.save(name, data.state);
      return { name, state: data.state };
    }
    throw new Error('Invalid preset file');
  }
}
