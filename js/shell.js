/* shell.js — navigation and overlays.
   The app logic knows nothing about how it is presented; everything to do with
   destinations, panes and sheets lives here. */
(function (App) {
  "use strict";

  function el(id) { return document.getElementById(id); }

  App.sheetOpen = null;

  /* ---- sheets ---------------------------------------------------------- */
  function openSheet(which) {
    closeSheets(true);
    var node = which === "advice" ? el("adviceSheet")
      : which === "data" ? el("dataSheet")
      : which === "meals" ? el("mealsSheet") : el("sheet");
    App.sheetOpen = which;
    el("scrim").hidden = false;
    node.hidden = false;
    if (which === "targets" && App.fillTargets) App.fillTargets();
    if (which === "advice" && App.refresh) App.refresh();
    if (which === "meals" && App.renderMeals) App.renderMeals();
  }

  function closeSheets(silent) {
    App.sheetOpen = null;
    el("scrim").hidden = true;
    el("sheet").hidden = true;
    el("adviceSheet").hidden = true;
    var d = el("dataSheet"); if (d) d.hidden = true;
    var mm = el("mealsSheet"); if (mm) mm.hidden = true;
    if (!silent && App.refresh) App.refresh();
  }
  App.closeSheets = closeSheets;
  App.openSheet = openSheet;

  /* ---- wiring ---------------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", function () {
    // destinations
    [["tabLog", "log"], ["tabMonth", "month"], ["tabWeight", "weight"],
     ["tabGym", "gym"], ["tabAsk", "ask"]].forEach(function (p) {
      var b = el(p[0]);
      if (b) b.onclick = function () { App.go(p[1]); };
    });

    // sub-panes
    if (el("segWeight")) el("segWeight").onclick = function () { App.pane("body", "weight"); };
    if (el("segStreak")) el("segStreak").onclick = function () { App.pane("body", "streak"); };
    if (el("segComp")) el("segComp").onclick = function () { App.pane("body", "comp"); };

    // gym sub-views
    [["segSession", "session"], ["segTrends", "trends"], ["segPlan", "plan"]].forEach(function (p) {
      var b = el(p[0]);
      if (b) b.onclick = function () { App.gym.view = p[1]; App.gymRender(); };
    });

    // streak month paging
    function stepStreakMonth(n) {
      var m = App.streakMonth();
      App.setStreakMonth(new Date(m.getFullYear(), m.getMonth() + n, 1));
    }
    if (el("prevStMonth")) el("prevStMonth").onclick = function () { stepStreakMonth(-1); };
    if (el("nextStMonth")) el("nextStMonth").onclick = function () { stepStreakMonth(1); };

    // body composition entry
    if (el("compAdd")) el("compAdd").onclick = function () {
      App.comp.editing = new Date().toISOString().slice(0, 10);
      App.renderComp();
    };
    if (el("compShoot")) el("compShoot").onclick = function () { el("compPhoto").click(); };
    if (el("compPhoto")) el("compPhoto").onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) App.readScan(f);
    };
    if (el("segChat")) el("segChat").onclick = function () { App.pane("ask", "chat"); };
    if (el("segRead")) el("segRead").onclick = function () { App.pane("ask", "read"); };

    // sheets
    el("gear").onclick = function () {
      if (App.sheetOpen === "targets") closeSheets(); else openSheet("targets");
    };
    el("scrim").onclick = function () { closeSheets(); };
    if (el("openData")) el("openData").onclick = function () { openSheet("data"); };
    if (el("hardRefresh")) el("hardRefresh").onclick = function () {
      if (App.hardRefresh) App.hardRefresh();
    };
    if (el("chipAdvice")) el("chipAdvice").onclick = function () { openSheet("advice"); };
    if (el("chipMeals")) el("chipMeals").onclick = function () { openSheet("meals"); };
    if (el("remOff")) el("remOff").onclick = function () {
      if (!App.reminders) return;
      App.reminders.setList([]);
      ["remTime", "remTime2", "remTime3"].forEach(function (id) {
        var n = el(id); if (n) n.value = "";
      });
      App.reminderStatus();
    };
    if (el("remTest")) el("remTest").onclick = async function () {
      if (!App.reminders) return;
      var n = el("remStat");
      n.className = "note"; n.textContent = "Writing one";
      var body = await App.reminders.compose();
      if (App.reminders.permission() === "default") await App.reminders.request();
      var shown = App.reminders.fire(body, "boulder-preview");
      n.textContent = (shown ? "Sent: " : "Would say: ") + body;
    };
    if (el("chipStreak")) el("chipStreak").onclick = function () {
      App.go("weight"); App.pane("body", "streak");
    };
    if (el("wGoal")) el("wGoal").onclick = function () {
      App.go("weight"); App.pane("body", "weight");
    };

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && App.sheetOpen) closeSheets();
    });

    // a sheet should not scroll the page behind it
    ["sheet", "adviceSheet", "dataSheet", "mealsSheet"].forEach(function (id) {
      var n = el(id);
      if (n) n.addEventListener("touchmove", function (e) {
        if (!e.target.closest(".scroll")) e.preventDefault();
      }, { passive: false });
    });

    /* ── swipe between sections ──
       Only acts on a clearly horizontal drag that did not start inside
       something scrollable sideways, so the favourites strip, the photo queue
       and any vertical list keep their own gestures. */
    var ORDER = ["log", "month", "weight", "gym", "ask"];
    var sx = 0, sy = 0, tracking = false, decided = false, horizontal = false;

    function scrollsSideways(node) {
      while (node && node !== document.body) {
        if (node.scrollWidth > node.clientWidth + 4) {
          var ov = getComputedStyle(node).overflowX;
          if (ov === "auto" || ov === "scroll") return true;
        }
        node = node.parentElement;
      }
      return false;
    }

    var stage = document.querySelector(".stage");
    stage.addEventListener("touchstart", function (e) {
      if (App.sheetOpen || e.touches.length !== 1) { tracking = false; return; }
      var t = e.touches[0];
      if (scrollsSideways(e.target)) { tracking = false; return; }
      sx = t.clientX; sy = t.clientY;
      tracking = true; decided = false; horizontal = false;
    }, { passive: true });

    stage.addEventListener("touchmove", function (e) {
      if (!tracking) return;
      var dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (!decided && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        decided = true;
        horizontal = Math.abs(dx) > Math.abs(dy) * 1.6;
      }
    }, { passive: true });

    stage.addEventListener("touchend", function (e) {
      if (!tracking || !horizontal) { tracking = false; return; }
      tracking = false;
      var dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) < 55) return;
      var i = ORDER.indexOf(App.currentView ? App.currentView() : "log");
      var next = dx < 0 ? i + 1 : i - 1;
      if (next < 0 || next >= ORDER.length) return;
      App.swipeDir = dx < 0 ? "left" : "right";
      App.go(ORDER[next]);
      App.swipeDir = null;
    }, { passive: true });

    /* On Android the soft keyboard shrinks the visual viewport rather than the
       layout viewport, which would leave the docked entry hidden behind it.
       Track the difference and lift the frame by exactly that much. */
    if (window.visualViewport) {
      var vv = window.visualViewport;
      var apply = function () {
        var lift = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        document.documentElement.style.setProperty("--kb", lift + "px");
        document.querySelector(".app").style.height =
          lift > 80 ? "calc(100dvh - " + lift + "px)" : "100dvh";
      };
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
    }
  });
})(window.App = window.App || {});
