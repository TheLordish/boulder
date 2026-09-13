/* entry.js — the structured add form.

   One rule decides everything here: fill from the cheapest source that knows
   the answer, and never overwrite something you typed yourself.

     1. your fields        free, instant
     2. your own library   free, instant, scaled to the amount
     3. Open Food Facts    free, one network call
     4. the model          costs a request, and only for what is still blank

   If every field is filled, nothing leaves the phone. */
(function (App) {
  "use strict";

  var el = function (id) { return document.getElementById(id); };
  var UNITS = ["g", "ml", "piece", "slice", "serving"];
  var MACROS = ["kcal", "p", "c", "f"];

  var entry = {
    unit: "g",

    num: function (id) {
      var v = Number(el(id).value);
      return (el(id).value !== "" && isFinite(v) && v >= 0) ? v : null;
    },

    read: function () {
      return {
        name: el("fName").value.trim(),
        amount: this.num("fAmt"),
        unit: this.unit,
        kcal: this.num("fKcal"),
        p: this.num("fP"),
        c: this.num("fC"),
        f: this.num("fF")
      };
    },

    clear: function () {
      ["fName", "fAmt", "fKcal", "fP", "fC", "fF"].forEach(function (id) { el(id).value = ""; });
      var s = el("fSuggest"); if (s) s.hidden = true;
    },

    cycleUnit: function () {
      this.unit = UNITS[(UNITS.indexOf(this.unit) + 1) % UNITS.length];
      el("fUnit").textContent = this.unit === "serving" ? "srv" : this.unit === "piece" ? "pc" : this.unit;
      App.store.set("lastUnit", this.unit);
    },

    missing: function (f) {
      return MACROS.filter(function (k) { return f[k] == null; });
    },

    /* ---- step 2b: the bundled database ---- */
    fromBundled: function (f) {
      if (!App.foods || App.foods.state !== "ready") return null;
      var hits = App.foods.search(f.name, 1);
      if (!hits.length) return null;
      var per = App.foods.portion(hits[0], f.amount || 100, f.unit);
      if (!per) return null;
      per.label = hits[0].name;
      return per;
    },

    /* ---- step 2: your own library ---- */
    fromLibrary: function (f) {
      if (!App.meals) return null;
      var name = f.name.toLowerCase();
      var hit = App.meals.all().filter(function (m) {
        return m.name.toLowerCase() === name;
      })[0];
      if (!hit) {
        // a looser match, so "chicken" finds "Chicken breast" once you have one
        hit = App.meals.all().filter(function (m) {
          var n = m.name.toLowerCase();
          return n.indexOf(name) === 0 || name.indexOf(n) === 0;
        })[0];
      }
      if (!hit) return null;
      var amount = f.amount || hit.last || (hit.unit === "g" || hit.unit === "ml" ? 100 : 1);
      return {
        unit: hit.unit,
        amount: amount,
        kcal: Math.round(hit.kcal * amount),
        p: Math.round(hit.p * amount),
        c: Math.round(hit.c * amount),
        f: Math.round(hit.f * amount),
        label: hit.name
      };
    },

    /* ---- step 3: the public food database ---- */
    fromDatabase: async function (f) {
      if (!App.offLookup) return null;
      var rows = await App.offLookup(f.name);
      if (!rows || !rows.length) return null;
      var r = rows[0];
      var per = (f.unit === "g" || f.unit === "ml") ? (f.amount || 100) / 100 : null;
      if (per === null) return null;          // per-100g data cannot size a "piece"
      return {
        kcal: Math.round(r.kcal100 * per),
        p: Math.round(r.p100 * per),
        c: Math.round(r.c100 * per),
        f: Math.round(r.f100 * per),
        label: r.name
      };
    },

    /* ---- step 4: the model, for the gaps only ---- */
    RULES: function (f, gaps) {
      return "Give the missing nutrition figures for one food. Levantine, Lebanese and Gulf " +
        "foods are common. Account for cooking oil and sauces.\n" +
        "Food: " + f.name + "\n" +
        "Portion: " + (f.amount || 1) + " " + f.unit + "\n" +
        (f.kcal != null ? "Known calories: " + f.kcal + " kcal. Your figures must be consistent with it.\n" : "") +
        (f.p != null ? "Known protein: " + f.p + " g\n" : "") +
        (f.c != null ? "Known carbs: " + f.c + " g\n" : "") +
        (f.f != null ? "Known fat: " + f.f + " g\n" : "") +
        "Return ONLY these fields: " + gaps.join(", ") + ".\n" +
        "Protein and carbohydrate are 4 kcal per gram and fat is 9, so the four numbers must " +
        "reconcile with each other.\n\n" +
        "Reply with ONLY a JSON object, no markdown, no code fences:\n" +
        '{"kcal":integer,"protein":integer,"carbs":integer,"fat":integer}';
    },

    fromModel: async function (f, gaps) {
      var data = await App.api.call([{ role: "user", content: this.RULES(f, gaps) }], { tier: "fast" });
      var o = App.api.json(data);
      var map = { kcal: "kcal", p: "protein", c: "carbs", f: "fat" };
      var out = {};
      gaps.forEach(function (k) {
        var v = Number(o[map[k]]);
        if (!isFinite(v) || v < 0) return;
        if (k === "kcal" && v <= 0) return;      // zero calories is a non-answer
        out[k] = Math.round(v);
      });
      return Object.keys(out).length ? out : null;
    },

    /* Same cascade, but stop before writing anything. Useful for "what would
       that actually cost me" before you commit to eating it. */
    preview: async function () {
      var box = el("previewBox");
      var item = await this.resolve(true);
      if (!item) return;
      box.hidden = false;
      box.innerHTML = "";
      var card = document.createElement("div"); card.className = "preview";
      var h = document.createElement("h4"); h.textContent = "Estimate only, nothing logged";
      var v = document.createElement("div"); v.className = "pv";
      v.textContent = item.amount + " " + item.unit + " " + item.name + " \u00b7 " + item.kcal + " kcal";
      var m = document.createElement("div"); m.className = "pm";
      m.textContent = item.p + " g protein, " + item.c + " g carbs, " + item.f + " g fat";
      var acts = document.createElement("div"); acts.className = "pacts";
      var go = document.createElement("button"); go.className = "go"; go.textContent = "Log it";
      go.onclick = function () { box.hidden = true; App.entry.clear(); App.logStructured(item, []); };
      var no = document.createElement("button"); no.className = "mini"; no.textContent = "Close";
      no.onclick = function () { box.hidden = true; };
      acts.appendChild(go); acts.appendChild(no);
      card.appendChild(h); card.appendChild(v); card.appendChild(m); card.appendChild(acts);
      box.appendChild(card);
    },

    /* ---- the cascade ---- */
    submit: async function () {
      var item = await this.resolve(false);
      if (!item) return;
      this.clear();
      App.logStructured(item, this._sources);
    },

    resolve: async function (quiet) {
      var f = this.read();
      if (!f.name) { App.entryStatus("Give the food a name.", true); return null; }

      var sources = [];
      var src = "given";

      // 2. library
      if (this.missing(f).length) {
        var lib = this.fromLibrary(f);
        if (lib) {
          if (!f.amount) { f.amount = lib.amount; f.unit = lib.unit; }
          MACROS.forEach(function (k) { if (f[k] == null && lib[k] != null) f[k] = lib[k]; });
          sources.push("your library");
          src = "repeat";
        }
      }

      // 2b. the database shipped with the app, free and offline
      if (this.missing(f).length && App.foods) {
        try { await App.foods.load(); } catch (e) { /* no database, carry on */ }
        var bun = this.fromBundled(f);
        if (bun) {
          MACROS.forEach(function (k) { if (f[k] == null && bun[k] != null) f[k] = bun[k]; });
          sources.push("the built-in database");
          src = "database";
        }
      }

      // 3. Open Food Facts, for packaged goods the built-in set will not have
      if (this.missing(f).length) {
        App.entryStatus("Checking the food database");
        try {
          var db = await this.fromDatabase(f);
          if (db) {
            MACROS.forEach(function (k) { if (f[k] == null && db[k] != null) f[k] = db[k]; });
            sources.push("the database");
            src = "database";
          }
        } catch (e) { /* offline or no match, carry on */ }
      }

      // 4. the model, for whatever is still blank
      var gaps = this.missing(f);
      if (gaps.length) {
        App.entryStatus("Working out " + gaps.length + " missing figure" + (gaps.length > 1 ? "s" : ""));
        try {
          var ai = await this.fromModel(f, gaps);
          if (ai) {
            MACROS.forEach(function (k) { if (f[k] == null && ai[k] != null) f[k] = ai[k]; });
            sources.push("an estimate");
            if (f.kcal != null && gaps.indexOf("kcal") > -1) src = "estimate";
          }
        } catch (e) {
          if (App.entryError(e)) return null;
        }
      }

      if (!f.kcal) {
        App.entryStatus("Could not work out the calories for that. Type them in and it will log.", true);
        return null;
      }

      this._sources = sources;
      return {
        name: f.name.charAt(0).toUpperCase() + f.name.slice(1),
        amount: f.amount || 1,
        unit: f.amount ? f.unit : "serving",
        src: src,
        kcal: Math.round(f.kcal),
        p: Math.round(f.p || 0),
        c: Math.round(f.c || 0),
        f: Math.round(f.f || 0)
      };
    },

    init: function () {
      this.unit = App.store.get("lastUnit", "g") || "g";
      el("fUnit").textContent = this.unit === "serving" ? "srv" : this.unit === "piece" ? "pc" : this.unit;
      var self = this;
      el("fUnit").onclick = function () { self.cycleUnit(); };
      el("fLog").onclick = function () { self.submit(); };
      if (el("fPreview")) el("fPreview").onclick = function () { self.preview(); };
      ["fName", "fAmt", "fKcal", "fP", "fC", "fF"].forEach(function (id) {
        el(id).addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); self.submit(); }
        });
      });
      /* suggest as you type, from the bundled set */
      var box = el("fSuggest");
      var nameField = el("fName");
      nameField.addEventListener("input", function () {
        var q = nameField.value.trim();
        if (q.length < 2 || !App.foods) { box.hidden = true; return; }
        App.foods.load().then(function () {
          var hits = App.foods.search(q, 6);
          box.innerHTML = "";
          if (!hits.length) { box.hidden = true; return; }
          hits.forEach(function (h) {
            var b = document.createElement("button");
            b.className = "fs";
            var n = document.createElement("span"); n.className = "fn"; n.textContent = h.name;
            var m = document.createElement("span"); m.className = "fm";
            m.textContent = h.kcal + " kcal \u00b7 " + h.p + "g per 100";
            b.appendChild(n); b.appendChild(m);
            b.onclick = function () {
              nameField.value = h.name;
              if (!el("fAmt").value) el("fAmt").value = 100;
              if (self.unit !== "g" && self.unit !== "ml") { while (self.unit !== "g") self.cycleUnit(); }
              var per = App.foods.portion(h, el("fAmt").value, self.unit);
              if (per) {
                el("fKcal").value = per.kcal; el("fP").value = per.p;
                el("fC").value = per.c; el("fF").value = per.f;
              }
              box.hidden = true;
            };
            box.appendChild(b);
          });
          box.hidden = false;
        });
      });
      nameField.addEventListener("blur", function () { setTimeout(function () { box.hidden = true; }, 180); });

      el("modeFields").onclick = function () { self.mode("fields"); };
      el("modeText").onclick = function () { self.mode("text"); };
      this.mode(App.store.get("entryMode", "fields"));
    },

    mode: function (m) {
      el("formEntry").hidden = m !== "fields";
      el("textEntry").hidden = m !== "text";
      el("modeFields").setAttribute("aria-selected", String(m === "fields"));
      el("modeText").setAttribute("aria-selected", String(m === "text"));
      App.store.set("entryMode", m);
    }
  };

  App.entry = entry;
})(window.App = window.App || {});
