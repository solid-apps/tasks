/* SolidKit v1.0 — shared hardening + live-sync kit for solid-apps.
 *
 * Canonical copy: solid-apps.github.io/kit/kit.js  (vendor a copy per app,
 * like intents.js — no build step, no runtime dependency on this URL).
 * Classic script: exposes window.SolidKit; safe to load before or after
 * xlogin. ES-module apps can read window.SolidKit as well.
 *
 * Everything here exists because the 2026-07 estate audit found the same
 * bugs re-implemented (and re-broken) across ~75 apps:
 *   esc/escAttr   – HTML escaping that also covers quotes (attr breakout)
 *   safeUrl       – scheme gate; javascript:/data: from pod data never
 *                   becomes a live href/src
 *   safeDecode    – decodeURIComponent that can't throw on a stray '%'
 *   loadDoc       – fetch wrapper that NEVER conflates "missing" (404/410)
 *                   with "failed" (network/5xx) — the #1 data-loss bug
 *   toaster       – honest toast bound to the app's own element; timers
 *                   don't stack, errors persist longer
 *   copyText      – clipboard that reports the truth (with fallback)
 *   debounce      – with .flush() and .cancel(), so navigation/pagehide can
 *                   commit pending work instead of dropping it
 *   subscribe     – solid-0.1 Updates-Via WebSocket manager: one socket per
 *                   endpoint, resubscribes on reconnect, capped backoff,
 *                   returns an unsubscribe function
 */
(function () {
  "use strict";
  if (window.SolidKit) return; // idempotent under double-include

  /* ---------------- escaping & URL hygiene ---------------- */

  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };

  // Attribute-context alias (same escaping; the name documents intent).
  var escAttr = esc;

  // Return an absolute http(s) URL, or null for anything unsafe/garbled.
  // Pass extra schemes explicitly when an app really needs them
  // (e.g. ["http:", "https:", "mailto:"]).
  var safeUrl = function (u, schemes) {
    if (u == null) return null;
    var allow = schemes || ["http:", "https:"];
    try {
      var p = new URL(String(u), (typeof location !== "undefined" && location.href) || "https://invalid.local/");
      return allow.indexOf(p.protocol) !== -1 ? p.href : null;
    } catch (e) { return null; }
  };

  var safeDecode = function (s) {
    if (s == null) return "";
    try { return decodeURIComponent(s); } catch (e) { return String(s); }
  };

  /* ---------------- honest document loading ---------------- */

  // loadDoc(fetchFn, url, init?) -> Promise<{
  //   ok:      true when the request settled conclusively (found OR missing)
  //   missing: true only for a definite 404/410
  //   status:  HTTP status (0 for network failure)
  //   res:     Response (when found)
  //   text:    body text (when found)
  //   error:   Error (when ok === false)
  // }>
  // Rule the whole estate now follows: only `missing === true` may be
  // treated as "start empty". `ok === false` must surface an error state and
  // MUST block any subsequent save from overwriting the remote document.
  function loadDoc(fetchFn, url, init) {
    var f = fetchFn || (typeof fetch !== "undefined" ? fetch : null);
    return Promise.resolve()
      .then(function () { return f(url, init); })
      .then(function (res) {
        if (res.status === 404 || res.status === 410) {
          return { ok: true, missing: true, status: res.status };
        }
        if (!res.ok) {
          return { ok: false, missing: false, status: res.status,
                   error: new Error("HTTP " + res.status) };
        }
        return res.text().then(function (text) {
          return { ok: true, missing: false, status: res.status, res: res, text: text };
        });
      })
      .catch(function (error) {
        return { ok: false, missing: false, status: 0, error: error };
      });
  }

  // Same contract, plus JSON parsing. A body that fails to parse is a
  // FAILURE (ok:false), never "empty" — parse errors were overwriting real
  // documents in the wild.
  function loadJson(fetchFn, url, init) {
    return loadDoc(fetchFn, url, init).then(function (r) {
      if (!r.ok || r.missing) return r;
      try { r.data = JSON.parse(r.text); return r; }
      catch (e) {
        return { ok: false, missing: false, status: r.status,
                 error: new Error("unparseable response: " + e.message) };
      }
    });
  }

  /* ---------------- honest UI feedback ---------------- */

  // toaster(el?, showClass?) -> show(msg, opts?)
  // Binds to the app's existing toast element so visuals stay the app's own.
  // With no element, lazily creates a minimal accessible one.
  // opts: { error: bool, ms: number }  (errors default to a longer hold)
  function toaster(el, showClass) {
    var timer = 0;
    var cls = showClass || "show";
    function ensure() {
      if (el && el.isConnected !== false) return el;
      el = document.createElement("div");
      el.id = "sk-toast";
      el.setAttribute("style",
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
        "max-width:min(480px,calc(100vw - 32px));padding:10px 16px;border-radius:10px;" +
        "background:rgba(20,20,26,.94);color:#f5f5f7;font:13px/1.45 system-ui,sans-serif;" +
        "box-shadow:0 10px 30px rgba(0,0,0,.35);z-index:9999;display:none;overflow-wrap:anywhere;");
      document.body.appendChild(el);
      cls = null; // style-driven fallback uses display toggling
    }
    return function show(msg, opts) {
      opts = opts || {};
      ensure();
      el.textContent = String(msg == null ? "" : msg);
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      if (cls) el.classList.add(cls); else el.style.display = "block";
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (cls) el.classList.remove(cls); else el.style.display = "none";
      }, opts.ms || (opts.error ? 6000 : 2600));
    };
  }

  // copyText(text) -> Promise<boolean>. Never claim success you didn't have.
  function copyText(text) {
    var t = String(text == null ? "" : text);
    var viaClipboard = (navigator.clipboard && navigator.clipboard.writeText)
      ? navigator.clipboard.writeText(t).then(function () { return true; }, function () { return false; })
      : Promise.resolve(false);
    return viaClipboard.then(function (ok) {
      if (ok) return true;
      try {
        var ta = document.createElement("textarea");
        ta.value = t;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var done = document.execCommand("copy");
        ta.remove();
        return !!done;
      } catch (e) { return false; }
    });
  }

  /* ---------------- debounce that can't lose work ---------------- */

  function debounce(fn, ms) {
    var t = 0, pendingArgs = null;
    function run() {
      t = 0;
      var a = pendingArgs; pendingArgs = null;
      fn.apply(null, a || []);
    }
    function d() {
      pendingArgs = Array.prototype.slice.call(arguments);
      clearTimeout(t);
      t = setTimeout(run, ms);
    }
    d.flush = function () { if (t) { clearTimeout(t); run(); } };
    d.cancel = function () { clearTimeout(t); t = 0; pendingArgs = null; };
    d.pending = function () { return !!t; };
    return d;
  }

  /* ---------------- Updates-Via live sync ---------------- */

  // One shared socket per Updates-Via endpoint; per-URL callback sets;
  // resubscribes everything on reconnect; capped exponential backoff
  // (2.5s → 30s, reset on a successful open); closes the socket when the
  // last subscriber leaves.
  var socks = new Map(); // via -> { ws, subs: Map<url, Set<cb>>, backoff, timer }

  function skOpen(via, entry) {
    var ws = new WebSocket(via);
    entry.ws = ws;
    ws.onopen = function () {
      entry.backoff = 2500;
      entry.subs.forEach(function (_cbs, url) { try { ws.send("sub " + url); } catch (e) {} });
    };
    ws.onmessage = function (ev) {
      var m = String(ev.data == null ? "" : ev.data).trim();
      if (m.slice(0, 4) !== "pub ") return;
      var cbs = entry.subs.get(m.slice(4));
      if (cbs) cbs.forEach(function (f) { try { f(); } catch (e) {} });
    };
    ws.onclose = function () {
      if (entry.ws !== ws) return;          // superseded socket: stay quiet
      entry.ws = null;
      if (!entry.subs.size) { socks.delete(via); return; }
      entry.timer = setTimeout(function () { skOpen(via, entry); }, entry.backoff);
      entry.backoff = Math.min(entry.backoff * 2, 30000);
    };
  }

  // subscribe(url, cb, { fetch }) -> Promise<unsubscribe>
  // Rejects with Error("no Updates-Via") when the server doesn't advertise
  // the header — callers should catch and simply run without live sync.
  function subscribe(url, cb, opts) {
    opts = opts || {};
    var f = opts.fetch || fetch;
    return Promise.resolve()
      .then(function () { return f(url, { method: "HEAD", cache: "no-store" }); })
      .then(function (res) {
        var via = res.headers.get("Updates-Via");
        if (!via) throw new Error("no Updates-Via");
        var entry = socks.get(via);
        if (!entry) {
          entry = { ws: null, subs: new Map(), backoff: 2500, timer: 0 };
          socks.set(via, entry);
          skOpen(via, entry);
        }
        var isNewUrl = !entry.subs.has(url);
        if (isNewUrl) entry.subs.set(url, new Set());
        entry.subs.get(url).add(cb);
        if (isNewUrl && entry.ws && entry.ws.readyState === 1) {
          try { entry.ws.send("sub " + url); } catch (e) {}
        }
        return function unsubscribe() {
          var cbs = entry.subs.get(url);
          if (!cbs) return;
          cbs.delete(cb);
          if (!cbs.size) entry.subs.delete(url);
          if (!entry.subs.size) {
            clearTimeout(entry.timer);
            var w = entry.ws;
            entry.ws = null;               // prevent the close handler reconnecting
            socks.delete(via);
            if (w) { try { w.close(); } catch (e) {} }
          }
        };
      });
  }

  window.SolidKit = {
    version: "1.0.0",
    esc: esc, escAttr: escAttr,
    safeUrl: safeUrl, safeDecode: safeDecode,
    loadDoc: loadDoc, loadJson: loadJson,
    toaster: toaster, copyText: copyText,
    debounce: debounce, subscribe: subscribe,
  };
})();
