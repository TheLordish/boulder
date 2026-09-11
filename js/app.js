(function (App) {
  "use strict";

  var VERSION = "Boulder 3.5.0";
  // where a figure came from, and the only values allowed on an item
  var SRC = ["database", "web", "estimate", "given", "label"];

  // ring circumferences, must match the radii in index.html
  /* One scale used everywhere a number is judged.
       idle  nothing to conclude yet
       near  closing in, worth watching
       ok    landed inside the buffer, treat as hitting the target
       over  past the target by more than the buffer            */
  function zoneFor(value, target, buffer, opts) {
    if (!target) return "idle";
    buffer = buffer || 0;
    opts = opts || {};
    if (value > target + buffer) return opts.moreIsBetter ? "ok" : "over";
    if (value >= target - buffer) return "ok";
    if (value >= target * 0.8) return "near";
    return "idle";
  }
  App.zoneFor = zoneFor;

  var CIRC_K = 2 * Math.PI * 52;
  var CIRC_P = 2 * Math.PI * 39;

  var state = {
    view: "log", date: new Date(), month: new Date(), wMonth: new Date(), wPick: null,
    entries: [], favs: [], totals: {}, weights: {}, pantry: {}, checkpoints: [], coach: null,
    targets: { kcal: 2000, protein: 150, lookup: false, weight: 0, rate: 0.5, buffer: 100 },
    openId: null, busy: false, shown: 0, sugg: null, recipe: null, recipeBusy: false, lastRecipe: null, fit: null, fitBusy: false, fitText: "", mealSize: "meal", clean: {}, stOpen: false, thread: [], askBusy: false, carry: {}, model: null
  };

  var el = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var iso = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var dayKey = function (d) { return "day:" + iso(d); };
  var today = function () { return iso(new Date()); };
  var isToday = function (d) { return iso(d) === today(); };
  var parseISO = function (s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); };

  function prettyDate(d) {
    if (isToday(d)) return "Today";
    var y = new Date(); y.setDate(y.getDate() - 1);
    if (iso(d) === iso(y)) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }
  function monthLabel(d) { return d.toLocaleDateString(undefined, { month: "long", year: "numeric" }); }
  function setStatus(m, e) { var n = el("status"); n.textContent = m || ""; n.className = "status" + (e ? " err" : ""); }
  function dStat(m, e, w) { var n = el(w || "dStat"); n.textContent = m || ""; n.className = "dstat" + (e ? " err" : ""); }

  function load(k, f) { return App.store.get(k, f); }
  function save(k, v) {
    if (!App.store.set(k, v)) setStatus("Storage is full. Export and clear old days.", true);
  }

  var UNIT_RE = /^\s*(?:about\s+|approx\.?\s+|around\s+)?([\d.]+)\s*(kg|g|ml|l|oz|lb|tbsp|tsp|cups?|slices?|pieces?|wraps?|scoops?|eggs?|loa(?:f|ves))?\b/i;

  function splitPortion(txt) {
    var m = UNIT_RE.exec(String(txt || ""));
    if (!m) return { amount: null, unit: "" };
    return { amount: Number(m[1]), unit: (m[2] || "").toLowerCase() };
  }
  function qtyLabel(i) {
    if (i.amount == null) return i.portion || "";
    var n = i.amount % 1 === 0 ? i.amount : i.amount.toFixed(1);
    return n + (i.unit ? " " + i.unit : "");
  }
  function itemTitle(i) {
    var q = qtyLabel(i);
    return q ? q + " " + i.name : i.name;
  }

  // an item without a scalable quantity is unusable, so always end up with one
  function normaliseItem(i) {
    if (!i.src) i.src = "estimate";
    if (i.amount == null || !isFinite(Number(i.amount)) || Number(i.amount) <= 0) {
      var sp = splitPortion(i.portion);
      if (sp.amount) { i.amount = sp.amount; i.unit = sp.unit; }
      else { i.amount = 1; i.unit = "serving"; }
    }
    i.amount = Math.round(Number(i.amount) * 100) / 100;
    if (!i.unit) i.unit = "serving";
    return i;
  }

  function normalise(e) {
    if (!e.items) e.items = [{ name: e.name || "Item", kcal: e.kcal || 0, p: e.p || 0, c: e.c || 0, f: e.f || 0 }];
    if (!e.label) e.label = e.name || (e.items[0] && e.items[0].name) || "Meal";
    e.items.forEach(normaliseItem);
    return e;
  }
  function sum(items, k) { return items.reduce(function (a, i) { return a + (Number(i[k]) || 0); }, 0); }
  function entryKcal(e) { return sum(e.items, "kcal"); }
  function dayTotals(es) {
    return es.reduce(function (a, e) {
      a.kcal += sum(e.items, "kcal"); a.p += sum(e.items, "p");
      a.c += sum(e.items, "c"); a.f += sum(e.items, "f"); return a;
    }, { kcal: 0, p: 0, c: 0, f: 0 });
  }

  function stockPantry(items) {
    items.forEach(function (i) {
      if (!i.name || i.kcal <= 0) return;
      var k = i.name.toLowerCase().trim();
      var e = state.pantry[k];
      if (e) { e.n++; e.kcal = Math.round((e.kcal * 0.6) + (i.kcal * 0.4)); e.p = Math.round((e.p * 0.6) + (i.p * 0.4));
        if (i.amount) { e.amount = i.amount; e.unit = i.unit || ""; } }
      else state.pantry[k] = { name: i.name, kcal: i.kcal, p: i.p, c: i.c || 0, f: i.f || 0, n: 1,
        amount: i.amount || null, unit: i.unit || "" };
    });
  }

  async function persistDay() {
    save(dayKey(state.date), state.entries);
    var k = iso(state.date), t = dayTotals(state.entries).kcal;
    if (t > 0) state.totals[k] = t; else delete state.totals[k];
    save("totals", state.totals);
    save("pantry", state.pantry);
  }

  var BASE_RULES =
    "Break this meal into its separate components and estimate the nutrition of each one. " +
    "Levantine, Lebanese and Gulf dishes are common, as are European cafe and restaurant foods. " +
    "When no quantity is stated, assume one realistic serving as normally eaten, and account for " +
    "cooking oil, sauces and bread. List every distinct food or drink as its own item, including " +
    "sides and drinks. Do not merge different foods into one item.\n" +
    "Check your arithmetic: protein and carbohydrate are 4 kcal per gram and fat is 9, so each " +
    "item's macros must roughly account for its calorie figure.\n" +
    "IMPORTANT: any figure the person states themselves is authoritative, it has come off a label " +
    "or a scale. Copy it through exactly, never adjust, round or second-guess it. Set that item's " +
    "src to \"given\" and list the fields they supplied in a given array, for example " +
    '["kcal","protein"]. Fill in only what they did not state, choosing the remaining macros so ' +
    "they stay consistent with the figures they did give.\n" +
    "For every item give a src field: \"database\" if you used the reference data below, \"web\" if " +
    "you used a search result, \"estimate\" otherwise. Also give a portion field, a short phrase " +
    "such as \"about 200 g\" or \"1 large wrap\".\n\n" +
    "Be concise. Keep names and portions short so the whole object fits.\n" +
    "Reply with ONLY a JSON object, no markdown, no code fences, no explanation:\n" +
    '{"label":"short name for the meal, under 34 characters",' +
    '"items":[{"name":"one food, under 34 characters","amount":number,"unit":"g",' +
    '"src":"database|web|estimate|given","given":["fields the person stated, omit if none"],' +
    '"kcal":integer,"protein":integer,"carbs":integer,"fat":integer}]}';

  var ITEM_RULES =
    "Estimate one food item at the portion given. Levantine, Lebanese and Gulf dishes are common, " +
    "as are European cafe and restaurant foods. Account for cooking oil and sauces. " +
    "Protein and carbohydrate are 4 kcal per gram and fat is 9, so the macros must roughly account " +
    "for the calorie figure.\n" +
    "Reply with ONLY a JSON object, no markdown, no code fences, no explanation:\n" +
    '{"kcal":integer,"protein":integer,"carbs":integer,"fat":integer}';

  var PHOTO_RULES =
    "This photo is either food, or a nutrition information panel on packaging, or both. Work out " +
    "which before anything else.\n\n" +
    "IF IT IS A NUTRITION PANEL: transcribe the printed numbers exactly as printed. Never adjust, " +
    "round or sanity-check them against what you expect, the label is the truth here even if it " +
    "looks unusual. Note whether the figures are given per 100 g, per 100 ml, or per serving, and " +
    "whether a serving size or pack size is stated. Then work out the amount actually eaten: use " +
    "the note the person typed if there is one, otherwise assume one serving as the label defines " +
    "it, or the whole pack if it is clearly a single-portion pack. Scale the printed figures to " +
    "that amount arithmetically. Panels may be in Arabic, French or English. Set src to \"label\" " +
    "and put both the amount eaten and the basis you read in the portion field, for example " +
    '"60 g, label says 480 kcal/100 g". If any figure is unreadable, estimate only that one and ' +
    "say so in the portion field.\n\n" +
    "IF IT IS FOOD ON A PLATE: identify each distinct food and estimate as usual, src \"estimate\".\n\n" +
    "Then follow the shared rules below.\n\n";

  var SEARCH_RULES = "\nYou have web search. Use it at most ONCE, and only for a packaged product " +
    "or a large chain with published figures. Never search for independent restaurants, home cooking, " +
    "or plain ingredients. Do not summarise what you found. The JSON object is the only output, and " +
    "it must be complete, so stop searching early rather than running out of room.";

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, r) { setTimeout(function () { r(new Error("timeout")); }, ms); })]);
  }
  async function offLookup(q) {
    var url = "https://world.openfoodfacts.org/cgi/search.pl?search_terms=" + encodeURIComponent(q) +
      "&search_simple=1&action=process&json=1&page_size=4" +
      "&fields=product_name,brands,quantity,serving_size,nutriments";
    var res = await withTimeout(fetch(url), 5000);
    if (!res.ok) throw new Error("off");
    var data = await res.json();
    return (data.products || []).map(function (p) {
      var n = p.nutriments || {}, kcal = n["energy-kcal_100g"];
      if (kcal == null && n.energy_100g != null) kcal = n.energy_100g / 4.184;
      if (kcal == null) return null;
      return { name: [p.brands, p.product_name].filter(Boolean).join(" ").slice(0, 60),
        pack: p.quantity || "", serving: p.serving_size || "", kcal100: Math.round(kcal),
        p100: Math.round((n.proteins_100g || 0) * 10) / 10,
        c100: Math.round((n.carbohydrates_100g || 0) * 10) / 10,
        f100: Math.round((n.fat_100g || 0) * 10) / 10 };
    }).filter(Boolean).slice(0, 3);
  }
  function relevant(rows, query) {
    var words = query.toLowerCase().split(/[^a-z0-9]+/)
      .filter(function (w) { return w.length > 3; });
    if (!words.length) return [];
    return rows.filter(function (r) {
      var n = r.name.toLowerCase();
      var hits = words.filter(function (w) { return n.indexOf(w) > -1; }).length;
      return hits >= Math.min(2, words.length);
    });
  }
  function offBlock(rows) {
    if (!rows || !rows.length) return "";
    return "\n\nReference data from Open Food Facts, per 100 g. Use a row only if it genuinely " +
      "matches what was eaten, otherwise ignore it:\n" + rows.map(function (r) {
        return "- " + r.name + (r.pack ? " (" + r.pack + ")" : "") + (r.serving ? ", serving " + r.serving : "") +
          ": " + r.kcal100 + " kcal, " + r.p100 + " g protein, " + r.c100 + " g carbs, " + r.f100 + " g fat";
      }).join("\n");
  }
  async function askClaude(content, useSearch) {
    var data = await App.api.call([{ role: "user", content: content }],
      useSearch
        ? { tier: "fast", tools: [{ type: "web_search_20250305", name: "web_search" }] }
        : { tier: "fast" });
    var obj = App.api.json(data);
    var items = (obj.items || []).map(function (i) {
      var am = Number(i.amount);
      return { name: String(i.name || "Item").slice(0, 44),
        amount: isFinite(am) && am > 0 ? Math.round(am * 100) / 100 : null,
        unit: String(i.unit || "").slice(0, 10).trim(),
        basis: String(i.basis || "").slice(0, 40),
        portion: String(i.portion || "").slice(0, 48),
        src: SRC.indexOf(i.src) === -1 ? "estimate" : i.src,
        given: Array.isArray(i.given) ? i.given : [],
        kcal: Math.max(0, Math.round(Number(i.kcal) || 0)), p: Math.max(0, Math.round(Number(i.protein) || 0)),
        c: Math.max(0, Math.round(Number(i.carbs) || 0)), f: Math.max(0, Math.round(Number(i.fat) || 0)) };
    }).filter(function (i) { return i.kcal > 0 || i.p > 0; });
    if (!items.length) throw new Error("empty");
    return { label: String(obj.label || items[0].name).slice(0, 44), items: items };
  }
  function fileToBase64(f) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(",")[1]); };
      r.onerror = function () { rej(new Error("read")); };
      r.readAsDataURL(f);
    });
  }
  // pull any figures the person typed, so the model cannot quietly overwrite them
  function statedNumbers(text) {
    var t = " " + String(text).toLowerCase().replace(/,/g, "") + " ";
    var out = { kcal: [], p: [], c: [], f: [] }, m, re;
    re = /(\d+(?:\.\d+)?)\s*(?:k?cals?|kcal|calories|calorie)\b/g;
    while ((m = re.exec(t))) out.kcal.push(Math.round(+m[1]));
    re = /(\d+(?:\.\d+)?)\s*(?:g|gr|grams?)?\s*(?:of\s+)?protein\b/g;
    while ((m = re.exec(t))) out.p.push(Math.round(+m[1]));
    re = /protein\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:g|gr|grams?)\b(?!\s*(?:of\s+)?(?:carb|fat|sugar|cal))/g;
    while ((m = re.exec(t))) out.p.push(Math.round(+m[1]));
    re = /(\d+(?:\.\d+)?)\s*(?:g|gr|grams?)?\s*(?:of\s+)?carb(?:s|ohydrates?)?\b/g;
    while ((m = re.exec(t))) out.c.push(Math.round(+m[1]));
    re = /(\d+(?:\.\d+)?)\s*(?:g|gr|grams?)?\s*(?:of\s+)?fat\b/g;
    while ((m = re.exec(t))) out.f.push(Math.round(+m[1]));
    ["kcal", "p", "c", "f"].forEach(function (k) {
      var seen = {}; out[k] = out[k].filter(function (v) {
        if (seen[v]) return false; seen[v] = true; return true; });
    });
    return out;
  }

  function closestTo(list, v) {
    return list.reduce(function (a, b) { return Math.abs(b - v) < Math.abs(a - v) ? b : a; }, list[0]);
  }

  function enforceStated(meal, stated) {
    var fields = [["kcal", "kcal", "calories"], ["p", "p", "protein"], ["c", "c", "carbs"], ["f", "f", "fat"]];
    var changed = [];
    fields.forEach(function (fx) {
      var vals = stated[fx[0]], key = fx[1];
      if (!vals.length) return;
      if (meal.items.length === 1) {
        if (vals.length === 1 && meal.items[0][key] !== vals[0]) {
          meal.items[0][key] = vals[0]; changed.push(fx[2]);
        }
        meal.items[0].src = "given";
        return;
      }
      meal.items.forEach(function (it) {
        var g = it.given || [];
        var flagged = g.some(function (x) {
          x = String(x).toLowerCase();
          return x.indexOf(fx[2].slice(0, 4)) === 0 || x.indexOf(key) === 0;
        });
        if (!flagged) return;
        var near = closestTo(vals, it[key]);
        if (near !== it[key]) { it[key] = near; changed.push(fx[2]); }
        it.src = "given";
      });
    });
    return changed;
  }

  /* Translate an api.js failure into something the person can act on.
     Returns true when the message has been shown and the caller should stop. */
  function fatal(err) {
    var k = err && err.kind, msg = (err && err.message) || "";
    if (k === "nokey") { setStatus("Add your API key under the gear, Data and setup.", true); return true; }
    if (k === "auth") { setStatus("Key rejected: " + (msg || "check it in Data and setup"), true); return true; }
    if (k === "credit") { setStatus("Out of credit or rate limited. Check console.anthropic.com billing.", true); return true; }
    if (k === "offline") { setStatus("No connection.", true); return true; }
    if (k === "cors") { setStatus("Blocked before reaching Anthropic. Tap Test it in Data and setup.", true); return true; }
    if (k === "rejected") { setStatus("No model accepted the request: " + msg, true); return true; }
    if (k === "http") {
      setStatus("API error " + (err.status || "") + ": " + (msg || "unknown") +
        (err.model ? " (" + err.model + ")" : ""), true);
      return true;
    }
    return false;
  }

  function setBusy(b) { state.busy = b; el("logBtn").disabled = b; el("photoBtn").disabled = b; }

  async function addEntry(meal) {
    var now = new Date();
    state.entries.push({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      time: isToday(state.date) ? pad(now.getHours()) + ":" + pad(now.getMinutes()) : "--:--",
      label: meal.label, items: meal.items });
    stockPantry(meal.items);
    if (App.meals) meal.items.forEach(function (i) { App.meals.add(i); });
    state.recipe = null; state.fit = null; state.fitText = "";
    await persistDay(); render();
  }
  /* If you have already given the figures, there is nothing for a model to work
     out. Parse it here, log it instantly, and send no request at all.
     A calorie figure is the only requirement; everything else is optional.

     Works by finding every macro fragment first and recording where it sits, so
     the portion scan can skip over them. "20 g of protein" is a macro, not a
     serving size, and the two are only distinguishable by position. */
  var RE_KCAL    = /(\d+(?:\.\d+)?)\s*(?:k?cals?|kcal|calories|calorie)\b/gi;
  var RE_MACRO_A = /(\d+(?:\.\d+)?)\s*(?:g|gr|grams?)?\s*(?:of\s+)?(protein|carb(?:s|ohydrates?)?|fat)\b/gi;
  var RE_MACRO_B = /(protein|carb(?:s|ohydrates?)?|fat)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:g|gr|grams?)?(?!\s*(?:k?cals?|kcal|calorie))/gi;
  var RE_PORTION = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|oz|lb|tbsp|tsp|cups?|slices?|pieces?|pcs?|wraps?|scoops?|eggs?|servings?)\b/gi;
  var RE_BARE_G  = /(\d+(?:\.\d+)?)\s*(?:g|gr|grams?)\b/gi;

  function scan(re, text, fn) {
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(text)) !== null) fn(m, m.index, m.index + m[0].length);
  }
  function overlaps(spans, a, b) {
    for (var i = 0; i < spans.length; i++) {
      if (a < spans[i][1] && b > spans[i][0]) return true;
    }
    return false;
  }
  var MACRO_KEY = { protein: "p", carb: "c", carbs: "c", carbohydrate: "c", carbohydrates: "c", fat: "f" };

  function localItem(text) {
    var t = String(text).replace(/[~,;]/g, " ").replace(/\s+/g, " ").trim();
    var spans = [], vals = {};

    scan(RE_KCAL, t, function (m, a, b) {
      if (vals.kcal == null) { vals.kcal = Math.round(Number(m[1])); spans.push([a, b]); }
    });
    if (vals.kcal == null) return null;              // no calories given, ask the model

    scan(RE_MACRO_A, t, function (m, a, b) {
      var k = MACRO_KEY[m[2].toLowerCase()];
      if (k && vals[k] == null && !overlaps(spans, a, b)) {
        vals[k] = Math.round(Number(m[1])); spans.push([a, b]);
      }
    });
    scan(RE_MACRO_B, t, function (m, a, b) {
      var k = MACRO_KEY[m[1].toLowerCase()];
      if (k && vals[k] == null && !overlaps(spans, a, b)) {
        vals[k] = Math.round(Number(m[2])); spans.push([a, b]);
      }
    });

    /* portion: the first weight or count that is not part of a macro fragment,
       and that sits BEFORE the calorie figure. People write the serving first
       and the macros after, so a trailing "30 g" is protein, not a portion. */
    var kcalStart = spans[0][0];
    var amount = null, unit = "";
    scan(RE_PORTION, t, function (m, a, b) {
      if (amount !== null || a >= kcalStart || overlaps(spans, a, b)) return;
      amount = Number(m[1]);
      unit = m[2].toLowerCase().replace(/s$/, "");
      if (unit === "pc") unit = "piece";
      spans.push([a, b]);
    });

    // a bare gram figure sitting after the calories is protein by convention
    if (vals.p == null) {
      var kcalEnd = spans[0][1];
      scan(RE_BARE_G, t, function (m, a, b) {
        if (vals.p != null || a < kcalEnd || overlaps(spans, a, b)) return;
        vals.p = Math.round(Number(m[1]));
        spans.push([a, b]);
      });
    }

    // whatever is left, once every recorded fragment is cut out, is the name
    spans.sort(function (x, y) { return y[0] - x[0]; });
    var name = t;
    spans.forEach(function (sp) { name = name.slice(0, sp[0]) + " " + name.slice(sp[1]); });
    name = name
      .replace(/\b(?:of|and)\b/gi, " ")
      .replace(/[^A-Za-z\u0600-\u06FF\s'-]/g, " ")
      .replace(/\s+/g, " ").trim();
    if (!name) name = "Logged item";
    name = name.charAt(0).toUpperCase() + name.slice(1);

    return {
      name: name.slice(0, 44),
      amount: amount || 1,
      unit: amount ? unit : "serving",
      src: "given",
      kcal: vals.kcal,
      p: vals.p || 0,
      c: vals.c || 0,
      f: vals.f || 0
    };
  }

  async function logText() {
    var v = el("foodInput").value.trim();
    if (!v || state.busy) return;

    var direct = localItem(v);
    if (direct) {
      el("foodInput").value = "";
      await addEntry({ label: direct.name, items: [direct] });
      setStatus("Logged from your numbers, " + direct.kcal + " kcal" +
        (direct.p ? ", " + direct.p + " g protein" : "") + ". No request sent.");
      return;
    }

    setBusy(true);
    var ref = "";
    setStatus("Checking the food database");
    try { ref = offBlock(relevant(await offLookup(v), v)); } catch (e) { ref = ""; }

    var useSearch = !!state.targets.lookup;
    setStatus(useSearch ? "Searching" : (ref ? "Matched a product" : "Working it out"));
    var meal = null, note = "";
    try {
      meal = await askClaude(BASE_RULES + (useSearch ? SEARCH_RULES : "") +
        '\n\nMeal: "' + v + '"' + ref, useSearch);
    } catch (e1) {
      if (fatal(e1)) { setBusy(false); return; }
      setStatus("Retrying without lookups");
      try {
        meal = await askClaude(BASE_RULES + '\n\nMeal: "' + v + '"', false);
        note = useSearch ? " (search got in the way, estimated instead)" : "";
      } catch (e2) {
        if (!fatal(e2)) setStatus("Couldn't read that. Try naming the dish and a rough portion.", true);
        setBusy(false);
        return;
      }
    }
    var stated = statedNumbers(v);
    var forced = enforceStated(meal, stated);
    if (forced.length) {
      var uniq = forced.filter(function (x, i) { return forced.indexOf(x) === i; });
      note += " (kept your " + uniq.join(" and ") + ")";
    }
    el("foodInput").value = "";
    await addEntry(meal);
    setStatus("Logged " + sum(meal.items, "kcal") + " kcal across " + meal.items.length +
      (meal.items.length === 1 ? " item" : " items") + note);
    setBusy(false);
  }

  /* Capture is now cheap and safe: shrink, store, and let the queue deal with
     the network. Nothing is lost if the call fails. */
  async function logPhoto(f) {
    if (!f) return;
    if (!App.photos || !App.photos.ready()) { setStatus("This browser cannot queue photos.", true); return; }
    var note = (el("foodInput") ? el("foodInput").value.trim() : "") ||
      (el("fName") ? el("fName").value.trim() : "");
    setStatus("Saving the photo");
    try {
      await App.photos.add(f, note);
      if (el("foodInput")) el("foodInput").value = "";
      if (el("fName")) el("fName").value = "";
      setStatus("Photo saved. Reading it now.");
      renderPhotoQueue();
      App.photos.drain();
    } catch (e) {
      setStatus((e && e.message) || "Could not save that photo.", true);
    }
  }

  /* Turn one queued shot into a logged meal. Throws on failure so the queue
     keeps the image and can try again. */
  App.processPhoto = async function (rec) {
    var meal = await askClaude([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: rec.data } },
      { type: "text", text: PHOTO_RULES + BASE_RULES +
        (rec.note ? '\n\nThe person also typed: "' + rec.note + '". Treat that as what they ate, ' +
          'and as authoritative for any figure it states.' : "") }
    ], false);
    if (rec.note) enforceStated(meal, statedNumbers(rec.note));

    // a shot taken yesterday belongs to yesterday
    var target = rec.day || today();
    if (target === iso(state.date)) {
      await addEntry(meal);
    } else {
      var list = load("day:" + target, []).map(normalise);
      var now = new Date(rec.at);
      list.push(normalise({
        id: rec.id, time: pad(now.getHours()) + ":" + pad(now.getMinutes()),
        label: meal.label, items: meal.items
      }));
      save("day:" + target, list);
      state.totals[target] = dayTotals(list).kcal;
      save("totals", state.totals);
      meal.items.forEach(function (i) { if (App.meals) App.meals.add(i); });
    }
    var fromLabel = meal.items.some(function (i) { return i.src === "label"; });
    setStatus("Logged " + sum(meal.items, "kcal") + " kcal" + (fromLabel ? " off the label" : "") +
      (target === today() ? "" : " to " + target));
    render();
  };

  function renderPhotoQueue() {
    var box = el("photoQueue");
    if (!box || !App.photos) return;
    App.photos.all().then(function (list) {
      box.innerHTML = "";
      if (!list.length) { box.hidden = true; return; }
      box.hidden = false;
      list.forEach(function (rec) {
        var chip = document.createElement("div");
        chip.className = "shot " + (rec.state === "working" ? "working"
          : rec.tries >= App.photos.MAX_TRIES ? "stuck" : "pending");
        var img = document.createElement("img");
        img.src = rec.thumb; img.alt = "queued photo";
        chip.appendChild(img);
        var lab = document.createElement("span");
        lab.textContent = rec.state === "working" ? "reading"
          : rec.tries >= App.photos.MAX_TRIES ? "gave up"
          : rec.tries ? "retry " + rec.tries : "waiting";
        chip.appendChild(lab);
        if (rec.error && rec.state !== "working") chip.title = rec.error;
        var x = document.createElement("button");
        x.className = "shotx";
        x.innerHTML = App.icon("x", 12);
        x.setAttribute("aria-label", "Discard this photo");
        x.onclick = function () { App.photos.remove(rec.id).then(renderPhotoQueue); };
        chip.appendChild(x);
        if (rec.state !== "working") {
          img.onclick = function () {
            rec.tries = 0; rec.error = "";
            App.photos.put(rec).then(function () { App.photos.drain(); });
          };
        }
        box.appendChild(chip);
      });
    });
  }
  App.onPhotoQueue = renderPhotoQueue;

  async function removeEntry(id) {
    state.entries = state.entries.filter(function (e) { return e.id !== id; });
    state.openId = null; await persistDay(); render();
  }
  async function removeItem(id, idx) {
    var e = state.entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return; e.items.splice(idx, 1);
    if (!e.items.length) return removeEntry(id);
    await persistDay(); render();
  }
  async function scaleItem(id, idx, newAmount) {
    var e = state.entries.filter(function (x) { return x.id === id; })[0];
    if (!e || !e.items[idx]) return;
    var it = e.items[idx];
    var n = Number(newAmount);
    if (!isFinite(n) || n <= 0) { setStatus("Give a number greater than zero.", true); return; }
    normaliseItem(it);
    n = Math.round(n * 100) / 100;
    if (n === it.amount) return;
    var k = n / it.amount, before = it.kcal, fromAmt = it.amount, fromUnit = it.unit;
    it.kcal = Math.round(it.kcal * k);
    it.p = Math.round(it.p * k);
    it.c = Math.round((it.c || 0) * k);
    it.f = Math.round((it.f || 0) * k);
    it.amount = n;
    it.portion = "";
    stockPantry([it]);
    await persistDay();
    var d = it.kcal - before;
    setStatus(fromAmt + " to " + n + " " + fromUnit + ", scaled by " + k.toFixed(2) + ": " +
      it.kcal + " kcal (" + (d > 0 ? "+" : "") + d + ")");
    render();
  }

  // typing a quantity must never reach the model when it is just a rescale
  async function applyPortion(id, idx, text) {
    var e = state.entries.filter(function (x) { return x.id === id; })[0];
    if (!e || !e.items[idx]) return;
    var it = e.items[idx];
    text = String(text || "").trim();
    if (!text) return;

    // explicit figures win outright
    var given = statedNumbers(text);
    if (given.kcal.length || given.p.length) return reEstimateItem(id, idx, text);

    var sp = splitPortion(text);
    if (sp.amount) {
      var sameUnit = !sp.unit || sp.unit === (it.unit || "").toLowerCase() ||
        (sp.unit + "s") === (it.unit || "").toLowerCase() ||
        sp.unit === ((it.unit || "").toLowerCase() + "s");
      if (sameUnit) return scaleItem(id, idx, sp.amount);   // rule of three, no network
    }
    return reEstimateItem(id, idx, text);                    // unit actually changed
  }

  async function reEstimateItem(id, idx, portion) {
    var e = state.entries.filter(function (x) { return x.id === id; })[0];
    if (!e || !e.items[idx] || state.busy) return;
    var it = e.items[idx];
    portion = String(portion || "").trim();
    if (!portion) { setStatus("Give a portion, such as 180 g or 1 large wrap.", true); return; }
    var given = statedNumbers(portion);
    if (given.kcal.length || given.p.length) {
      if (given.kcal.length) it.kcal = given.kcal[0];
      if (given.p.length) it.p = given.p[0];
      if (given.c.length) it.c = given.c[0];
      if (given.f.length) it.f = given.f[0];
      var sp0 = splitPortion(portion);
      it.portion = portion.slice(0, 48);
      if (sp0.amount) { it.amount = sp0.amount; it.unit = sp0.unit; }
      it.src = "given";
      stockPantry([it]);
      await persistDay();
      setStatus(it.name + " set to your numbers, " + it.kcal + " kcal");
      render();
      return;
    }
    setBusy(true);
    setStatus("Re-estimating " + it.name + " at " + portion);
    try {
      var data = await App.api.call([{ role: "user",
        content: ITEM_RULES + '\n\nFood: "' + it.name + '"\nPortion: "' + portion + '"' }],
        { tier: "fast" });
      var o = App.api.json(data);
      var kcal = Math.max(0, Math.round(Number(o.kcal) || 0));
      if (!kcal) throw new Error("empty");
      var before = it.kcal;
      var sp1 = splitPortion(portion);
      it.portion = portion.slice(0, 48);
      it.amount = sp1.amount; it.unit = sp1.unit;
      it.kcal = kcal;
      it.p = Math.max(0, Math.round(Number(o.protein) || 0));
      it.c = Math.max(0, Math.round(Number(o.carbs) || 0));
      it.f = Math.max(0, Math.round(Number(o.fat) || 0));
      it.src = "estimate";
      stockPantry([it]);
      await persistDay();
      var d = it.kcal - before;
      setStatus(it.name + " is now " + it.kcal + " kcal" +
        (d ? " (" + (d > 0 ? "+" : "") + d + ")" : ""));
      render();
    } catch (err) {
      setStatus("Couldn't re-estimate that portion. Try phrasing it as a weight.", true);
    }
    setBusy(false);
  }

  async function saveFav(e) {
    if (state.favs.some(function (f) { return f.label === e.label; })) { setStatus("Already a repeat"); return; }
    state.favs.unshift({ label: e.label, items: JSON.parse(JSON.stringify(e.items)) });
    state.favs = state.favs.slice(0, 24);
    save("favorites", state.favs); setStatus("Saved as a repeat"); render();
  }
  async function removeFav(l) {
    state.favs = state.favs.filter(function (f) { return f.label !== l; });
    save("favorites", state.favs); render();
  }
  async function logFav(f) {
    var items = JSON.parse(JSON.stringify(f.items));
    items.forEach(function (i) { i.src = "repeat"; });
    await addEntry({ label: f.label, items: items });
    setStatus("Logged " + f.label);
  }
  async function goToDay(d) {
    state.date = d; state.openId = null; state.shown = 0; state.recipe = null; state.fit = null;
    state.entries = (load(dayKey(d), [])).map(normalise); setStatus("");
  }
  async function changeDay(delta) {
    var d = new Date(state.date); d.setDate(d.getDate() + delta);
    if (iso(d) > today()) return;
    await goToDay(d); render();
  }
  async function saveWeight(ds, kg) {
    var v = Number(kg);
    if (!isFinite(v) || v <= 0) return;
    state.weights[ds] = Math.round(v * 10) / 10;
    save("weights", state.weights); render();
  }
  async function clearWeight(ds) { delete state.weights[ds]; save("weights", state.weights); render(); }
  function weightSeries() {
    return Object.keys(state.weights).sort().map(function (k) { return { d: k, v: state.weights[k] }; });
  }
  function smooth(s, w) {
    return s.map(function (_, i) {
      var sl = s.slice(Math.max(0, i - w + 1), i + 1);
      return sl.reduce(function (a, p) { return a + p.v; }, 0) / sl.length;
    });
  }
  function latestWeight() {
    var s = weightSeries();
    return s.length ? s[s.length - 1].v : 0;
  }

  // ---- streak ----
  // clean[date] is 1 for a clean day, -1 for a slip, absent for not logged
  var MILESTONES = [3, 7, 14, 21, 30, 45, 60, 90, 120, 180, 270, 365];
  var DAYMS = 86400000;

  function shift(ds, n) { var d = parseISO(ds); d.setDate(d.getDate() + n); return iso(d); }
  function isClean(ds) { return state.clean[ds] === 1; }
  function isSlip(ds) { return state.clean[ds] === -1; }
  function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / DAYMS); }

  function currentStreak() {
    var cur = today();
    if (isSlip(cur)) return 0;
    if (!isClean(cur)) cur = shift(cur, -1);      // today not logged yet does not break it
    var n = 0;
    while (isClean(cur)) { n++; cur = shift(cur, -1); }
    return n;
  }
  function bestStreak() {
    var keys = Object.keys(state.clean).filter(isClean).sort();
    var best = 0, run = 0, prev = null;
    keys.forEach(function (k) {
      run = (prev && shift(prev, 1) === k) ? run + 1 : 1;
      if (run > best) best = run;
      prev = k;
    });
    return Math.max(best, currentStreak());
  }
  function slipStats() {
    var slips = Object.keys(state.clean).filter(isSlip).sort();
    var gaps = [];
    for (var i = 1; i < slips.length; i++) gaps.push(daysBetween(slips[i - 1], slips[i]));
    var since = slips.length ? daysBetween(slips[slips.length - 1], today()) : null;
    var recent = null, earlier = null;
    if (gaps.length >= 2) {
      var half = Math.max(1, Math.ceil(gaps.length / 2));
      var r = gaps.slice(-half), e = gaps.slice(0, gaps.length - half);
      recent = r.reduce(function (a, b) { return a + b; }, 0) / r.length;
      if (e.length) earlier = e.reduce(function (a, b) { return a + b; }, 0) / e.length;
    }
    return { slips: slips, gaps: gaps, since: since, recent: recent, earlier: earlier };
  }
  function nextMilestone(n) {
    for (var i = 0; i < MILESTONES.length; i++) if (MILESTONES[i] > n) return MILESTONES[i];
    return null;
  }
  function streakMessage(n, st) {
    if (isSlip(today())) {
      var b = bestStreak();
      return "Logged. That run ended, the record of " + b + " day" + (b === 1 ? "" : "s") +
        " stands and the count starts again tomorrow. The useful question is what was different today, " +
        "not whether it should have happened.";
    }
    if (n === 0) return "Nothing running. Log a clean day and it starts tonight.";
    if (n < 3) return "Early. The first few days ask the most and give back the least, which is the whole difficulty.";
    if (n < 7) return "Past the opening stretch. This is usually where it starts costing less attention.";
    if (n < 14) return "Over a week. Long enough that it is becoming the default rather than an hourly decision.";
    if (n < 30) return "Weeks in. By now you have enough logged to see what actually sets it off.";
    if (n < 90) return "A month plus. The run is no longer the interesting part, the habits around it are.";
    return "Long run. Whatever you have built here is working, keep it boring.";
  }

  async function setDay(ds, val) {
    if (ds > today()) return;
    if (state.clean[ds] === val) delete state.clean[ds]; else state.clean[ds] = val;
    save("clean", state.clean);
    render();
  }
  function renderStreak() {
    var n = currentStreak(), best = bestStreak(), st = slipStats();
    var t = today(), logged = state.clean[t] !== undefined;
    el("stBig").textContent = n;
    el("stSub").textContent = (n === 1 ? "day clean" : "days clean") +
      (st.since !== null ? ", " + st.since + " since the last slip" : "") +
      ", best " + best;
    var acts = el("stStrip");
    acts.innerHTML = "";
    if (logged) {
      var tag = document.createElement("span");
      tag.style.fontSize = "0.75rem";
      tag.style.color = isSlip(t) ? "var(--warn)" : "var(--sage)";
      tag.textContent = isSlip(t) ? "slip logged" : "today logged";
      var undo = document.createElement("button");
      undo.className = "mini"; undo.textContent = "undo";
      undo.onclick = function () { setDay(t, state.clean[t]); };
      acts.appendChild(tag); acts.appendChild(undo);
    } else {
      var ok = document.createElement("button");
      ok.className = "mini ok"; ok.textContent = "Clean";
      ok.onclick = function () { setDay(t, 1); };
      var no = document.createElement("button");
      no.className = "mini no"; no.textContent = "Slipped";
      no.onclick = function () { setDay(t, -1); };
      acts.appendChild(ok); acts.appendChild(no);
    }
    var panel = el("stPanel");
    panel.innerHTML = "";

    var nums = document.createElement("div"); nums.className = "stnums";
    var cells = [[best, "best run"]];
    cells.push([st.slips.length, st.slips.length === 1 ? "slip logged" : "slips logged"]);
    if (st.recent !== null) cells.push([st.recent.toFixed(1), "day gap lately"]);
    cells.forEach(function (x) {
      var d = document.createElement("div");
      d.innerHTML = "<div class='v'>" + x[0] + "</div><div class='k'>" + x[1] + "</div>";
      nums.appendChild(d);
    });
    panel.appendChild(nums);

    App.renderStreakCal(state, { setDay: setDay });

    var nm = nextMilestone(n);
    if (nm && !isSlip(t)) {
      var bar = document.createElement("div"); bar.className = "stbar";
      var sp = document.createElement("span"); sp.style.width = Math.round(n / nm * 100) + "%";
      bar.appendChild(sp);
      var nx = document.createElement("div"); nx.className = "stnext";
      nx.textContent = (nm - n) + " more to " + nm + " days";
      panel.appendChild(bar); panel.appendChild(nx);
    }

    var msg = document.createElement("div");
    msg.className = "stmsg" + (isSlip(t) ? " reset" : "");
    msg.style.marginTop = "0.8rem";
    msg.textContent = streakMessage(n, st);
    panel.appendChild(msg);

    if (st.recent !== null) {
      var gt = document.createElement("div"); gt.className = "gaptrend";
      if (st.earlier !== null) {
        var better = st.recent > st.earlier;
        gt.innerHTML = "Gap between slips: <b class='" + (better ? "" : "down") + "'>" +
          st.recent.toFixed(1) + " days</b> lately, against " + st.earlier.toFixed(1) +
          " earlier on. " + (better ? "Stretching out." : "Tightening up.");
      } else {
        gt.innerHTML = "Average gap between slips: <b>" + st.recent.toFixed(1) + " days</b>.";
      }
      panel.appendChild(gt);
    }

    var note = document.createElement("div"); note.className = "asknote";
    note.textContent = "Tap a square to cycle it: blank, clean, slip. Nothing is ever deleted from the record.";
    panel.appendChild(note);
  }

  // ---- trend analysis ----
  var DAY = 86400000;

  function ratePerWeek(days) {
    var s = weightSeries();
    if (s.length < 3) return null;
    var sm = smooth(s, 7);
    var end = parseISO(s[s.length - 1].d).getTime();
    var cutoff = end - days * DAY;
    var i0 = 0;
    for (var i = 0; i < s.length; i++) { if (parseISO(s[i].d).getTime() >= cutoff) { i0 = i; break; } }
    if (i0 >= s.length - 1) return null;
    var spanDays = (end - parseISO(s[i0].d).getTime()) / DAY;
    if (spanDays < 3) return null;
    return ((sm[i0] - sm[sm.length - 1]) / spanDays) * 7;
  }

  function intakeWindow(days) {
    var end = new Date(), n = 0, total = 0, elapsed = 0;
    for (var i = 0; i < days; i++) {
      var d = new Date(end.getTime() - i * DAY), k = iso(d);
      elapsed++;
      if (state.totals[k]) { total += state.totals[k]; n++; }
    }
    return { avg: n ? Math.round(total / n) : 0, logged: n, elapsed: elapsed };
  }

  function estimateMaintenance(days) {
    var s = weightSeries();
    if (s.length < 6) return null;
    var sm = smooth(s, 7);
    var end = parseISO(s[s.length - 1].d).getTime(), cutoff = end - days * DAY;
    var i0 = -1;
    for (var i = 0; i < s.length; i++) { if (parseISO(s[i].d).getTime() >= cutoff) { i0 = i; break; } }
    if (i0 < 0 || i0 >= s.length - 1) return null;
    var spanDays = (end - parseISO(s[i0].d).getTime()) / DAY;
    if (spanDays < 10) return null;
    var win = intakeWindow(Math.round(spanDays));
    if (!win.avg || win.logged < spanDays * 0.6) return null;
    var kgLost = sm[i0] - sm[sm.length - 1];
    return { kcal: Math.round(win.avg + (kgLost * 7700 / spanDays)),
      days: Math.round(spanDays), adherence: Math.round(win.logged / spanDays * 100) };
  }

  function cpStatus(cp) {
    var cur = latestWeight();
    if (!cur) return { key: "near", text: "no weight yet" };
    var daysLeft = (parseISO(cp.date).getTime() - new Date().setHours(0, 0, 0, 0)) / DAY;
    var togo = cur - cp.kg;
    if (togo <= 0.05) return { key: "done", text: "reached" };
    if (daysLeft <= 0) return { key: "off", text: togo.toFixed(1) + " kg short" };
    var need = (togo / daysLeft) * 7;
    var have = ratePerWeek(21) || ratePerWeek(14) || 0;
    if (have <= 0.02) return { key: "off", text: "needs " + need.toFixed(2) + " kg/wk" };
    var ratio = have / need;
    var key = ratio >= 0.95 ? "ok" : ratio >= 0.75 ? "near" : "off";
    return { key: key, text: "needs " + need.toFixed(2) + ", doing " + have.toFixed(2) + " kg/wk" };
  }

  async function addCheckpoint(kg, date) {
    var v = Number(kg);
    if (!isFinite(v) || v <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setStatus("Give a weight and a date.", true); return;
    }
    state.checkpoints.push({ id: String(Date.now()), kg: Math.round(v * 10) / 10, date: date });
    state.checkpoints.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    save("checkpoints", state.checkpoints);
    el("cpKg").value = ""; el("cpDate").value = "";
    render();
  }
  async function removeCheckpoint(id) {
    state.checkpoints = state.checkpoints.filter(function (c) { return c.id !== id; });
    save("checkpoints", state.checkpoints);
    render();
  }

  // ---- the coach ----
  var COACH_RULES =
    "You are reading someone's fat-loss data and giving them an honest, useful read. " +
    "Be specific and quantitative, refer to their actual numbers. Be direct, no cheerleading, " +
    "no moralising about food, never shame them. If the data is too thin to conclude something, " +
    "say so rather than inventing a trend. Weight fluctuates with water and salt, so judge the " +
    "smoothed rate, not individual days. If their loss rate exceeds about 1 percent of bodyweight " +
    "per week, say plainly that it is faster than is useful and costs muscle. If protein is well " +
    "under target during a deficit, flag it, that is the thing that protects muscle. If logging " +
    "adherence is low, say that the numbers cannot be trusted yet and that is the first fix.\n\n" +
    "Reply with ONLY a JSON object, no markdown, no code fences:\n" +
    '{"status":"steady|drifting|stalled|fast|early",' +
    '"verdict":"one punchy sentence under 90 characters, the headline",' +
    '"trend":"2 to 3 sentences reading the trend and what is driving it",' +
    '"working":["1 to 3 short points, what the data says is going right"],' +
    '"watch":["1 to 3 short points, what is slipping or worth watching"],' +
    '"move":"one concrete change for the next two weeks, with a number in it",' +
    '"outlook":"one sentence on whether the checkpoints are realistic"}';

  function coachPayload() {
    var s = weightSeries(), cur = latestWeight();
    var w7 = intakeWindow(7), w14 = intakeWindow(14), w28 = intakeWindow(28);
    var maint = estimateMaintenance(28) || estimateMaintenance(21);
    var protDays = 0, protTotal = 0;
    var lines = [];
    lines.push("Tracking for " + (s.length ? Math.round((parseISO(s[s.length - 1].d) - parseISO(s[0].d)) / DAY) + " days" : "no time yet") + ".");
    if (s.length) lines.push("Start weight " + s[0].v + " kg, current " + cur + " kg, " + s.length + " weigh-ins.");
    if (state.targets.weight) lines.push("Goal weight " + state.targets.weight + " kg.");
    if (state.targets.rate) lines.push("Wants to lose " + state.targets.rate + " kg per week.");
    var r7 = ratePerWeek(10), r21 = ratePerWeek(21), r42 = ratePerWeek(42);
    if (r7 != null) lines.push("Smoothed rate last 10 days: " + r7.toFixed(2) + " kg/week.");
    if (r21 != null) lines.push("Last 3 weeks: " + r21.toFixed(2) + " kg/week.");
    if (r42 != null) lines.push("Last 6 weeks: " + r42.toFixed(2) + " kg/week.");
    lines.push("Calorie target " + state.targets.kcal + ", protein target " + state.targets.protein + " g.");
    lines.push("Average intake last 7 days " + (w7.avg || "not logged") + " kcal, logged " + w7.logged + " of 7 days.");
    lines.push("Last 14 days " + (w14.avg || "not logged") + " kcal, logged " + w14.logged + " of 14.");
    lines.push("Last 28 days " + (w28.avg || "not logged") + " kcal, logged " + w28.logged + " of 28.");
    if (maint) lines.push("Implied maintenance from intake versus weight change over " + maint.days +
      " days: about " + maint.kcal + " kcal, at " + maint.adherence + " percent logging adherence.");
    else lines.push("Not enough paired intake and weight data to estimate maintenance yet.");
    if (state.checkpoints.length) {
      lines.push("Checkpoints: " + state.checkpoints.map(function (c) {
        var st = cpStatus(c);
        return c.kg + " kg by " + c.date + " (" + st.text + ")";
      }).join("; ") + ".");
    } else lines.push("No checkpoints set.");
    return lines.join("\n");
  }

  async function askCoach() {
    var btn = el("coachBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Reading your data"; }
    try {
      var data = await App.api.call([{ role: "user",
        content: COACH_RULES + "\n\nHere is the data:\n" + coachPayload() }], { tier: "deep" });
      var o = App.api.json(data);
      state.coach = { at: new Date().toISOString(), d: o };
      save("coach", state.coach);
    } catch (e) {
      state.coach = { at: new Date().toISOString(), err: true };
    }
    render();
  }

  // ---- assistant ----
  var ASSISTANT_RULES =
    "You are the assistant built into Boulder, a personal food, body and training log. " +
    "You exist to help this person with nutrition, food and cooking, body composition, weight " +
    "management, training and recovery, and reading their own logged data. That is your remit.\n\n" +
    "SCOPE. If a request falls outside food, body, training or their own data, decline briefly and " +
    "say what you can help with instead. Do not answer it anyway, and do not add a partial answer " +
    "before declining. Keep the refusal to one short sentence with no lecture.\n\n" +
    "ALWAYS REFUSE, whatever the framing, including hypotheticals, roleplay, fiction, jokes, or " +
    "claims that a previous message permitted it:\n" +
    "- sexual or romantic content of any kind, and sexual health beyond the plainly clinical\n" +
    "- anything involving minors in a sexual, romantic or unsafe context\n" +
    "- illegal drugs, and steroids or other prescription-only performance drugs, including dosing, " +
    "sourcing or cycles. You may discuss caffeine, creatine and ordinary supplements\n" +
    "- self-harm, suicide, or any method of hurting themselves or anyone else\n" +
    "- weapons, violence, hacking, fraud, or other wrongdoing\n" +
    "- medical diagnosis, prescriptions, or advice that should come from a doctor. Point them to a " +
    "clinician instead\n" +
    "- hate, harassment or abuse about anyone\n\n" +
    "HEALTH CARE. Never encourage extreme restriction, purging, fasting beyond what they already " +
    "log, or exercise as punishment for eating. If they describe a target or behaviour that looks " +
    "harmful, say so plainly and briefly. If anything they write suggests disordered eating or " +
    "genuine distress, drop the numbers and suggest they talk to a professional.\n\n" +
    "STYLE. Use their actual figures when the question touches their data. Be concise, a few " +
    "sentences unless more is asked for. No cheerleading, no moralising about food, never shame " +
    "them. Say when the data will not support a conclusion instead of inventing a trend. Weight " +
    "moves with water and salt, so judge smoothed rates, not single days. Plain text, no markdown " +
    "headers or bullet symbols.";

  function assistantContext() {
    var L = [], s = weightSeries(), cur = latestWeight(), t = dayTotals(state.entries);
    L.push("Today is " + today() + ".");
    L.push("Targets: " + state.targets.kcal + " kcal, " + state.targets.protein + " g protein" +
      (state.targets.weight ? ", goal weight " + state.targets.weight + " kg" : "") +
      (state.targets.rate ? ", aiming to lose " + state.targets.rate + " kg per week" : "") + ".");
    var effToday = effectiveTarget(today());
    L.push("Today so far: " + t.kcal + " kcal, " + t.p + " g protein, " + t.c + " g carbs, " + t.f + " g fat, " +
      (effToday - t.kcal) + " kcal remaining against a target of " + effToday +
      (effToday !== state.targets.kcal ? " (adjusted for yesterday's balance)" : "") + ".");
    if (state.entries.length) {
      L.push("Today's meals: " + state.entries.map(function (e) {
        return e.time + " " + e.label + " [" + e.items.map(function (i) {
          return itemTitle(i) + " " + i.kcal + "kcal/" + i.p + "gP";
        }).join(", ") + "]";
      }).join("; ") + ".");
    } else L.push("Nothing logged today yet.");
    var recent = Object.keys(state.totals).sort().slice(-30);
    if (recent.length) L.push("Daily calorie totals, last " + recent.length + " logged days: " +
      recent.map(function (k) { return k.slice(5) + " " + state.totals[k]; }).join(", ") + ".");
    if (s.length) {
      L.push("Weigh-ins: start " + s[0].v + " kg on " + s[0].d + ", latest " + cur + " kg on " + s[s.length - 1].d +
        ", " + s.length + " readings.");
      var r10 = ratePerWeek(10), r21 = ratePerWeek(21);
      if (r10 != null) L.push("Smoothed rate, last 10 days " + r10.toFixed(2) + " kg/week" +
        (r21 != null ? ", last 3 weeks " + r21.toFixed(2) + " kg/week" : "") + ".");
      L.push("Recent weights: " + s.slice(-14).map(function (p) { return p.d.slice(5) + " " + p.v; }).join(", ") + ".");
    } else L.push("No weight logged.");
    var m = estimateMaintenance(28) || estimateMaintenance(21);
    if (m) L.push("Maintenance measured from their own intake versus weight change over " + m.days +
      " days: about " + m.kcal + " kcal, logging adherence " + m.adherence + " percent.");
    if (state.checkpoints.length) L.push("Checkpoints: " + state.checkpoints.map(function (c) {
      return c.kg + " kg by " + c.date + " (" + cpStatus(c).text + ")"; }).join("; ") + ".");
    var top = Object.keys(state.pantry).map(function (k) { return state.pantry[k]; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 20);
    if (top.length) L.push("Foods they eat most: " + top.map(function (i) {
      return i.name + " (" + i.kcal + " kcal, " + i.p + "gP, logged " + i.n + "x)"; }).join(", ") + ".");
    var cs = currentStreak(), ss = slipStats();
    L.push("Separate habit streak they track, unrelated to food: currently " + cs + " days, best ever " +
      bestStreak() + " days, " + ss.slips.length + " slips logged" +
      (ss.since !== null ? ", " + ss.since + " days since the last one" : "") +
      (ss.recent !== null ? ", average gap between slips " + ss.recent.toFixed(1) + " days lately" +
        (ss.earlier !== null ? " against " + ss.earlier.toFixed(1) + " earlier" : "") : "") +
      ". Only discuss this if they raise it. Treat it plainly, never with judgement or moralising, " +
      "and if they mention a slip, focus on triggers and patterns rather than on the slip itself.");
    L.push("");
    L.push("TRAINING");
    L.push(App.gym ? App.gym.summary() : "No training data.");
    L.push("");
    L.push("BODY COMPOSITION");
    L.push(App.comp ? App.comp.summary() : "No scans.");
    L.push("");
    L.push("Note: you have item-level detail only for today, and daily calorie totals for earlier days. " +
      "You can see the full training log and every body composition scan.");
    return L.join("\n");
  }

  // A cheap first pass. The model has its own instructions, but this stops the
  // blatant cases costing a request and keeps the refusal instant.
  var OFF_TOPIC = [
    /\b(sex|sexual|porn|nude|naked|horny|masturbat|orgasm|erotic|fetish|nsfw)\w*\b/i,
    /\b(steroid|anabolic|trenbolone|dianabol|clenbuterol|sarms|anavar|winstrol)\w*\b/i,
    /\b(cocaine|heroin|meth|mdma|ketamine|lsd)\b/i
  ];
  // Distress is not an off-topic request and must never get a curt refusal.
  var DISTRESS = [
    /\b(kill myself|killing myself|end my life|want to die|suicid\w*)\b/i,
    /\b(self.?harm|hurt myself|cut myself)\b/i,
    /\b(make myself (throw up|sick|vomit)|purge|purging)\b/i,
    /\b(starve myself|stop eating (entirely|completely))\b/i
  ];
  function screen(q) {
    for (var i = 0; i < DISTRESS.length; i++) if (DISTRESS[i].test(q)) return "distress";
    for (var j = 0; j < OFF_TOPIC.length; j++) if (OFF_TOPIC[j].test(q)) return "offtopic";
    return null;
  }

  async function askAssistant(q) {
    q = String(q || "").trim();
    if (!q || state.askBusy) return;
    state.thread.push({ r: "you", t: q });
    var flag = screen(q);
    if (flag === "offtopic") {
      state.thread.push({ r: "bot", t: "That is outside what this assistant does. " +
        "Ask me about your food, your training, your weight or anything in your log." });
      el("askInput").value = ""; renderAsk(); return;
    }
    if (flag === "distress") {
      state.thread.push({ r: "bot", t:
        "I am not the right thing to talk to about this, and I do not want to hand you a " +
        "calorie number in response to it.\n\n" +
        "Please talk to someone who can actually help, a doctor, a therapist, or someone you " +
        "trust. If it feels urgent, contact your local emergency services or a crisis line.\n\n" +
        "I am still here for the food and training side whenever you want it." });
      el("askInput").value = ""; renderAsk(); return;
    }
    state.askBusy = true;
    el("askInput").value = "";
    renderAsk();
    try {
      var history = state.thread.filter(function (m) { return !m.pending; }).slice(-8).map(function (m) {
        return { role: m.r === "you" ? "user" : "assistant", content: m.t };
      });
      history[history.length - 1] = { role: "user",
        content: ASSISTANT_RULES + "\n\nTheir data:\n" + assistantContext() + "\n\nTheir question: " + q };
      var data = await App.api.call(history, { tier: "deep" });
      var txt = (data.content || []).filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; }).join("\n").trim();
      state.thread.push({ r: "bot", t: txt || "No answer came back." });
    } catch (e) {
      state.thread.push({ r: "bot", t: "That failed. Try again in a moment." });
    }
    state.askBusy = false;
    renderAsk();
  }

  function renderAsk() {
    var th = el("thread"); th.innerHTML = "";
    state.thread.forEach(function (m) {
      var d = document.createElement("div");
      d.className = "msg " + (m.r === "you" ? "you" : "bot");
      d.textContent = m.t;
      th.appendChild(d);
    });
    if (state.askBusy) {
      var w = document.createElement("div"); w.className = "msg bot";
      w.style.color = "var(--muted)"; w.textContent = "Thinking";
      th.appendChild(w);
    }
    el("askSend").disabled = state.askBusy;
    th.scrollTop = th.scrollHeight;
  }

  // ---- burn equivalents ----
  /* METs from the compendium of physical activities, scaled by real bodyweight.
     kcal per minute = MET x 3.5 x kg / 200 */
  var ACTIVITIES = [
    ["Walk, brisk", 4.3], ["Cycle, easy", 6.8], ["Swim, steady", 7.0],
    ["Stairs", 8.0], ["Jog", 9.8], ["Skipping rope", 11.8]
  ];
  function burnList(extraKcal, kg) {
    var w = kg || 75;
    return {
      assumed: !kg,
      kg: w,
      items: ACTIVITIES.map(function (a) {
        var perMin = a[1] * 3.5 * w / 200;
        return { name: a[0], min: Math.round(extraKcal / perMin) };
      }).filter(function (x) { return x.min > 0 && x.min < 600; })
    };
  }

  // ---- meal suggestion from past food ----
  function suggestMeal(gapK, gapP) {
    var pool = Object.keys(state.pantry).map(function (k) { return state.pantry[k]; })
      .filter(function (i) { return i.kcal > 15 && i.kcal <= gapK * 1.12; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 40);
    if (pool.length < 2) return null;
    var best = null;
    function consider(combo) {
      var k = combo.reduce(function (a, i) { return a + i.kcal; }, 0);
      if (k > gapK * 1.06) return;
      var p = combo.reduce(function (a, i) { return a + i.p; }, 0);
      var score = Math.abs(gapK - k) - Math.min(p, Math.max(gapP, 0)) * 0.45;
      if (!best || score < best.score) best = { score: score, items: combo, kcal: k, p: p };
    }
    for (var a = 0; a < pool.length; a++) {
      consider([pool[a]]);
      for (var b = a + 1; b < pool.length; b++) {
        consider([pool[a], pool[b]]);
        for (var c = b + 1; c < pool.length && gapK > 450; c++) consider([pool[a], pool[b], pool[c]]);
      }
    }
    if (!best || Math.abs(best.kcal - gapK) > Math.max(60, gapK * 0.18)) return null;
    return best;
  }

  var RECIPE_RULES =
    "Suggest ONE simple, genuinely delicious meal that totals TARGET_K kcal and delivers at least " +
    "TARGET_P g of protein. Any cuisine in the world is fine, pick something worth eating rather " +
    "than diet food. Constraints: under 25 minutes, at most 8 ingredients, everything buyable in " +
    "an ordinary Lebanese or Gulf supermarket.\n" +
    "HARD REQUIREMENT: the ingredient calories must sum to within 5 percent of TARGET_K, so between " +
    "LOW_K and HIGH_K kcal. Adjust ingredient weights until they do. Protein must reach TARGET_P g " +
    "or more, which usually means leading with a lean protein and sizing the rest around it. " +
    "Add up your own numbers before replying and correct them if the total misses.\n" +
    "Accuracy matters more than anything else here. Give every ingredient a precise weight in grams " +
    "or millilitres, never a vague measure, and give that ingredient's kcal, protein, carbs and fat " +
    "AT THAT EXACT WEIGHT using standard reference values. Count cooking oil as an ingredient with " +
    "its own weight. Protein and carbohydrate are 4 kcal per gram and fat is 9, so every " +
    "ingredient's own macros must reconcile with its own calorie figure. Do not give a total, it " +
    "will be summed from the ingredients, so the ingredients are what must be right.\n" +
    "Method in at most 4 short steps.\n\n" +
    "Reply with ONLY a JSON object, no markdown, no code fences:\n" +
    '{"name":"dish name under 34 characters",' +
    '"blurb":"one sentence on why it tastes good and why it fits",' +
    '"ingredients":[{"name":"ingredient","amount":number,"unit":"g","kcal":integer,"protein":integer,"carbs":integer,"fat":integer}],' +
    '"steps":["short step","short step"]}';

  function reconcile(i) {
    var macroK = (i.p * 4) + (i.c * 4) + (i.f * 9);
    var fixed = false;
    if (macroK > 0 && Math.abs(macroK - i.kcal) > Math.max(25, i.kcal * 0.15)) {
      i.kcal = Math.round(macroK); fixed = true;
    }
    return fixed;
  }

  /* A gap of 1,800 kcal is a day, not a dish. Aim a single recipe at a
     realistic slice of it unless the remainder is already meal-sized. */
  function sizeOf(kind, left) {
    if (kind === "all" || left <= 900) return left;
    if (kind === "snack") return Math.max(150, Math.round(left * 0.22 / 10) * 10);
    return Math.round(left * 0.45 / 10) * 10;
  }
  function mealSize(left) { return sizeOf(state.mealSize || "meal", left); }

  function recipePrompt(gapK, gapP) {
    return RECIPE_RULES
      .replace("TARGET_K", gapK).replace("TARGET_K", gapK)
      .replace("LOW_K", Math.round(gapK * 0.95))
      .replace("HIGH_K", Math.round(gapK * 1.05))
      .replace("TARGET_P", Math.max(0, gapP)).replace("TARGET_P", Math.max(0, gapP));
  }

  async function askRecipe(gapK, gapP, retryNote) {
    if (state.busy) return;
    setBusy(true);
    state.recipeBusy = true;
    renderAdvice(dayTotals(state.entries));
    var taste = Object.keys(state.pantry).map(function (k) { return state.pantry[k]; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 14)
      .map(function (i) { return i.name; });
    var ctx = taste.length
      ? "\n\nFor flavour context, foods this person actually eats: " + taste.join(", ") +
        ". Lean towards that palate, but do not restrict yourself to those ingredients."
      : "";
    try {
      var data = await App.api.call([{ role: "user",
        content: recipePrompt(gapK, gapP) + ctx +
          (state.lastRecipe ? "\n\nDo not suggest " + state.lastRecipe + " again." : "") +
          (retryNote || "") }], { tier: "deep" });
      var o = App.api.json(data);
      var fixes = 0;
      var ings = (o.ingredients || []).map(function (x) {
        var am0 = Number(x.amount);
        var i = { name: String(x.name || "Ingredient").slice(0, 40),
          amount: isFinite(am0) && am0 > 0 ? Math.round(am0 * 100) / 100 : null,
          unit: String(x.unit || "").slice(0, 10).trim(),
          portion: String(x.qty || "").slice(0, 20), src: "estimate",
          kcal: Math.max(0, Math.round(Number(x.kcal) || 0)),
          p: Math.max(0, Math.round(Number(x.protein) || 0)),
          c: Math.max(0, Math.round(Number(x.carbs) || 0)),
          f: Math.max(0, Math.round(Number(x.fat) || 0)) };
        if (reconcile(i)) fixes++;
        return i;
      }).filter(function (i) { return i.kcal > 0; });
      if (!ings.length) throw new Error("empty");

      /* Verify rather than trust. One corrective retry, then accept and be
         honest about the miss on the card. */
      var tot = ings.reduce(function (a, i) { return a + i.kcal; }, 0);
      var prot = ings.reduce(function (a, i) { return a + i.p; }, 0);
      var offBy = Math.abs(tot - gapK) / Math.max(1, gapK);
      var shortP = gapP > 0 && prot < gapP * 0.9;
      if (!retryNote && (offBy > 0.05 || shortP)) {
        state.recipeBusy = false;
        setBusy(false);
        return askRecipe(gapK, gapP,
          "\n\nYour previous attempt came to " + tot + " kcal and " + prot + " g protein, which " +
          (offBy > 0.05 ? "misses the " + gapK + " kcal target by more than 5 percent. " : "") +
          (shortP ? "falls short of " + gapP + " g protein. " : "") +
          "Resize the ingredient weights so the totals land correctly this time.");
      }

      state.recipe = { name: String(o.name || "Recipe").slice(0, 40),
        blurb: String(o.blurb || ""), ings: ings,
        steps: (o.steps || []).slice(0, 4).map(function (x) { return String(x); }),
        fixes: fixes, gap: gapK, wantP: gapP, retried: !!retryNote };
      state.lastRecipe = state.recipe.name;
    } catch (e) {
      state.recipe = { err: true };
    }
    state.recipeBusy = false;
    setBusy(false);
    render();
  }

  function recipeCard(box, left) {
    var r = state.recipe;
    var c = document.createElement("div"); c.className = "card rec";
    var h = document.createElement("h3"); h.textContent = "Recipe idea"; c.appendChild(h);
    if (r.err) {
      var pe = document.createElement("p"); pe.textContent = "That one failed. Try again.";
      c.appendChild(pe);
    } else {
      var total = r.ings.reduce(function (a, i) { return a + i.kcal; }, 0);
      var prot = r.ings.reduce(function (a, i) { return a + i.p; }, 0);
      var nm = document.createElement("div"); nm.className = "recname"; nm.textContent = r.name;
      var bl = document.createElement("div"); bl.className = "recblurb"; bl.textContent = r.blurb;
      var ing = document.createElement("div"); ing.className = "ings";
      r.ings.forEach(function (i) {
        var row = document.createElement("div");
        var a = document.createElement("span");
        a.innerHTML = "<span class='q'>" + qtyLabel(i) + "</span> " + i.name;
        var b = document.createElement("span"); b.className = "k"; b.textContent = i.kcal;
        row.appendChild(a); row.appendChild(b); ing.appendChild(row);
      });
      var ol = document.createElement("ol"); ol.className = "steps";
      r.steps.forEach(function (st) { var li = document.createElement("li"); li.textContent = st; ol.appendChild(li); });
      var tot = document.createElement("div"); tot.className = "rectot";
      var diff = left - total;
      var pctOff = Math.round(Math.abs(total - r.gap) / Math.max(1, r.gap) * 100);
      var cls = pctOff <= 5 ? "ok" : pctOff <= 12 ? "near" : "over";
      tot.innerHTML = "<b class='" + cls + "'>" + total + " kcal</b>, " + prot + " g protein \u00b7 " +
        (pctOff <= 5 ? "within " + (pctOff || 1) + "% of your " + r.gap + " kcal gap"
          : (diff > 0 ? diff + " kcal spare" : Math.abs(diff) + " kcal over") + ", " + pctOff + "% off target") +
        (r.wantP > 0 ? (prot >= r.wantP ? ", protein covered" : ", " + (r.wantP - prot) + " g protein short") : "");
      c.appendChild(nm); c.appendChild(bl); c.appendChild(ing); c.appendChild(ol); c.appendChild(tot);
      if (r.fixes) {
        var fn = document.createElement("div"); fn.className = "fixnote";
        fn.textContent = r.fixes + (r.fixes === 1 ? " ingredient's calories were" : " ingredients' calories were") +
          " recalculated from its macros to make the numbers add up.";
        c.appendChild(fn);
      }
    }
    var acts = document.createElement("div"); acts.className = "suggacts";
    acts.style.paddingTop = "0.7rem";
    if (!r.err) {
      var log = document.createElement("button"); log.className = "ghost"; log.textContent = "Log it";
      log.onclick = function () {
        addEntry({ label: r.name, items: JSON.parse(JSON.stringify(r.ings)) });
        state.recipe = null;
      };
      acts.appendChild(log);
    }
    var again = document.createElement("button"); again.className = "ghost";
    again.textContent = "Another"; again.disabled = state.busy;
    again.onclick = function () { askRecipe(left, state.targets.protein - dayTotals(state.entries).p); };
    var back = document.createElement("button"); back.className = "ghost";
    back.textContent = "Close"; back.onclick = function () { state.recipe = null; render(); };
    acts.appendChild(again); acts.appendChild(back);
    c.appendChild(acts);
    box.appendChild(c);
  }

  var PORTION_RULES =
    "Someone has room for about TARGET_K kcal left today and wants to know how much of a specific " +
    "food they can have. Work out the largest sensible portion that fits inside that budget without " +
    "going over. Keep the proportions they described: if they name a main food plus a smaller " +
    "accompaniment, scale both together so the result is still the thing they asked for.\n" +
    "Round to portions a person would actually serve, whole teaspoons, sensible gram amounts. " +
    "Give amount as a plain number and unit separately, and keep the quantity out of the name.\n" +
    "If even a small realistic portion would blow the budget, say so plainly in the answer and give " +
    "the largest portion that does fit anyway.\n" +
    "Levantine, Lebanese and Gulf foods are common. Give each component with an exact weight or " +
    "measure and its own kcal, protein, carbs and fat at that amount, using standard reference " +
    "values. Protein and carbohydrate are 4 kcal per gram and fat is 9, so each component's macros " +
    "must reconcile with its own calorie figure. Do not give a total, it is summed from the parts.\n\n" +
    "Reply with ONLY a JSON object, no markdown, no code fences:\n" +
    '{"answer":"one sentence telling them how much they can have, in plain language",' +
    '"items":[{"name":"component","amount":number,"unit":"g","kcal":integer,"protein":integer,"carbs":integer,"fat":integer}],' +
    '"note":"optional short caveat, empty string if none"}';

  async function askPortion(text, gapK, gapP) {
    text = String(text || "").trim();
    if (!text) { setStatus("Name a food first.", true); return; }
    if (state.busy) return;
    setBusy(true);
    state.fitBusy = true;
    state.fitText = text;
    renderAdvice(dayTotals(state.entries));
    try {
      var data = await App.api.call([{ role: "user",
        content: PORTION_RULES.replace("TARGET_K", gapK) +
          (gapP > 0 ? "\nThey are also " + gapP + " g short of their protein target today." : "") +
          '\n\nThe food: "' + text + '"' }], { tier: "deep" });
      var o = App.api.json(data);
      var fixes = 0;
      var items = (o.items || []).map(function (x) {
        var am1 = Number(x.amount);
        var i = { name: String(x.name || "Item").slice(0, 40),
          amount: isFinite(am1) && am1 > 0 ? Math.round(am1 * 100) / 100 : null,
          unit: String(x.unit || "").slice(0, 10).trim(),
          portion: String(x.qty || "").slice(0, 20), src: "estimate",
          kcal: Math.max(0, Math.round(Number(x.kcal) || 0)),
          p: Math.max(0, Math.round(Number(x.protein) || 0)),
          c: Math.max(0, Math.round(Number(x.carbs) || 0)),
          f: Math.max(0, Math.round(Number(x.fat) || 0)) };
        if (reconcile(i)) fixes++;
        return i;
      }).filter(function (i) { return i.kcal > 0; });
      if (!items.length) throw new Error("empty");
      state.fit = { q: text, answer: String(o.answer || ""), note: String(o.note || ""),
        items: items, fixes: fixes };
    } catch (e) { state.fit = { q: text, err: true }; }
    state.fitBusy = false;
    setBusy(false);
    render();
  }

  function fitCard(box, left) {
    var r = state.fit;
    var c = document.createElement("div"); c.className = "card fit";
    var h = document.createElement("h3"); h.textContent = "How much fits"; c.appendChild(h);
    if (r.err) {
      var pe = document.createElement("p"); pe.textContent = "Couldn't work that one out. Try naming it more plainly.";
      c.appendChild(pe);
    } else {
      var total = r.items.reduce(function (a, i) { return a + i.kcal; }, 0);
      var prot = r.items.reduce(function (a, i) { return a + i.p; }, 0);
      var ans = document.createElement("div"); ans.className = "fitans"; ans.textContent = r.answer;
      var ing = document.createElement("div"); ing.className = "ings";
      r.items.forEach(function (i) {
        var row = document.createElement("div");
        var a = document.createElement("span");
        a.innerHTML = "<span class='q'>" + qtyLabel(i) + "</span> " + i.name;
        var b = document.createElement("span"); b.className = "k"; b.textContent = i.kcal;
        row.appendChild(a); row.appendChild(b); ing.appendChild(row);
      });
      var tot = document.createElement("div"); tot.className = "rectot";
      var diff = left - total;
      tot.innerHTML = "<b>" + total + " kcal</b>, " + prot + " g protein. " +
        (diff >= 0 ? diff + " kcal left after it." : Math.abs(diff) + " kcal over your limit.");
      c.appendChild(ans); c.appendChild(ing); c.appendChild(tot);
      if (r.note) { var n = document.createElement("div"); n.className = "fitnote"; n.textContent = r.note; c.appendChild(n); }
      if (r.fixes) {
        var fn = document.createElement("div"); fn.className = "fixnote";
        fn.textContent = r.fixes + " figure" + (r.fixes === 1 ? " was" : "s were") +
          " recalculated from macros to make the arithmetic hold.";
        c.appendChild(fn);
      }
    }
    var acts = document.createElement("div"); acts.className = "suggacts";
    acts.style.paddingTop = "0.7rem";
    if (!r.err) {
      var log = document.createElement("button"); log.className = "ghost"; log.textContent = "Log it";
      log.onclick = function () {
        addEntry({ label: r.items.map(function (i) { return i.name; }).join(" + ").slice(0, 40),
          items: JSON.parse(JSON.stringify(r.items)) });
        state.fit = null; state.fitText = "";
      };
      acts.appendChild(log);
    }
    var close = document.createElement("button"); close.className = "ghost";
    close.textContent = "No thanks";
    close.onclick = function () { state.fit = null; render(); };
    acts.appendChild(close);
    c.appendChild(acts);
    box.appendChild(c);
  }

  function adviceChip(totals) {
    var chip = el("chipAdvice");
    if (!isToday(state.date)) { chip.hidden = true; return; }
    chip.hidden = false;
    var buf = state.targets.buffer || 0;
    var left = effectiveTarget(iso(state.date)) - totals.kcal;
    if (left < -buf) {
      chip.className = "chip act hot";
      chip.innerHTML = App.icon("burn", 13) + "<b>" + Math.abs(left) + "</b> over \u00b7 work it off";
    } else if (left > buf) {
      chip.className = "chip act good";
      chip.innerHTML = App.icon("ideas", 13) + "<b>" + left + "</b> left \u00b7 cook something";
    } else {
      chip.className = "chip act";
      chip.innerHTML = "on target \u00b7 ideas";
    }
  }

  function renderAdvice(totals) {
    var box = el("advice");
    if (!box) return;
    box.innerHTML = "";
    state.sugg = null;
    if (!isToday(state.date)) return;
    var left = effectiveTarget(iso(state.date)) - totals.kcal;

    if (left < -(state.targets.buffer || 0)) {
      var over = Math.abs(left);
      var b = burnList(over, latestWeight());
      var card = document.createElement("div");
      card.className = "card burn";
      var h = document.createElement("h3");
      h.textContent = over + " kcal over";
      var p = document.createElement("p");
      p.textContent = "What it would take to work off, at " + b.kg + " kg" +
        (b.assumed ? ", assumed since no weight is logged" : "") +
        ". Steady effort, not flat out.";
      var row = document.createElement("div");
      row.className = "burnrow";
      b.items.forEach(function (x) {
        var pill = document.createElement("span");
        pill.className = "burnpill";
        pill.innerHTML = x.name + " <b>" + x.min + " min</b>";
        row.appendChild(pill);
      });
      var note = document.createElement("div");
      note.className = "fitnote";
      note.textContent = "One heavy day inside a good week barely moves the average. " +
        "Carrying it forward on tomorrow's target usually beats a punishing session.";
      card.appendChild(h); card.appendChild(p); card.appendChild(row); card.appendChild(note);
      box.appendChild(card);
      return;
    }

    if (left > (state.targets.buffer || 0)) {
      var gapP = state.targets.protein - totals.p;

      if (state.fitBusy) {
        var w0 = document.createElement("div"); w0.className = "card fit";
        var w0h = document.createElement("h3"); w0h.textContent = "How much fits";
        var w0p = document.createElement("p"); w0p.textContent = "Working out how much " + state.fitText + " fits in " + left + " kcal.";
        w0.appendChild(w0h); w0.appendChild(w0p); box.appendChild(w0);
        return;
      }
      if (state.fit) { fitCard(box, left); return; }

      if (state.recipeBusy) {
        var wait = document.createElement("div"); wait.className = "card rec";
        var wh = document.createElement("h3"); wh.textContent = "Recipe idea";
        var wp = document.createElement("p"); wp.textContent = "Working out something that fits " + left + " kcal.";
        wait.appendChild(wh); wait.appendChild(wp); box.appendChild(wait);
        return;
      }
      if (state.recipe) { recipeCard(box, left); return; }

      var s = suggestMeal(left, gapP);
      state.sugg = s;
      var c2 = document.createElement("div");
      c2.className = "card sugg";
      var h2 = document.createElement("h3");
      h2.textContent = left + " kcal still to go";
      c2.appendChild(h2);

      if (s) {
        var list = document.createElement("div"); list.className = "sugglist";
        s.items.forEach(function (i) {
          var r = document.createElement("div");
          var n = document.createElement("span"); n.style.color = "var(--ink)"; n.textContent = i.name;
          var v = document.createElement("span"); v.textContent = i.kcal;
          r.appendChild(n); r.appendChild(v); list.appendChild(r);
        });
        var p2 = document.createElement("p");
        p2.textContent = "From what you already eat. " + s.kcal + " kcal, " + s.p + "g protein, leaving " +
          (left - s.kcal) + " kcal spare.";
        c2.appendChild(list); c2.appendChild(p2);
      } else {
        var p3 = document.createElement("p");
        p3.textContent = Object.keys(state.pantry).length < 6
          ? "Not enough logged history yet to build something from your own foods."
          : "Nothing in your own foods fits that gap cleanly.";
        c2.appendChild(p3);
      }

      var acts = document.createElement("div"); acts.className = "suggacts";
      if (s) {
        var add = document.createElement("button");
        add.className = "ghost"; add.textContent = "Log this";
        add.onclick = function () {
          var items = s.items.map(function (i) {
            return { name: i.name, amount: i.amount || null, unit: i.unit || "", portion: "",
              src: "repeat", kcal: i.kcal, p: i.p, c: i.c || 0, f: i.f || 0 };
          });
          addEntry({ label: items.map(function (i) { return i.name; }).join(" + ").slice(0, 40), items: items });
        };
        var skip = document.createElement("button");
        skip.className = "ghost"; skip.textContent = "Something else";
        skip.onclick = function () { renderAdvice(totals); };
        acts.appendChild(add); acts.appendChild(skip);
      }
      var rec = document.createElement("button");
      rec.className = "ghost"; rec.textContent = "Cook something";
      rec.disabled = state.busy;
      rec.onclick = function () { askRecipe(mealSize(left), gapP); };
      acts.appendChild(rec);
      c2.appendChild(acts);

      if (left > 900) {
        var sizeRow = document.createElement("div"); sizeRow.className = "chips";
        sizeRow.style.paddingTop = ".55rem";
        [["snack", "Snack"], ["meal", "Meal"], ["all", "All"]].forEach(function (o) {
          var b2 = document.createElement("button");
          b2.className = "chip act" + ((state.mealSize || "meal") === o[0] ? " on" : "");
          b2.textContent = o[0] === "all" ? "All " + left : o[1] + " \u00b7 " + sizeOf(o[0], left);
          b2.onclick = function () { state.mealSize = o[0]; renderAdvice(totals); };
          sizeRow.appendChild(b2);
        });
        c2.appendChild(sizeRow);
      }

      var lab = document.createElement("div"); lab.className = "fitlabel";
      lab.textContent = "Got something in mind? I'll tell you how much of it fits.";
      var ask = document.createElement("div"); ask.className = "fitask";
      var inp = document.createElement("input"); inp.type = "text";
      inp.placeholder = "karishe cheese with a teaspoon of honey";
      inp.value = state.fitText || "";
      inp.oninput = function () { state.fitText = inp.value; };
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); askPortion(inp.value, left, gapP); }
      });
      var go = document.createElement("button"); go.className = "ghost";
      go.textContent = "How much?"; go.disabled = state.busy;
      go.onclick = function () { askPortion(inp.value, left, gapP); };
      ask.appendChild(inp); ask.appendChild(go);
      c2.appendChild(lab); c2.appendChild(ask);
      box.appendChild(c2);
    }
  }

  function countTo(node, target, cls) {
    var from = state.shown || 0, start = null, dur = 480;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.textContent = (target < 0 ? "+" : "") + Math.abs(target).toLocaleString();
      node.className = cls; state.shown = target; return;
    }
    function step(ts) {
      if (!start) start = ts;
      var t = Math.min(1, (ts - start) / dur), e = 1 - Math.pow(1 - t, 3);
      var v = Math.round(from + (target - from) * e);
      node.textContent = (v < 0 ? "+" : "") + Math.abs(v).toLocaleString();
      if (t < 1) requestAnimationFrame(step); else state.shown = target;
    }
    node.className = cls;
    requestAnimationFrame(step);
  }

  var CARRY_CAP = 500;

  // yesterday's surplus or shortfall, measured against the plain target so it never compounds
  function carryAmount(ds) {
    var prev = shift(ds, -1);
    if (!(prev in state.totals)) return null;
    var raw = state.targets.kcal - state.totals[prev];
    if (!raw) return null;
    return { raw: raw, applied: Math.max(-CARRY_CAP, Math.min(CARRY_CAP, raw)) };
  }
  function effectiveTarget(ds) {
    var base = state.targets.kcal;
    if (!state.carry[ds]) return base;
    var c = carryAmount(ds);
    return c ? base + c.applied : base;
  }
  async function toggleCarry(ds) {
    if (state.carry[ds]) delete state.carry[ds]; else state.carry[ds] = 1;
    save("carry", state.carry);
    render();
  }

  function renderCarry(ds) {
    var wrap = el("carryWrap");
    wrap.innerHTML = "";
    var c = carryAmount(ds);
    if (!c) return;
    var on = !!state.carry[ds];
    var sign = c.applied < 0 ? "\u2212" : "+";
    var btn = document.createElement("button");
    btn.className = "carry";
    btn.setAttribute("aria-pressed", String(on));
    btn.innerHTML = (on ? "Carrying " : "Carry ") + "<span class='amt'>" + sign +
      Math.abs(c.applied) + "</span> from yesterday";
    btn.onclick = function () { toggleCarry(ds); };
    wrap.appendChild(btn);

    var note = document.createElement("div");
    note.className = "carrynote";
    if (Math.abs(c.raw) > CARRY_CAP) {
      note.textContent = "Yesterday was " + (c.raw < 0 ? "over" : "under") + " by " +
        Math.abs(c.raw) + ". Only " + CARRY_CAP + " carries across, spread the rest over the week.";
    } else if (on) {
      note.textContent = "Today's target is " + effectiveTarget(ds).toLocaleString() +
        " instead of " + state.targets.kcal.toLocaleString() + ".";
    } else {
      note.textContent = c.applied < 0
        ? "You went over yesterday. Applying this trims today to match."
        : "You came in under yesterday. Applying this gives today the difference.";
    }
    wrap.appendChild(note);
  }

  function renderWeightBlock() {
    var box = el("wGoal");
    if (!box) return;
    var cur = latestWeight(), tgt = state.targets.weight, series = weightSeries();
    var t = today(), loggedToday = state.weights[t] != null;

    if (!cur) {
      box.innerHTML = '<div class="wgempty">No weight yet. Log one on the Body tab and this fills in.</div>';
      return;
    }
    if (!tgt) {
      box.innerHTML = '<div class="wgtop"><span class="wgnow">' + cur.toFixed(1) +
        '<small>kg</small></span><span class="wgtogo">set a goal weight to track progress</span></div>';
      return;
    }

    var start = series[0].v;
    var span = start - tgt;
    var doneKg = start - cur;
    var pct = span > 0 ? Math.max(0, Math.min(100, doneKg / span * 100)) : (cur <= tgt ? 100 : 0);
    var togo = cur - tgt;
    var reached = togo <= 0.05;

    // the knob sits at the current weight, the fill shows ground already covered
    box.innerHTML =
      '<div class="wgtop">' +
        '<span class="wgnow">' + cur.toFixed(1) + '<small>kg</small></span>' +
        '<span class="wgtogo">' + (reached
          ? '<b>goal reached</b>'
          : '<b>' + togo.toFixed(1) + ' kg</b> to go') +
          (loggedToday ? '' : ' \u00b7 not weighed today') + '</span>' +
      '</div>' +
      '<div class="wgtrack">' +
        '<div class="wgfill" style="width:' + pct.toFixed(1) + '%"></div>' +
        '<div class="wgknob" style="left:' + pct.toFixed(1) + '%"></div>' +
      '</div>' +
      '<div class="wgends">' +
        '<span>' + start.toFixed(1) + ' start</span>' +
        '<span class="wgpct">' + Math.round(pct) + '% of the way' +
          (doneKg > 0.05 ? ', ' + doneKg.toFixed(1) + ' kg down' : '') + '</span>' +
        '<span>' + tgt.toFixed(1) + ' goal</span>' +
      '</div>';
  }

  function renderStreakChip() {
    var n = currentStreak(), t = today();
    var logged = state.clean[t] !== undefined;
    var chip = el("chipStreak");
    chip.className = "chip act" + (logged ? " good" : "");
    chip.innerHTML = "<b>" + n + "</b> day streak" + (logged ? "" : " \u00b7 log today");
  }

  function renderLog() {
    el("lookupBtn").setAttribute("aria-pressed", String(!!state.targets.lookup));
    var t = dayTotals(state.entries);
    var ds = iso(state.date);
    var eff = effectiveTarget(ds);
    var left = eff - t.kcal, over = left < 0;

    var buf = state.targets.buffer || 0;
    var zone = zoneFor(t.kcal, eff, buf);
    over = t.kcal > eff + buf;
    countTo(el("remaining"), left, "big " + zone);
    el("heroSub").textContent = (zone === "ok" && left >= 0 ? "on target, " + eff.toLocaleString() + " kcal"
      : over ? "over " + eff.toLocaleString() + " kcal"
      : "left of " + eff.toLocaleString() + " kcal") +
      (eff !== state.targets.kcal ? " (adjusted)" : "");
    var pzone = zoneFor(t.p, state.targets.protein, Math.round((state.targets.protein || 0) * 0.05), { moreIsBetter: true });
    var pl = el("protLine");
    pl.textContent = t.p + " of " + state.targets.protein + " g protein";
    pl.className = "sub prot " + pzone;
    renderCarry(ds);

    var kr = eff ? Math.min(1, t.kcal / eff) : 0;
    var pr = state.targets.protein ? Math.min(1, t.p / state.targets.protein) : 0;
    var ak = el("arcK"), ap = el("arcP");
    ak.setAttribute("stroke-dasharray", CIRC_K);
    ak.setAttribute("stroke-dashoffset", CIRC_K * (1 - kr));
    ak.setAttribute("class", "arcK " + zone);
    ap.setAttribute("stroke-dasharray", CIRC_P);
    ap.setAttribute("stroke-dashoffset", CIRC_P * (1 - pr));
    ap.setAttribute("class", "arcP " + pzone);

    renderWeightBlock();
    renderStreakChip();
    adviceChip(t);
    if (App.sheetOpen === "advice") renderAdvice(t);

    el("logTitle").textContent = state.entries.length
      ? state.entries.length + (state.entries.length === 1 ? " meal" : " meals") : "";
    el("logTotal").textContent = state.entries.length
      ? t.kcal.toLocaleString() + " kcal, " + t.c + "g carbs, " + t.f + "g fat" : "";

    var favs = el("favs"); favs.innerHTML = "";
    state.favs.forEach(function (f) {
      var chip = document.createElement("span"); chip.className = "chip";
      var b = document.createElement("button");
      b.appendChild(document.createTextNode(f.label));
      var kc = document.createElement("span"); kc.className = "kc"; kc.textContent = sum(f.items, "kcal");
      b.appendChild(kc); b.onclick = function () { logFav(f); };
      var x = document.createElement("button"); x.className = "x"; x.innerHTML = App.icon("x", 13);
      x.setAttribute("aria-label", "Remove " + f.label); x.onclick = function () { removeFav(f.label); };
      chip.appendChild(b); chip.appendChild(x); favs.appendChild(chip);
    });

    var rows = el("rows"); rows.innerHTML = "";
    if (!state.entries.length) {
      var em = document.createElement("div"); em.className = "empty";
      em.textContent = isToday(state.date)
        ? "Nothing logged yet. Describe a whole meal at once, it gets split into items."
        : "Nothing logged this day.";
      rows.appendChild(em);
    }
    state.entries.forEach(function (e) {
      var row = document.createElement("div"); row.className = "row";
      var main = document.createElement("button"); main.className = "rowmain";
      main.onclick = function () { state.openId = state.openId === e.id ? null : e.id; render(); };
      var tm = document.createElement("span"); tm.className = "rowtime"; tm.textContent = e.time;
      var nm = document.createElement("span"); nm.className = "rowname"; nm.textContent = e.label;
      if (e.items.length > 1) {
        var cnt = document.createElement("span"); cnt.className = "rown";
        cnt.textContent = e.items.length;
        nm.appendChild(cnt);
      }
      var kc = document.createElement("span"); kc.className = "rowkc"; kc.textContent = entryKcal(e);
      main.appendChild(tm); main.appendChild(nm); main.appendChild(kc); row.appendChild(main);

      var kc2 = document.createElement("span"); kc2.className = "rowp";
      kc2.textContent = sum(e.items, "p") + "p";
      main.appendChild(kc2);

      var det = document.createElement("div");
      det.className = "detail" + (state.openId === e.id ? " open" : "");
      if (e.items.length > 1) {
        var tot = document.createElement("div"); tot.className = "detailtot";
        tot.textContent = sum(e.items, "c") + " g carbs, " + sum(e.items, "f") + " g fat";
        det.appendChild(tot);
      }
      e.items.forEach(function (it, idx) {
        var box = document.createElement("div"); box.className = "item";
        var nmv = document.createElement("div"); nmv.className = "itemname";
        nmv.textContent = itemTitle(it);
        var badge = document.createElement("span"); badge.className = "src " + (it.src || "estimate");
        badge.textContent = it.src === "database" ? "database" : it.src === "web" ? "searched"
          : it.src === "repeat" ? "repeat" : it.src === "given" ? "your numbers"
            : it.src === "label" ? "off the label" : "estimated";
        nmv.appendChild(badge);

        var fr = document.createElement("div"); fr.className = "itemfields";
        var qb = document.createElement("div"); qb.className = "qtybox";
        var i1 = document.createElement("input");
        i1.type = "number"; i1.inputMode = "decimal"; i1.step = "any"; i1.min = "0";
        i1.value = it.amount;
        i1.setAttribute("aria-label", "Amount of " + it.name);
        var u = document.createElement("span"); u.className = "u"; u.textContent = it.unit || "";
        qb.appendChild(i1); qb.appendChild(u);
        var nmq = document.createElement("span"); nmq.className = "qtyname"; nmq.textContent = it.name;
        fr.appendChild(qb); fr.appendChild(nmq);
        i1.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); i1.blur(); scaleItem(e.id, idx, i1.value); }
        });
        i1.addEventListener("blur", function () { scaleItem(e.id, idx, i1.value); });

        var pen = document.createElement("button"); pen.className = "xitem";
        pen.innerHTML = App.icon("pencil", 15); pen.title = "Describe the portion differently";
        pen.setAttribute("aria-label", "Redescribe portion of " + it.name);
        pen.disabled = state.busy;
        pen.onclick = function () {
          var txt = window.prompt("How much " + it.name + "? Change the unit here, e.g. 2 wraps",
            qtyLabel(it) || "");
          if (txt) applyPortion(e.id, idx, txt);
        };
        var dl = document.createElement("button"); dl.className = "xitem"; dl.innerHTML = App.icon("x", 15);
        dl.setAttribute("aria-label", "Remove " + it.name);
        dl.onclick = function () { removeItem(e.id, idx); };
        fr.appendChild(pen); fr.appendChild(dl);

        var vals = document.createElement("div"); vals.className = "itemvals";
        vals.innerHTML = "<b>" + it.kcal + " kcal</b>, " + it.p + " g protein, " +
          (it.c || 0) + " g carbs, " + (it.f || 0) + " g fat";

        box.appendChild(nmv); box.appendChild(fr); box.appendChild(vals);
        if (it.basis) {
          var bs = document.createElement("div"); bs.className = "basis"; bs.textContent = it.basis;
          box.appendChild(bs);
        }
        det.appendChild(box);
      });
      var acts = document.createElement("div"); acts.className = "acts";
      var fv = document.createElement("button"); fv.className = "ghost";
      fv.textContent = "Save as repeat"; fv.onclick = function () { saveFav(e); };
      var da = document.createElement("button"); da.className = "ghost danger";
      da.textContent = "Delete meal"; da.onclick = function () { removeEntry(e.id); };
      acts.appendChild(fv); acts.appendChild(da);
      det.appendChild(acts); row.appendChild(det);
      rows.appendChild(row);
    });

    var times = state.entries.map(function (e) { return e.time; })
      .filter(function (x) { return x !== "--:--"; }).sort();
    el("window").textContent = times.length > 1
      ? "Eating window " + times[0] + " to " + times[times.length - 1]
      : (times.length === 1 ? "First food at " + times[0] : "");
  }
  function buildGrid(container, monthDate, cellFn) {
    container.innerHTML = "";
    var y = monthDate.getFullYear(), m = monthDate.getMonth();
    var lead = (new Date(y, m, 1).getDay() + 6) % 7;
    var days = new Date(y, m + 1, 0).getDate();
    for (var i = 0; i < lead; i++) {
      var b = document.createElement("div"); b.className = "cell blank"; container.appendChild(b);
    }
    for (var d = 1; d <= days; d++) {
      var ds = y + "-" + pad(m + 1) + "-" + pad(d);
      var cell = document.createElement("button");
      cell.className = "cell" + (ds > today() ? " future" : "") + (ds === today() ? " today" : "");
      var dn = document.createElement("span"); dn.className = "dnum"; dn.textContent = d;
      cell.appendChild(dn); cellFn(cell, ds); container.appendChild(cell);
    }
  }
  function calTint(k) {
    var t = state.targets.kcal || 1, r = k / t;
    if (r <= 1) return "rgba(143,176,139," + (0.12 + Math.min(r, 1) * 0.36).toFixed(2) + ")";
    return "rgba(208,112,90," + (0.24 + Math.min((r - 1) / 0.4, 1) * 0.36).toFixed(2) + ")";
  }
  function renderMonth() {
    el("monthLabel").textContent = monthLabel(state.month);
    var now = new Date();
    el("nextMonth").disabled = state.month.getFullYear() === now.getFullYear() && state.month.getMonth() === now.getMonth();
    var logged = [];
    buildGrid(el("calGrid"), state.month, function (cell, ds) {
      var v = state.totals[ds];
      if (v) {
        logged.push(v); cell.className += " has"; cell.style.background = calTint(v);
        var val = document.createElement("span"); val.className = "dval";
        val.textContent = v >= 1000 ? (v / 1000).toFixed(1) + "k" : v;
        cell.appendChild(val);
      }
      if (ds <= today()) cell.onclick = async function () { await goToDay(parseISO(ds)); switchView("log"); };
    });
    renderHistogram(logged);

    var stats = el("mStats"); stats.innerHTML = "";
    var avg = logged.length ? Math.round(logged.reduce(function (a, b) { return a + b; }, 0) / logged.length) : 0;
    var under = logged.filter(function (v) { return v <= state.targets.kcal; }).length;
    [[logged.length ? avg.toLocaleString() : "\u2014", "average per logged day"],
     [logged.length ? under + "/" + logged.length : "\u2014", "days at or under target"]].forEach(function (s) {
      var box = document.createElement("div"); box.className = "mstat";
      var v = document.createElement("div"); v.className = "v"; v.textContent = s[0];
      var k = document.createElement("div"); k.className = "k"; k.textContent = s[1];
      box.appendChild(v); box.appendChild(k); stats.appendChild(box);
    });
  }

  /* Bars for every day of the month on screen, coloured by how the day landed.
     Missing days are drawn faintly rather than skipped, so gaps in logging are
     as visible as heavy days. */
  function renderHistogram() {
    var box = el("histBox");
    if (!box) return;
    box.innerHTML = "";
    var y = state.month.getFullYear(), m = state.month.getMonth();
    var days = new Date(y, m + 1, 0).getDate();
    var tgt = state.targets.kcal || 2000;
    var vals = [];
    for (var d = 1; d <= days; d++) {
      var ds = y + "-" + pad(m + 1) + "-" + pad(d);
      vals.push({ d: ds, v: state.totals[ds] || 0 });
    }
    var logged = vals.filter(function (x) { return x.v > 0; });
    var peak = Math.max(tgt * 1.25, logged.length ? Math.max.apply(null, logged.map(function (x) { return x.v; })) : tgt);

    var line = document.createElement("div");
    line.className = "htarget";
    line.style.bottom = (tgt / peak * 100) + "%";
    box.appendChild(line);

    vals.forEach(function (x) {
      var b = document.createElement("div");
      b.className = "hbar " + (!x.v ? "none" : zoneFor(x.v, tgt, state.targets.buffer || 0));
      b.style.height = (x.v ? Math.max(3, x.v / peak * 100) : 3) + "%";
      b.title = x.d + (x.v ? ": " + x.v + " kcal" : ": nothing logged");
      if (x.d <= today()) {
        b.onclick = async function () { await goToDay(parseISO(x.d)); switchView("log"); };
      }
      box.appendChild(b);
    });

    var note = el("histNote");
    if (note) {
      note.textContent = logged.length
        ? "dashed line is your " + tgt.toLocaleString() + " target"
        : "nothing logged this month";
    }
  }

  function renderChart(series) {
    var box = el("chartBox"); box.innerHTML = "";
    if (series.length < 2) {
      var p = document.createElement("div"); p.className = "empty";
      p.textContent = series.length === 1 ? "One weight logged. Add a few more and the trend appears."
        : "No weights yet. Log one below and the chart builds itself.";
      box.appendChild(p); return;
    }
    var W = 340, H = 92, PL = 4, PR = 4, PT = 10, PB = 14;
    var t0 = parseISO(series[0].d).getTime(), tLast = parseISO(series[series.length - 1].d).getTime();
    /* A checkpoint months out would squash a fortnight of weigh-ins into a
       sliver. Look forward by at most the length of what you have logged, or
       six weeks, whichever is longer. Checkpoints past that still appear in the
       list below, just not on the chart. */
    var logged = tLast - t0;
    var horizon = tLast + Math.max(logged, 42 * DAY);
    var t1 = tLast;
    state.checkpoints.forEach(function (c) {
      var ct = parseISO(c.date).getTime();
      if (ct > t1 && ct <= horizon) t1 = ct;
    });
    if (t1 === tLast) t1 = tLast + Math.min(logged || 14 * DAY, 21 * DAY);
    var span = Math.max(1, t1 - t0);
    var vals = series.map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var tgt = state.targets.weight;
    if (tgt && tgt < lo) lo = tgt;
    if (tgt && tgt > hi) hi = tgt;
    state.checkpoints.forEach(function (c) {
      if (parseISO(c.date).getTime() > t1) return;   // off the chart, ignore its range
      if (c.kg < lo) lo = c.kg;
      if (c.kg > hi) hi = c.kg;
    });
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    var padY = (hi - lo) * 0.16; lo -= padY; hi += padY;
    var X = function (d) { return PL + ((parseISO(d).getTime() - t0) / span) * (W - PL - PR); };
    var sm0 = null;
    var Y = function (v) { return PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB); };
    var raw = series.map(function (p) { return X(p.d).toFixed(1) + "," + Y(p.v).toFixed(1); }).join(" ");
    var sm = smooth(series, 7);
    var smp = series.map(function (p, i) { return X(p.d).toFixed(1) + "," + Y(sm[i]).toFixed(1); }).join(" ");
    var area = "M" + X(series[0].d).toFixed(1) + "," + (H - PB) + " L" +
      series.map(function (p, i) { return X(p.d).toFixed(1) + "," + Y(sm[i]).toFixed(1); }).join(" L") +
      " L" + X(series[series.length - 1].d).toFixed(1) + "," + (H - PB) + " Z";
    var dots = series.map(function (p) {
      return '<circle cx="' + X(p.d).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) +
        '" r="1.9" fill="var(--muted)" opacity="0.7"/>'; }).join("");
    var goal = "";
    if (tgt) {
      goal = '<line x1="' + PL + '" y1="' + Y(tgt).toFixed(1) + '" x2="' + (W - PR) + '" y2="' + Y(tgt).toFixed(1) +
        '" stroke="var(--sage)" stroke-width="1" stroke-dasharray="4 4" opacity="0.75"/>' +
        '<text x="' + (W - PR) + '" y="' + (Y(tgt) - 4).toFixed(1) +
        '" fill="var(--sage)" font-size="9" text-anchor="end">target ' + tgt + '</text>';
    }
    var last = series[series.length - 1];
    var XT = function (ms) { return PL + ((ms - t0) / span) * (W - PL - PR); };

    // projected line from today at the current smoothed pace
    var proj = "";
    var rate = ratePerWeek(21) || ratePerWeek(14);
    if (rate != null && Math.abs(rate) > 0.005 && t1 > tLast) {
      var endW = sm[sm.length - 1] - (rate / 7) * ((t1 - tLast) / DAY);
      proj = '<line x1="' + XT(tLast).toFixed(1) + '" y1="' + Y(sm[sm.length - 1]).toFixed(1) +
        '" x2="' + XT(t1).toFixed(1) + '" y2="' + Y(Math.max(lo, Math.min(hi, endW))).toFixed(1) +
        '" stroke="var(--blue)" stroke-width="1.6" stroke-dasharray="3 4" opacity="0.55"/>';
    }
    // checkpoint markers
    var cps = state.checkpoints.filter(function (c) {
      return parseISO(c.date).getTime() <= t1;
    }).map(function (c) {
      var st = cpStatus(c);
      var col = st.key === "off" ? "var(--warn)" : st.key === "near" ? "var(--amber)" : "var(--sage)";
      return '<circle cx="' + XT(parseISO(c.date).getTime()).toFixed(1) + '" cy="' + Y(c.kg).toFixed(1) +
        '" r="3.4" fill="none" stroke="' + col + '" stroke-width="1.8"/>' +
        '<text x="' + XT(parseISO(c.date).getTime()).toFixed(1) + '" y="' + (Y(c.kg) - 7).toFixed(1) +
        '" fill="' + col + '" font-size="8.5" text-anchor="middle">' + c.kg + '</text>';
    }).join("");

    box.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Weight trend">' +
      '<defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="var(--blue)" stop-opacity="0.24"/>' +
      '<stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#wg)"/>' + goal + proj + cps +
      '<polyline points="' + raw + '" fill="none" stroke="var(--muted)" stroke-width="1" stroke-opacity="0.5"/>' +
      '<polyline points="' + smp + '" fill="none" stroke="var(--blue)" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/>' + dots +
      '<circle cx="' + X(last.d).toFixed(1) + '" cy="' + Y(last.v).toFixed(1) + '" r="3.6" fill="var(--blue)"/>' +
      '<text x="' + PL + '" y="' + (H - 4) + '" fill="var(--muted)" font-size="9">' +
      parseISO(series[0].d).toLocaleDateString(undefined, { day: "numeric", month: "short" }) + '</text>' +
      '<text x="' + (W - PR) + '" y="' + (H - 4) + '" fill="var(--muted)" font-size="9" text-anchor="end">' +
      new Date(t1).toLocaleDateString(undefined, { day: "numeric", month: "short" }) + '</text></svg>';
  }

  function renderRate() {
    var box = el("rateRow"); box.innerHTML = "";
    var defs = [];
    var r10 = ratePerWeek(10), r21 = ratePerWeek(21);
    var tgt = state.targets.rate || 0;
    function pill(label, val, cls) {
      var d = document.createElement("div"); d.className = "ratepill";
      d.innerHTML = "<b class='" + (cls || "") + "'>" + val + "</b><span>" + label + "</span>";
      box.appendChild(d);
    }
    if (r10 != null) {
      var cls = !tgt ? "blue" : (r10 >= tgt * 0.85 && r10 <= tgt * 1.25) ? "good"
        : r10 > tgt * 1.25 ? "warn" : "warn";
      pill("10 days", (r10 > 0 ? "\u2212" : "+") + Math.abs(r10).toFixed(2), cls);
    }
    if (r21 != null) pill("3 weeks", (r21 > 0 ? "\u2212" : "+") + Math.abs(r21).toFixed(2), "");
    if (tgt) pill("target", "\u2212" + tgt.toFixed(2), "");
    var m = estimateMaintenance(28) || estimateMaintenance(21);
    if (m) pill("maintenance", m.kcal.toLocaleString(), "blue");
    if (!box.children.length) {
      var d = document.createElement("div"); d.className = "ratepill";
      d.textContent = "Rates appear after about a week of weigh-ins.";
      box.appendChild(d);
    }
  }

  function renderCheckpoints() {
    var list = el("cpList"); list.innerHTML = "";
    if (!state.checkpoints.length) {
      var e = document.createElement("div"); e.className = "empty"; e.style.padding = "0.6rem 0";
      e.textContent = "None set. Try 85 kg by 1 December.";
      list.appendChild(e); return;
    }
    state.checkpoints.forEach(function (c) {
      var row = document.createElement("div"); row.className = "cp";
      var kg = document.createElement("span"); kg.className = "kg"; kg.textContent = c.kg + " kg";
      var wh = document.createElement("span"); wh.className = "when";
      wh.textContent = "by " + parseISO(c.date).toLocaleDateString(undefined,
        { day: "numeric", month: "short", year: "numeric" });
      var st = cpStatus(c);
      var vd = document.createElement("span"); vd.className = "verdict " + st.key; vd.textContent = st.text;
      var x = document.createElement("button"); x.className = "cpx"; x.innerHTML = App.icon("x", 14);
      x.setAttribute("aria-label", "Remove checkpoint");
      x.onclick = function () { removeCheckpoint(c.id); };
      row.appendChild(kg); row.appendChild(wh); row.appendChild(vd); row.appendChild(x);
      list.appendChild(row);
    });
  }

  function renderCoach() {
    var box = el("coachBox"); box.innerHTML = "";
    var head = document.createElement("div"); head.className = "cvh";
    var h = document.createElement("h3"); h.textContent = "Your read";
    var btn = document.createElement("button"); btn.className = "ghost"; btn.id = "coachBtn";
    btn.textContent = state.coach ? "Refresh" : "Get a read";
    btn.onclick = askCoach;
    head.appendChild(h); head.appendChild(btn); box.appendChild(head);

    if (!state.coach) {
      var p = document.createElement("p");
      p.textContent = weightSeries().length < 4
        ? "Log a few more weigh-ins and some days of food, then ask for a read on how it is going."
        : "Ask for an honest read on the trend, whether the pace is right, and what to change.";
      box.appendChild(p); return;
    }
    if (state.coach.err) {
      var pe = document.createElement("p"); pe.textContent = "That read failed. Try again in a moment.";
      box.appendChild(pe); return;
    }
    var d = state.coach.d;
    var when = document.createElement("div"); when.className = "when2";
    when.textContent = new Date(state.coach.at).toLocaleDateString(undefined,
      { day: "numeric", month: "short" });
    head.insertBefore(when, btn);

    var v = document.createElement("div");
    v.className = "verdictline " + (d.status || "steady");
    v.textContent = d.verdict || "";
    box.appendChild(v);
    if (d.trend) { var t = document.createElement("p"); t.textContent = d.trend; box.appendChild(t); }

    function bullets(arr, cls, label) {
      if (!arr || !arr.length) return;
      var l = document.createElement("div"); l.className = "clabel"; l.textContent = label;
      box.appendChild(l);
      var ul = document.createElement("ul"); ul.className = "clist " + cls;
      arr.slice(0, 3).forEach(function (x) {
        var li = document.createElement("li"); li.textContent = x; ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    bullets(d.working, "", "Holding up");
    bullets(d.watch, "watch", "Worth watching");
    if (d.move) {
      var m = document.createElement("div"); m.className = "move"; m.textContent = d.move;
      box.appendChild(m);
    }
    if (d.outlook) {
      var o = document.createElement("p"); o.style.color = "var(--muted)";
      o.style.fontSize = "0.79rem"; o.textContent = d.outlook; box.appendChild(o);
    }
  }

  function renderWeight() {
    var series = weightSeries();
    if (series.length) {
      var last = series[series.length - 1];
      el("wBig").textContent = last.v.toFixed(1);
      var bits = ["kg"];
      if (series.length > 1) {
        var diff = last.v - series[0].v;
        bits.push((diff > 0 ? "+" : "\u2212") + Math.abs(diff).toFixed(1) + " overall");
      }
      if (state.targets.weight) {
        var togo = last.v - state.targets.weight;
        var sm = smooth(series, 7);
        var wk = "";
        if (series.length > 7 && togo > 0.05) {
          var days = (parseISO(last.d) - parseISO(series[0].d)) / 86400000;
          var rate = days > 0 ? (sm[0] - sm[sm.length - 1]) / days : 0;
          if (rate > 0.001) {
            var eta = new Date(parseISO(last.d).getTime() + (togo / rate) * 86400000);
            wk = ", " + eta.toLocaleDateString(undefined, { month: "short", year: "numeric" });
          }
        }
        bits.push(togo > 0.05 ? togo.toFixed(1) + " to go" + wk : "target reached");
      }
      el("wSub").textContent = bits.join(", ");
    } else { el("wBig").textContent = "\u2014"; el("wSub").textContent = "no weight logged yet"; }

    renderChart(series);
    renderRate();
    renderCoach();
    renderCheckpoints();
    var pick = state.wPick || today();
    el("wInputLabel").textContent = pick === today() ? "Weight today (kg)"
      : "Weight on " + parseISO(pick).toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " (kg)";
    el("wInput").value = state.weights[pick] != null ? state.weights[pick] : "";
    var wn = el("wNote");
    if (wn) wn.textContent = state.wPick && state.wPick !== today()
      ? "Editing a past day." : "";
    el("wMonthLabel").textContent = monthLabel(state.wMonth);
    var now = new Date();
    el("nextWMonth").disabled = state.wMonth.getFullYear() === now.getFullYear() && state.wMonth.getMonth() === now.getMonth();
    buildGrid(el("wGrid"), state.wMonth, function (cell, ds) {
      var v = state.weights[ds];
      if (v) {
        cell.className += " has wcell";
        cell.style.background = "rgba(134,169,196,0.16)";
        var val = document.createElement("span"); val.className = "dval"; val.textContent = v.toFixed(1);
        cell.appendChild(val);
      }
      if (ds === pick) cell.className += " today";
      if (ds <= today()) cell.onclick = function () { state.wPick = ds; render(); };
    });
  }
  var SHEETJS = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

  async function loadAllDays(onP) {
    var keys = App.store.keys("day:").slice(0, 500).sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var ents = (load(keys[i], [])).map(normalise);
      if (ents.length) out.push({ date: keys[i].slice(4), entries: ents });
      if (onP) onP(i + 1, keys.length);
    }
    return out;
  }
  function buildTables(days) {
    var items = [["Date", "Time", "Meal", "Item", "Assumed portion", "Source", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)"]];
    var daily = [["Date", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Meals", "First food", "Last food", "Eating window (h)", "Weight (kg)"]];
    days.forEach(function (d) {
      d.entries.forEach(function (e) {
        e.items.forEach(function (i) {
          items.push([d.date, e.time, e.label, i.name, qtyLabel(i) || i.portion || "", i.src || "estimate",
            i.kcal, i.p, i.c || 0, i.f || 0]);
        });
      });
      var t = dayTotals(d.entries);
      var times = d.entries.map(function (e) { return e.time; })
        .filter(function (x) { return x && x !== "--:--"; }).sort();
      var win = "";
      if (times.length > 1) {
        var toMin = function (x) { var q = x.split(":"); return +q[0] * 60 + +q[1]; };
        win = ((toMin(times[times.length - 1]) - toMin(times[0])) / 60).toFixed(1);
      }
      daily.push([d.date, t.kcal, t.p, t.c, t.f, d.entries.length, times[0] || "",
        times.length ? times[times.length - 1] : "", win,
        state.weights[d.date] != null ? state.weights[d.date] : ""]);
    });
    var series = weightSeries(), sm = smooth(series, 7);
    var weight = [["Date", "Weight (kg)", "7-day average"]];
    series.forEach(function (p, i) { weight.push([p.d, p.v, Math.round(sm[i] * 100) / 100]); });
    return { items: items, daily: daily, weight: weight };
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (window.XLSX) return res();
      var s = document.createElement("script");
      s.src = src; s.onload = function () { res(); }; s.onerror = function () { rej(new Error("cdn")); };
      document.head.appendChild(s);
    });
  }
  function toTSV(rows) {
    return rows.map(function (r) {
      return r.map(function (c) { return String(c == null ? "" : c).replace(/[\t\r\n]/g, " "); }).join("\t");
    }).join("\n");
  }
  function downloadText(text, name, mime) {
    try {
      var blob = new Blob([text], { type: mime || "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
      return true;
    } catch (e) { return false; }
  }
  async function putOnClipboard(text, label) {
    el("copyBox").value = text;
    try {
      await navigator.clipboard.writeText(text);
      el("copyBox").classList.remove("show");
      dStat(label + " copied. Paste straight into Excel, it lands in columns.");
    } catch (e) {
      el("copyBox").classList.add("show");
      dStat("Clipboard blocked here. Select the text above and copy it manually.", true);
    }
  }
  async function exportXlsx() {
    dStat("Gathering every logged day");
    try {
      var days = await loadAllDays(function (i, n) { dStat("Reading day " + i + " of " + n); });
      if (!days.length && !Object.keys(state.weights).length) { dStat("Nothing to export yet.", true); return; }
      var t = buildTables(days);
      dStat("Building the workbook");
      await loadScript(SHEETJS);
      var wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(t.items), "Items");
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(t.daily), "Daily");
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(t.weight), "Weight");
      window.XLSX.writeFile(wb, "calorie-log-" + today() + ".xlsx");
      dStat("Saved. If nothing downloaded, your browser blocked it, use Copy food instead.");
    } catch (e) { dStat("Couldn't build the file. Use Copy food and paste into Excel.", true); }
  }
  async function exportAll() {
    dStat("Gathering everything");
    try {
      var days = await loadAllDays(function (i, n) { dStat("Reading day " + i + " of " + n); });
      var payload = { app: "calorie-log", v: 2, made: new Date().toISOString(),
        settings: state.targets, favorites: state.favs, weights: state.weights,
        totals: state.totals, pantry: state.pantry, checkpoints: state.checkpoints, clean: state.clean, carry: state.carry,
        gymPlan: App.store.get("gym:plan", null), comp: App.store.get("comp", null),
        meals: App.store.get("meals", null), reminder: App.store.get("reminder", null),
        gymSessions: App.store.keys("gymses:").reduce(function (a, k) { a[k] = App.store.get(k, []); return a; }, {}),
        days: days.reduce(function (a, d) { a[d.date] = d.entries; return a; }, {}) };
      var text = JSON.stringify(payload);
      var ok = downloadText(text, "calorie-log-full-" + today() + ".json", "application/json");
      el("copyBox").value = text;
      try { await navigator.clipboard.writeText(text); } catch (e) {}
      el("copyBox").classList.add("show");
      dStat((ok ? "Downloaded, copied to clipboard, and shown above. " : "Download blocked, but it is copied and shown above. ") +
        "Keep it somewhere outside Claude.");
    } catch (e) { dStat("Couldn't build the export.", true); }
  }
  async function copyFood() {
    dStat("Gathering every logged day");
    try {
      var days = await loadAllDays(function (i, n) { dStat("Reading day " + i + " of " + n); });
      await putOnClipboard(toTSV(buildTables(days).items), "Food log");
    } catch (e) { dStat("Couldn't read the log.", true); }
  }
  async function copyWeight() {
    var t = buildTables([]);
    if (t.weight.length < 2) { dStat("No weights logged yet.", true); return; }
    await putOnClipboard(toTSV(t.weight), "Weight log");
  }

  // ---------- import ----------
  function splitRows(text) {
    return text.replace(/\r/g, "").split("\n").filter(function (l) { return l.trim(); })
      .map(function (l) { return l.indexOf("\t") > -1 ? l.split("\t") : l.split(","); });
  }
  function importTable(rows) {
    var head = rows[0].map(function (h) { return String(h).toLowerCase().trim(); });
    var idx = function (name) { return head.findIndex(function (h) { return h.indexOf(name) === 0; }); };
    var iDate = idx("date");
    if (iDate === -1) throw new Error("no date column");
    var iW = head.findIndex(function (h) { return h.indexOf("weight") === 0; });
    var iItem = idx("item"), iKcal = idx("calorie"), iProt = idx("protein");
    var days = {}, weights = {}, nW = 0, nI = 0;
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r], date = String(row[iDate] || "").trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (iItem === -1 && iW > -1) {
        var w = Number(row[iW]); if (isFinite(w) && w > 0) { weights[date] = Math.round(w * 10) / 10; nW++; }
        continue;
      }
      if (iItem === -1 || iKcal === -1) continue;
      var time = idx("time") > -1 ? String(row[idx("time")] || "--:--") : "--:--";
      var meal = idx("meal") > -1 ? String(row[idx("meal")] || "Meal") : "Meal";
      var key = date + "|" + time + "|" + meal;
      days[date] = days[date] || {};
      days[date][key] = days[date][key] || { id: key, time: time, label: meal, items: [] };
      days[date][key].items.push({
        name: String(row[iItem] || "Item").slice(0, 44),
        portion: idx("assumed") > -1 ? String(row[idx("assumed")] || "") : "",
        src: idx("source") > -1 ? (SRC.indexOf(String(row[idx("source")]).trim()) > -1 ? String(row[idx("source")]).trim() : "estimate") : "estimate",
        kcal: Math.max(0, Math.round(Number(row[iKcal]) || 0)),
        p: iProt > -1 ? Math.max(0, Math.round(Number(row[iProt]) || 0)) : 0,
        c: idx("carb") > -1 ? Math.max(0, Math.round(Number(row[idx("carb")]) || 0)) : 0,
        f: idx("fat") > -1 ? Math.max(0, Math.round(Number(row[idx("fat")]) || 0)) : 0 });
      nI++;
    }
    var out = {};
    Object.keys(days).forEach(function (d) {
      out[d] = Object.keys(days[d]).map(function (k) { return days[d][k]; });
    });
    return { days: out, weights: weights, nW: nW, nI: nI };
  }
  async function applyImport(days, weights, extra) {
    var dates = Object.keys(days).slice(0, 500), merged = 0;
    for (var i = 0; i < dates.length; i++) {
      dStat("Importing " + (i + 1) + " of " + dates.length, false, "rStat");
      var d = dates[i];
      var existing = (load("day:" + d, [])).map(normalise);
      var seen = {};
      existing.forEach(function (e) { seen[e.time + "|" + e.label] = true; });
      var add = days[d].map(normalise).filter(function (e) { return !seen[e.time + "|" + e.label]; });
      if (!add.length) continue;
      var all = existing.concat(add);
      save("day:" + d, all);
      state.totals[d] = dayTotals(all).kcal;
      all.forEach(function (e) { stockPantry(e.items); });
      merged += add.length;
    }
    if (weights && Object.keys(weights).length) {
      Object.keys(weights).forEach(function (k) { state.weights[k] = weights[k]; });
      save("weights", state.weights);
    }
    if (extra) {
      if (extra.settings) { state.targets = Object.assign(state.targets, extra.settings); save("settings", state.targets); }
      if (extra.favorites) { state.favs = extra.favorites; save("favorites", state.favs); }
      if (extra.pantry) { state.pantry = Object.assign(extra.pantry, state.pantry); }
      if (extra.checkpoints) { state.checkpoints = extra.checkpoints; save("checkpoints", state.checkpoints); }
      if (extra.clean) { state.clean = Object.assign(extra.clean, state.clean); save("clean", state.clean); }
      if (extra.carry) { state.carry = Object.assign(extra.carry, state.carry); save("carry", state.carry); }
      if (extra.gymPlan) { save("gym:plan", extra.gymPlan); if (App.gym) App.gym.load(); }
      if (extra.comp) { save("comp", extra.comp); if (App.comp) App.comp.load(); }
      if (extra.meals) save("meals", extra.meals);
      if (extra.reminder) save("reminder", extra.reminder);
      if (extra.gymSessions) Object.keys(extra.gymSessions).forEach(function (k) { save(k, extra.gymSessions[k]); });
    }
    save("totals", state.totals);
    save("pantry", state.pantry);
    state.entries = (load(dayKey(state.date), [])).map(normalise);
    return merged;
  }
  async function doImport() {
    var box = el("importBox");
    if (!box.classList.contains("show")) {
      box.classList.add("show"); box.focus();
      dStat("Paste an export or Excel rows above, then press Import data again.", false, "rStat");
      return;
    }
    var raw = box.value.trim();
    if (!raw) { dStat("Nothing pasted yet.", true, "rStat"); return; }
    try {
      if (raw.charAt(0) === "{") {
        var data = JSON.parse(raw);
        if (!data.days) throw new Error("bad");
        var n = await applyImport(data.days, data.weights, data);
        box.classList.remove("show"); box.value = "";
        dStat("Imported " + n + " meals and " + Object.keys(data.weights || {}).length + " weights.", false, "rStat");
      } else {
        var t = importTable(splitRows(raw));
        var m = await applyImport(t.days, t.weights, null);
        box.classList.remove("show"); box.value = "";
        dStat("Imported " + m + " meals and " + t.nW + " weights from the pasted rows.", false, "rStat");
      }
      render();
    } catch (e) {
      dStat("Couldn't read that. It needs to be a full export, or rows with a Date column.", true, "rStat");
    }
  }
  function switchView(v) {
    state.view = v;
    ["Log","Month","Weight","Gym","Ask"].forEach(function (k) {
      var sec = el("view" + k), tab = el("tab" + k);
      if (sec) sec.hidden = (v !== k.toLowerCase());
      if (tab) tab.setAttribute("aria-selected", String(v === k.toLowerCase()));
    });
    if (App.swipeDir) {
      var sec = el("view" + v.charAt(0).toUpperCase() + v.slice(1));
      if (sec) { sec.classList.remove("fromL", "fromR");
        void sec.offsetWidth;
        sec.classList.add(App.swipeDir === "left" ? "fromR" : "fromL"); }
    }
    var isLog = v === "log";
    el("prevDay").style.visibility = isLog ? "" : "hidden";
    el("nextDay").style.visibility = isLog ? "" : "hidden";
    App.closeSheets();
    render();
  }

  function setPane(group, which) {
    if (group === "body") {
      el("paneWeight").hidden = which !== "weight";
      el("paneStreak").hidden = which !== "streak";
      el("paneComp").hidden = which !== "comp";
      el("segWeight").setAttribute("aria-selected", String(which === "weight"));
      el("segStreak").setAttribute("aria-selected", String(which === "streak"));
      el("segComp").setAttribute("aria-selected", String(which === "comp"));
      state.bodyPane = which;
    } else {
      el("paneChat").hidden = which !== "chat";
      el("paneRead").hidden = which !== "read";
      el("segChat").setAttribute("aria-selected", String(which === "chat"));
      el("segRead").setAttribute("aria-selected", String(which === "read"));
      state.askPane = which;
    }
    render();
  }

  function render() {
    el("dateLabel").textContent =
      state.view === "log" ? prettyDate(state.date)
      : state.view === "month" ? "Calendar"
      : state.view === "weight" ? "Body"
      : state.view === "gym" ? "Training" : "Ask";
    el("nextDay").disabled = isToday(state.date);
    var vl = el("verLine");
    if (vl) vl.textContent = VERSION + " \u00b7 " + Object.keys(state.totals).length + " days \u00b7 " +
      Object.keys(state.weights).length + " weights \u00b7 " + state.checkpoints.length + " checkpoints \u00b7 " +
      Object.keys(state.pantry).length + " foods";
    var ml = el("modelLine");
    if (ml) ml.textContent = state.model
      ? "Answering with " + state.model
      : "Model resolves on the first request";

    if (state.view === "log") renderLog();
    else if (state.view === "month") renderMonth();
    else if (state.view === "weight") {
      if (state.bodyPane === "streak") renderStreak();
      else if (state.bodyPane === "comp") App.renderComp();
      else renderWeight();
    } else if (state.view === "gym") {
      App.gymRender();
    } else if (state.view === "ask") {
      if (state.askPane === "read") renderCoach(); else renderAsk();
    }
  }

  if (el("logBtn")) el("logBtn").onclick = logText;
  el("foodInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); logText(); } });
  el("photoBtn").onclick = function () { el("photoInput").click(); };
  el("photoInput").onchange = function (e) {
    var f = e.target.files && e.target.files[0]; e.target.value = ""; logPhoto(f); };
  el("prevDay").onclick = function () { changeDay(-1); };
  el("nextDay").onclick = function () { changeDay(1); };
  el("askSend").onclick = function () { askAssistant(el("askInput").value); };
  el("askInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); askAssistant(el("askInput").value); } });
  el("askClear").onclick = function () { state.thread = []; renderAsk(); };
  el("lookupBtn").onclick = async function () {
    state.targets.lookup = !state.targets.lookup;
    save("settings", state.targets);
    el("lookupBtn").setAttribute("aria-pressed", String(state.targets.lookup));
    setStatus(state.targets.lookup
      ? "Web search on. Use it for packaged and chain items only, it crowds out longer meals."
      : "Web search off. The food database still runs on every log.");
  };
  App.fillTargets = function () {
    el("tKcal").value = state.targets.kcal;
    el("tProt").value = state.targets.protein;
    el("tWeight").value = state.targets.weight || "";
    el("tRate").value = state.targets.rate || "";
    var tb = el("tBuffer"); if (tb) tb.value = state.targets.buffer != null ? state.targets.buffer : 100;
    if (App.reminders) {
      var slots = App.reminders.list();
      ["remTime", "remTime2", "remTime3"].forEach(function (id, i) {
        var n = el(id); if (n) n.value = slots[i] || "";
      });
    }
    App.reminderStatus();
  };

  App.reminderStatus = function () {
    var n = el("remStat");
    if (!n || !App.reminders) return;
    var slots = App.reminders.list(), perm = App.reminders.permission();
    n.className = "note";
    if (perm === "unsupported") { n.textContent = "This browser cannot show notifications."; return; }
    if (!slots.length) { n.textContent = "No reminders set."; return; }
    if (perm !== "granted") {
      n.textContent = "Set for " + slots.join(", ") + ", but notifications are not allowed yet. Saving again will ask.";
      n.className = "note err";
      return;
    }
    n.textContent = slots.join(", ") + ". Each one is written from what is actually missing at " +
      "that moment. They arrive while the app is open, or next time you open it.";
  };
  el("saveTargets").onclick = async function () {
    state.targets.kcal = Math.max(0, Math.round(Number(el("tKcal").value) || 0));
    state.targets.protein = Math.max(0, Math.round(Number(el("tProt").value) || 0));
    state.targets.weight = Math.max(0, Math.round((Number(el("tWeight").value) || 0) * 10) / 10);
    state.targets.rate = Math.max(0, Number(el("tRate").value) || 0);
    var tb = el("tBuffer");
    if (tb) state.targets.buffer = Math.max(0, Math.round(Number(tb.value) || 0));
    save("settings", state.targets);
    if (App.reminders) {
      var vals = ["remTime", "remTime2", "remTime3"]
        .map(function (id) { var n = el(id); return n ? n.value : ""; });
      var set = App.reminders.setList(vals);
      if (set.length && App.reminders.permission() === "default") {
        App.reminders.request().then(function () { App.reminderStatus(); App.reminders.start(); });
      } else { App.reminders.start(); }
      App.reminderStatus();
    }
    App.closeSheets();
    setStatus("Targets saved"); render();
  };
  el("prevMonth").onclick = function () { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); render(); };
  el("nextMonth").onclick = function () { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); render(); };
  el("prevWMonth").onclick = function () { state.wMonth = new Date(state.wMonth.getFullYear(), state.wMonth.getMonth() - 1, 1); render(); };
  el("nextWMonth").onclick = function () { state.wMonth = new Date(state.wMonth.getFullYear(), state.wMonth.getMonth() + 1, 1); render(); };
  el("wSave").onclick = function () { saveWeight(state.wPick || today(), el("wInput").value); };
  el("wInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); saveWeight(state.wPick || today(), el("wInput").value); } });
  el("wClear").onclick = function () { clearWeight(state.wPick || today()); };
  el("cpAdd").onclick = function () { addCheckpoint(el("cpKg").value, el("cpDate").value); };
  el("xlsxBtn").onclick = exportXlsx;
  el("allBtn").onclick = exportAll;
  el("copyFood").onclick = copyFood;
  el("copyWeight").onclick = copyWeight;
  el("modelRetry").onclick = function () {
    state.model = null;
    App.api.clearModel();
    dStat("Cleared. The next request will try " + MODEL_PREF + " again.");
    render();
  };
  el("importBtn").onclick = doImport;
  el("fileBtn").onclick = function () { el("fileInput").click(); };
  el("fileInput").onchange = function (e) {
    var f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      el("importBox").classList.add("show");
      el("importBox").value = String(r.result);
      dStat("File loaded. Press Import data to apply it.", false, "rStat");
    };
    r.onerror = function () { dStat("Couldn't read that file.", true, "rStat"); };
    r.readAsText(f);
  };

  App.logSavedMeal = function (item) {
    addEntry({ label: item.name, items: [item] });
    App.closeSheets();
    setStatus("Logged " + item.amount + " " + item.unit + " " + item.name + ", " + item.kcal + " kcal");
  };
  /* What the notification writer is told. Facts only, no instructions,
     so the wording stays its job and the data stays ours. */
  App.reminderContext = function () {
    var L = [], t = dayTotals(state.entries), now = new Date();
    var d = today();
    L.push("Time " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ".");
    L.push(state.entries.length
      ? "Food logged today: " + state.entries.length + " meals, " + t.kcal + " kcal of a " +
        effectiveTarget(d) + " target, " + t.p + " g of " + state.targets.protein + " g protein."
      : "No food logged today at all.");
    var times = state.entries.map(function (e) { return e.time; })
      .filter(function (x) { return x !== "--:--"; }).sort();
    if (times.length) L.push("Last thing eaten at " + times[times.length - 1] + ".");
    L.push(state.weights[d] != null
      ? "Weighed in today at " + state.weights[d] + " kg."
      : "Not weighed today. Last known " + (latestWeight() || "unknown") + " kg.");
    var cs = currentStreak(), ss = slipStats();
    L.push("Habit streak " + cs + " days" +
      (state.clean[d] !== undefined ? ", already logged today" : ", not logged today") +
      ", best ever " + bestStreak() + ".");
    if (App.gym) {
      var dates = App.gym.allDates();
      var last = dates[dates.length - 1];
      L.push(last === d ? "Trained today already."
        : last ? "Last training session " + last + "." : "No training logged yet.");
    }
    if (state.targets.weight && latestWeight()) {
      L.push("Goal weight " + state.targets.weight + " kg, currently " +
        (latestWeight() - state.targets.weight).toFixed(1) + " kg away.");
    }
    return L.join("\n");
  };
  App.reminderFallback = function () {
    var d = today();
    if (state.clean[d] === undefined && currentStreak() > 2) return "Streak is at " + currentStreak() + " days. Log today.";
    if (!state.entries.length) return "Nothing logged today yet.";
    if (state.weights[d] == null) return "No weigh-in today.";
    var t = dayTotals(state.entries);
    return t.p < state.targets.protein * 0.7 ? "Protein is at " + t.p + " g so far." : "Log is up to date.";
  };
  App.offLookup = function (q) { return offLookup(q).then(function (rows) { return relevant(rows, q); }); };
  App.entryStatus = function (m, e) { setStatus(m, e); };
  App.entryError = function (e) { return fatal(e); };
  App.logStructured = function (item, sources) {
    addEntry({ label: item.name, items: [item] });
    var how = sources && sources.length
      ? " (filled from " + sources.join(", then ") + ")"
      : " from your figures, nothing sent";
    setStatus("Logged " + item.amount + " " + item.unit + " " + item.name +
      ", " + item.kcal + " kcal" + how);
  };
  App.setStreakDay = setDay;
  App.streakMonth = function () { return state.stMonth || new Date(); };
  App.setStreakMonth = function (m) { state.stMonth = m; render(); };

  /* Read a body composition printout the same way a nutrition label is read. */
  App.readScan = async function (file) {
    var ok = ["image/jpeg", "image/png", "image/webp"];
    if (ok.indexOf(file.type) === -1) { App.compStatus("That image format is not supported.", true); return; }
    App.compStatus("Reading the printout");
    try {
      var b64 = await fileToBase64(file);
      var data = await App.api.call([{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: file.type, data: b64 } },
        { type: "text", text: App.comp.READ_RULES }
      ] }], { tier: "fast" });
      var o = App.api.json(data);
      var date = /^\d{4}-\d{2}-\d{2}$/.test(o.date || "") ? o.date : today();
      if (App.comp.put(date, o)) {
        App.compStatus("Scan from " + date + " saved. Check the numbers against the sheet.");
        App.comp.editing = date;
        App.renderComp();
      } else App.compStatus("Nothing readable on that image.", true);
    } catch (e) {
      App.compStatus(e && e.kind === "nokey" ? "Add your API key first."
        : e && e.kind === "auth" ? "API key rejected."
        : "Could not read that printout. Try a straighter, closer shot.", true);
    }
  };

  App.compStatus = function (m, e) { var n = el("compStat"); if (n) { n.textContent = m || ""; n.className = "status" + (e ? " err" : ""); } };
  App.askClaudeRaw = askClaude;
  App.currentView = function () { return state.view; };
  App.go = switchView;
  App.pane = setPane;
  App.refresh = render;

  App.boot = function () {
    setStatus("Loading");
    var r = [
      load("settings", { kcal: 2000, protein: 150, lookup: false, weight: 0, rate: 0.5, buffer: 100 }),
      load("favorites", []), load("totals", {}), load("weights", {}),
      load("pantry", {}), load(dayKey(state.date), []),
      load("checkpoints", []), load("coach", null), load("clean", {}), load("carry", {}),
      App.api.model()
    ];
    state.targets = Object.assign({ kcal: 2000, protein: 150, lookup: false, weight: 0, rate: 0.5, buffer: 100 }, r[0]);
    if (state.targets.buffer == null) state.targets.buffer = 100;
    state.favs = (r[1] || []).map(function (f) {
      return f.items ? f : { label: f.name || "Repeat",
        items: [{ name: f.name || "Repeat", kcal: f.kcal || 0, p: f.p || 0, c: f.c || 0, f: f.f || 0 }] };
    });
    state.totals = r[2] || {}; state.weights = r[3] || {}; state.pantry = r[4] || {};
    state.entries = (r[5] || []).map(normalise);
    state.checkpoints = r[6] || [];
    state.coach = r[7] || null;
    state.clean = r[8] || {};
    state.carry = r[9] || {};
    state.model = r[10] || null;

    // rebuild the calendar rollup for any day the index has not seen
    try {
      var dayKeys = App.store.keys("day:");
      var missing = dayKeys.filter(function (k) { return !(k.slice(4) in state.totals); });
      var needPantry = !Object.keys(state.pantry).length && dayKeys.length;
      var scan = needPantry ? dayKeys : missing;
      if (scan.length) {
        scan.forEach(function (k) {
          var ents = load(k, []).map(normalise);
          var t = dayTotals(ents).kcal;
          if (t > 0) state.totals[k.slice(4)] = t;
          ents.forEach(function (e) { stockPantry(e.items); });
        });
        save("totals", state.totals);
        save("pantry", state.pantry);
      }
    } catch (e) {}

    state.stMonth = new Date();
    if (App.gym) App.gym.load();
    if (App.comp) App.comp.load();
    if (App.reminders) App.reminders.start();
    if (App.photos && App.photos.ready()) { renderPhotoQueue(); App.photos.start(); }
    state.bodyPane = "weight";
    state.askPane = "chat";
    switchView("log");
    setStatus("");
  };

})(window.App = window.App || {});
