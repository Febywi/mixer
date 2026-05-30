/* ============================================================
   main.js — bootstrap & wiring
   ============================================================ */

(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  window.addEventListener("DOMContentLoaded", () => {
    const audioEl = $("audioEl");

    // ---- core instances ----
    const engine = new window.AudioEngine(audioEl);
    engine.init(); // build graph up-front (context starts suspended until first play)

    const playlist = new window.Playlist($("songList"), $("emptyHint"));
    const waveform = new window.Waveform($("waveform"), document.querySelector(".waveform-wrap"));
    const analyzer = new window.Analyzer($("bigAnalyzer"));
    const eqEditor = new window.EQEditor($("eqCanvas"));
    const presets = new window.Presets(engine);

    analyzer.bind(engine);

    const els = {
      npTitle: $("npTitle"), npSub: $("npSub"), curTime: $("curTime"), durTime: $("durTime"),
      waveProgress: $("waveProgress"),
      iconPlay: $("iconPlay"), iconPause: $("iconPause"),
      engineDot: $("engineDot"), engineState: $("engineState"),
      channelRack: $("channelRack"), masterRack: $("masterRack"), presetGrid: $("presetGrid"),
      tabs: $("tabs"), eqChannelSelect: $("eqChannelSelect"), eqFilterType: $("eqFilterType"), eqResetBtn: $("eqResetBtn"),
      roSel: $("roSel"), roFreq: $("roFreq"), roGain: $("roGain"), roQ: $("roQ"),
      modeToggle: $("modeToggle"), qualityToggle: $("qualityToggle"), compareToggle: $("compareToggle"),
      soloHint: $("soloHint"),
      advSR: $("advSR"), advLat: $("advLat"), advBuf: $("advBuf"),
      advX1: $("advX1"), advX2: $("advX2"), advX3: $("advX3"),
    };

    const ui = new window.UI({ engine, presets, eqEditor, analyzer, els });
    ui.init();

    const player = new window.Player({ audioEl, engine, playlist, waveform, els });

    // engine is live
    els.engineDot.classList.add("live");
    els.engineState.textContent = "Engine Live";

    // ---- callbacks ----
    presets.onChange = () => ui.syncFromEngine();
    playlist.onPlay = (song) => { player.load(song); player.play(); };
    playlist.onChange = () => { $("songCount").textContent = playlist.songs.length; };
    waveform.onSeek = (r) => player.seek(r);

    // ---- upload ----
    $("fileInput").addEventListener("change", (e) => {
      const n = playlist.add(e.target.files);
      if (n) ui.toast(n + " lagu ditambahkan", "ok");
      e.target.value = "";
    });

    // ---- search ----
    $("searchInput").addEventListener("input", (e) => playlist.setSearch(e.target.value));

    // ---- transport ----
    $("btnPlay").addEventListener("click", () => player.toggle());
    $("btnNext").addEventListener("click", () => player.next(false));
    $("btnPrev").addEventListener("click", () => player.prev());

    const btnShuffle = $("btnShuffle");
    btnShuffle.addEventListener("click", () => {
      playlist.shuffle = !playlist.shuffle;
      btnShuffle.classList.toggle("on", playlist.shuffle);
    });

    const btnRepeat = $("btnRepeat");
    btnRepeat.addEventListener("click", () => {
      playlist.repeat = playlist.repeat === "off" ? "all" : (playlist.repeat === "all" ? "one" : "off");
      btnRepeat.classList.toggle("on", playlist.repeat !== "off");
      btnRepeat.classList.toggle("repeat-one-on", playlist.repeat === "one");
    });

    // ---- preset save/export/import ----
    $("savePresetBtn").addEventListener("click", () => {
      const name = prompt("Nama preset:", "Preset Saya");
      if (name) { presets.saveCurrent(name); ui.toast("Preset disimpan: " + name, "ok"); }
    });
    $("exportPresetBtn").addEventListener("click", () => presets.exportActive());
    $("importPresetInput").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) presets.importFile(f).then((p) => ui.toast("Import: " + p.name, "ok")).catch(() => ui.toast("File preset tidak valid", "err"));
      e.target.value = "";
    });

    // ---- keyboard shortcuts ----
    window.addEventListener("keydown", (e) => {
      if (e.target.matches("input, textarea, select")) return;
      if (e.code === "Space") { e.preventDefault(); player.toggle(); }
      else if (e.code === "ArrowRight") { audioEl.currentTime = Math.min((audioEl.duration || 0), audioEl.currentTime + 5); }
      else if (e.code === "ArrowLeft") { audioEl.currentTime = Math.max(0, audioEl.currentTime - 5); }
      else if (e.key === "n") player.next(false);
      else if (e.key === "p") player.prev();
    });

    // ---- resize ----
    let rt;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => { eqEditor.resize(); analyzer.resize(); waveform.resize(); }, 120);
    });

    // ---- animation loop ----
    function frame() {
      ui.updateMeters();
      if (ui.activeTab === "eq") eqEditor.draw();
      else if (ui.activeTab === "analyzer") analyzer.draw();
      requestAnimationFrame(frame);
    }
    // ensure canvases are sized after layout settles
    requestAnimationFrame(() => { eqEditor.resize(); analyzer.resize(); waveform.resize(); requestAnimationFrame(frame); });

    // default preset selected (flat)
    presets.activeId = "b0";
    ui.syncFromEngine();

    // expose for debugging / tooling
    window.NEXUS = { engine, playlist, waveform, analyzer, eqEditor, presets, player, ui };

    console.log("[NEXUS DSP] ready · sampleRate", engine.ctx.sampleRate);
  });
})();
