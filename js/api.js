/* api.js — the only place that talks to Anthropic.
   Holds the key, picks the model, and reports failures in a way the caller can
   act on. Nothing else in the app knows the endpoint exists. */
(function (App) {
  "use strict";

  var ENDPOINT = "https://api.anthropic.com/v1/messages";
  var VERSION = "2023-06-01";
  /* Two tiers. Narrow, well-specified jobs go to the fast model because you are
     standing in a kitchen waiting for them. Open judgement goes to the deep one
     because you are not. Each tier remembers what was accepted. */
  var TIERS = {
    fast: ["claude-sonnet-5", "claude-opus-5"],
    deep: ["claude-opus-5", "claude-sonnet-5"]
  };
  var MAX_TOKENS = 2000;

  var api = {
    /* ---- key vault ---- */
    getKey: function () { return App.store.get("apiKey", "") || ""; },
    setKey: function (k) {
      k = String(k || "").trim();
      App.store.set("apiKey", k);
      App.store.set("model", null);        // re-probe the model on the next call
      return k;
    },
    hasKey: function () { return this.getKey().length > 10; },
    maskedKey: function () {
      var k = this.getKey();
      if (!k) return "none set";
      return k.slice(0, 7) + "\u2026" + k.slice(-4);
    },

    model: function (tier) { return App.store.get("model:" + (tier || "fast"), null); },
    clearModel: function () {
      App.store.set("model:fast", null);
      App.store.set("model:deep", null);
      App.store.set("model", null);
    },
    tierOf: function (tier) { return TIERS[tier] ? tier : "fast"; },

    online: function () { return navigator.onLine !== false; },

    /* ---- the call ----
       Throws an Error whose .kind says what went wrong, so callers can decide
       between queueing the request, prompting for a key, and simply retrying:
         offline    no network
         nokey      no API key stored
         auth       key rejected
         credit     out of credit or rate limited
         rejected   this model is not available to this key
         http       anything else from the server
         parse      the reply was not usable */
    call: async function (messages, opts) {
      opts = opts || {};
      if (!this.hasKey()) throw kind(new Error("No API key"), "nokey");
      if (!this.online()) throw kind(new Error("Offline"), "offline");

      var tier = this.tierOf(opts.tier);
      var stored = this.model(tier);
      var order = stored ? [stored] : TIERS[tier].slice();
      var lastErr = null;

      for (var i = 0; i < order.length; i++) {
        var body = {
          model: order[i],
          max_tokens: opts.max_tokens || MAX_TOKENS,
          messages: messages
        };
        if (opts.tools) body.tools = opts.tools;

        var res;
        try {
          res = await fetch(ENDPOINT, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": this.getKey(),
              "anthropic-version": VERSION,
              // required for calls made straight from a browser
              "anthropic-dangerous-direct-browser-access": "true"
            },
            body: JSON.stringify(body)
          });
        } catch (netErr) {
          // a browser blocks the response before any status is visible, so a
          // thrown fetch on a live connection almost always means CORS
          throw kind(new Error("the request never reached Anthropic, which usually means the " +
            "browser blocked it"), this.online() ? "cors" : "offline");
        }

        if (res.ok) {
          var data;
          try { data = await res.json(); }
          catch (e) { throw kind(new Error("Bad JSON from server"), "parse"); }
          if (stored !== order[i]) App.store.set("model:" + tier, order[i]);
          return data;
        }

        var detail = "";
        try { var body = await res.json(); detail = (body.error && body.error.message) || ""; }
        catch (e) {}

        if (res.status === 401 || res.status === 403) {
          throw kind(new Error(detail || "API key rejected"), "auth");
        }
        if (res.status === 429) {
          throw kind(new Error(detail || "Rate limited or out of credit"), "credit");
        }
        if (res.status === 400 && /model/i.test(detail) && i < order.length - 1) {
          lastErr = kind(new Error(detail), "rejected");
          continue;                        // the model name was refused, try the fallback
        }
        if (res.status >= 400 && res.status < 500 && i < order.length - 1) {
          lastErr = kind(new Error(detail || "rejected"), "rejected");
          continue;
        }
        var err = kind(new Error(detail || ("server returned " + res.status)), "http");
        err.status = res.status;
        err.model = order[i];
        throw err;
      }
      throw lastErr || kind(new Error("No model available"), "rejected");
    },

    /* ---- reply helpers ---- */
    text: function (data) {
      return (data.content || [])
        .filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; })
        .join("\n");
    },

    /* Tolerant JSON extraction. Survives a truncated reply by walking back to
       the last complete object and closing the brackets. */
    json: function (data) {
      var blocks = (data.content || []).filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; });
      for (var i = blocks.length - 1; i >= 0; i--) {
        try { return parse(blocks[i]); } catch (e) {}
      }
      return parse(blocks.join("\n"));
    },

    TIERS: TIERS
  };

  function kind(err, k) { err.kind = k; return err; }

  function balance(frag) {
    var c = 0, b = 0, inStr = false, esc = false;
    for (var i = 0; i < frag.length; i++) {
      var ch = frag.charAt(i);
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") c++; else if (ch === "}") c--;
      else if (ch === "[") b++; else if (ch === "]") b--;
    }
    return { c: c, b: b, open: inStr };
  }

  function parse(t) {
    var a = t.indexOf("{");
    if (a === -1) throw kind(new Error("no json"), "parse");
    var z = t.lastIndexOf("}");
    if (z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch (e) {} }
    var s = t.slice(a), stops = [];
    for (var i = 0; i < s.length; i++) if (s.charAt(i) === "}") stops.push(i + 1);
    for (var k = stops.length - 1; k >= 0; k--) {
      var frag = s.slice(0, stops[k]), bal = balance(frag);
      if (bal.open || bal.c < 0 || bal.b < 0) continue;
      var fixed = frag.replace(/,\s*$/, "") +
        new Array(bal.b + 1).join("]") + new Array(bal.c + 1).join("}");
      try { return JSON.parse(fixed); } catch (e) {}
    }
    throw kind(new Error("unparseable"), "parse");
  }

  App.api = api;
})(window.App = window.App || {});
