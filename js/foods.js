/* foods.js — the bundled food database.

   Loaded on first use, never at boot, because it is the largest single asset in
   the app and most sessions never touch it. Once fetched the service worker
   keeps it, so it works offline from then on.

   Every entry is per 100 g or 100 ml, so scaling to a real portion is the same
   arithmetic used everywhere else. */
(function (App) {
  "use strict";

  var URLS = ["data/foods.json", "data/regional.json"];

  var db = {
    rows: null,          // [name, kcal, protein, carbs, fat]
    index: null,         // token -> row indices
    state: "idle",       // idle | loading | ready | failed
    source: "",

    load: function () {
      if (this.state === "ready" || this.state === "loading") return this._p;
      this.state = "loading";
      var self = this;
      this._p = Promise.all(URLS.map(function (u) {
        return fetch(u).then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      })).then(function (parts) {
        var rows = [], names = {};
        parts.forEach(function (p) {
          if (!p || !p.foods) return;
          p.foods.forEach(function (r) {
            var key = String(r[0]).toLowerCase();
            if (names[key]) return;        // first file wins, regional is listed first
            names[key] = 1;
            rows.push(r);
          });
        });
        if (!rows.length) { self.state = "failed"; return null; }
        self.rows = rows;
        self.build();
        self.state = "ready";
        self.source = parts[0] && parts[0].built ? "USDA " + parts[0].built + " plus regional" : "regional";
        return rows;
      });
      return this._p;
    },

    /* A token index rather than a scan: 8,000 rows is fine to walk once, but
       not on every keystroke. */
    build: function () {
      var idx = {};
      this.rows.forEach(function (r, i) {
        String(r[0]).toLowerCase().split(/[^a-z0-9]+/).forEach(function (t) {
          if (t.length < 2) return;
          (idx[t] = idx[t] || []).push(i);
        });
      });
      this.index = idx;
    },

    /* Rank by how completely the query is matched, then by how short the name
       is, so "rice" finds "Rice, white, cooked" before "Rice pudding with figs". */
    search: function (q, limit) {
      if (this.state !== "ready") return [];
      q = String(q || "").toLowerCase().trim();
      if (q.length < 2) return [];
      var terms = q.split(/[^a-z0-9]+/).filter(function (t) { return t.length > 1; });
      if (!terms.length) return [];

      var hits = {};
      var self = this;
      terms.forEach(function (t) {
        var exact = self.index[t] || [];
        exact.forEach(function (i) { hits[i] = (hits[i] || 0) + 2; });
        // a prefix match counts for less, so "chick" still reaches "chickpeas"
        if (t.length >= 3) {
          Object.keys(self.index).forEach(function (k) {
            if (k !== t && k.indexOf(t) === 0) {
              self.index[k].forEach(function (i) { hits[i] = (hits[i] || 0) + 1; });
            }
          });
        }
      });

      var out = Object.keys(hits).map(function (i) {
        var r = self.rows[i];
        var score = hits[i] - Math.min(r[0].length, 60) / 100;
        if (r[0].toLowerCase() === q) score += 10;
        else if (r[0].toLowerCase().indexOf(q) === 0) score += 4;
        return { name: r[0], kcal: r[1], p: r[2], c: r[3], f: r[4], score: score };
      });
      out.sort(function (a, b) { return b.score - a.score; });
      return out.slice(0, limit || 8);
    },

    /* Scale a per-100 entry to a real portion. Countable units cannot be
       derived from per-100 g data, so those are refused rather than guessed. */
    portion: function (hit, amount, unit) {
      if (unit !== "g" && unit !== "ml") return null;
      var a = Number(amount) || 100;
      var k = a / 100;
      return {
        kcal: Math.round(hit.kcal * k),
        p: Math.round(hit.p * k),
        c: Math.round(hit.c * k),
        f: Math.round(hit.f * k)
      };
    },

    count: function () { return this.rows ? this.rows.length : 0; }
  };

  App.foods = db;
})(window.App = window.App || {});
