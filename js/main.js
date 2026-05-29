// ============================================================
//  main.js — UI wiring & real-time render loop
// ============================================================

import {
  ISO_31_BANDS, BANDS, GEQ_MIN_DB, GEQ_MAX_DB, REVERB_PRESETS,
  XOVER_RANGES, fmtFreq, clamp,
} from './constants.js';
import { MixerEngine } from './audioEngine.js';
import { SpectrumView, VuMeter } from './visualizer.js';
import { PresetStore } from './presets.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const fmtTime = (s) => {
  if (!isFinite(s)) return '∞';
  s = Math.max(0, s | 0);
  const m = (s / 60) | 0;
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
};

const engine = new MixerEngine();
const presets = new PresetStore();

let spectrum = null;
let masterVuL = null;
let masterVuR = null;
const bandMeters = {}; // id -> VuMeter
const trackEls = new Map(); // trackId -> { seek, cur, dur, ... }

// ============================================================
//  START
// ============================================================
$('#startBtn').addEventListener('click', async () => {
  engine.init();
  await engine.resume();

  $('#startOverlay').classList.add('hidden');
  $('#app').classList.remove('hidden');

  buildGeq();
  buildBands();
  wireMaster();
  wireVocal();
  wireCrossover();
  wireTransport();
  wireSources();
  wirePresets();

  spectrum = new SpectrumView($('#spectrum'), engine);
  masterVuL = new VuMeter($('#masterVuL'));
  masterVuR = new VuMeter($('#masterVuR'));

  $('#ctxInfo').textContent =
    `${(engine.ctx.sampleRate / 1000).toFixed(1)} kHz · ${engine.ctx.baseLatency ? (engine.ctx.baseLatency * 1000).toFixed(1) + ' ms' : 'low'} latency`;

  // restore last session
  const last = presets.loadLast();
  if (last) { engine.importState(last); syncUiFromState(); }

  refreshPresetSelect();
  requestAnimationFrame(loop);
});

// ============================================================
//  31-BAND GRAPHIC EQ
// ============================================================
const GEQ_OCTAVES = new Set([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);

// color faders by crossover region (visual grouping)
function geqRegionColor(freq) {
  if (freq < 65) return '#ff3b6b';      // sub
  if (freq < 300) return '#ff9f1c';     // low
  if (freq < 3000) return '#2ec4b6';    // mid
  return '#4895ef';                     // high
}

function buildGeq() {
  const wrap = $('#geq');
  wrap.innerHTML = '';
  ISO_31_BANDS.forEach((freq, i) => {
    const cap = geqRegionColor(freq);

    const band = el('div', 'geq-band');
    band.dataset.geqIndex = i;
    band.style.setProperty('--cap', cap);

    const val = el('span', 'geq-val', '0');

    const fwrap = el('div', 'fader-wrap');
    const slider = el('input', 'geq-slider');
    slider.type = 'range';
    slider.min = GEQ_MIN_DB;
    slider.max = GEQ_MAX_DB;
    slider.step = 0.5;
    slider.value = 0;
    slider.setAttribute('aria-label', `${fmtFreq(freq)} Hz`);
    slider.title = `${fmtFreq(freq)} Hz — double-click to reset`;
    fwrap.append(slider);

    const freqLabel = el('span', 'geq-freq' + (GEQ_OCTAVES.has(freq) ? ' oct' : ''), fmtFreq(freq));

    const apply = (db) => {
      engine.setGeqBand(i, db);
      val.textContent = db > 0 ? `+${db}` : `${db}`;
      band.classList.toggle('active', db !== 0);
      autosave();
    };
    slider.addEventListener('input', () => apply(parseFloat(slider.value)));
    slider.addEventListener('dblclick', () => { slider.value = 0; apply(0); });

    band.append(val, fwrap, freqLabel);
    wrap.append(band);
  });
  $('#geqReset').addEventListener('click', () => {
    engine.resetGeq();
    wrap.querySelectorAll('.geq-band').forEach((b) => {
      b.querySelector('.geq-slider').value = 0;
      b.querySelector('.geq-val').textContent = '0';
      b.classList.remove('active');
    });
    autosave();
  });
}

// ============================================================
//  OUTPUT BAND STRIPS (SUB/LOW/MID/HIGH)
// ============================================================
function buildBands() {
  const wrap = $('#bands');
  wrap.innerHTML = '';
  BANDS.forEach((b) => {
    const st = engine.state.bands[b.id];
    const rangeTxt =
      b.id === 'sub' ? `< ${fmtFreq(engine.state.xover.subLow)} Hz`
      : b.id === 'high' ? `> ${fmtFreq(engine.state.xover.midHigh)} Hz`
      : b.id === 'low' ? `${fmtFreq(engine.state.xover.subLow)}–${fmtFreq(engine.state.xover.lowMid)} Hz`
      : `${fmtFreq(engine.state.xover.lowMid)}–${fmtFreq(engine.state.xover.midHigh)} Hz`;

    const card = el('div', 'band');
    card.style.setProperty('--band-color', b.color);
    card.dataset.bandId = b.id;

    const revPresetOpts = Object.entries(REVERB_PRESETS)
      .map(([k, v]) => `<option value="${k}" ${st.reverbPreset === k ? 'selected' : ''}>${v.name}</option>`)
      .join('');

    card.innerHTML = `
      <div class="band-head">
        <span class="band-title">${b.name}</span>
        <span class="band-range" data-range>${rangeTxt}</span>
      </div>
      <div class="band-body">
        <canvas class="band-meter" data-meter></canvas>
        <div class="band-controls">
          <div class="band-toggles">
            <div class="tg mute ${st.mute ? 'on' : ''}" data-mute>MUTE</div>
            <div class="tg solo ${st.solo ? 'on' : ''}" data-solo>SOLO</div>
            <div class="tg ${st.phaseInvert ? 'on' : ''}" data-phase>ø</div>
          </div>
          <div class="ctl">
            <div class="ctl-head"><label>GAIN</label><output data-gainval>${st.gainDb.toFixed(1)} dB</output></div>
            <input type="range" data-gain min="-40" max="12" step="0.5" value="${st.gainDb}" />
          </div>
          <div class="ctl">
            <div class="ctl-head"><label>DELAY</label><output data-delval>${st.delayMs} ms</output></div>
            <input type="range" data-delay min="0" max="100" step="0.5" value="${st.delayMs}" />
          </div>
          <div class="band-toggles">
            <div class="tg ${st.reverbOn ? 'on' : ''}" data-reverb style="flex:1">REVERB</div>
            <div class="tg ${st.compOn ? 'on' : ''}" data-comp style="flex:1">COMP</div>
          </div>
          <div class="ctl">
            <div class="ctl-head"><label>REVERB MIX</label><output data-revval>${Math.round(st.reverbWet * 100)}%</output></div>
            <input type="range" data-reverbwet min="0" max="80" step="1" value="${Math.round(st.reverbWet * 100)}" />
          </div>
          <select data-revpreset>${revPresetOpts}</select>
          <div class="ctl">
            <div class="ctl-head"><label>COMP THRESH</label><output data-compval>${st.compThreshold} dB</output></div>
            <input type="range" data-compthresh min="-48" max="0" step="1" value="${st.compThreshold}" />
          </div>
        </div>
      </div>`;

    wrap.append(card);

    // meter
    bandMeters[b.id] = new VuMeter(card.querySelector('[data-meter]'), b.color);

    // toggles
    const muteEl = card.querySelector('[data-mute]');
    muteEl.onclick = () => { const on = !muteEl.classList.contains('on'); muteEl.classList.toggle('on', on); engine.setBandMute(b.id, on); autosave(); };
    const soloEl = card.querySelector('[data-solo]');
    soloEl.onclick = () => { const on = !soloEl.classList.contains('on'); soloEl.classList.toggle('on', on); engine.setBandSolo(b.id, on); autosave(); };
    const phaseEl = card.querySelector('[data-phase]');
    phaseEl.onclick = () => { const on = !phaseEl.classList.contains('on'); phaseEl.classList.toggle('on', on); engine.setBandPhase(b.id, on); autosave(); };
    const revEl = card.querySelector('[data-reverb]');
    revEl.onclick = () => { const on = !revEl.classList.contains('on'); revEl.classList.toggle('on', on); engine.setBandReverbOn(b.id, on); autosave(); };
    const compEl = card.querySelector('[data-comp]');
    compEl.onclick = () => { const on = !compEl.classList.contains('on'); compEl.classList.toggle('on', on); engine.setBandComp(b.id, on); autosave(); };

    // sliders
    const gain = card.querySelector('[data-gain]');
    const gainVal = card.querySelector('[data-gainval]');
    gain.oninput = () => { const v = parseFloat(gain.value); engine.setBandGain(b.id, v); gainVal.textContent = `${v.toFixed(1)} dB`; autosave(); };

    const delay = card.querySelector('[data-delay]');
    const delVal = card.querySelector('[data-delval]');
    delay.oninput = () => { const v = parseFloat(delay.value); engine.setBandDelay(b.id, v); delVal.textContent = `${v} ms`; autosave(); };

    const wet = card.querySelector('[data-reverbwet]');
    const revVal = card.querySelector('[data-revval]');
    wet.oninput = () => { const v = parseInt(wet.value); engine.setBandReverbWet(b.id, v / 100); revVal.textContent = `${v}%`; autosave(); };

    const revPreset = card.querySelector('[data-revpreset]');
    revPreset.onchange = () => { engine.setBandReverbPreset(b.id, revPreset.value); autosave(); };

    const compThr = card.querySelector('[data-compthresh]');
    const compVal = card.querySelector('[data-compval]');
    compThr.oninput = () => { const v = parseInt(compThr.value); engine.setBandCompThreshold(b.id, v); compVal.textContent = `${v} dB`; autosave(); };
  });
}

function updateBandRanges() {
  document.querySelectorAll('.band').forEach((card) => {
    const id = card.dataset.bandId;
    const x = engine.state.xover;
    const txt =
      id === 'sub' ? `< ${fmtFreq(x.subLow)} Hz`
      : id === 'high' ? `> ${fmtFreq(x.midHigh)} Hz`
      : id === 'low' ? `${fmtFreq(x.subLow)}–${fmtFreq(x.lowMid)} Hz`
      : `${fmtFreq(x.lowMid)}–${fmtFreq(x.midHigh)} Hz`;
    card.querySelector('[data-range]').textContent = txt;
  });
}

// ============================================================
//  MASTER / VOCAL / CROSSOVER
// ============================================================
function wireMaster() {
  const g = $('#masterGain'), gv = $('#masterGainVal');
  g.oninput = () => { const v = parseFloat(g.value); engine.setMasterGain(v); gv.textContent = `${v.toFixed(1)} dB`; autosave(); };
  const l = $('#masterLimiter'), lv = $('#masterLimiterVal');
  l.oninput = () => { const v = parseFloat(l.value); engine.setMasterLimiter(v); lv.textContent = `${v.toFixed(1)} dB`; autosave(); };
}

function wireVocal() {
  const v = $('#vocalAmount'), vv = $('#vocalAmountVal');
  v.oninput = () => {
    const pct = parseInt(v.value);
    engine.setVocalAmount(pct / 100);
    vv.textContent = pct === 0 ? 'OFF' : `${pct}%`;
    autosave();
  };
}

function wireCrossover() {
  const map = [
    ['#xoSubLow', '#xoSubLowVal', 'subLow'],
    ['#xoLowMid', '#xoLowMidVal', 'lowMid'],
    ['#xoMidHigh', '#xoMidHighVal', 'midHigh'],
  ];
  map.forEach(([inp, out, key]) => {
    const input = $(inp), output = $(out);
    input.oninput = () => {
      const v = parseFloat(input.value);
      engine.setCrossover(key, v);
      output.textContent = `${fmtFreq(v)} Hz`;
      updateBandRanges();
      autosave();
    };
  });
}

// ============================================================
//  TRANSPORT + SOURCES
// ============================================================
function wireTransport() {
  $('#playAll').onclick = () => { engine.resume(); engine.playAll(); };
  $('#pauseAll').onclick = () => engine.pauseAll();
  $('#stopAll').onclick = () => engine.stopAll();
}

function wireSources() {
  $('#fileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const audio = await engine.decode(buf);
        const track = engine.addFileTrack(file.name, audio);
        renderTrack(track);
      } catch (err) {
        alert(`Gagal decode "${file.name}": ${err.message}`);
      }
    }
    e.target.value = '';
    clearEmptyHint();
  });

  $('#addMic').addEventListener('click', async () => {
    try {
      const track = await engine.addMicTrack('Mic / Line-in');
      renderTrack(track);
      clearEmptyHint();
    } catch (err) {
      alert('Gagal akses mic: ' + err.message);
    }
  });
}

function clearEmptyHint() {
  const hint = document.querySelector('.empty-hint');
  if (hint) hint.remove();
}

function renderTrack(track) {
  const row = el('div', 'track');
  row.dataset.trackId = track.id;
  const isFile = track.kind === 'file';

  row.innerHTML = `
    <div class="track-top">
      <span class="track-kind">${isFile ? 'FILE' : 'LIVE'}</span>
      <span class="track-name" title="${track.name}">${track.name}</span>
      <div class="track-btns">
        ${isFile ? `<button class="icon-btn" data-play title="Play/Pause">▶</button>
        <button class="icon-btn" data-loop title="Loop">↻</button>` : ''}
        <button class="icon-btn mute" data-mute title="Mute">M</button>
        <button class="icon-btn" data-remove title="Hapus">✕</button>
      </div>
    </div>
    ${isFile ? `
      <input class="track-seek" type="range" min="0" max="${track.duration}" step="0.01" value="0" data-seek />
      <div class="track-time"><span data-cur>0:00</span><span data-dur>${fmtTime(track.duration)}</span></div>
    ` : ''}
    <div class="track-controls">
      <div class="mini-ctl">
        <label>GAIN <output data-gainval>0.0 dB</output></label>
        <input type="range" data-gain min="-40" max="12" step="0.5" value="0" />
      </div>
      <div class="mini-ctl">
        <label>PAN <output data-panval>C</output></label>
        <input type="range" data-pan min="-100" max="100" step="1" value="0" />
      </div>
    </div>`;

  $('#trackList').append(row);

  const refs = { row };

  if (isFile) {
    const playBtn = row.querySelector('[data-play]');
    playBtn.onclick = () => {
      if (track.playing) { engine.pauseTrack(track.id); playBtn.textContent = '▶'; playBtn.classList.remove('on'); }
      else { engine.resume(); engine.playTrack(track.id); playBtn.textContent = '⏸'; playBtn.classList.add('on'); }
    };
    const loopBtn = row.querySelector('[data-loop]');
    loopBtn.onclick = () => { const on = !loopBtn.classList.contains('on'); loopBtn.classList.toggle('on', on); engine.setTrackLoop(track.id, on); };

    const seek = row.querySelector('[data-seek]');
    seek.oninput = () => engine.seekTrack(track.id, parseFloat(seek.value));
    refs.seek = seek;
    refs.cur = row.querySelector('[data-cur]');
    refs.playBtn = playBtn;
  }

  const muteBtn = row.querySelector('[data-mute]');
  muteBtn.onclick = () => { const on = !muteBtn.classList.contains('on'); muteBtn.classList.toggle('on', on); engine.setTrackMute(track.id, on); };

  row.querySelector('[data-remove]').onclick = () => {
    engine.removeTrack(track.id);
    trackEls.delete(track.id);
    row.remove();
    if (engine.tracks.size === 0) {
      $('#trackList').append(el('div', 'empty-hint',
        'Belum ada lagu. Klik <b>＋ Lagu</b> untuk upload (bisa banyak sekaligus / multi-track).'));
    }
  };

  const gain = row.querySelector('[data-gain]');
  const gainVal = row.querySelector('[data-gainval]');
  gain.oninput = () => { const v = parseFloat(gain.value); engine.setTrackGain(track.id, v); gainVal.textContent = `${v.toFixed(1)} dB`; };

  const pan = row.querySelector('[data-pan]');
  const panVal = row.querySelector('[data-panval]');
  pan.oninput = () => {
    const v = parseInt(pan.value);
    engine.setTrackPan(track.id, v / 100);
    panVal.textContent = v === 0 ? 'C' : (v < 0 ? `L${-v}` : `R${v}`);
  };

  trackEls.set(track.id, refs);
}

engine.onTrackEnded = (id) => {
  const refs = trackEls.get(id);
  if (refs && refs.playBtn) { refs.playBtn.textContent = '▶'; refs.playBtn.classList.remove('on'); }
};

// ============================================================
//  PRESETS
// ============================================================
function wirePresets() {
  $('#presetSave').onclick = () => {
    const name = $('#presetName').value.trim();
    if (!name) { alert('Kasih nama preset dulu cuy.'); return; }
    presets.save(name, engine.exportState());
    refreshPresetSelect(name);
    $('#presetName').value = '';
  };
  $('#presetLoad').onclick = () => {
    const name = $('#presetSelect').value;
    if (!name) return;
    const st = presets.get(name);
    if (st) { engine.importState(st); syncUiFromState(); }
  };
  $('#presetDelete').onclick = () => {
    const name = $('#presetSelect').value;
    if (!name) return;
    if (confirm(`Hapus preset "${name}"?`)) { presets.remove(name); refreshPresetSelect(); }
  };
  $('#presetExport').onclick = () => {
    const name = $('#presetSelect').value || $('#presetName').value.trim() || 'preset';
    presets.exportToFile(name, engine.exportState());
  };
  $('#presetImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { name, state } = await presets.importFromFile(file);
      engine.importState(state); syncUiFromState();
      refreshPresetSelect(name);
    } catch (err) { alert('Import gagal: ' + err.message); }
    e.target.value = '';
  });
}

function refreshPresetSelect(selected) {
  const sel = $('#presetSelect');
  sel.innerHTML = '<option value="">— pilih preset —</option>';
  presets.list().forEach((name) => {
    const opt = el('option', null, name);
    opt.value = name;
    if (name === selected) opt.selected = true;
    sel.append(opt);
  });
}

// ============================================================
//  SYNC UI <- engine.state (after preset load)
// ============================================================
function syncUiFromState() {
  const s = engine.state;

  // GEQ
  document.querySelectorAll('#geq .geq-band').forEach((b, i) => {
    const db = s.geq[i] || 0;
    b.querySelector('.geq-slider').value = db;
    b.querySelector('.geq-val').textContent = db > 0 ? `+${db}` : `${db}`;
    b.classList.toggle('active', db !== 0);
  });

  // master + vocal
  $('#masterGain').value = s.master.gainDb; $('#masterGainVal').textContent = `${s.master.gainDb.toFixed(1)} dB`;
  $('#masterLimiter').value = s.master.limiterThreshold; $('#masterLimiterVal').textContent = `${s.master.limiterThreshold.toFixed(1)} dB`;
  const vp = Math.round(s.vocal.amount * 100);
  $('#vocalAmount').value = vp; $('#vocalAmountVal').textContent = vp === 0 ? 'OFF' : `${vp}%`;

  // crossover
  $('#xoSubLow').value = s.xover.subLow; $('#xoSubLowVal').textContent = `${fmtFreq(s.xover.subLow)} Hz`;
  $('#xoLowMid').value = s.xover.lowMid; $('#xoLowMidVal').textContent = `${fmtFreq(s.xover.lowMid)} Hz`;
  $('#xoMidHigh').value = s.xover.midHigh; $('#xoMidHighVal').textContent = `${fmtFreq(s.xover.midHigh)} Hz`;
  updateBandRanges();

  // bands
  document.querySelectorAll('.band').forEach((card) => {
    const id = card.dataset.bandId;
    const st = s.bands[id];
    card.querySelector('[data-mute]').classList.toggle('on', st.mute);
    card.querySelector('[data-solo]').classList.toggle('on', st.solo);
    card.querySelector('[data-phase]').classList.toggle('on', st.phaseInvert);
    card.querySelector('[data-reverb]').classList.toggle('on', st.reverbOn);
    card.querySelector('[data-comp]').classList.toggle('on', st.compOn);
    card.querySelector('[data-gain]').value = st.gainDb;
    card.querySelector('[data-gainval]').textContent = `${st.gainDb.toFixed(1)} dB`;
    card.querySelector('[data-delay]').value = st.delayMs;
    card.querySelector('[data-delval]').textContent = `${st.delayMs} ms`;
    card.querySelector('[data-reverbwet]').value = Math.round(st.reverbWet * 100);
    card.querySelector('[data-revval]').textContent = `${Math.round(st.reverbWet * 100)}%`;
    card.querySelector('[data-revpreset]').value = st.reverbPreset;
    card.querySelector('[data-compthresh]').value = st.compThreshold;
    card.querySelector('[data-compval]').textContent = `${st.compThreshold} dB`;
  });
}

// ============================================================
//  AUTOSAVE (debounced)
// ============================================================
let autosaveTimer = null;
function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => presets.saveLast(engine.exportState()), 400);
}

// ============================================================
//  RENDER LOOP
// ============================================================
function loop() {
  // spectrum + GEQ overlay
  spectrum.draw();

  // master VU (mono RMS mirrored to L/R)
  const m = engine.getMasterLevel();
  masterVuL.draw(m);
  masterVuR.draw(m);

  // band meters
  BANDS.forEach((b) => bandMeters[b.id].draw(engine.getBandLevel(b.id)));

  // track seek positions
  trackEls.forEach((refs, id) => {
    if (!refs.seek) return;
    const t = engine.tracks.get(id);
    if (t && t.playing) {
      const pos = engine.getTrackPosition(id);
      refs.seek.value = pos;
      refs.cur.textContent = fmtTime(pos);
    }
  });

  requestAnimationFrame(loop);
}
