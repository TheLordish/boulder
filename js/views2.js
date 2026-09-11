/* views2.js — rendering for the two new pages and the streak calendar.
   Kept apart from app.js so the older views can be migrated piece by piece. */
(function (App) {
  "use strict";

  var el = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var iso = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var today = function () { return iso(new Date()); };
  var parseISO = function (s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); };
  var short = function (s) {
    return parseISO(s).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(cls, text, fn) { var b = node("button", cls, text); b.onclick = fn; return b; }
  function iconBtn(cls, icon, fn, label) {
    var b = node("button", cls);
    b.innerHTML = App.icon(icon, 14);
    if (label) b.setAttribute("aria-label", label);
    b.onclick = fn;
    return b;
  }

  /* A bare sparkline. No axes, no grid, just the shape and the endpoints. */
  function spark(series, opts) {
    opts = opts || {};
    if (series.length < 2) {
      return node("div", "empty", opts.empty || "Two entries and a line appears.");
    }
    var W = 320, H = opts.h || 96, PL = 3, PR = 3, PT = 12, PB = 16;
    var t0 = parseISO(series[0].d).getTime();
    var t1 = parseISO(series[series.length - 1].d).getTime();
    var span = Math.max(1, t1 - t0);
    var vals = series.map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 0.4) { lo -= 0.5; hi += 0.5; }
    var padY = (hi - lo) * 0.2; lo -= padY; hi += padY;
    var X = function (d) { return PL + ((parseISO(d).getTime() - t0) / span) * (W - PL - PR); };
    var Y = function (v) { return PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB); };
    var pts = series.map(function (p) { return X(p.d).toFixed(1) + "," + Y(p.v).toFixed(1); }).join(" ");
    var area = "M" + X(series[0].d).toFixed(1) + "," + (H - PB) + " L" + pts.split(" ").join(" L") +
      " L" + X(series[series.length - 1].d).toFixed(1) + "," + (H - PB) + " Z";
    var last = series[series.length - 1], first = series[0];
    var box = node("div", "chart");
    box.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + (opts.label || "trend") + '">' +
      '<defs><linearGradient id="g' + (opts.id || "x") + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="var(--blue)" stop-opacity=".22"/>' +
      '<stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#g' + (opts.id || "x") + ')"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--ink)" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round"/>' +
      series.map(function (p) {
        return '<circle cx="' + X(p.d).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) +
          '" r="1.8" fill="var(--dim)"/>'; }).join("") +
      '<circle cx="' + X(last.d).toFixed(1) + '" cy="' + Y(last.v).toFixed(1) + '" r="3.4" fill="var(--ink)"/>' +
      '<text x="' + PL + '" y="' + (H - 3) + '" fill="var(--dim)" font-size="8.5">' + short(first.d) + "</text>" +
      '<text x="' + (W - PR) + '" y="' + (H - 3) + '" fill="var(--dim)" font-size="8.5" text-anchor="end">' +
      short(last.d) + "</text></svg>";
    return box;
  }
  App.spark = spark;

  /* ─────────────── streak calendar ─────────────── */
  App.renderStreakCal = function (state, helpers) {
    var wrap = el("stCal");
    if (!wrap) return;
    wrap.innerHTML = "";
    var m = state.stMonth || new Date();
    el("stMonthLabel").textContent = m.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    var y = m.getFullYear(), mo = m.getMonth();
    var lead = (new Date(y, mo, 1).getDay() + 6) % 7;
    var days = new Date(y, mo + 1, 0).getDate();
    for (var i = 0; i < lead; i++) wrap.appendChild(node("div", "cell blank"));
    for (var d = 1; d <= days; d++) {
      var ds = y + "-" + pad(mo + 1) + "-" + pad(d);
      var v = state.clean[ds];
      var cell = node("button", "cell" + (v === 1 ? " on" : v === -1 ? " slip" : "") +
        (ds === today() ? " today" : "") + (ds > today() ? " future" : ""));
      cell.appendChild(node("span", "dnum", d));
      if (v === 1) cell.appendChild(node("span", "mark", "\u2022"));
      else if (v === -1) cell.appendChild(node("span", "mark", "\u00d7"));
      cell.setAttribute("aria-label", ds + (v === 1 ? ", clean" : v === -1 ? ", slip" : ", not logged"));
      if (ds <= today()) {
        (function (date) {
          cell.onclick = function () { helpers.setDay(date, state.clean[date] === 1 ? -1 : state.clean[date] === -1 ? -1 : 1); };
        })(ds);
      }
      wrap.appendChild(cell);
    }
  };

  /* ─────────────── body composition ─────────────── */
  App.renderComp = function () {
    var c = App.comp, box = el("compBody");
    box.innerHTML = "";
    var dates = c.dates(), last = c.latest();

    if (c.editing !== null) return compForm(box);

    if (!dates.length) {
      box.appendChild(node("div", "empty",
        "No scans yet. Add one by hand, or photograph the printout and it will be read off the sheet."));
    } else {
      el("compBig").textContent = last.fatPct != null ? last.fatPct.toFixed(1) : "\u2014";
      el("compSub").textContent = "% body fat on " + short(dates[dates.length - 1]) +
        (dates.length > 1 ? ", " + dates.length + " scans" : "");

      var seg = node("div", "seg tiny");
      [["skm", "Muscle"], ["fatMass", "Fat"], ["fatPct", "Body fat"], ["weight", "Weight"]].forEach(function (k) {
        var b = btn("", k[1], function () { c.chartKey = k[0]; App.renderComp(); });
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(c.chartKey === k[0]));
        seg.appendChild(b);
      });
      box.appendChild(seg);
      box.appendChild(spark(c.series(c.chartKey), { id: "c", h: 104, label: "composition trend" }));

      var tbl = node("div", "kv");
      c.FIELDS.forEach(function (f) {
        if (last[f[1]] == null) return;
        var row = node("div", "kvrow");
        row.appendChild(node("span", "k", f[0]));
        row.appendChild(node("span", "v", last[f[1]] + (f[2] ? " " + f[2] : "")));
        var dl = c.delta(f[1]);
        row.appendChild(node("span", "d", dl === null ? "" : (dl > 0 ? "+" : "") + dl));
        tbl.appendChild(row);
      });
      box.appendChild(tbl);

      if (last.segMuscle || last.segFat) {
        box.appendChild(node("div", "clabel", "Segmental, muscle and fat in kg"));
        var st = node("div", "kv");
        c.SEG.forEach(function (s) {
          var mu = last.segMuscle && last.segMuscle[s[1]], fa = last.segFat && last.segFat[s[1]];
          if (mu == null && fa == null) return;
          var row = node("div", "kvrow");
          row.appendChild(node("span", "k", s[0]));
          row.appendChild(node("span", "v", mu != null ? mu : "\u2014"));
          row.appendChild(node("span", "d", fa != null ? fa : ""));
          st.appendChild(row);
        });
        box.appendChild(st);
      }

      var hist = node("div", "kv");
      dates.slice().reverse().slice(0, 8).forEach(function (d) {
        var row = node("div", "kvrow");
        var b = btn("k link", short(d), function () { App.comp.editing = d; App.renderComp(); });
        row.appendChild(b);
        row.appendChild(node("span", "v", (c.data[d].weight != null ? c.data[d].weight + " kg" : "")));
        row.appendChild(node("span", "d", (c.data[d].fatPct != null ? c.data[d].fatPct + "%" : "")));
        hist.appendChild(row);
      });
      box.appendChild(node("div", "clabel", "Scans, tap to edit"));
      box.appendChild(hist);
    }
  };

  function compForm(box) {
    var c = App.comp;
    var date = c.editing || today();
    var rec = c.at(date) || {};
    var draft = JSON.parse(JSON.stringify(rec));

    var head = node("div", "formhead");
    var di = node("input", "date"); di.type = "date"; di.value = date;
    head.appendChild(node("span", "lbl", "Scan date"));
    head.appendChild(di);
    box.appendChild(head);

    var grid = node("div", "fgrid");
    var inputs = {};
    c.FIELDS.forEach(function (f) {
      var w = node("div", "field");
      var lab = node("label", null, f[0] + (f[2] ? " (" + f[2] + ")" : ""));
      lab.setAttribute("for", "cf_" + f[1]);
      var i = node("input"); i.id = "cf_" + f[1]; i.type = "number"; i.step = "any";
      i.inputMode = "decimal"; i.value = rec[f[1]] != null ? rec[f[1]] : "";
      inputs[f[1]] = i;
      w.appendChild(lab); w.appendChild(i); grid.appendChild(w);
    });
    box.appendChild(grid);

    ["segMuscle", "segFat"].forEach(function (g) {
      box.appendChild(node("div", "clabel", g === "segMuscle" ? "Segmental muscle (kg)" : "Segmental fat (kg)"));
      var gr = node("div", "fgrid");
      inputs[g] = {};
      c.SEG.forEach(function (s) {
        var w = node("div", "field");
        var lab = node("label", null, s[0]);
        var i = node("input"); i.type = "number"; i.step = "any"; i.inputMode = "decimal";
        i.value = (rec[g] && rec[g][s[1]] != null) ? rec[g][s[1]] : "";
        inputs[g][s[1]] = i;
        w.appendChild(lab); w.appendChild(i); gr.appendChild(w);
      });
      box.appendChild(gr);
    });

    var acts = node("div", "btns");
    acts.appendChild(btn("go", "Save scan", function () {
      var out = {};
      Object.keys(inputs).forEach(function (k) {
        if (k === "segMuscle" || k === "segFat") {
          out[k] = {};
          Object.keys(inputs[k]).forEach(function (s) { out[k][s] = inputs[k][s].value; });
        } else out[k] = inputs[k].value;
      });
      if (c.put(di.value, out)) {
        if (di.value !== date && c.at(date)) c.remove(date);
        c.editing = null;
        App.renderComp();
        if (App.refresh) App.refresh();
      } else App.compStatus("Fill in at least one value.", true);
    }));
    acts.appendChild(btn("mini", "Cancel", function () { c.editing = null; App.renderComp(); }));
    if (c.at(date)) {
      acts.appendChild(btn("mini no", "Delete", function () {
        c.remove(date); c.editing = null; App.renderComp();
      }));
    }
    box.appendChild(acts);
  }

  /* ─────────────── gym ─────────────── */
  App.gymRender = function () {
    var g = App.gym, box = el("gymBody");
    if (!box) return;
    box.innerHTML = "";
    ["segSession", "segPlan", "segTrends"].forEach(function (id, i) {
      var b = el(id);
      if (b) b.setAttribute("aria-selected", String(g.view === ["session", "plan", "trends"][i]));
    });
    if (g.view === "plan") return gymPlan(box);
    if (g.view === "trends") return gymTrends(box);
    return gymSession(box);
  };

  function gymSession(box) {
    var g = App.gym, s = g.current();

    if (!s) {
      var recent = g.allDates().slice(-1)[0];
      el("gymBig").textContent = g.allDates().length;
      el("gymSub").textContent = (g.allDates().length === 1 ? "session logged" : "sessions logged") +
        (recent ? ", last " + short(recent) : "");
      box.appendChild(node("div", "clabel", "Start a session"));
      var row = node("div", "chips");
      g.plan.days.forEach(function (d) {
        row.appendChild(btn("chip act", d.name + " \u00b7 " + g.dayLifts(d).length, function () { g.startSession(d.id); }));
      });
      if (!g.plan.days.length) row.appendChild(node("div", "empty", "No split defined yet. Open Plan."));
      box.appendChild(row);

      var dates = g.allDates().slice().reverse().slice(0, 10);
      if (dates.length) {
        box.appendChild(node("div", "clabel", "Recent"));
        var list = node("div", "kv");
        dates.forEach(function (date) {
          g.sessions(date).forEach(function (ses) {
            var day = g.plan.days.filter(function (d) { return d.id === ses.dayId; })[0];
            var vol = (ses.entries || []).reduce(function (a, e) { return a + g.volume(e); }, 0);
            var sets = (ses.entries || []).reduce(function (a, e) { return a + (e.sets || []).length; }, 0);
            var r = node("div", "kvrow");
            r.appendChild(node("span", "k", short(date)));
            r.appendChild(node("span", "v", (day ? day.name : "Session") + ", " + sets + " sets"));
            r.appendChild(node("span", "d", Math.round(vol).toLocaleString() + " kg"));
            list.appendChild(r);
          });
        });
        box.appendChild(list);
      }
      return;
    }

    var day = g.plan.days.filter(function (d) { return d.id === s.dayId; })[0];
    var totalSets = s.entries.reduce(function (a, e) { return a + (e.sets || []).length; }, 0);
    var totalVol = s.entries.reduce(function (a, e) { return a + g.volume(e); }, 0);
    el("gymBig").textContent = totalSets;
    el("gymSub").textContent = (day ? day.name : "Session") + ", " +
      Math.round(totalVol).toLocaleString() + " kg moved";

    var seenGroup = null;
    s.entries.forEach(function (e) {
      var lift = g.plan.lifts[e.liftId];
      if (!lift) return;
      var grp = day ? g.groupOf(day, e.liftId) : null;
      if (grp && grp.id !== seenGroup) {
        seenGroup = grp.id;
        box.appendChild(node("div", "grouphead", grp.name));
      }

      var prev = g.lastTime(e.liftId, today());
      var card = node("div", "lift");

      var h = node("div", "lifthead");
      h.appendChild(node("span", "ln", lift.name));
      card.appendChild(h);

      /* What you did last time, in full, so you can beat it set for set
         rather than guessing from a single best. */
      if (prev) {
        var lastRow = node("div", "lastsets");
        lastRow.appendChild(node("span", "lbl2", short(prev.date)));
        prev.sets.forEach(function (st) {
          lastRow.appendChild(node("span", "ghost-set", st.w + "\u00d7" + st.r));
        });
        lastRow.appendChild(node("span", "lbl2 vol", Math.round(prev.volume) + " kg"));
        card.appendChild(lastRow);
      } else {
        card.appendChild(node("div", "lastsets", "first time on this lift"));
      }

      if ((e.sets || []).length) {
        var sr = node("div", "sets");
        e.sets.forEach(function (st, i) {
          var pill = node("button", "setpill", st.w + " \u00d7 " + st.r);
          if (prev && g.e1rm(st.w, st.r) > prev.best.v) pill.className += " pr";
          pill.setAttribute("aria-label", "Remove set " + (i + 1));
          pill.onclick = function () { g.dropSet(e.liftId, i); };
          sr.appendChild(pill);
        });
        var vol = g.volume(e);
        if (prev) {
          var d = vol - prev.volume;
          sr.appendChild(node("span", "voldelta " + (d >= 0 ? "up" : "down"),
            (d >= 0 ? "+" : "") + Math.round(d) + " kg"));
        }
        card.appendChild(sr);
      }

      var add = node("div", "setadd");
      var w = node("input"); w.type = "number"; w.inputMode = "decimal"; w.step = "0.5";
      w.placeholder = prev ? String(prev.sets[prev.sets.length - 1].w) : "kg";
      w.setAttribute("aria-label", "Weight for " + lift.name);
      var x = node("span", "x", "\u00d7");
      var r = node("input"); r.type = "number"; r.inputMode = "numeric";
      r.placeholder = prev ? String(prev.sets[prev.sets.length - 1].r) : "reps";
      r.setAttribute("aria-label", "Reps for " + lift.name);
      var go = btn("mini ok", "Add", function () {
        if (g.addSet(e.liftId, w.value || w.placeholder, r.value || r.placeholder)) { w.value = ""; r.value = ""; }
      });
      r.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); go.click(); } });
      add.appendChild(w); add.appendChild(x); add.appendChild(r); add.appendChild(go);
      card.appendChild(add);
      box.appendChild(card);
    });

    var end = node("div", "btns");
    end.appendChild(btn("go", "Finish session", function () { g.endSession(); }));
    box.appendChild(end);
  }

  function gymPlan(box) {
    var g = App.gym;
    el("gymBig").textContent = g.plan.days.length;
    el("gymSub").textContent = "presets, " + Object.keys(g.plan.lifts).length + " lifts";

    g.plan.days.forEach(function (d, di) {
      var card = node("div", "lift preset");

      var h = node("div", "lifthead");
      var nm = node("button", "ln daylabel", d.name);
      nm.setAttribute("aria-label", "Rename " + d.name);
      nm.onclick = function () {
        var t = window.prompt("Name this preset", d.name);
        if (t) g.renameDay(d.id, t);
      };
      h.appendChild(nm);
      h.appendChild(mover(di > 0, function () { g.moveDay(d.id, -1); }, "up", "Move " + d.name + " up"));
      h.appendChild(mover(di < g.plan.days.length - 1, function () { g.moveDay(d.id, 1); }, "down", "Move " + d.name + " down"));
      h.appendChild(iconBtn("cpx", "plus", function () { g.duplicateDay(d.id); }, "Duplicate " + d.name));
      h.appendChild(iconBtn("cpx", "trash", function () { g.removeDay(d.id); }, "Remove " + d.name));
      card.appendChild(h);

      (d.groups || []).forEach(function (grp, gi) {
        var gh = node("div", "grouprow");
        gh.appendChild(node("span", "gname", grp.name));
        gh.appendChild(mover(gi > 0, function () { g.moveGroup(d.id, grp.id, -1); }, "up", "Move " + grp.name + " up"));
        gh.appendChild(mover(gi < d.groups.length - 1, function () { g.moveGroup(d.id, grp.id, 1); }, "down", "Move " + grp.name + " down"));
        gh.appendChild(iconBtn("cpx", "x", function () { g.removeGroup(d.id, grp.id); }, "Remove " + grp.name));
        card.appendChild(gh);

        var list = node("div", "orderlist");
        grp.liftIds.forEach(function (id, li) {
          var l = g.plan.lifts[id];
          if (!l) return;
          var r = node("div", "orderrow");
          r.appendChild(node("span", "onum", li + 1));
          r.appendChild(node("span", "oname", l.name));
          r.appendChild(mover(li > 0, function () { g.moveLift(d.id, grp.id, id, -1); }, "up", "Move " + l.name + " up"));
          r.appendChild(mover(li < grp.liftIds.length - 1, function () { g.moveLift(d.id, grp.id, id, 1); }, "down", "Move " + l.name + " down"));
          r.appendChild(iconBtn("cpx", "x", function () { g.removeLift(d.id, grp.id, id); }, "Remove " + l.name));
          list.appendChild(r);
        });
        card.appendChild(list);

        var addL = node("div", "setadd");
        var li2 = node("input"); li2.type = "text"; li2.placeholder = "add a lift to " + grp.name;
        li2.style.flex = "1";
        var lg = btn("mini ok", "Add", function () { g.addLift(d.id, grp.id, li2.value); li2.value = ""; });
        li2.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); lg.click(); } });
        addL.appendChild(li2); addL.appendChild(lg);
        card.appendChild(addL);
      });

      var addG = node("div", "setadd");
      var gi2 = node("input"); gi2.type = "text"; gi2.placeholder = "add a muscle group";
      gi2.style.flex = "1";
      var gg = btn("mini", "Add group", function () { g.addGroup(d.id, gi2.value); gi2.value = ""; });
      gi2.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); gg.click(); } });
      addG.appendChild(gi2); addG.appendChild(gg);
      card.appendChild(addG);
      box.appendChild(card);
    });

    var nd = node("div", "setadd");
    var ni = node("input"); ni.type = "text"; ni.placeholder = "new preset, e.g. Upper";
    ni.style.flex = "1";
    var ng = btn("mini ok", "Add preset", function () { g.addDay(ni.value); ni.value = ""; });
    ni.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); ng.click(); } });
    nd.appendChild(ni); nd.appendChild(ng);
    box.appendChild(nd);
  }

  function mover(enabled, fn, dir, label) {
    var b = node("button", "cpx move" + (enabled ? "" : " off"));
    b.innerHTML = App.icon(dir === "up" ? "up" : "down", 13);
    b.setAttribute("aria-label", label);
    if (enabled) b.onclick = fn; else b.disabled = true;
    return b;
  }

  function gymTrends(box) {
    var g = App.gym;
    var ids = Object.keys(g.plan.lifts).filter(function (id) { return g.history(id).length; });
    if (!ids.length) {
      el("gymBig").textContent = "\u2014";
      el("gymSub").textContent = "nothing logged yet";
      box.appendChild(node("div", "empty", "Log a session or two and the trends appear here."));
      return;
    }
    if (!g.trendLift || ids.indexOf(g.trendLift) === -1) g.trendLift = ids[0];
    var hist = g.history(g.trendLift);
    var first = hist[0], last = hist[hist.length - 1];
    el("gymBig").textContent = Math.round(last.best.v);
    el("gymSub").textContent = "estimated 1RM, " + g.plan.lifts[g.trendLift].name +
      (hist.length > 1 ? ", " + (last.best.v >= first.best.v ? "up " : "down ") +
        Math.abs(Math.round(last.best.v - first.best.v)) + " kg since " + short(first.date) : "");

    var picker = node("div", "chips");
    ids.forEach(function (id) {
      var b = btn("chip act" + (id === g.trendLift ? " on" : ""), g.plan.lifts[id].name, function () {
        g.trendLift = id; App.gymRender();
      });
      picker.appendChild(b);
    });
    box.appendChild(picker);

    box.appendChild(spark(hist.map(function (h) { return { d: h.date, v: Math.round(h.best.v) }; }),
      { id: "g", h: 104, label: "estimated one rep max" }));

    box.appendChild(node("div", "clabel", "Session by session"));
    var list = node("div", "kv");
    hist.slice().reverse().forEach(function (h, i) {
      var r = node("div", "kvrow");
      r.appendChild(node("span", "k", short(h.date)));
      r.appendChild(node("span", "v", h.sets.map(function (s) { return s.w + "\u00d7" + s.r; }).join("  ")));
      var prevRow = hist[hist.length - 2 - i];
      var d = prevRow ? Math.round(h.best.v - prevRow.best.v) : null;
      r.appendChild(node("span", "d", d === null ? "" : (d > 0 ? "+" : "") + d));
      list.appendChild(r);
    });
    box.appendChild(list);
  }
})(window.App = window.App || {});
