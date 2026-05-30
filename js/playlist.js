/* ============================================================
   playlist.js — Spotify-style playlist management
   ============================================================ */

(function () {
  "use strict";

  window.fmtTime = function (s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ":" + String(sec).padStart(2, "0");
  };

  let _id = 1;

  class Playlist {
    constructor(listEl, emptyHintEl) {
      this.listEl = listEl;
      this.emptyHint = emptyHintEl;
      this.songs = [];
      this.currentId = null;
      this.playing = false;
      this.filter = "";
      this.shuffle = false;
      this.repeat = "off"; // off | one | all

      this.onPlay = null;    // (song) => {}
      this.onChange = null;  // () => {}

      this._dragId = null;
    }

    add(fileList) {
      const files = Array.from(fileList).filter((f) => f.type.startsWith("audio") || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name));
      files.forEach((file) => {
        const song = {
          id: _id++,
          name: file.name.replace(/\.[^.]+$/, ""),
          file,
          url: URL.createObjectURL(file),
          duration: 0,
        };
        this.songs.push(song);
        // lazy duration probe
        const probe = new Audio();
        probe.preload = "metadata";
        probe.src = song.url;
        probe.addEventListener("loadedmetadata", () => {
          song.duration = probe.duration;
          this.render();
        });
      });
      this.render();
      if (this.onChange) this.onChange();
      return files.length;
    }

    remove(id) {
      const i = this.songs.findIndex((s) => s.id === id);
      if (i < 0) return;
      const wasCurrent = this.songs[i].id === this.currentId;
      URL.revokeObjectURL(this.songs[i].url);
      this.songs.splice(i, 1);
      if (wasCurrent) this.currentId = null;
      this.render();
      if (this.onChange) this.onChange();
    }

    get current() { return this.songs.find((s) => s.id === this.currentId) || null; }
    indexOf(id) { return this.songs.findIndex((s) => s.id === id); }

    setSearch(q) { this.filter = q.trim().toLowerCase(); this.render(); }

    play(id) {
      this.currentId = id;
      const s = this.current;
      this.render();
      if (s && this.onPlay) this.onPlay(s);
    }

    getNext(auto) {
      if (!this.songs.length) return null;
      if (auto && this.repeat === "one") return this.current;
      const idx = this.indexOf(this.currentId);
      if (this.shuffle) {
        if (this.songs.length === 1) return this.songs[0];
        let r; do { r = Math.floor(Math.random() * this.songs.length); } while (r === idx);
        return this.songs[r];
      }
      if (idx < this.songs.length - 1) return this.songs[idx + 1];
      // at end
      if (this.repeat === "all" || !auto) return this.songs[0];
      return null; // stop
    }

    getPrev() {
      if (!this.songs.length) return null;
      const idx = this.indexOf(this.currentId);
      if (this.shuffle) return this.getNext(false);
      if (idx > 0) return this.songs[idx - 1];
      return this.songs[this.songs.length - 1];
    }

    render() {
      const el = this.listEl;
      // remove song nodes (keep empty hint)
      el.querySelectorAll(".song-item").forEach((n) => n.remove());

      const visible = this.songs.filter((s) => !this.filter || s.name.toLowerCase().includes(this.filter));
      if (this.emptyHint) this.emptyHint.style.display = this.songs.length ? "none" : "flex";

      visible.forEach((song) => {
        const realIdx = this.indexOf(song.id);
        const li = document.createElement("li");
        li.className = "song-item" + (song.id === this.currentId ? " active" : "") + (song.id === this.currentId && this.playing ? " playing" : "");
        li.draggable = true;
        li.dataset.id = song.id;
        li.innerHTML =
          '<span class="song-num">' + (realIdx + 1) + '</span>' +
          '<span class="song-bars"><i></i><i></i><i></i></span>' +
          '<span class="song-meta"><span class="song-name">' + this._esc(song.name) + '</span>' +
          '<span class="song-dur">' + (song.duration ? window.fmtTime(song.duration) : "--:--") + '</span></span>' +
          '<button class="song-remove" title="Hapus"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>';

        li.addEventListener("click", (e) => {
          if (e.target.closest(".song-remove")) { this.remove(song.id); return; }
          this.play(song.id);
        });

        // drag reorder
        li.addEventListener("dragstart", () => { this._dragId = song.id; li.classList.add("dragging"); });
        li.addEventListener("dragend", () => { this._dragId = null; li.classList.remove("dragging"); });
        li.addEventListener("dragover", (e) => { e.preventDefault(); });
        li.addEventListener("drop", (e) => {
          e.preventDefault();
          this._reorder(this._dragId, song.id);
        });

        el.appendChild(li);
      });
    }

    _reorder(fromId, toId) {
      if (fromId == null || fromId === toId) return;
      const from = this.indexOf(fromId), to = this.indexOf(toId);
      if (from < 0 || to < 0) return;
      const [moved] = this.songs.splice(from, 1);
      this.songs.splice(to, 0, moved);
      this.render();
    }

    _esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  }

  window.Playlist = Playlist;
})();
