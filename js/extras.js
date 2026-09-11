/* extras.js — the saved-meal library and reminders.

   A saved meal stores macros for ONE unit: one gram, one piece, one serving.
   Adding it asks how much you actually ate and scales from there, which is the
   same arithmetic the portion editor uses and never involves the model. */
(function (App) {
  "use strict";

  var el = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, "0"); };

  /* ─────────── saved meals ─────────── */
  var meals = {
    /* Convert an already-logged item into a reusable per-unit entry. */
    fromItem: function (item) {
      var amt = Number(item.amount) || 1;
      var unit = item.unit || "serving";
      // grams and millilitres are stored per 1; countable things per 1 piece
      var per = amt > 0 ? amt : 1;
      return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: item.name,
        unit: unit,
        // macros for a single unit
        kcal: item.kcal / per,
        p: (item.p || 0) / per,
        c: (item.c || 0) / per,
        f: (item.f || 0) / per,
        src: item.src === "label" || item.src === "given" ? item.src : "repeat",
        // a sensible default amount, the portion it was first saved at
        last: per
      };
    },

    all: function () { return App.store.get("meals", []); },
    save: function (list) { App.store.set("meals", list); },

    add: function (item) {
      var list = this.all();
      var m = this.fromItem(item);
      var dup = list.filter(function (x) {
        return x.name.toLowerCase() === m.name.toLowerCase() && x.unit === m.unit;
      })[0];
      var stamp = new Date().toISOString().slice(0, 10);
      if (dup) {
        // a figure you stated outranks an estimate, otherwise keep what is there
        var better = m.src === "given" || m.src === "label";
        if (better || dup.src === "estimate") {
          dup.kcal = m.kcal; dup.p = m.p; dup.c = m.c; dup.f = m.f; dup.src = m.src;
        }
        dup.n = (dup.n || 1) + 1;
        dup.seen = stamp;
        dup.last = m.last;
      } else {
        m.n = 1; m.seen = stamp;
        list.unshift(m);
      }
      // most used first, then most recent, so the list stays useful as it grows
      list.sort(function (a, b) {
        return (b.n || 1) - (a.n || 1) || String(b.seen || "").localeCompare(String(a.seen || ""));
      });
      this.save(list.slice(0, 120));
      return dup || m;
    },

    remove: function (id) {
      this.save(this.all().filter(function (m) { return m.id !== id; }));
    },

    /* Build a loggable item at the amount given. */
    portion: function (m, amount) {
      var a = Number(amount);
      if (!isFinite(a) || a <= 0) return null;
      return {
        name: m.name, amount: Math.round(a * 100) / 100, unit: m.unit,
        src: m.src === "label" ? "label" : "repeat",
        kcal: Math.round(m.kcal * a),
        p: Math.round(m.p * a),
        c: Math.round(m.c * a),
        f: Math.round(m.f * a)
      };
    },

    /* "per 100 g" reads better than "per 1 g" for dense-unit foods. */
    basisLabel: function (m) {
      var mass = m.unit === "g" || m.unit === "ml";
      var mult = mass ? 100 : 1;
      return Math.round(m.kcal * mult) + " kcal, " + Math.round(m.p * mult) + " g protein per " +
        (mass ? "100 " + m.unit : "1 " + m.unit);
    }
  };
  App.meals = meals;

  App.renderMeals = function () {
    var box = el("mealsBody");
    if (!box) return;
    box.innerHTML = "";
    var list = meals.all();
    var q = (App.mealQuery || "").toLowerCase();
    if (q) list = list.filter(function (m) { return m.name.toLowerCase().indexOf(q) > -1; });

    if (list.length > 6 || q) {
      var find = document.createElement("input");
      find.type = "text"; find.className = "mealfind";
      find.placeholder = "search your foods";
      find.value = App.mealQuery || "";
      find.oninput = function () { App.mealQuery = find.value; App.renderMeals(); };
      box.appendChild(find);
    }

    if (!list.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = q ? "Nothing matches that."
        : "Empty for now. Everything you log lands here automatically.";
      box.appendChild(e);
      return;
    }
    list.forEach(function (m) {
      var card = document.createElement("div"); card.className = "meal";
      var head = document.createElement("div"); head.className = "mealhead";
      var nm = document.createElement("span"); nm.className = "mn"; nm.textContent = m.name;
      var del = document.createElement("button"); del.className = "cpx"; del.innerHTML = App.icon("x", 14);
      del.setAttribute("aria-label", "Remove " + m.name);
      del.onclick = function () { meals.remove(m.id); App.renderMeals(); };
      head.appendChild(nm); head.appendChild(del);

      var per = document.createElement("div"); per.className = "mealper";
      per.textContent = meals.basisLabel(m) +
        (m.n > 1 ? "  \u00b7  logged " + m.n + " times" : "");

      var row = document.createElement("div"); row.className = "mealadd";
      var qty = document.createElement("input");
      qty.type = "number"; qty.inputMode = "decimal"; qty.step = "any"; qty.min = "0";
      qty.value = m.last || (m.unit === "g" || m.unit === "ml" ? 100 : 1);
      qty.setAttribute("aria-label", "Amount of " + m.name);
      var u = document.createElement("span"); u.className = "u"; u.textContent = m.unit;
      var calc = document.createElement("span"); calc.className = "calc";
      function preview() {
        var p = meals.portion(m, qty.value);
        calc.textContent = p ? p.kcal + " kcal \u00b7 " + p.p + " g protein" : "";
      }
      qty.oninput = preview; preview();
      var go = document.createElement("button"); go.className = "mini ok"; go.textContent = "Add";
      go.onclick = function () {
        var p = meals.portion(m, qty.value);
        if (!p) return;
        m.last = p.amount;
        meals.save(meals.all().map(function (x) { return x.id === m.id ? m : x; }));
        App.logSavedMeal(p);
      };
      row.appendChild(qty); row.appendChild(u); row.appendChild(calc); row.appendChild(go);

      card.appendChild(head); card.appendChild(per); card.appendChild(row);
      box.appendChild(card);
    });
  };

  /* ─────────── reminders ─────────── */
  var reminders = {
    /* Up to three slots. What each one says is decided when it fires, from
       whatever is actually missing at that moment, so a morning slot asks
       about the scale and an evening one asks about dinner. */
    list: function () {
      var v = App.store.get("reminders", null);
      if (Array.isArray(v)) return v.filter(Boolean);
      var old = App.store.get("reminder", null);      // single-slot format
      return old ? [old] : [];
    },
    setList: function (arr) {
      var clean = (arr || []).filter(function (t) { return /^\d{2}:\d{2}$/.test(t); }).slice(0, 3);
      clean.sort();
      App.store.set("reminders", clean);
      App.store.set("reminder", clean[0] || null);
      return clean;
    },
    get: function () { return this.list()[0] || null; },
    set: function (t) { this.setList(t ? [t] : []); },
    lastFired: function (slot) { return App.store.get("reminderFired:" + slot, ""); },
    markFired: function (slot, day) { App.store.set("reminderFired:" + slot, day); },

    supported: function () { return typeof Notification !== "undefined"; },
    permission: function () { return this.supported() ? Notification.permission : "unsupported"; },

    request: async function () {
      if (!this.supported()) return "unsupported";
      try { return await Notification.requestPermission(); }
      catch (e) { return Notification.permission; }
    },

    fire: function (body, tag) {
      if (this.permission() !== "granted") return false;
      try {
        new Notification("Boulder", {
          body: body, icon: "icons/icon-192.png", badge: "icons/icon-192.png",
          tag: tag || "boulder", renotify: false
        });
        return true;
      } catch (e) { return false; }
    },

    /* One short line, written from what is actually missing right now.
       Falls back to a plain sentence when there is no key or no connection. */
    RULES:
      "You write a single push notification for someone's own food and training log. " +
      "One sentence, under 90 characters, no emoji, no exclamation marks, no greeting. " +
      "Speak plainly to them, like a note they left themselves. Pick the ONE thing below " +
      "that most deserves a nudge right now and address only that. Never mention calories " +
      "they have left in a way that pressures them to eat or not eat. Never shame. If the " +
      "streak is running, acknowledging it briefly is fine. If nothing needs a nudge, say " +
      "something short and neutral.\n\nReply with the sentence only, no quotes, no JSON.",

    compose: async function () {
      var ctx = App.reminderContext ? App.reminderContext() : "";
      var fb = App.reminderFallback ? App.reminderFallback() : "Time to log.";
      if (!App.api || !App.api.hasKey() || !App.api.online()) return fb;
      try {
        var data = await App.api.call(
          [{ role: "user", content: this.RULES + "\n\nRight now:\n" + ctx }],
          { tier: "fast", max_tokens: 80 }
        );
        var t = App.api.text(data).trim().replace(/^["'“]|["'”]$/g, "");
        return (t && t.length < 160) ? t : fb;
      } catch (e) { return fb; }
    },

    /* A page can only run timers while it is open, so this does two things:
       schedules a timer for today's time if it is still ahead, and on every
       launch fires a catch-up if the time passed while the app was closed.
       Background delivery would need a push server, which this app does not have. */
    start: function () {
      var self = this;
      async function check() {
        var slots = self.list();
        if (!slots.length) return;
        var now = new Date();
        var day = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
        var soonest = null;

        /* Opening the app at night with three slots already past should not
           produce three notifications. Only the most recent overdue one is
           worth saying; the earlier ones are marked done silently. */
        var overdue = [];
        for (var i = 0; i < slots.length; i++) {
          var parts = slots[i].split(":");
          var due = new Date(now); due.setHours(+parts[0], +parts[1], 0, 0);
          if (now >= due) {
            if (self.lastFired(slots[i]) !== day) overdue.push(slots[i]);
          } else if (soonest === null || due - now < soonest) soonest = due - now;
        }
        if (overdue.length) {
          overdue.sort();
          var latest = overdue[overdue.length - 1];
          overdue.forEach(function (s) { self.markFired(s, day); });   // claim all first
          var body = await self.compose();
          self.fire(body, "boulder-daily");
        }
        clearTimeout(self._t);
        self._t = setTimeout(check, Math.min((soonest === null ? 3600000 : soonest) + 1000, 1800000));
      }
      check();
      document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
    }
  };
  App.reminders = reminders;
})(window.App = window.App || {});
