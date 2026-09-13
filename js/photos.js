/* photos.js — captured images survive until they are actually logged.

   A photo is expensive to retake and cheap to store, so nothing is thrown away
   on a failed call. Every shot is downscaled, written to IndexedDB, and only
   removed once the model has turned it into a meal. Failures stay queued with
   their reason and retry on their own when the app reopens or the connection
   returns.

   IndexedDB rather than localStorage because a few photos would blow the 5 MB
   quota that holds all your actual data. */
(function (App) {
  "use strict";

  var DB = "boulder-photos", STORE = "shots", VERSION = 1;
  var MAX_EDGE = 1400;      // long edge; beyond this costs tokens and buys nothing
  var QUALITY = 0.82;
  var MAX_TRIES = 6;

  var dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error("no indexeddb"));
      var r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(STORE, mode), s = t.objectStore(STORE), out;
        out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }

  /* Re-encode through a canvas. Two things fall out of this for free: the
     output is always JPEG whatever went in, and a 12 MP camera shot drops from
     several megabytes to a couple of hundred kilobytes. */
  function shrink(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return rej(new Error("could not read that image"));
        var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var c = document.createElement("canvas");
        c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(img, 0, 0, cw, ch);

        var full = c.toDataURL("image/jpeg", QUALITY);
        // a small thumbnail so the pending row can show what is waiting
        var t = document.createElement("canvas");
        var ts = Math.min(1, 120 / Math.max(cw, ch));
        t.width = Math.round(cw * ts); t.height = Math.round(ch * ts);
        t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);

        res({ data: full.split(",")[1], thumb: t.toDataURL("image/jpeg", 0.6), w: cw, h: ch });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        rej(new Error("this phone cannot read that image format"));
      };
      img.src = url;
    });
  }

  var photos = {
    ready: function () { return !!window.indexedDB; },

    add: async function (file, note) {
      var s = await shrink(file);
      var rec = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        at: new Date().toISOString(),
        day: new Date().toISOString().slice(0, 10),
        data: s.data, thumb: s.thumb, note: note || "",
        tries: 0, error: "", state: "pending"
      };
      await tx("readwrite", function (st) { st.put(rec); });
      return rec;
    },

    all: function () {
      return tx("readonly", function (st) { return st.getAll(); })
        .then(function (r) { return (r || []).sort(function (a, b) { return a.at < b.at ? -1 : 1; }); })
        .catch(function () { return []; });
    },
    get: function (id) { return tx("readonly", function (st) { return st.get(id); }); },
    put: function (rec) { return tx("readwrite", function (st) { st.put(rec); }); },
    remove: function (id) { return tx("readwrite", function (st) { st.delete(id); }); },
    count: function () { return this.all().then(function (a) { return a.length; }); },

    /* Work through the queue one at a time. Called on capture, on app open,
       and whenever the connection comes back. */
    drain: async function () {
      if (this._busy) return;
      this._busy = true;
      try {
        var list = await this.all();
        for (var i = 0; i < list.length; i++) {
          var rec = list[i];
          if (rec.state === "done" || rec.tries >= MAX_TRIES) continue;
          if (!App.api.online() || !App.api.hasKey()) break;

          rec.state = "working";
          await this.put(rec);
          if (App.onPhotoQueue) App.onPhotoQueue();

          try {
            await App.processPhoto(rec);
            await this.remove(rec.id);
          } catch (e) {
            rec.state = "pending";
            rec.tries = (rec.tries || 0) + 1;
            rec.error = (e && e.message) || "failed";
            rec.kind = (e && e.kind) || "";
            await this.put(rec);
            // a missing key or no credit will not fix itself on a retry loop
            if (rec.kind === "nokey" || rec.kind === "auth" || rec.kind === "credit") break;
          }
          if (App.onPhotoQueue) App.onPhotoQueue();
        }
      } finally {
        this._busy = false;
        if (App.onPhotoQueue) App.onPhotoQueue();
      }
    },

    start: function () {
      var self = this;
      window.addEventListener("online", function () { self.drain(); });
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) self.drain();
      });
      setTimeout(function () { self.drain(); }, 1200);
    },

    MAX_TRIES: MAX_TRIES
  };

  App.photos = photos;
})(window.App = window.App || {});
