/* main.js — start-up order and everything that only matters outside the app
   logic: migrations, the key setup panel, the service worker, install state. */
(function (App) {
  "use strict";

  var BUILD = "3.5.0";

  function el(id) { return document.getElementById(id); }

  function bail(msg) {
    var box = el("bootError");
    box.hidden = false;
    box.textContent = msg;
    box.setAttribute("role", "alert");
  }

  /* ---- key setup panel ---- */
  function wireSetup() {
    var input = el("keyInput"), stat = el("keyStat"), show = el("keyShow");
    if (!input) return;

    function say(msg, bad) {
      stat.textContent = msg || "";
      stat.className = "dstat" + (bad ? " err" : "");
    }
    function refresh() {
      if (App.api.hasKey()) {
        input.value = "";
        input.placeholder = App.api.maskedKey();
        say("Key saved on this device.");
      } else {
        input.placeholder = "sk-ant-...";
        say("No key set. Logging by hand works without one; estimates need it.");
      }
    }

    el("keySave").onclick = function () {
      var v = input.value.trim();
      if (!v) { say("Paste your key first.", true); return; }
      if (v.indexOf("sk-ant-") !== 0) {
        say("That does not look like an Anthropic key, they start with sk-ant-.", true);
        return;
      }
      App.api.setKey(v);
      refresh();
      if (App.refresh) App.refresh();
    };

    show.onclick = function () {
      input.type = input.type === "password" ? "text" : "password";
      show.textContent = input.type === "password" ? "Show" : "Hide";
    };

    el("keyTest").onclick = async function () {
      if (!App.api.hasKey()) { say("Save a key first.", true); return; }
      say("Testing");
      try {
        var data = await App.api.call(
          [{ role: "user", content: "Reply with the single word: ready" }],
          { max_tokens: 16, tier: "fast" }
        );
        var txt = App.api.text(data).trim().toLowerCase();
        say(txt.indexOf("ready") > -1
          ? "Working. Logging uses " + (App.api.model("fast") || "the fast model") + "."
          : "Got a reply, so the key works.");
        if (App.refresh) App.refresh();
      } catch (e) {
        var k = e && e.kind;
        say(k === "auth" ? "Key rejected: " + (e.message || "check you copied all of it")
          : k === "credit" ? "Key works but there is no credit, or you are rate limited."
          : k === "offline" ? "No connection right now."
          : k === "cors" ? "The request never reached Anthropic. Your network or an extension blocked it."
          : k === "rejected" ? "No model accepted the request: " + (e.message || "")
          : "Error " + (e.status || "") + ": " + (e.message || "unknown"), true);
      }
    };

    refresh();
  }

  /* Escape hatch: clears every cache and unregisters the worker, then reloads
     from the network. Data in localStorage is untouched. */
  App.hardRefresh = function () {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage("reset");
    }
    if (window.caches) {
      caches.keys().then(function (n) {
        return Promise.all(n.map(function (k) { return caches.delete(k); }));
      }).then(function () { location.reload(true); });
    } else location.reload(true);
  };

  /* ---- diagnostics line in the Data tab ---- */
  function wireDiagnostics(migration) {
    var line = el("diagLine");
    if (!line) return;
    function update() {
      var kb = Math.round(App.store.bytes() / 1024);
      line.textContent = "Build " + BUILD + ", schema " + App.store.schema +
        (migration && migration.applied.length ? " (migrated " + migration.applied.join(", ") + ")" : "") +
        ", " + kb + " KB stored, " +
        (navigator.onLine === false ? "offline" : "online") + ".";
    }
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
  }

  /* ---- service worker ---- */
  function wireServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").then(function (reg) {
        // a new build is live as soon as it is fetched; take it on next launch
        reg.addEventListener("updatefound", function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", function () {
            if (sw.state === "installed" && navigator.serviceWorker.controller) {
              var line = el("diagLine");
              if (line) line.textContent = "An update is ready. Close and reopen the app to use it.";
            }
          });
        });
      }).catch(function () { /* offline caching is optional, never fatal */ });
    });
  }

  /* ---- start ---- */
  document.addEventListener("DOMContentLoaded", function () {
    if (!App.store.available()) {
      bail("This browser is blocking local storage, so nothing can be saved. " +
        "Private browsing is the usual cause. Open the app in a normal window.");
      return;
    }
    var migration = App.store.migrate();
    try {
      App.boot();
    } catch (e) {
      bail("The app failed to start: " + (e && e.message ? e.message : e));
      if (window.console) console.error(e);
      return;
    }
    if (App.paintIcons) App.paintIcons();
    if (App.entry) App.entry.init();
    wireSetup();
    wireDiagnostics(migration);
    wireServiceWorker();
  });
})(window.App = window.App || {});
