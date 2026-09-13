/* native.js — everything that only exists once the app is a real package.

   Loads harmlessly in a browser: every entry point checks Capacitor is present
   and falls back to the web behaviour, so the same source serves both the
   GitHub Pages version and the APK.

   Three things the shell unlocks:
     - notifications the OS delivers with the app closed
     - Health Connect, which is where Samsung Health writes its data
     - a real filesystem, so backups can happen without you remembering */
(function (App) {
  "use strict";

  var C = window.Capacitor;
  var native = {
    is: function () { return !!(C && C.isNativePlatform && C.isNativePlatform()); },
    plugin: function (name) { return C && C.Plugins ? C.Plugins[name] : null; },

    /* ─────────── notifications ───────────
       Android fires these, so the text must exist before the moment arrives.
       We write tomorrow's lines whenever the app is open and schedule them
       ahead. Two days of runway means missing a day of opening the app costs
       nothing. */
    LN: function () { return this.plugin("LocalNotifications"); },

    scheduleAhead: async function () {
      var LN = this.LN();
      if (!LN || !App.reminders) return;
      var slots = App.reminders.list();
      try {
        var perm = await LN.checkPermissions();
        if (perm.display !== "granted") {
          perm = await LN.requestPermissions();
          if (perm.display !== "granted") return;
        }
        var pending = await LN.getPending();
        if (pending && pending.notifications && pending.notifications.length) {
          await LN.cancel({ notifications: pending.notifications });
        }
        if (!slots.length) return;

        var out = [], now = new Date(), id = 1;
        for (var day = 0; day < 2; day++) {
          for (var i = 0; i < slots.length; i++) {
            var p = slots[i].split(":");
            var at = new Date(now);
            at.setDate(at.getDate() + day);
            at.setHours(+p[0], +p[1], 0, 0);
            if (at <= now) continue;
            // written now, delivered later; the fallback is used if there is
            // no key or no connection at scheduling time
            var body = await App.reminders.compose();
            out.push({
              id: id++, title: "Boulder", body: body,
              schedule: { at: at, allowWhileIdle: true },
              smallIcon: "ic_stat_boulder"
            });
          }
        }
        if (out.length) await LN.schedule({ notifications: out });
        App.store.set("scheduledAt", new Date().toISOString());
        return out.length;
      } catch (e) {
        if (window.console) console.warn("scheduling failed", e);
      }
    },

    /* ─────────── Health Connect ───────────
       Samsung Health writes into Health Connect, and this reads from there.
       Nothing is imported without being asked for, and every import is
       idempotent: a weigh-in already on file is left alone. */
    H: function () { return this.plugin("Health"); },

    PERMS: ["READ_STEPS", "READ_ACTIVE_CALORIES", "READ_WEIGHT",
            "READ_BODY_FAT", "READ_LEAN_BODY_MASS", "READ_WORKOUTS"],

    healthAvailable: async function () {
      var H = this.H();
      if (!H) return { available: false, reason: "not a native build" };
      try {
        var r = await H.isHealthAvailable();
        return { available: !!r.available, reason: r.available ? "" : "Health Connect is not set up on this phone" };
      } catch (e) { return { available: false, reason: (e && e.message) || "unavailable" }; }
    },

    askHealth: async function () {
      var H = this.H();
      if (!H) return false;
      try {
        await H.requestHealthPermissions({ permissions: this.PERMS });
        var c = await H.checkHealthPermissions({ permissions: this.PERMS });
        var granted = {};
        (c.permissions || []).forEach(function (p) {
          Object.keys(p).forEach(function (k) { granted[k] = p[k]; });
        });
        App.store.set("healthPerms", granted);
        return granted;
      } catch (e) { return false; }
    },

    openHealthSettings: function () {
      var H = this.H();
      if (H) H.openHealthConnectSettings().catch(function () {});
    },

    iso: function (d) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
        "-" + String(d.getDate()).padStart(2, "0");
    },

    /* Pull the last N days and merge. Returns a summary of what changed. */
    syncHealth: async function (days) {
      var H = this.H();
      if (!H) return null;
      days = days || 30;
      var end = new Date(), start = new Date();
      start.setDate(start.getDate() - days);
      var range = { startDate: start.toISOString(), endDate: end.toISOString() };
      var out = { weights: 0, fat: 0, lean: 0, steps: 0, active: 0, workouts: 0, errors: [] };
      var self = this;

      // weigh-ins: only fill days you have not already recorded yourself
      try {
        var wr = await H.queryRecords(Object.assign({ dataType: "weight" }, range));
        var weights = App.store.get("weights", {});
        (wr.records || []).forEach(function (r) {
          var d = self.iso(new Date(r.startDate));
          if (weights[d] == null && r.value > 20 && r.value < 400) {
            weights[d] = Math.round(r.value * 10) / 10;
            out.weights++;
          }
        });
        if (out.weights) App.store.set("weights", weights);
      } catch (e) { out.errors.push("weight"); }

      // body fat and lean mass land in the scan history, which already holds them
      try {
        var comp = App.store.get("comp", {}) || {};
        var fr = await H.queryRecords(Object.assign({ dataType: "body-fat" }, range));
        (fr.records || []).forEach(function (r) {
          var d = self.iso(new Date(r.startDate));
          comp[d] = comp[d] || {};
          if (comp[d].fatPct == null) { comp[d].fatPct = Math.round(r.value * 10) / 10; out.fat++; }
        });
        var lr = await H.queryRecords(Object.assign({ dataType: "lean-body-mass" }, range));
        (lr.records || []).forEach(function (r) {
          var d = self.iso(new Date(r.startDate));
          comp[d] = comp[d] || {};
          if (comp[d].ffm == null) { comp[d].ffm = Math.round(r.value * 10) / 10; out.lean++; }
        });
        if (out.fat || out.lean) {
          App.store.set("comp", comp);
          if (App.comp) App.comp.load();
        }
      } catch (e) { out.errors.push("body composition"); }

      // steps and active energy per day, which is what sharpens maintenance
      try {
        var act = App.store.get("activity", {});
        var sr = await H.queryAggregated(Object.assign({ dataType: "steps", bucket: "day" }, range));
        (sr.aggregatedData || []).forEach(function (s) {
          var d = self.iso(new Date(s.startDate));
          act[d] = act[d] || {};
          act[d].steps = Math.round(s.value);
          out.steps++;
        });
        var ar = await H.queryAggregated(Object.assign({ dataType: "active-calories", bucket: "day" }, range));
        (ar.aggregatedData || []).forEach(function (s) {
          var d = self.iso(new Date(s.startDate));
          act[d] = act[d] || {};
          act[d].active = Math.round(s.value);
          out.active++;
        });
        App.store.set("activity", act);
      } catch (e) { out.errors.push("steps and energy"); }

      // workouts, for cross-referencing training days
      try {
        var w = await H.queryWorkouts(Object.assign(
          { includeHeartRate: false, includeRoute: false, includeSteps: true }, range));
        App.store.set("hcWorkouts", (w.workouts || []).slice(-60).map(function (x) {
          return { at: x.startDate, type: x.workoutType, min: Math.round(x.duration / 60),
                   kcal: Math.round(x.calories || 0), source: x.sourceName };
        }));
        out.workouts = (w.workouts || []).length;
      } catch (e) { out.errors.push("workouts"); }

      App.store.set("healthSyncedAt", new Date().toISOString());
      // the store has moved underneath the app, so pull it back into memory
      if (App.reloadFromStore) App.reloadFromStore();
      return out;
    },

    /* ─────────── automatic backups ───────────
       Storage now lives inside the app, so uninstalling deletes it. A dated
       JSON written to Documents means that is recoverable without you having
       to remember anything. */
    FS: function () { return this.plugin("Filesystem"); },

    backup: async function (force) {
      var FS = this.FS();
      if (!FS || !App.exportAll) return null;
      var last = App.store.get("lastBackup", "");
      var today = this.iso(new Date());
      if (!force && last === today) return null;
      try {
        var text = await App.exportAll();
        await FS.writeFile({
          path: "Boulder/boulder-" + today + ".json",
          data: text,
          directory: "DOCUMENTS",
          encoding: "utf8",
          recursive: true
        });
        App.store.set("lastBackup", today);
        return "Boulder/boulder-" + today + ".json";
      } catch (e) {
        if (window.console) console.warn("backup failed", e);
        return null;
      }
    },

    start: function () {
      if (!this.is()) return;
      document.body.classList.add("native");
      var self = this;
      this.scheduleAhead();
      setTimeout(function () { self.backup(); }, 4000);
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) { self.scheduleAhead(); self.backup(); }
      });
    }
  };

  App.native = native;
})(window.App = window.App || {});
