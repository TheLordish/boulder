/* store.js — everything that touches the disk lives here.
   Keys are namespaced so the app can share localStorage with anything else on
   the origin. Every read passes through a migration chain, so an old record
   written by an earlier build can never reach the rest of the app in a shape
   it does not expect. That is the failure that corrupted quantities in the
   artifact version, and it is designed out here rather than patched. */
(function (App) {
  "use strict";

  var NS = "clog:";
  var SCHEMA_KEY = NS + "__schema";
  var SCHEMA = 4;

  function raw(key) {
    try { return window.localStorage.getItem(NS + key); } catch (e) { return null; }
  }
  function rawSet(key, val) {
    try { window.localStorage.setItem(NS + key, val); return true; }
    catch (e) { return false; }
  }

  /* ---- migrations -------------------------------------------------------
     Each step takes the whole store from version n to n+1. They run once, on
     boot, before anything else reads. Adding a future migration means adding
     one function here and bumping SCHEMA. */
  var MIGRATIONS = {
    // 1 -> 2: meals gained per-item breakdowns
    2: function (get, set, keys) {
      keys.filter(function (k) { return k.indexOf("day:") === 0; }).forEach(function (k) {
        var entries = get(k, []);
        if (!Array.isArray(entries)) return;
        entries.forEach(function (e) {
          if (!e.items) {
            e.items = [{ name: e.name || "Item", kcal: e.kcal || 0, p: e.p || 0,
              c: e.c || 0, f: e.f || 0 }];
          }
          if (!e.label) e.label = e.name || (e.items[0] && e.items[0].name) || "Meal";
        });
        set(k, entries);
      });
    },
    // 2 -> 3: items gained a numeric amount and a unit, so portions can be scaled
    3: function (get, set, keys) {
      var UNIT_RE = /^\s*(?:about\s+|approx\.?\s+|around\s+)?([\d.]+)\s*(kg|g|ml|l|oz|lb|tbsp|tsp|cups?|slices?|pieces?|wraps?|scoops?|eggs?|loa(?:f|ves))?\b/i;
      function fix(i) {
        if (i.amount == null || !isFinite(Number(i.amount)) || Number(i.amount) <= 0) {
          var m = UNIT_RE.exec(String(i.portion || ""));
          if (m) { i.amount = Number(m[1]); i.unit = (m[2] || "").toLowerCase(); }
          else { i.amount = 1; i.unit = "serving"; }
        }
        if (!i.unit) i.unit = "serving";
        if (!i.src) i.src = "estimate";
      }
      keys.filter(function (k) { return k.indexOf("day:") === 0; }).forEach(function (k) {
        var entries = get(k, []);
        if (!Array.isArray(entries)) return;
        entries.forEach(function (e) { (e.items || []).forEach(fix); });
        set(k, entries);
      });
      var favs = get("favorites", []);
      if (Array.isArray(favs)) {
        favs.forEach(function (f) { (f.items || []).forEach(fix); });
        set("favorites", favs);
      }
    }
    ,
    // 3 -> 4: training and body composition stores introduced, nothing to convert
    4: function () {}
  };

  var store = {
    /* Read a value. Returns fallback on a missing key or unparseable JSON,
       never throws, because a single bad record must not stop the app booting. */
    get: function (key, fallback) {
      var v = raw(key);
      if (v === null) return fallback;
      try { return JSON.parse(v); } catch (e) { return fallback; }
    },

    set: function (key, val) {
      var ok = rawSet(key, JSON.stringify(val));
      if (!ok && App.onStorageFull) App.onStorageFull(key);
      return ok;
    },

    remove: function (key) {
      try { window.localStorage.removeItem(NS + key); } catch (e) {}
    },

    /* Keys under this app only, with the namespace stripped. */
    keys: function (prefix) {
      var out = [];
      try {
        for (var i = 0; i < window.localStorage.length; i++) {
          var k = window.localStorage.key(i);
          if (k && k.indexOf(NS) === 0) {
            var bare = k.slice(NS.length);
            if (bare.indexOf("__") === 0) continue;
            if (!prefix || bare.indexOf(prefix) === 0) out.push(bare);
          }
        }
      } catch (e) {}
      return out.sort();
    },

    /* Rough bytes used by this app, for the diagnostics panel. */
    bytes: function () {
      var n = 0;
      this.keys().forEach(function (k) { var v = raw(k); if (v) n += v.length + k.length; });
      return n;
    },

    available: function () {
      try {
        var probe = NS + "__probe";
        window.localStorage.setItem(probe, "1");
        window.localStorage.removeItem(probe);
        return true;
      } catch (e) { return false; }
    },

    /* Run any outstanding migrations. Returns the list applied, so boot can
       report it rather than changing data silently. */
    migrate: function () {
      var self = this;
      var from = Number(raw("__schema")) || 0;
      var applied = [];
      if (!from) {
        // a fresh install, or one that predates versioning: treat existing
        // records as the oldest known shape so every step runs over them
        from = self.keys().length ? 1 : SCHEMA;
      }
      for (var v = from + 1; v <= SCHEMA; v++) {
        if (!MIGRATIONS[v]) continue;
        try {
          MIGRATIONS[v](
            function (k, d) { return self.get(k, d); },
            function (k, val) { return self.set(k, val); },
            self.keys()
          );
          applied.push(v);
        } catch (e) {
          if (window.console) console.warn("migration " + v + " failed", e);
        }
      }
      try { window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA)); } catch (e) {}
      return { from: from, to: SCHEMA, applied: applied };
    },

    schema: SCHEMA,

    /* Whole-store snapshot and restore, used by export and import. */
    dump: function () {
      var self = this, out = {};
      this.keys().forEach(function (k) { out[k] = self.get(k, null); });
      return out;
    },
    load: function (obj) {
      var self = this, n = 0;
      Object.keys(obj || {}).forEach(function (k) {
        if (obj[k] === null || obj[k] === undefined) return;
        if (self.set(k, obj[k])) n++;
      });
      return n;
    }
  };

  App.store = store;
})(window.App = window.App || {});
