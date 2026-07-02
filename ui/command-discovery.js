"use strict";
/* =====================================================================
   AgentOmega — Command Discovery subsystem  (parity gaps A8 + A10 + A9)

   ONE self-mounting classic script. Drop  <script src="command-discovery.js">
   in app.html AFTER the main app script (so it can see the app's top-level
   `const`/`function` bindings) and before </body>. It injects its own CSS,
   builds its own overlay DOM, and wires three command-discovery surfaces that
   behave identically to the opencode terminal UI:

     (A8) Ctrl+P  command palette   -> component/command-palette.tsx
     (A10) '/' and '@' autocomplete -> component/prompt/autocomplete.tsx
     (A9) Ctrl+X leader chords      -> config/keybind.ts (LEADER_TOKEN)

   All three are driven by ONE shared command list (built-ins mirrored from
   keybind.ts CommandMap + app.tsx/session slash names, merged live with engine
   commands from GET /api/command + skills + agents from /api/agent).

   SECURITY: every model/server/file string is HTML-escaped (esc) before it
   reaches innerHTML. Display text is set via textContent where possible.

   INTEGRATION CONTRACT (all optional / degrade gracefully):
   - window.registerKeydown(handler): if present, used to receive keydowns at
     high priority; handler returns true when it consumed the event. If absent,
     a capture-phase window listener is installed as a fallback.
   - The app's existing fns are reused when present: post, resetSession,
     setModelCmd, setAgentCmd, setTheme, showHelp, sysLine, runEngineCommand,
     escapeHtml, chatVisible, homeInput, chatInput.
   - Other agents register real pickers/actions via:
       AgentOmegaCommands.setAction(id, fn)   // override one command's behavior
       AgentOmegaCommands.setActions({...})    // bulk override
       AgentOmegaCommands.refresh()            // re-fetch engine commands/agents
   ===================================================================== */
(function () {
  // Engine HTTP API base. The sidecar announces the real port in its `ready`
  // frame (app.html sets window.AO_API_BASE); the old hardcoded 4577 was a
  // dead port that silently disabled every apiGet feature.
  const BASE_FALLBACK = "http://127.0.0.1:4577";
  const BASE = { toString() { return (typeof window !== "undefined" && window.AO_API_BASE) || BASE_FALLBACK; } };
  const LEADER_TIMEOUT = 2000; // matches LeaderTimeoutDefault

  /* ---------- tiny utils (reuse app's escapeHtml if available) ---------- */
  const esc =
    (typeof window !== "undefined" && typeof window.escapeHtml === "function")
      ? window.escapeHtml
      : (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const g = (name) => { try { return eval(name); } catch (e) { return undefined; } }; // late-bound app global lookup
  function appFn(name) { const f = (typeof window !== "undefined" && window[name]) || g(name); return typeof f === "function" ? f : null; }
  function notice(msg) {
    const sysLine = appFn("sysLine");
    if (sysLine) sysLine('<span style="color:#7c8b82;">' + esc(msg) + "</span>");
    else console.log("[agent-omega]", msg);
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch (e) {
      try { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); return true; } catch (_) { return false; }
    }
  }

  /* ---------- robust GET against the serve (direct fetch, host-proxy fallback) ----------
     The UI is loaded from file://, so a direct fetch to http://127.0.0.1 may be
     blocked by CORS. We try the fast direct path first, then fall back to the C#
     host which proxies the request (see Program.cs "api-get" handler in the note). */
  let _apiSeq = 0;
  const _apiPending = new Map();
  function _hostProxyGet(path) {
    return new Promise((resolve) => {
      const id = "ag" + (++_apiSeq);
      _apiPending.set(id, resolve);
      try { window.chrome.webview.postMessage({ type: "api-get", id, path }); }
      catch (e) { _apiPending.delete(id); resolve(null); }
      setTimeout(() => { if (_apiPending.has(id)) { _apiPending.delete(id); resolve(null); } }, 6000);
    });
  }
  // Receive host proxy replies: {type:'api-result', id, ok, body}
  try {
    window.chrome.webview.addEventListener("message", (e) => {
      const m = e && e.data; if (!m || m.type !== "api-result") return;
      const r = _apiPending.get(m.id); if (!r) return; _apiPending.delete(m.id);
      if (!m.ok) return r(null);
      try { r(JSON.parse(m.body)); } catch (_) { r(null); }
    });
  } catch (e) {}
  async function apiGet(path) {
    // path begins with "/api/..."
    // Host-provided bridge (the ACP build has no HTTP serve — app.html answers over the WS).
    if (typeof window.__aoApiGet === "function") {
      try { const b = await window.__aoApiGet(path); if (b != null) return (b && b.data !== undefined) ? b.data : b; } catch (e) {}
    }
    try {
      const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
      if (res.ok) { const j = await res.json(); return j && j.data !== undefined ? j.data : j; }
    } catch (e) { /* fall through to host proxy */ }
    const j = await _hostProxyGet(path);
    return j && j.data !== undefined ? j.data : j;
  }

  /* ---------- fuzzy matcher (subsequence + consecutive/word-start bonuses) ----------
     Returns {score, idx:[matched indices]} or null when not all chars match. */
  function fuzzy(query, target) {
    if (!query) return { score: 0, idx: [] };
    const q = query.toLowerCase(), t = target.toLowerCase();
    let qi = 0, score = 0, prev = -2; const idx = [];
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        let s = 1;
        if (ti === prev + 1) s += 5;                                  // consecutive
        if (ti === 0 || /[\s/_\-.:]/.test(t[ti - 1])) s += 8;         // word/segment start
        score += s; prev = ti; idx.push(ti); qi++;
      }
    }
    if (qi < q.length) return null;
    if (t.startsWith(q)) score += 20;                                  // strong prefix bonus
    score -= Math.max(0, t.length - q.length) * 0.05;                 // mild length penalty
    return { score, idx };
  }
  function highlight(target, idx) {
    if (!idx || !idx.length) return esc(target);
    let out = "", set = new Set(idx);
    for (let i = 0; i < target.length; i++) {
      const c = esc(target[i]);
      out += set.has(i) ? '<span style="color:#ffb454;">' + c + "</span>" : c;
    }
    return out;
  }

  /* =====================================================================
     SHARED COMMAND LIST
     ===================================================================== */

  // Display strings for key sequences (mirrors keybind.ts; ^X = leader ctrl+x).
  const KEYS = {
    "command.palette.show": "^P",
    "session.new": "^X n", "session.list": "^X l",
    "model.list": "^X m", "agent.list": "^X a",
    "theme.switch": "^X t", "session.compact": "^X c",
    "session.export": "^X x", "session.timeline": "^X g",
    "messages.copy": "^X y", "session.undo": "^X u", "session.redo": "^X r",
    "opencode.status": "^X s", "editor.open": "^X e",
    "session.sidebar.toggle": "^X b",
    "session.rename": "^R", "session.background": "^B", "session.pin.toggle": "^F",
    "agent.cycle": "tab", "agent.cycle.reverse": "shift+tab",
    "model.cycle_recent": "f2", "model.cycle_recent_reverse": "shift+f2",
    "variant.cycle": "^T", "app.exit": "^C",
  };

  // Built-in client-side commands (mirror app.tsx appCommands + session list).
  // kind:'builtin'. Pickers/actions that belong to other parity items dispatch
  // through an overridable action and fall back to existing app behavior or a
  // clear notice — never silently no-op.
  function builtinDefs() {
    return [
      // --- Session ---
      { id: "session.list", slash: "sessions", aliases: ["resume", "continue"], title: "Switch session", category: "Session", suggested: true },
      { id: "session.new", slash: "new", aliases: ["clear"], title: "New session", category: "Session", suggested: true },
      { id: "session.share", slash: "share", title: "Share session", category: "Session" },
      { id: "session.unshare", slash: "unshare", title: "Unshare session", category: "Session" },
      { id: "session.rename", slash: "rename", title: "Rename session", category: "Session" },
      { id: "session.timeline", slash: "timeline", title: "Jump to message", category: "Session" },
      { id: "session.fork", slash: "fork", title: "Fork session", category: "Session" },
      { id: "session.compact", slash: "compact", aliases: ["summarize"], title: "Compact session", category: "Session" },
      { id: "session.undo", slash: "undo", title: "Undo previous message", category: "Session" },
      { id: "session.redo", slash: "redo", title: "Redo", category: "Session" },
      { id: "session.copy", slash: "copy", title: "Copy session transcript", category: "Session" },
      { id: "session.export", slash: "export", title: "Export session transcript", category: "Session" },
      { id: "messages.copy", title: "Copy last assistant message", category: "Session" },
      { id: "session.sidebar.toggle", title: "Toggle sidebar", category: "Session" },
      // --- Agent / model ---
      { id: "model.list", slash: "models", aliases: ["mo"], title: "Switch model", category: "Agent", suggested: true },
      { id: "agent.list", slash: "agents", title: "Switch agent", category: "Agent" },
      { id: "mcp.list", slash: "mcps", title: "Toggle MCPs", category: "Agent" },
      { id: "effort.set", slash: "effort", aliases: ["variants", "variant"], title: "Reasoning effort", category: "Agent" },
      { id: "thinking.toggle", slash: "thinking", aliases: ["thoughts"], title: "Toggle thinking traces", category: "System" },
      { id: "model.cycle_recent", title: "Model cycle", category: "Agent", hidden: true },
      { id: "agent.cycle", title: "Agent cycle", category: "Agent", hidden: true },
      { id: "variant.cycle", title: "Variant cycle", category: "Agent", hidden: true },
      // --- Provider ---
      { id: "provider.connect", slash: "connect", title: "Connect provider", category: "Provider" },
      // --- System ---
      { id: "opencode.status", slash: "status", title: "View status", category: "System" },
      { id: "theme.switch", slash: "themes", title: "Switch theme", category: "System" },
      { id: "skin.switch", slash: "skin", aliases: ["modern", "crt"], title: "Switch skin (CRT ↔ Modern)", category: "System", suggested: true },
      { id: "help.show", slash: "help", title: "Help", category: "System" },
      { id: "docs.open", title: "Open docs", category: "System" },
      { id: "editor.open", title: "Open external editor", category: "System", hidden: true },
      { id: "app.exit", slash: "exit", aliases: ["quit", "q"], title: "Exit the app", category: "System" },
    ].map((c) => ({ kind: "builtin", aliases: c.aliases || [], keys: KEYS[c.id] || null, ...c }));
  }

  // Default action table for built-ins. Each returns nothing; may be async.
  // Other agents replace any of these via AgentOmegaCommands.setAction(id, fn).
  const ACTIONS = {
    "session.new": () => { const f = appFn("resetSession"); if (f) return f(); const p = appFn("post"); if (p) p({ type: "new" }); },
    "model.list": () => { const f = appFn("setModelCmd"); if (f) return f(""); notice("model picker not wired yet"); },
    "agent.list": () => { const f = appFn("setAgentCmd"); if (f) return f(""); notice("agent picker not wired yet"); },
    "theme.switch": () => { const f = appFn("setTheme"); if (f) return f(""); notice("theme picker not wired yet"); },
    "skin.switch": (args) => {
      const f = appFn("setSkin");
      if (!f) return notice("skin switch not available");
      const cur = document.body.classList.contains("theme-modern") ? "modern" : "crt";
      const a = String(args || "").toLowerCase();
      const want = a.indexOf("modern") >= 0 ? "modern" : a.indexOf("crt") >= 0 ? "crt" : cur === "crt" ? "modern" : "crt";
      f(want);
      notice("skin → " + want);
    },
    "help.show": () => { const f = appFn("showHelp"); if (f) return f(); notice("type / to discover commands, or press ctrl+p"); },
    "app.exit": () => { const p = appFn("post"); if (p) p({ type: "close" }); },
    "docs.open": () => { try { window.open("https://opencode.ai/docs", "_blank"); } catch (e) { notice("Agent Omega runs on the opencode engine — engine docs: https://opencode.ai/docs"); } },
    "messages.copy": async () => {
      const rows = document.querySelectorAll("#log .arow");
      const last = rows[rows.length - 1];
      if (!last) return notice("no assistant message to copy");
      const ok = await copyText(last.innerText.trim());
      notice(ok ? "Copied message" : "copy failed");
    },
    // Commands below land with other parity waves (session actions B1, pickers
    // A11/B2/B3); until an agent registers them they report honestly.
    "session.list": () => { const f = appFn("showSessions"); if (f) return f(); notice("session list unavailable"); },
    "session.share": () => { const f = appFn("shareSession"); if (f) return f(); notice("share unavailable"); },
    "session.unshare": () => { const f = appFn("unshareSession"); if (f) return f(); notice("unshare unavailable"); },
    "session.rename": () => { const f = appFn("insertSlashText"); if (f) return f("/rename "); notice("rename unavailable"); },
    "session.timeline": () => { const f = appFn("timelinePanel"); if (f) return f(); notice("timeline unavailable"); },
    "session.fork": () => { const f = appFn("forkSession"); if (f) return f(); notice("fork unavailable"); },
    "session.compact": () => { const f = appFn("compactSession"); if (f) return f(); notice("compact unavailable"); },
    "session.undo": () => { const f = appFn("undoLast"); if (f) return f(); notice("undo unavailable"); },
    "session.redo": () => { const f = appFn("redoLast"); if (f) return f(); notice("redo unavailable"); },
    "session.copy": () => { const f = appFn("copySessionTranscript"); if (f) return f(); notice("copy unavailable"); },
    "session.export": () => { const f = appFn("exportSession"); if (f) return f(); notice("export unavailable"); },
    "session.sidebar.toggle": () => notice("sidebar lands later"),
    "mcp.list": () => notice("MCP picker lands later"),
    "effort.set": (args) => { const f = appFn("effortCmd"); if (f) return f(args || ""); notice("effort control unavailable"); },
    "thinking.toggle": (args) => { const f = appFn("thinkingCmd"); if (f) return f(args || ""); notice("thinking toggle unavailable"); },
    "model.cycle_recent": () => notice("model cycle lands with B22"),
    "agent.cycle": () => notice("agent cycle lands with B21"),
    "variant.cycle": () => { const f = appFn("effortCmd"); if (f) return f(""); notice("effort control unavailable"); },
    "provider.connect": () => notice("/connect lands later"),
    "opencode.status": () => notice("/status lands later"),
    "editor.open": () => notice("external editor unavailable"),
  };

  // Live registry: built-ins + fetched engine commands + agents (for '@').
  const Registry = {
    builtins: builtinDefs(),
    engine: [],   // {kind:'engine', id, slash, title, desc, category, source}
    agents: [],   // subagents for '@'  {name, description}
    byId: new Map(),

    index() {
      this.byId.clear();
      for (const c of this.all()) this.byId.set(c.id, c);
    },
    all() { return [...this.builtins, ...this.engine]; },
    // commands offered in the palette (everything not flagged hidden)
    palette() { return this.all().filter((c) => !c.hidden); },
    // commands offered to the '/' dropdown (anything with a slash; engine skills
    // are EXCLUDED here exactly like autocomplete.tsx, they live in the palette)
    slashes() {
      return this.all().filter((c) => c.slash && !c.hidden && !(c.kind === "engine" && c.source === "skill"));
    },

    async refresh() {
      try {
        const cmds = await apiGet("/api/command");
        if (Array.isArray(cmds)) {
          this.engine = cmds.map((c) => ({
            kind: "engine",
            id: "engine:" + c.name,
            name: c.name,
            slash: c.name,
            aliases: [],
            title: c.name,
            desc: c.description || "",
            category: c.source === "skill" ? "Skill" : c.source === "mcp" ? "MCP" : "Command",
            source: c.source || "command",
            keys: null,
          }));
        }
      } catch (e) {}
      try {
        const ag = await apiGet("/api/agent");
        if (Array.isArray(ag)) this.agents = ag.filter((a) => !a.hidden && a.mode !== "primary");
      } catch (e) {}
      this.index();
      if (Palette.open) Palette.render();
      if (Drop.visible) Drop.render();
    },

    // unified dispatch (used by palette + leader). args optional.
    dispatch(id, args) {
      const c = this.byId.get(id) || (id.indexOf("engine:") === 0 ? null : { id, kind: "builtin" });
      const isEngine = (c && c.kind === "engine") || id.indexOf("engine:") === 0;
      if (isEngine) {
        const name = (c && c.name) || id.replace(/^engine:/, "");
        const run = appFn("runEngineCommand");
        if (run) return run(name, args || "");
        return notice("engine command runner unavailable");
      }
      // quick-switch slots 1..9 -> Nth most recent session
      if (/^session\.quick_switch\.\d$/.test(id)) {
        const slot = Number(id.slice(-1));
        const f = appFn("quickSwitchSession");
        if (f) return f(slot);
        return notice("quick-switch " + slot + " unavailable");
      }
      const f = ACTIONS[id];
      if (f) return f(args);
      return notice("command not wired: " + id);
    },
  };
  Registry.index();

  /* =====================================================================
     (A8) COMMAND PALETTE  (Ctrl+P)
     ===================================================================== */
  const Palette = {
    open: false, sel: 0, items: [],
    el: null, input: null, list: null,

    mount() {
      const root = document.createElement("div");
      root.id = "ftpPalette";
      root.className = "ftp-overlay hidden";
      root.innerHTML =
        '<div class="ftp-pal">' +
        '  <div class="ftp-pal-head"><span class="ac">&gt;</span>' +
        '    <input id="ftpPalInput" class="ftp-pal-input" autocomplete="off" spellcheck="false" placeholder="search commands…"></div>' +
        '  <div id="ftpPalList" class="ftp-pal-list"></div>' +
        '  <div class="ftp-pal-foot"><span class="ac">↑↓</span> nav · <span class="ac">enter</span> run · <span class="ac">esc</span> close</div>' +
        "</div>";
      (document.querySelector(".screen") || document.body).appendChild(root);
      this.el = root;
      this.input = root.querySelector("#ftpPalInput");
      this.list = root.querySelector("#ftpPalList");
      this.input.addEventListener("input", () => { this.sel = 0; this.render(); });
      // clicking the backdrop closes; clicks inside the panel do not
      root.addEventListener("mousedown", (e) => { if (e.target === root) this.close(); });
    },

    show() {
      if (this.open) return;
      this.open = true; this.sel = 0;
      this.el.classList.remove("hidden");
      this.input.value = "";
      this.render();
      setTimeout(() => this.input.focus(), 0);
      // keep the engine list fresh whenever discovery is opened
      Registry.refresh();
    },
    close() {
      if (!this.open) return;
      this.open = false;
      this.el.classList.add("hidden");
      const fa = appFn("focusActive"); if (fa) fa();
    },
    toggle() { this.open ? this.close() : this.show(); },

    compute() {
      const q = this.input.value.trim();
      const pal = Registry.palette();
      if (!q) {
        // suggested section first, then grouped by category (mirrors palette.tsx)
        const out = [];
        const sugg = pal.filter((c) => c.suggested);
        if (sugg.length) { out.push({ header: "Suggested" }); for (const c of sugg) out.push({ cmd: c, idx: [] }); }
        const order = ["Session", "Agent", "Provider", "System", "Command", "Skill", "MCP"];
        const byCat = {};
        for (const c of pal) (byCat[c.category] = byCat[c.category] || []).push(c);
        const cats = Object.keys(byCat).sort((a, b) => {
          const ia = order.indexOf(a), ib = order.indexOf(b);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
        });
        for (const cat of cats) { out.push({ header: cat }); for (const c of byCat[cat]) out.push({ cmd: c, idx: [] }); }
        return out;
      }
      const scored = [];
      for (const c of pal) {
        const hay = (c.title || c.id) + " " + (c.slash ? "/" + c.slash : "") + " " + (c.desc || "");
        const m = fuzzy(q, hay);
        if (m) {
          const tm = fuzzy(q, c.title || c.id);
          scored.push({ cmd: c, score: m.score + (tm ? tm.score : 0), idx: tm ? tm.idx : [] });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 60).map((s) => ({ cmd: s.cmd, idx: s.idx }));
    },

    render() {
      this.items = this.compute();
      // clamp selection to a selectable (non-header) row
      const selectable = this.items.map((r, i) => (r.cmd ? i : -1)).filter((i) => i >= 0);
      if (!selectable.length) { this.list.innerHTML = '<div class="ftp-pal-empty">No matching commands</div>'; return; }
      if (!this.items[this.sel] || !this.items[this.sel].cmd) this.sel = selectable[0];
      let html = "";
      this.items.forEach((row, i) => {
        if (row.header) { html += '<div class="ftp-pal-cat">' + esc(row.header) + "</div>"; return; }
        const c = row.cmd, on = i === this.sel;
        const label = c.title || c.id;
        const slash = c.slash ? ' <span class="ftp-pal-slash">/' + esc(c.slash) + "</span>" : "";
        html +=
          '<div class="ftp-pal-row' + (on ? " on" : "") + '" data-i="' + i + '">' +
          '<span class="ftp-pal-title">' + highlight(label, row.idx) + "</span>" + slash +
          (c.desc ? '<span class="ftp-pal-desc">' + esc(c.desc) + "</span>" : "") +
          (c.keys ? '<span class="ftp-pal-key">' + esc(c.keys) + "</span>" : "") +
          "</div>";
      });
      this.list.innerHTML = html;
      // wire mouse
      this.list.querySelectorAll(".ftp-pal-row").forEach((r) => {
        const i = +r.getAttribute("data-i");
        r.addEventListener("mousemove", () => { if (this.sel !== i) { this.sel = i; this.paint(); } });
        r.addEventListener("mousedown", (e) => { e.preventDefault(); this.sel = i; this.choose(); });
      });
      this.scrollToSel();
    },
    paint() {
      this.list.querySelectorAll(".ftp-pal-row").forEach((r) => {
        r.classList.toggle("on", +r.getAttribute("data-i") === this.sel);
      });
      this.scrollToSel();
    },
    scrollToSel() {
      const r = this.list.querySelector('.ftp-pal-row[data-i="' + this.sel + '"]');
      if (r && r.scrollIntoView) r.scrollIntoView({ block: "nearest" });
    },
    move(dir) {
      const sel = this.items.map((row, i) => (row.cmd ? i : -1)).filter((i) => i >= 0);
      if (!sel.length) return;
      let pos = sel.indexOf(this.sel);
      pos = (pos + dir + sel.length) % sel.length;
      this.sel = sel[pos];
      this.paint();
    },
    choose() {
      const row = this.items[this.sel];
      if (!row || !row.cmd) return;
      this.close();
      Registry.dispatch(row.cmd.id);
    },

    // returns true if it consumed the key
    onKey(e) {
      if (!this.open) return false;
      const k = e.key;
      if (k === "Escape") { this.close(); return true; }
      if (k === "ArrowDown" || (e.ctrlKey && (k === "n" || k === "N"))) { this.move(1); return true; }
      if (k === "ArrowUp" || (e.ctrlKey && (k === "p" || k === "P"))) { this.move(-1); return true; }
      if (k === "PageDown") { this.move(8); return true; }
      if (k === "PageUp") { this.move(-8); return true; }
      if (k === "Home") { const s = this.items.findIndex((r) => r.cmd); if (s >= 0) { this.sel = s; this.paint(); } return true; }
      if (k === "End") { for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].cmd) { this.sel = i; this.paint(); break; } return true; }
      if (k === "Enter") { e.preventDefault(); this.choose(); return true; }
      return false; // typing flows to the search input
    },
  };

  /* =====================================================================
     (A10) '/' and '@' AUTOCOMPLETE DROPDOWN
     ===================================================================== */
  const Drop = {
    visible: false,     // false | '/' | '@'
    mode: false,
    triggerIdx: 0,      // offset of the trigger char in the input value
    sel: 0,
    items: [],
    el: null, listEl: null,
    input: null,        // active <input> element

    mount() {
      const root = document.createElement("div");
      root.id = "ftpDrop";
      root.className = "ftp-drop hidden";
      root.innerHTML = '<div id="ftpDropList" class="ftp-drop-list"></div>';
      (document.querySelector(".screen") || document.body).appendChild(root);
      this.el = root; this.listEl = root.querySelector("#ftpDropList");
    },

    activeInput() {
      const chatVisible = appFn("chatVisible");
      const ci = (typeof window !== "undefined" && window.chatInput) || g("chatInput");
      const hi = (typeof window !== "undefined" && window.homeInput) || g("homeInput");
      if (chatVisible) return chatVisible() ? ci : hi;
      // fallback: whichever is focused / visible
      if (document.activeElement === ci) return ci;
      if (document.activeElement === hi) return hi;
      return ci || hi;
    },

    // called on every input event
    onInput() {
      const inp = this.activeInput();
      if (!inp) return;
      this.input = inp;
      const val = inp.value;
      const pos = inp.selectionStart == null ? val.length : inp.selectionStart;

      if (this.visible) {
        // hide rules (mirror autocomplete.tsx onInput)
        const between = val.slice(this.triggerIdx, pos);
        if (pos <= this.triggerIdx || /\s/.test(between) ||
            (this.visible === "/" && /^\S+\s+\S+\s*$/.test(val))) {
          this.hide(); // fallthrough to re-open check below
        } else {
          this.render(); return;
        }
      }
      if (pos === 0) { this.hide(); return; }

      // '/' at column 0 (no whitespace before cursor)
      if (val[0] === "/" && !/\s/.test(val.slice(0, pos))) {
        this.show("/", 0); return;
      }
      // '@' trigger: nearest '@' before cursor with no whitespace between
      const at = this.mentionTrigger(val, pos);
      if (at !== -1) { this.show("@", at); return; }
      this.hide();
    },

    mentionTrigger(val, pos) {
      for (let i = pos - 1; i >= 0; i--) {
        const ch = val[i];
        if (ch === "@") {
          const before = i === 0 ? "" : val[i - 1];
          if (i === 0 || /\s/.test(before)) return i;   // '@' must start a word
          return -1;
        }
        if (/\s/.test(ch)) return -1;
      }
      return -1;
    },

    show(mode, idx) {
      this.visible = mode; this.mode = mode; this.triggerIdx = idx; this.sel = 0;
      this.navigated = false;
      this.el.classList.remove("hidden");
      this.render();
      if (mode === "@") this.refreshFiles();
    },
    hide() {
      if (!this.visible) return;
      this.visible = false; this.mode = false;
      this.el.classList.add("hidden");
    },

    query() {
      if (!this.input) return "";
      const pos = this.input.selectionStart == null ? this.input.value.length : this.input.selectionStart;
      // text between trigger+1 and cursor
      return this.input.value.slice(this.triggerIdx + 1, pos);
    },

    async refreshFiles() {
      const q = this.query();
      try {
        const data = await apiGet("/api/find/file?query=" + encodeURIComponent(q) + "&limit=20");
        this._files = Array.isArray(data) ? data : [];
      } catch (e) { this._files = []; }
      if (this.visible === "@") this.render();
    },

    compute() {
      const q = this.query();
      if (this.visible === "/") {
        const list = Registry.slashes().map((c) => ({
          label: "/" + c.slash,
          desc: c.desc || c.title || "",
          cmd: c,
        }));
        if (!q) return list.sort((a, b) => a.label.localeCompare(b.label)).slice(0, 12);
        const scored = [];
        for (const it of list) {
          const m = fuzzy(q, it.label + " " + it.desc + " " + (it.cmd.aliases || []).join(" "));
          if (m) { const lm = fuzzy(q, it.label); scored.push({ it, score: m.score + (lm ? lm.score : 0), idx: lm ? lm.idx : [] }); }
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 12).map((s) => ({ ...s.it, idx: s.idx }));
      }
      // '@' : references/agents + files (files already ranked by the server)
      const agentItems = Registry.agents.map((a) => ({ label: "@" + a.name, desc: a.description || "", at: { type: "agent", value: a.name } }));
      const fileItems = (this._files || []).map((p) => ({ label: p, desc: "", at: { type: "file", value: p, dir: p.endsWith("/") } }));
      if (!q) return [...agentItems, ...fileItems].slice(0, 12);
      const scoredA = [];
      for (const it of agentItems) { const m = fuzzy(q, it.label); if (m) scoredA.push({ it, score: m.score, idx: m.idx }); }
      scoredA.sort((a, b) => b.score - a.score);
      // files: keep server order, just attach (no fuzzy re-rank — matches autocomplete.tsx)
      return [...scoredA.map((s) => ({ ...s.it, idx: s.idx })), ...fileItems].slice(0, 12);
    },

    render() {
      if (!this.input) return;
      this.items = this.compute();
      if (this.sel >= this.items.length) this.sel = 0;
      if (!this.items.length) {
        this.listEl.innerHTML = '<div class="ftp-drop-empty">No matching items</div>';
      } else {
        let html = "";
        this.items.forEach((it, i) => {
          html +=
            '<div class="ftp-drop-row' + (i === this.sel ? " on" : "") + '" data-i="' + i + '">' +
            '<span class="ftp-drop-label">' + highlight(it.label, it.idx) + "</span>" +
            (it.desc ? '<span class="ftp-drop-desc">' + esc(it.desc) + "</span>" : "") +
            "</div>";
        });
        this.listEl.innerHTML = html;
        this.listEl.querySelectorAll(".ftp-drop-row").forEach((r) => {
          const i = +r.getAttribute("data-i");
          r.addEventListener("mousemove", () => { if (this.sel !== i) { this.sel = i; this.paint(); } });
          r.addEventListener("mousedown", (e) => { e.preventDefault(); this.sel = i; this.complete(false, true); });
        });
      }
      this.position();
    },
    paint() {
      this.listEl.querySelectorAll(".ftp-drop-row").forEach((r) =>
        r.classList.toggle("on", +r.getAttribute("data-i") === this.sel));
      const r = this.listEl.querySelector(".ftp-drop-row.on");
      if (r && r.scrollIntoView) r.scrollIntoView({ block: "nearest" });
    },
    position() {
      // anchor the dropdown directly ABOVE the active input's box
      const box = this.input && this.input.closest(".box");
      const rect = (box || this.input).getBoundingClientRect();
      this.el.style.left = rect.left + "px";
      this.el.style.width = rect.width + "px";
      this.el.style.bottom = (window.innerHeight - rect.top + 6) + "px";
    },
    move(dir) {
      if (!this.items.length) return;
      this.navigated = true; // arrow keys = a deliberate pick; Enter may fire it
      this.sel = (this.sel + dir + this.items.length) % this.items.length;
      this.paint();
    },

    // replace [trigger..cursor] with the chosen completion text
    replaceToken(text) {
      const inp = this.input;
      const pos = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
      inp.value = inp.value.slice(0, this.triggerIdx) + text + inp.value.slice(pos);
      const np = this.triggerIdx + text.length;
      try { inp.setSelectionRange(np, np); } catch (e) {}
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    },

    // tab=true means "complete" (directories expand, slashes insert text);
    // else "select" (Enter) which also runs built-in slash commands.
    // deliberate=true when the row was chosen by arrow keys or click.
    complete(tab, deliberate) {
      const it = this.items[this.sel];
      if (!it) { this.hide(); return; }
      if (this.visible === "/") {
        const c = it.cmd;
        const q = this.query().toLowerCase();
        // Enter only fires what the user MEANT: a deliberate pick, an empty
        // query, or a typed prefix of the command's name/alias. A loose fuzzy
        // hit (e.g. "/thinking" landing on an unrelated command) must never run.
        if (!tab && !(deliberate || this.navigated) && q) {
          const names = [c.slash, ...(c.aliases || [])].map((s) => String(s).toLowerCase());
          if (!names.some((n) => n.startsWith(q))) {
            notice("no matching command: /" + q);
            this.hide();
            return;
          }
        }
        if (c.kind === "builtin") {
          // run immediately (matches useCommandSlashes onSelect -> dispatchCommand)
          const typedArgs = q;
          this.input.value = "";
          this.input.dispatchEvent(new Event("input", { bubbles: true }));
          this.hide();
          Registry.dispatch(c.id, typedArgs);
          return;
        }
        // engine/server command -> insert "/name " so the user can add args
        this.input.value = "/" + c.slash + " ";
        try { this.input.setSelectionRange(this.input.value.length, this.input.value.length); } catch (e) {}
        this.hide();
        this.input.focus();
        return;
      }
      // '@'
      if (it.at.type === "file" && it.at.dir && tab) {
        // expand directory: keep dropdown open with the dir prefix
        this.replaceToken("@" + it.at.value);
        // re-evaluate against the new prefix
        this.show("@", this.triggerIdx);
        return;
      }
      const needsSpace = true;
      this.replaceToken("@" + it.at.value + (needsSpace ? " " : ""));
      this.hide();
      this.input.focus();
    },

    onKey(e) {
      if (!this.visible) return false;
      const k = e.key;
      if (k === "Escape") { this.hide(); return true; }
      if (k === "ArrowDown" || (e.ctrlKey && (k === "n" || k === "N"))) { e.preventDefault(); this.move(1); return true; }
      if (k === "ArrowUp" || (e.ctrlKey && (k === "p" || k === "P"))) { e.preventDefault(); this.move(-1); return true; }
      if (k === "Tab") { e.preventDefault(); this.complete(true); return true; }
      if (k === "Enter") { e.preventDefault(); this.complete(false); return true; }
      return false; // other keys edit the input (and re-trigger onInput)
    },
  };

  /* =====================================================================
     (A9) LEADER-KEY CHORD SYSTEM  (Ctrl+X prefix)
     ===================================================================== */
  const LEADER_MAP = {
    n: "session.new", l: "session.list", m: "model.list", a: "agent.list",
    t: "theme.switch", c: "session.compact", x: "session.export", g: "session.timeline",
    y: "messages.copy", u: "session.undo", r: "session.redo", e: "editor.open",
    s: "opencode.status", b: "session.sidebar.toggle", q: "app.exit",
    "1": "session.quick_switch.1", "2": "session.quick_switch.2", "3": "session.quick_switch.3",
    "4": "session.quick_switch.4", "5": "session.quick_switch.5", "6": "session.quick_switch.6",
    "7": "session.quick_switch.7", "8": "session.quick_switch.8", "9": "session.quick_switch.9",
  };
  const Leader = {
    pending: false, timer: null, hintEl: null,

    mountHint() {
      const h = document.createElement("div");
      h.id = "ftpLeaderHint"; h.className = "ftp-leader hidden";
      (document.querySelector(".screen") || document.body).appendChild(h);
      this.hintEl = h;
    },
    showHint() {
      const labels = {
        n: "new", l: "sessions", m: "models", a: "agents", t: "theme",
        c: "compact", x: "export", g: "timeline", y: "copy msg",
        u: "undo", r: "redo", s: "status", b: "sidebar", q: "exit",
        "1-9": "quick switch",
      };
      this.hintEl.innerHTML =
        '<span class="ftp-leader-title">^X</span>' +
        Object.keys(labels).map((k) =>
          '<span class="ftp-leader-item"><span class="ac">' + esc(k) + "</span> " + esc(labels[k]) + "</span>"
        ).join("");
      this.hintEl.classList.remove("hidden");
    },
    hideHint() { if (this.hintEl) this.hintEl.classList.add("hidden"); },

    arm() {
      this.pending = true;
      this.showHint();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.cancel(), LEADER_TIMEOUT);
    },
    cancel() { this.pending = false; clearTimeout(this.timer); this.hideHint(); },

    onKey(e) {
      // resolve a pending chord
      if (this.pending) {
        if (e.key === "Escape") { this.cancel(); return true; }
        if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return false;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
        e.preventDefault();
        this.cancel();
        const id = LEADER_MAP[key];
        if (id) Registry.dispatch(id);
        else notice("no leader binding: ^X " + key);
        return true;
      }
      // arm on the leader trigger (ctrl+x)
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "x" || e.key === "X")) {
        e.preventDefault();
        this.arm();
        return true;
      }
      return false;
    },
  };

  /* =====================================================================
     KEY DISPATCH WIRING  (priority chain)
     ===================================================================== */
  // priority: palette > autocomplete > leader(resolve/arm) > ctrl+p(open)
  function masterKeydown(e) {
    if (Palette.onKey(e)) return true;
    if (Drop.onKey(e)) return true;
    if (Leader.onKey(e)) return true;
    // Ctrl+P opens the palette (when nothing else claimed it). On macOS the native
    // modifier is Cmd — accept Cmd+P there (the shell's menu defines no Cmd+P key
    // equivalent, so the event falls through to the page); reject the Win key elsewhere.
    const isMac = /Mac/.test(navigator.platform || "");
    const mod = isMac ? (e.metaKey || e.ctrlKey) : (e.ctrlKey && !e.metaKey);
    if (mod && !e.altKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault(); Palette.show(); return true;
    }
    return false;
  }

  function installKeydown() {
    if (typeof window.registerKeydown === "function") {
      window.registerKeydown(masterKeydown);
      return;
    }
    // fallback: capture-phase listener that stops propagation when we consume the
    // key, so it lands BEFORE the app's own Escape/Enter handlers.
    window.addEventListener("keydown", (e) => {
      if (masterKeydown(e)) { e.stopImmediatePropagation(); }
    }, true);
  }

  function installInputListeners() {
    const ci = (typeof window !== "undefined" && window.chatInput) || g("chatInput");
    const hi = (typeof window !== "undefined" && window.homeInput) || g("homeInput");
    [ci, hi].forEach((inp) => {
      if (!inp || inp._ftpDropWired) return;
      inp._ftpDropWired = true;
      inp.addEventListener("input", () => Drop.onInput());
      inp.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== inp) Drop.hide(); }, 120));
    });
  }

  /* =====================================================================
     CSS  (CRT-phosphor look; behavior identical to the terminal UI)
     ===================================================================== */
  function injectCss() {
    const css = `
    .hidden{ display:none !important; }
    /* ---- command palette ---- */
    #ftpPalette.ftp-overlay{ position:absolute; inset:0; z-index:60;
      background:rgba(4,6,7,.55); display:flex; align-items:flex-start; justify-content:center; }
    .ftp-pal{ margin-top:9vh; width:640px; max-width:86%; max-height:64vh; display:flex; flex-direction:column;
      background:#080c0e; border:1px solid #45554d; box-shadow:0 0 40px rgba(0,0,0,.6), inset 0 0 22px rgba(0,0,0,.5); }
    .ftp-pal-head{ display:flex; align-items:baseline; gap:10px; padding:14px 16px 10px; border-bottom:1px solid #1b2227; }
    .ftp-pal-head .ac{ color:#ffb454; font-size:22px; }
    .ftp-pal-input{ flex:1; background:transparent; border:none; outline:none; color:#dfeae2;
      font-family:inherit; font-size:22px; caret-color:#ffb454; }
    .ftp-pal-list{ overflow-y:auto; padding:6px 0; }
    .ftp-pal-list::-webkit-scrollbar{ width:8px; } .ftp-pal-list::-webkit-scrollbar-thumb{ background:#1e2d27; }
    .ftp-pal-cat{ color:#ffb454; font-size:15px; letter-spacing:1px; text-transform:uppercase; padding:9px 16px 3px; opacity:.8; }
    .ftp-pal-row{ display:flex; align-items:baseline; gap:10px; padding:5px 16px; font-size:20px; color:#b9c7be; cursor:default; }
    .ftp-pal-row.on{ background:rgba(255,180,84,.14); }
    .ftp-pal-title{ color:#e6efe8; }
    .ftp-pal-row.on .ftp-pal-title{ color:#fff4e2; }
    .ftp-pal-slash{ color:#5fd3dd; font-size:18px; }
    .ftp-pal-desc{ color:#54655b; font-size:17px; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ftp-pal-key{ color:#46544c; font-size:16px; margin-left:auto; }
    .ftp-pal-empty{ color:#54655b; padding:14px 16px; font-size:19px; }
    .ftp-pal-foot{ border-top:1px solid #1b2227; padding:8px 16px; font-size:16px; color:#46544c; }
    .ftp-pal-foot .ac{ color:#ffb454; }
    /* ---- autocomplete dropdown ---- */
    .ftp-drop{ position:fixed; z-index:62; background:#080c0e; border:1px solid #45554d;
      box-shadow:0 -6px 26px rgba(0,0,0,.5), inset 0 0 18px rgba(0,0,0,.45); max-height:240px; overflow:hidden; }
    .ftp-drop-list{ max-height:240px; overflow-y:auto; }
    .ftp-drop-list::-webkit-scrollbar{ width:8px; } .ftp-drop-list::-webkit-scrollbar-thumb{ background:#1e2d27; }
    .ftp-drop-row{ display:flex; align-items:baseline; gap:12px; padding:4px 14px; font-size:19px; color:#b9c7be; cursor:default; }
    .ftp-drop-row.on{ background:rgba(255,180,84,.14); }
    .ftp-drop-label{ color:#e6efe8; white-space:pre; }
    .ftp-drop-row.on .ftp-drop-label{ color:#fff4e2; }
    .ftp-drop-desc{ color:#54655b; font-size:17px; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ftp-drop-empty{ color:#54655b; padding:8px 14px; font-size:18px; }
    /* ---- leader which-key hint ---- */
    .ftp-leader{ position:absolute; left:0; right:0; bottom:0; z-index:61; display:flex; flex-wrap:wrap; gap:7px 18px;
      padding:10px 16px; background:#0b0e11; border-top:1px solid #1b2227; font-size:18px; color:#7c8b82; }
    .ftp-leader-title{ color:#ffb454; font-weight:bold; margin-right:8px; }
    .ftp-leader-item .ac{ color:#ffb454; }
    `;
    const s = document.createElement("style");
    s.id = "ftp-command-discovery-css";
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* =====================================================================
     PUBLIC API + BOOT
     ===================================================================== */
  window.AgentOmegaCommands = {
    registry: Registry,
    palette: Palette,
    autocomplete: Drop,
    leader: Leader,
    open() { Palette.show(); },
    dispatch(id, args) { return Registry.dispatch(id, args); },
    setAction(id, fn) { ACTIONS[id] = fn; },
    setActions(obj) { Object.assign(ACTIONS, obj); },
    refresh() { return Registry.refresh(); },
  };

  function boot() {
    injectCss();
    Palette.mount();
    Drop.mount();
    Leader.mountHint();
    installInputListeners();
    installKeydown();
    Registry.refresh(); // pull engine commands + agents once the serve is up
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
