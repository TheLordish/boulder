/* gym.js — training log.
   Model:
     gym:plan            { lifts:{id:{id,name}}, days:[{id,name,liftIds:[]}] }
     gymses:<YYYY-MM-DD> [ {dayId, at, entries:[{liftId, sets:[{w,r}]}]} ]
   Sessions are keyed by date so the store can page them the same way food days
   are paged, and a single day can hold more than one session. */
(function (App) {
  "use strict";

  var el = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var iso = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var today = function () { return iso(new Date()); };
  var uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); };

  var DEFAULT_PLAN = {
    lifts: {},
    days: []
  };
  var SEED = [
    ["Push", [["Chest", ["Bench press", "Incline dumbbell press"]],
              ["Shoulders", ["Overhead press", "Lateral raise"]],
              ["Triceps", ["Triceps pushdown", "Overhead extension"]]]],
    ["Pull", [["Back", ["Pull-up", "Barbell row", "Lat pulldown"]],
              ["Rear delts", ["Face pull"]],
              ["Biceps", ["Barbell curl", "Hammer curl"]]]],
    ["Legs", [["Quads", ["Squat", "Leg press"]],
              ["Hamstrings", ["Romanian deadlift", "Leg curl"]],
              ["Calves", ["Calf raise"]]]]
  ];

  var gym = {
    plan: null,
    open: null,          // the session being edited
    view: "session",     // session | plan | trends
    trendLift: null,

    /* ---- persistence ---- */
    load: function () {
      this.plan = App.store.get("gym:plan", null);
      if (!this.plan) { this.plan = JSON.parse(JSON.stringify(DEFAULT_PLAN)); this.seed(); }
      if (!this.plan.lifts) this.plan.lifts = {};
      if (!this.plan.days) this.plan.days = [];
      this.upgrade();
    },
    savePlan: function () { App.store.set("gym:plan", this.plan); },
    seed: function () {
      var self = this;
      SEED.forEach(function (d) {
        var day = { id: uid(), name: d[0], groups: [] };
        d[1].forEach(function (grp) {
          var group = { id: uid(), name: grp[0], liftIds: [] };
          grp[1].forEach(function (n) {
            var l = { id: uid(), name: n };
            self.plan.lifts[l.id] = l;
            group.liftIds.push(l.id);
          });
          day.groups.push(group);
        });
        self.plan.days.push(day);
      });
      this.savePlan();
    },

    /* Older plans stored a flat liftIds array on the day. Fold it into one
       unnamed group so nothing is lost and every reader can assume groups. */
    upgrade: function () {
      var changed = false;
      this.plan.days.forEach(function (d) {
        if (!d.groups) {
          d.groups = (d.liftIds && d.liftIds.length)
            ? [{ id: uid(), name: "Lifts", liftIds: d.liftIds.slice() }] : [];
          delete d.liftIds;
          changed = true;
        }
      });
      if (changed) this.savePlan();
    },
    dayLifts: function (day) {
      var out = [];
      (day.groups || []).forEach(function (g) { out = out.concat(g.liftIds); });
      return out;
    },
    sessions: function (date) { return App.store.get("gymses:" + date, []); },
    saveSessions: function (date, list) {
      if (list && list.length) App.store.set("gymses:" + date, list);
      else App.store.remove("gymses:" + date);
    },
    allDates: function () {
      return App.store.keys("gymses:").map(function (k) { return k.slice(7); }).sort();
    },

    /* ---- analysis ---- */
    // Epley, the usual gym-floor estimate. Capped at 12 reps because it drifts
    // badly above that and would flatter a light high-rep set.
    e1rm: function (w, r) {
      if (!w || !r) return 0;
      if (r === 1) return w;
      if (r > 12) r = 12;
      return w * (1 + r / 30);
    },
    bestSet: function (entry) {
      var best = null, self = this;
      (entry.sets || []).forEach(function (s) {
        var v = self.e1rm(s.w, s.r);
        if (!best || v > best.v) best = { v: v, w: s.w, r: s.r };
      });
      return best;
    },
    volume: function (entry) {
      return (entry.sets || []).reduce(function (a, s) { return a + (s.w || 0) * (s.r || 0); }, 0);
    },
    /* Every recorded appearance of one lift, oldest first. */
    history: function (liftId) {
      var self = this, out = [];
      this.allDates().forEach(function (date) {
        self.sessions(date).forEach(function (s) {
          (s.entries || []).forEach(function (e) {
            if (e.liftId !== liftId || !(e.sets || []).length) return;
            var b = self.bestSet(e);
            out.push({ date: date, best: b, volume: self.volume(e), sets: e.sets });
          });
        });
      });
      return out;
    },
    /* The previous time this lift was trained, for the comparison line. */
    lastTime: function (liftId, beforeDate) {
      var h = this.history(liftId).filter(function (x) { return x.date < beforeDate; });
      return h.length ? h[h.length - 1] : null;
    },

    /* ---- session editing ---- */
    startSession: function (dayId) {
      var day = this.plan.days.filter(function (d) { return d.id === dayId; })[0];
      if (!day) return;
      var list = this.sessions(today());
      var s = { id: uid(), dayId: dayId, at: new Date().toISOString(),
        entries: this.dayLifts(day).map(function (id) { return { liftId: id, sets: [] }; }) };
      list.push(s);
      this.saveSessions(today(), list);
      this.open = s.id;
      this.view = "session";
      this.render();
    },
    current: function () {
      var self = this, found = null;
      this.sessions(today()).forEach(function (s) { if (s.id === self.open) found = s; });
      return found;
    },
    commit: function (session) {
      var list = this.sessions(today()).map(function (s) { return s.id === session.id ? session : s; });
      this.saveSessions(today(), list);
    },
    addSet: function (liftId, w, r) {
      var s = this.current(); if (!s) return;
      w = Number(w); r = Number(r);
      if (!isFinite(w) || w < 0 || !isFinite(r) || r <= 0) return false;
      var e = s.entries.filter(function (x) { return x.liftId === liftId; })[0];
      if (!e) { e = { liftId: liftId, sets: [] }; s.entries.push(e); }
      e.sets.push({ w: Math.round(w * 4) / 4, r: Math.round(r) });
      this.commit(s); this.render();
      return true;
    },
    dropSet: function (liftId, i) {
      var s = this.current(); if (!s) return;
      var e = s.entries.filter(function (x) { return x.liftId === liftId; })[0];
      if (!e) return;
      e.sets.splice(i, 1);
      this.commit(s); this.render();
    },
    endSession: function () {
      var s = this.current();
      if (s) {
        var kept = s.entries.filter(function (e) { return (e.sets || []).length; });
        if (!kept.length) {
          this.saveSessions(today(), this.sessions(today()).filter(function (x) { return x.id !== s.id; }));
        } else { s.entries = kept; this.commit(s); }
      }
      this.open = null;
      this.render();
      if (App.refresh) App.refresh();
    },

    /* ---- plan editing ---- */
    addDay: function (name) {
      name = String(name || "").trim(); if (!name) return;
      this.plan.days.push({ id: uid(), name: name, groups: [] });
      this.savePlan(); this.render();
    },
    removeDay: function (id) {
      this.plan.days = this.plan.days.filter(function (d) { return d.id !== id; });
      this.savePlan(); this.render();
    },
    addGroup: function (dayId, name) {
      name = String(name || "").trim(); if (!name) return;
      var day = this.plan.days.filter(function (d) { return d.id === dayId; })[0];
      if (!day) return;
      day.groups.push({ id: uid(), name: name, liftIds: [] });
      this.savePlan(); this.render();
    },
    removeGroup: function (dayId, gid) {
      var day = this.plan.days.filter(function (d) { return d.id === dayId; })[0];
      if (!day) return;
      day.groups = day.groups.filter(function (g) { return g.id !== gid; });
      this.savePlan(); this.render();
    },
    addLift: function (dayId, groupId, name) {
      name = String(name || "").trim(); if (!name) return;
      var day = this.plan.days.filter(function (d) { return d.id === dayId; })[0];
      if (!day) return;
      var group = day.groups.filter(function (g) { return g.id === groupId; })[0];
      if (!group) return;
      var self = this, existing = null;
      Object.keys(this.plan.lifts).forEach(function (k) {
        if (self.plan.lifts[k].name.toLowerCase() === name.toLowerCase()) existing = k;
      });
      var id = existing || uid();
      if (!existing) this.plan.lifts[id] = { id: id, name: name };
      if (group.liftIds.indexOf(id) === -1) group.liftIds.push(id);
      this.savePlan(); this.render();
    },
    removeLift: function (dayId, groupId, liftId) {
      var day = this.plan.days.filter(function (d) { return d.id === dayId; })[0];
      if (!day) return;
      var group = day.groups.filter(function (g) { return g.id === groupId; })[0];
      if (!group) return;
      group.liftIds = group.liftIds.filter(function (x) { return x !== liftId; });
      this.savePlan(); this.render();
    },
    /* Order is the point of a preset: the sequence you actually lift in.
       Everything reorderable moves the same way. */
    moveIn: function (arr, i, dir) {
      var j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return false;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      return true;
    },
    moveLift: function (dayId, groupId, liftId, dir) {
      var day = this.plan.days.filter(function (d) { return d.id === dayId; })[0];
      if (!day) return;
      var grp = day.groups.filter(function (g) { return g.id === groupId; })[0];
      if (!grp) return;
      if (this.moveIn(grp.liftIds, grp.liftIds.indexOf(liftId), dir)) { this.savePlan(); this.render(); }
    },
    moveGroup: function (dayId, groupId, dir) {
      var day = this.plan.days.filter(function (d) { return d.id === dayId; })[0];
      if (!day) return;
      var i = day.groups.map(function (g) { return g.id; }).indexOf(groupId);
      if (this.moveIn(day.groups, i, dir)) { this.savePlan(); this.render(); }
    },
    moveDay: function (dayId, dir) {
      var i = this.plan.days.map(function (d) { return d.id; }).indexOf(dayId);
      if (this.moveIn(this.plan.days, i, dir)) { this.savePlan(); this.render(); }
    },
    /* Copy a day, so a new preset starts from one that already works. */
    duplicateDay: function (dayId) {
      var day = this.plan.days.filter(function (d) { return d.id === dayId; })[0];
      if (!day) return;
      var copy = JSON.parse(JSON.stringify(day));
      copy.id = uid();
      copy.name = day.name + " copy";
      copy.groups.forEach(function (g) { g.id = uid(); });
      this.plan.days.push(copy);
      this.savePlan(); this.render();
    },
    renameDay: function (dayId, name) {
      name = String(name || "").trim(); if (!name) return;
      var day = this.plan.days.filter(function (d) { return d.id === dayId; })[0];
      if (!day) return;
      day.name = name.slice(0, 24);
      this.savePlan(); this.render();
    },

    groupOf: function (day, liftId) {
      var found = null;
      (day.groups || []).forEach(function (g) {
        if (g.liftIds.indexOf(liftId) > -1) found = g;
      });
      return found;
    },

    /* ---- context for the assistant ---- */
    summary: function () {
      var self = this, dates = this.allDates();
      if (!dates.length) return "No training logged.";
      var L = [];
      L.push("Training split: " + this.plan.days.map(function (d) {
        return d.name + " [" + (d.groups || []).map(function (gr) {
          return gr.name + ": " + gr.liftIds.map(function (i) {
            return self.plan.lifts[i] ? self.plan.lifts[i].name : "?"; }).join(", ");
        }).join("; ") + "]";
      }).join("; ") + ".");
      L.push("Sessions logged: " + dates.length + ", most recent " + dates[dates.length - 1] + ".");
      var lines = [];
      Object.keys(this.plan.lifts).forEach(function (id) {
        var h = self.history(id);
        if (!h.length) return;
        var first = h[0], last = h[h.length - 1];
        var d = last.best.v - first.best.v;
        lines.push(self.plan.lifts[id].name + ": last " + last.best.w + " kg x " + last.best.r +
          " on " + last.date + ", estimated 1RM " + Math.round(last.best.v) +
          (h.length > 1 ? ", " + (d >= 0 ? "up " : "down ") + Math.abs(Math.round(d)) +
            " kg since " + first.date : "") + ", " + h.length + " sessions");
      });
      if (lines.length) L.push("Lifts:\n" + lines.join("\n"));
      return L.join("\n");
    },

    render: function () { App.gymRender(); }
  };

  App.gym = gym;
})(window.App = window.App || {});
