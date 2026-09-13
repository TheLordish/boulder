/* comp.js — body composition scans.
   Model: comp -> { "YYYY-MM-DD": {...fields} }
   Fields follow what a BIA printout actually gives you, so a scan can be typed
   in from the sheet or read off a photo of it without translation. */
(function (App) {
  "use strict";

  /* label, key, unit, whether it drives the trend chart */
  var FIELDS = [
    ["Weight", "weight", "kg", true],
    ["Body fat", "fatPct", "%", true],
    ["Fat mass", "fatMass", "kg", true],
    ["Skeletal muscle", "skm", "kg", true],
    ["Muscle mass", "muscle", "kg", false],
    ["Fat-free mass", "ffm", "kg", false],
    ["Total body water", "tbw", "L", false],
    ["Protein", "protein", "kg", false],
    ["Mineral", "mineral", "kg", false],
    ["Visceral / abdominal", "abdominal", "", false],
    ["BMR", "bmr", "kcal", false],
    ["Total energy expenditure", "tee", "kcal", false]
  ];
  var SEG = [["Left arm", "la"], ["Right arm", "ra"], ["Trunk", "tr"],
             ["Left leg", "ll"], ["Right leg", "rl"]];

  var comp = {
    data: {},
    editing: null,     // date being edited, or null
    chartKey: "skm",

    load: function () { this.data = App.store.get("comp", {}) || {}; },
    save: function () { App.store.set("comp", this.data); },

    dates: function () { return Object.keys(this.data).sort(); },
    latest: function () {
      var d = this.dates();
      return d.length ? this.data[d[d.length - 1]] : null;
    },
    at: function (date) { return this.data[date] || null; },

    put: function (date, rec) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
      var clean = {};
      FIELDS.forEach(function (f) {
        var v = Number(rec[f[1]]);
        if (isFinite(v) && v > 0) clean[f[1]] = Math.round(v * 100) / 100;
      });
      ["segFat", "segMuscle"].forEach(function (g) {
        if (!rec[g]) return;
        var o = {};
        SEG.forEach(function (s) {
          var v = Number(rec[g][s[1]]);
          if (isFinite(v) && v > 0) o[s[1]] = Math.round(v * 100) / 100;
        });
        if (Object.keys(o).length) clean[g] = o;
      });
      if (!Object.keys(clean).length) return false;
      this.data[date] = clean;
      this.save();
      return true;
    },
    remove: function (date) { delete this.data[date]; this.save(); },

    /* Change between the two most recent scans, for the delta column. */
    delta: function (key) {
      var d = this.dates();
      if (d.length < 2) return null;
      var a = this.data[d[d.length - 2]][key], b = this.data[d[d.length - 1]][key];
      if (a == null || b == null) return null;
      return Math.round((b - a) * 100) / 100;
    },

    series: function (key) {
      var self = this;
      return this.dates()
        .filter(function (d) { return self.data[d][key] != null; })
        .map(function (d) { return { d: d, v: self.data[d][key] }; });
    },

    FIELDS: FIELDS,
    SEG: SEG,

    /* ---- reading a printout ---- */
    READ_RULES:
      "This image is a body composition report from a bioimpedance scale, such as an InBody, " +
      "Mediana or Tanita printout. Read the printed values exactly as printed and do not adjust " +
      "or sanity-check them. Panels may be in English, Arabic or French. Ignore the reference or " +
      "standard ranges shown in brackets, take only the measured values. Weights are kilograms " +
      "unless the sheet says otherwise.\n" +
      "Return only the fields actually present. Omit anything you cannot read rather than guessing.\n\n" +
      "Reply with ONLY a JSON object, no markdown, no code fences:\n" +
      '{"date":"YYYY-MM-DD from the record date on the sheet, omit if absent",' +
      '"weight":number,"fatPct":number,"fatMass":number,"skm":number,"muscle":number,' +
      '"ffm":number,"tbw":number,"protein":number,"mineral":number,"abdominal":number,' +
      '"bmr":number,"tee":number,' +
      '"segFat":{"la":number,"ra":number,"tr":number,"ll":number,"rl":number},' +
      '"segMuscle":{"la":number,"ra":number,"tr":number,"ll":number,"rl":number}}',

    summary: function () {
      var d = this.dates();
      if (!d.length) return "No body composition scans recorded.";
      var self = this, last = this.data[d[d.length - 1]];
      var bits = [];
      FIELDS.forEach(function (f) {
        if (last[f[1]] == null) return;
        var dl = self.delta(f[1]);
        bits.push(f[0] + " " + last[f[1]] + (f[2] ? " " + f[2] : "") +
          (dl !== null ? " (" + (dl >= 0 ? "+" : "") + dl + " since previous scan)" : ""));
      });
      var out = "Body composition scans: " + d.length + ", latest " + d[d.length - 1] + ". " + bits.join("; ") + ".";
      if (last.segMuscle) {
        out += " Segmental muscle kg: " + SEG.filter(function (s) { return last.segMuscle[s[1]] != null; })
          .map(function (s) { return s[0] + " " + last.segMuscle[s[1]]; }).join(", ") + ".";
      }
      if (d.length > 1) {
        var first = this.data[d[0]];
        if (first.skm != null && last.skm != null) {
          out += " Skeletal muscle has moved " + (last.skm - first.skm >= 0 ? "up " : "down ") +
            Math.abs(Math.round((last.skm - first.skm) * 10) / 10) + " kg since " + d[0] + ".";
        }
        if (first.fatMass != null && last.fatMass != null) {
          out += " Fat mass has moved " + (last.fatMass - first.fatMass >= 0 ? "up " : "down ") +
            Math.abs(Math.round((last.fatMass - first.fatMass) * 10) / 10) + " kg over the same span.";
        }
      }
      return out;
    }
  };

  App.comp = comp;
})(window.App = window.App || {});
