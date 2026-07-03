"use strict";
/* =====================================================================
   AgentOmega — CRT-ERA SETTINGS LAYER   (crt-settings.js)

   A self-contained, self-mounting classic script. Drop
       <script src="crt-settings.js"></script>
   in app.html AFTER the main app script AND after command-discovery.js
   (so it can see window.registerKeydown / window.wsSend / window.onWs /
   window.escapeHtml / window.AgentOmegaCommands). It injects its own CSS,
   builds its own overlay DOM, and exposes:

       window.AgentOmegaSettings.open(section?)   section: 'vault'|'models'|'council'|'skin'
       window.AgentOmegaSettings.close()
       window.AgentOmegaSettings.onWs(msg)        -> true if it consumed the msg

   FOUR chained menus styled like an old DOS settings program (edit.com /
   BIOS setup / Norton Commander) inside AgentOmega's CRT-phosphor theme:
   a centred double-line box-drawing frame with the title inset in the top
   border, a Vault · Models · Council · Skin tab row, an inverted phosphor
   selection bar, ↑↓ move, ◄►/Enter change, Tab/◄► switch section, Esc back
   then close, and a bottom key-hint status line.

   IT WIRES ITSELF IN (zero required edits beyond the <script> tag):
     - keyboard: window.registerKeydown(handler, 95)  (below the permission
       panel's prio 100, above the palette's prio 0 so Ctrl+P is trapped
       while the menu is open)
     - modal awareness: composes window.__ftpModalOpen so the prompt textarea,
       transcript-scroll keys and the focus-stealing mousedown handler all
       yield while the menu is open
     - WS: wraps window.onWs to peek `ready` (model list) and to consume
       `councilConfig` / `vaultKeys` replies   (an explicit one-line hook in
       onWs is therefore OPTIONAL — see the integration notes)
     - palette: registers a `settings.open` builtin (/settings, ^,) + a gear
       button in the titlebar

   IPC CONTRACT (must be honoured by sidecar.mjs):
     UI->sidecar: {type:'getCouncilConfig'} ; {type:'setCouncilConfig',config}
                  {type:'vaultList'} ; {type:'vaultSet',name,value}
                  {type:'vaultRemove',name}
     sidecar->UI: {type:'councilConfig',config} ; {type:'vaultKeys',names:[...]}
                  (either may carry {error})

   SECURITY: every untrusted string (vault key names, model values/names,
   council member labels, synthesizer id, flash text) reaches the DOM via
   textContent, or via esc() when it must go through innerHTML. No key VALUE
   is ever shown — only names + a fixed masked •••••••• .
   ===================================================================== */
(function () {
  if (window.AgentOmegaSettings) return; // single-mount guard

  /* ---------- tiny utils ---------- */
  const esc =
    (typeof window.escapeHtml === "function")
      ? window.escapeHtml
      : (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function ws(o) { try { (window.wsSend || function () {})(o); } catch (_) {} }
  function el(tag, cls, txt) { const e = document.createElement(tag || "div"); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function shortLabel(v) { const s = String(v == null ? "" : v); const seg = s.split("/"); return seg[seg.length - 1] || s; }
  function providerOf(v) { const s = String(v == null ? "" : v); const i = s.indexOf("/"); return i >= 0 ? s.slice(0, i).toLowerCase() : "local"; }

  /* cloud provider -> the vault key NAME that unlocks it. Providers absent
     from this map are treated as LOCAL (llama-swap) and need no key. */
  const PROVIDER_KEY = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY", "openai-chat": "OPENAI_API_KEY", azure: "AZURE_API_KEY",
    google: "GEMINI_API_KEY", "google-vertex": "GEMINI_API_KEY", gemini: "GEMINI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY", groq: "GROQ_API_KEY",
    mistral: "MISTRAL_API_KEY", xai: "XAI_API_KEY", grok: "XAI_API_KEY",
    together: "TOGETHER_API_KEY", togetherai: "TOGETHER_API_KEY", fireworks: "FIREWORKS_API_KEY",
    cohere: "COHERE_API_KEY", perplexity: "PERPLEXITY_API_KEY",
    moonshotai: "KIMI_API_KEY", moonshot: "KIMI_API_KEY", kimi: "KIMI_API_KEY",
    zai: "ZAI_API_KEY", zhipuai: "ZAI_API_KEY", glm: "ZAI_API_KEY",
  };
  function neededKey(value) { return PROVIDER_KEY[providerOf(value)] || null; }   // null => local
  const FLAG = /(opus|sonnet|gpt-?5|gpt-?4\.?\d|o[34]\b|gemini.*(2\.5|pro)|grok-?[34]|deepseek.*(v3|r1|chat|reasoner)|mistral.*large|llama.*(70|405)|qwen.*(max|235|122)|kimi|glm-?4)/i;
  function rankFrontier(list) { return list.slice().sort((a, b) => (FLAG.test(b.value + " " + b.name) ? 1 : 0) - (FLAG.test(a.value + " " + a.name) ? 1 : 0)); }

  const FILL = "═".repeat(260);

  /* keycap-styled hint fragments (static markup; no untrusted text) */
  const KC = (s) => '<span class="fs-kc">' + s + "</span>";
  const HINT = {
    tabs: KC("Tab") + "/" + KC("◄►") + " Section&nbsp;&nbsp; " + KC("↓") + "/" + KC("↵") + " Open&nbsp;&nbsp; " + KC("Esc") + " Close",
    def: KC("↑↓") + " Move&nbsp;&nbsp; " + KC("◄►") + " Change&nbsp;&nbsp; " + KC("↵") + " Select&nbsp;&nbsp; " + KC("Esc") + " Back",
    vaultkey: KC("↑↓") + " Move&nbsp;&nbsp; " + KC("↵") + " Set value&nbsp;&nbsp; " + KC("Del") + " Remove&nbsp;&nbsp; " + KC("Esc") + " Back",
    add: KC("↑↓") + " Move&nbsp;&nbsp; " + KC("↵") + " Add key&nbsp;&nbsp; " + KC("Esc") + " Back",
    model: KC("↑↓") + " Move&nbsp;&nbsp; " + KC("◄►") + "/" + KC("↵") + " Toggle member&nbsp;&nbsp; " + KC("Esc") + " Back",
    preset: KC("◄►") + " Pick&nbsp;&nbsp; " + KC("↵") + " Apply preset&nbsp;&nbsp; " + KC("Esc") + " Back",
    council: KC("↑↓") + " Move&nbsp;&nbsp; " + KC("◄►") + " Change&nbsp;&nbsp; " + KC("Esc") + " Back",
    members: KC("↑↓") + " Move&nbsp;&nbsp; " + KC("↵") + " Choose members&nbsp;&nbsp; " + KC("Esc") + " Back",
    edit: KC("↵") + " Save&nbsp;&nbsp; " + KC("Tab") + " Next field&nbsp;&nbsp; " + KC("Esc") + " Cancel",
  };

  /* =====================================================================
     STATE
     ===================================================================== */
  const ST = {
    open: false,
    section: 0,          // 0 vault · 1 models · 2 council · 3 skin
    row: -1,             // -1 = tab row focused ; >=0 = index into nav
    nav: [],             // [{cell,left,right,enter,del,hint}]
    vaultNames: null,    // null = loading ; [] = empty
    council: null,       // null = loading
    models: [],          // [{value,name}] captured from `ready`
    curModel: "",
    presetSel: 0,        // 0 Frontier · 1 Local · 2 Mixed
    editing: null,       // null | {mode:'add'|'edit', name?, nameEl, valEl}
    delArm: "",          // vault key name armed for delete
    flash: "",
    flashT: null,
    hintsCell: null,
    scrollEl: null,
  };
  let pendingSave = false;   // a setCouncilConfig is in flight
  let pendingVault = false;  // a vaultSet/vaultRemove is in flight

  /* =====================================================================
     DATA HELPERS
     ===================================================================== */
  function getModels() {
    if (ST.models && ST.models.length) return ST.models;
    try { if (typeof models !== "undefined" && Array.isArray(models)) return models; } catch (_) {}
    return [];
  }
  function vaultUpper() { return (ST.vaultNames || []).map((n) => String(n).toUpperCase()); }
  function isAvailable(value) {
    const k = neededKey(value);
    if (!k) return true;                       // local model
    if (ST.vaultNames == null) return false;   // still loading -> dim until known
    const names = vaultUpper(), prov = providerOf(value).toUpperCase(), K = k.toUpperCase();
    return names.indexOf(K) >= 0 || names.some((n) => n === K || n.indexOf(prov) >= 0);
  }
  function normCouncil(c) {
    c = c || {};
    let rounds = parseInt(c.rounds, 10); if (!(rounds >= 1 && rounds <= 5)) rounds = 1;
    const members = Array.isArray(c.members)
      ? c.members.filter((m) => m && m.model).map((m) => ({ label: String(m.label || shortLabel(m.model)), model: String(m.model) }))
      : [];
    return {
      rounds,
      synthesizer: (typeof c.synthesizer === "string" && c.synthesizer) ? c.synthesizer : "driver",
      memberAccess: c.memberAccess === "readonly" ? "readonly" : "none",
      members,
    };
  }
  function ensureCouncil() { if (!ST.council) ST.council = normCouncil(null); }
  function isMember(value) { return !!(ST.council && ST.council.members.some((m) => m.model === value)); }

  function pushCouncil() {
    ws({ type: "setCouncilConfig", config: ST.council });
    pendingSave = true; setFlash("saving…");
    render();
  }
  function setC(patch) { ensureCouncil(); Object.assign(ST.council, patch); pushCouncil(); }
  function toggleMember(value, name) {
    ensureCouncil();
    const mem = ST.council.members.slice();
    const i = mem.findIndex((x) => x.model === value);
    if (i >= 0) {
      mem.splice(i, 1);
      if (ST.council.synthesizer === value) ST.council.synthesizer = "driver"; // keep synthesizer valid
    } else {
      mem.push({ label: shortLabel(name || value), model: value });
    }
    ST.council.members = mem; pushCouncil();
  }
  function applyPreset(kind) {
    ensureCouncil();
    const avail = getModels().filter((m) => isAvailable(m.value));
    const cloud = avail.filter((m) => neededKey(m.value));
    const local = avail.filter((m) => !neededKey(m.value));
    let pick = [];
    if (kind === "frontier") { pick = rankFrontier(cloud).slice(0, 4); if (!pick.length) pick = cloud.slice(0, 4); }
    else if (kind === "local") { pick = local.slice(0, 4); }
    else { pick = local.slice(0, 2).concat(rankFrontier(cloud).slice(0, 2)); }
    if (!pick.length) { setFlash("no available models for " + kind + " — add a key in Vault"); return; }
    ST.council.members = pick.map((m) => ({ label: shortLabel(m.name || m.value), model: m.value }));
    if (ST.council.synthesizer !== "driver" && !pick.some((m) => m.value === ST.council.synthesizer)) ST.council.synthesizer = "driver";
    pushCouncil();
  }
  function synthOptions() { ensureCouncil(); return ["driver"].concat(ST.council.members.map((m) => m.model)); }
  function cycleSynth(dir) {
    const opts = synthOptions(); let i = opts.indexOf(ST.council.synthesizer); if (i < 0) i = 0;
    i = (i + dir + opts.length) % opts.length; setC({ synthesizer: opts[i] });
  }

  /* ---- vault edit flow ---- */
  function startAdd() { ST.editing = { mode: "add" }; ST.delArm = ""; render(); }
  function startEdit(name) { ST.editing = { mode: "edit", name }; ST.delArm = ""; render(); }
  function cancelEdit() { ST.editing = null; setFlash(""); render(); }
  function focusNextEditField() {
    const n = ST.editing && ST.editing.nameEl, v = ST.editing && ST.editing.valEl;
    if (n && typeof n.focus === "function") { if (document.activeElement === n) v && v.focus(); else n.focus(); }
    else if (v) v.focus();
  }
  function submitEdit() {
    if (!ST.editing) return;
    const name = String((ST.editing.nameEl && ST.editing.nameEl.value) || "").trim();
    const val = String((ST.editing.valEl && ST.editing.valEl.value) || "");
    if (!name) { setFlash("name required"); ST.editing.nameEl && ST.editing.nameEl.focus && ST.editing.nameEl.focus(); return; }
    if (!val) { setFlash("value required"); ST.editing.valEl && ST.editing.valEl.focus(); return; }
    ws({ type: "vaultSet", name, value: val });
    pendingVault = true; setFlash("saving " + name + "…");
    ST.editing = null; render();
  }
  function delKey(name) {
    if (ST.delArm === name) { ws({ type: "vaultRemove", name }); pendingVault = true; setFlash("removing " + name + "…"); ST.delArm = ""; render(); }
    else { ST.delArm = name; setFlash("press Del again to remove " + name); render(); }
  }

  /* =====================================================================
     INCOMING WS  (peek `ready` ; consume councilConfig / vaultKeys)
     ===================================================================== */
  function onWs(m) {
    if (!m || !m.type) return false;
    if (m.type === "ready") {                                   // peek only
      if (Array.isArray(m.models)) ST.models = m.models;
      if (m.model != null) ST.curModel = m.model;
      return false;
    }
    if (m.type === "model") { if (m.model != null) ST.curModel = m.model; return false; }
    if (m.type === "councilConfig") {
      if (m.error) { setFlash("council error: " + m.error); }
      else {
        ST.council = normCouncil(m.config);
        if (pendingSave) { pendingSave = false; setFlash("saved ✓", 1500); }
      }
      if (ST.open) render();
      return true;
    }
    if (m.type === "vaultKeys") {
      if (m.error) { setFlash("vault error: " + m.error); }
      else {
        ST.vaultNames = Array.isArray(m.names) ? m.names.slice() : [];
        if (m.note) { pendingVault = false; setFlash(m.note, 8000); }
        else if (pendingVault) { pendingVault = false; setFlash("saved ✓", 1500); }
      }
      if (ST.open) render();
      return true;
    }
    return false;
  }

  /* =====================================================================
     RENDER
     ===================================================================== */
  let root = null, panel = null;
  function mount() {
    if (root) return;
    injectCss();
    root = el("div", "ftpset-overlay hidden");
    root.tabIndex = -1;
    panel = el("div", "ftpset");
    root.appendChild(panel);
    root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });
    (document.querySelector(".screen") || document.body).appendChild(root);
  }

  function borderRow(l, r) {
    const row = el("div", "fs-row");
    const L = el("span", "fs-edge", l), F = el("span", "fs-fill", FILL), R = el("span", "fs-edge", r);
    row.append(L, F, R); return row;
  }
  function topRow(title) {
    const row = el("div", "fs-row");
    row.append(
      el("span", "fs-edge", "╔"), el("span", "fs-fill", FILL),
      el("span", "fs-edge fs-title", "═╡ " + title + " ╞═"),
      el("span", "fs-fill", FILL), el("span", "fs-edge", "╗"));
    return row;
  }

  function render() {
    if (!panel) return;
    panel.innerHTML = "";
    ST.nav = [];
    panel.appendChild(topRow("Agent Omega · SETTINGS"));

    /* ---- tab row ---- */
    {
      const row = el("div", "fs-row");
      const L = el("span", "fs-edge", "║"), cell = el("div", "fs-cell fs-tabs"), R = el("span", "fs-edge", "║");
      ["Vault", "Models", "Council", "Skin"].forEach((label, i) => {
        const t = el("span", "fs-tab", " " + label + " ");
        if (i === ST.section) t.classList.add("on");
        if (i === ST.section && ST.row < 0) t.classList.add("focus");
        t.onclick = () => setSection(i);
        cell.appendChild(t);
        if (i < 3) cell.appendChild(el("span", "fs-tabsep", " · "));
      });
      row.append(L, cell, R); panel.appendChild(row);
    }
    panel.appendChild(borderRow("╠", "╣"));

    /* ---- scrolling content ---- */
    const scroll = el("div", "fs-scroll"); ST.scrollEl = scroll;
    panel.appendChild(scroll);

    function wallRow() {
      const row = el("div", "fs-row");
      const L = el("span", "fs-edge", "║"), cell = el("div", "fs-cell"), R = el("span", "fs-edge", "║");
      row.append(L, cell, R); return { row, cell };
    }
    function add(row) { scroll.appendChild(row); }
    function info(text, cls) { const w = wallRow(); w.cell.classList.add("fs-info"); if (cls) w.cell.classList.add(cls); w.cell.appendChild(el("span", null, text)); add(w.row); }
    function pushNav(cell, h) { const i = ST.nav.length; ST.nav.push({ cell, left: h.left, right: h.right, enter: h.enter, del: h.del, hint: h.hint }); return i; }

    if (ST.section === 0) buildVault(wallRow, add, info, pushNav);
    else if (ST.section === 1) buildModels(wallRow, add, info, pushNav);
    else if (ST.section === 2) buildCouncil(wallRow, add, info, pushNav);
    else buildSkin(wallRow, add, info, pushNav);

    /* ---- hints + bottom ---- */
    panel.appendChild(borderRow("╠", "╣"));
    {
      const row = el("div", "fs-row");
      const L = el("span", "fs-edge", "║"), cell = el("div", "fs-cell fs-hints"), R = el("span", "fs-edge", "║");
      row.append(L, cell, R); panel.appendChild(row); ST.hintsCell = cell;
    }
    panel.appendChild(borderRow("╚", "╝"));

    /* ---- clamp selection + paint ---- */
    if (ST.nav.length === 0) ST.row = -1;
    else if (ST.row >= ST.nav.length) ST.row = ST.nav.length - 1;
    if (ST.row < -1) ST.row = -1;
    if (ST.row >= 0 && ST.nav[ST.row]) {
      const c = ST.nav[ST.row].cell; c.classList.add("sel");
      if (c.scrollIntoView) c.scrollIntoView({ block: "nearest" });
    }
    updateHints();
  }

  /* ---------- VAULT ---------- */
  function buildVault(wallRow, add, info, pushNav) {
    info("VAULT · API keys & secrets", "fs-head");
    if (ST.vaultNames == null) { info("loading…"); return; }
    if (ST.vaultNames.length === 0 && !(ST.editing && ST.editing.mode === "add")) info("(vault is empty — add a key below)");

    ST.vaultNames.forEach((name) => {
      if (ST.editing && ST.editing.mode === "edit" && ST.editing.name === name) { editForm(wallRow, add, "edit", name); return; }
      const w = wallRow();
      w.cell.appendChild(el("span", "fs-vk", name));
      const sp = el("span"); sp.style.flex = "1"; w.cell.appendChild(sp);
      w.cell.appendChild(el("span", "fs-vd", "••••••••"));
      if (ST.delArm === name) w.cell.appendChild(el("span", "fs-del", " DEL?"));
      const idx = pushNav(w.cell, { enter: () => startEdit(name), del: () => delKey(name), hint: HINT.vaultkey });
      w.cell.onclick = () => { ST.row = idx; render(); };
      add(w.row);
    });

    if (ST.editing && ST.editing.mode === "add") { editForm(wallRow, add, "add"); }
    else {
      const w = wallRow();
      w.cell.appendChild(el("span", "fs-add", "[ + Add Key ]"));
      const idx = pushNav(w.cell, { enter: () => startAdd(), hint: HINT.add });
      w.cell.onclick = () => { ST.row = idx; startAdd(); };
      add(w.row);
    }
  }
  function editForm(wallRow, add, mode, name) {
    const r1 = wallRow(); r1.cell.classList.add("fs-form");
    r1.cell.appendChild(el("span", "fs-key", "name"));
    let nameEl;
    if (mode === "edit") { r1.cell.appendChild(el("span", "fs-val", name)); nameEl = { value: name }; }
    else { nameEl = document.createElement("input"); nameEl.className = "fs-input"; nameEl.spellcheck = false; nameEl.autocomplete = "off"; nameEl.placeholder = "KEY_NAME"; r1.cell.appendChild(nameEl); }
    add(r1.row);

    const r2 = wallRow(); r2.cell.classList.add("fs-form");
    r2.cell.appendChild(el("span", "fs-key", "value"));
    const valEl = document.createElement("input"); valEl.type = "password"; valEl.className = "fs-input"; valEl.spellcheck = false; valEl.autocomplete = "off"; valEl.placeholder = "•••• (masked)";
    r2.cell.appendChild(valEl);
    add(r2.row);

    ST.editing.nameEl = nameEl; ST.editing.valEl = valEl;
    setTimeout(() => { (mode === "add" ? nameEl : valEl).focus && (mode === "add" ? nameEl : valEl).focus(); }, 0);
  }

  /* ---------- MODELS ---------- */
  function buildModels(wallRow, add, info, pushNav) {
    info("MODELS · council members", "fs-head");
    const all = getModels();
    if (!all.length) { info("(no models reported yet — connect engine)"); return; }

    /* presets row */
    {
      const w = wallRow();
      w.cell.appendChild(el("span", "fs-key", "Presets"));
      ["Frontier", "Local", "Mixed"].forEach((p, i) => {
        const b = el("span", "fs-btn", "[ " + p + " ]");
        if (i === ST.presetSel) b.classList.add("on");
        b.onclick = () => { ST.presetSel = i; applyPreset(p.toLowerCase()); };
        w.cell.appendChild(b); w.cell.appendChild(document.createTextNode(" "));
      });
      const idx = pushNav(w.cell, {
        left: () => { ST.presetSel = (ST.presetSel + 2) % 3; render(); },
        right: () => { ST.presetSel = (ST.presetSel + 1) % 3; render(); },
        enter: () => applyPreset(["frontier", "local", "mixed"][ST.presetSel]),
        hint: HINT.preset,
      });
      w.cell.onclick = () => { ST.row = idx; render(); };
      add(w.row);
    }

    /* grouped by provider */
    const groups = {}; const order = [];
    all.forEach((m) => { const p = providerOf(m.value); if (!groups[p]) { groups[p] = []; order.push(p); } groups[p].push(m); });
    order.forEach((p) => {
      const need = PROVIDER_KEY[p] || null;
      const ok = !need || groups[p].some((m) => isAvailable(m.value));
      const tag = !need ? "local" : (ok ? "✓ key found" : "needs " + need);
      const w = wallRow(); w.cell.classList.add("fs-grp");
      w.cell.appendChild(el("span", "fs-grp-name", "┄ " + p.toUpperCase()));
      const t = el("span", "fs-grp-tag", "  " + tag); if (need && !ok) t.classList.add("warn");
      w.cell.appendChild(t); add(w.row);

      groups[p].forEach((m) => {
        const on = isMember(m.value), avail = isAvailable(m.value);
        const w2 = wallRow(); if (!avail) w2.cell.classList.add("dim");
        const box = el("span", "fs-box", on ? "[✓] " : "[ ] "); if (on) box.classList.add("on");
        w2.cell.appendChild(box);
        w2.cell.appendChild(el("span", "fs-mname", m.name || shortLabel(m.value)));
        if (!avail) w2.cell.appendChild(el("span", "fs-needs", "  needs " + (need || "key")));
        const toggle = () => { if (!avail) { setFlash("needs " + (need || "key") + " in vault"); return; } toggleMember(m.value, m.name); };
        const idx = pushNav(w2.cell, { left: toggle, right: toggle, enter: toggle, hint: HINT.model });
        w2.cell.onclick = () => { ST.row = idx; toggle(); };
        add(w2.row);
      });
    });
  }

  /* ---------- COUNCIL ---------- */
  function buildCouncil(wallRow, add, info, pushNav) {
    ensureCouncil();
    info("COUNCIL · deliberation", "fs-head");
    if (ST.council == null) { info("loading…"); return; }
    const c = ST.council;

    function valRow(label, value, h) {
      const w = wallRow();
      w.cell.appendChild(el("span", "fs-key", label));
      const changeable = h && (h.left || h.right);
      if (changeable) {
        w.cell.appendChild(el("span", "fs-arr", "◄ "));
        w.cell.appendChild(el("span", "fs-val", value));
        w.cell.appendChild(el("span", "fs-arr", " ►"));
      } else {
        w.cell.appendChild(el("span", "fs-val", value));
      }
      const idx = pushNav(w.cell, h || {});
      w.cell.onclick = () => { ST.row = idx; if (h && h.right) h.right(); else if (h && h.enter) h.enter(); else render(); };
      add(w.row);
    }

    valRow("Rounds", String(c.rounds), {
      left: () => setC({ rounds: Math.max(1, c.rounds - 1) }),
      right: () => setC({ rounds: Math.min(5, c.rounds + 1) }),
      hint: HINT.council,
    });
    valRow("Members", c.members.length + (c.members.length === 1 ? " selected" : " selected"), {
      enter: () => setSection(1), hint: HINT.members,
    });
    valRow("Access", c.memberAccess === "readonly" ? "File-aware" : "Discuss-only", {
      left: () => setC({ memberAccess: c.memberAccess === "none" ? "readonly" : "none" }),
      right: () => setC({ memberAccess: c.memberAccess === "none" ? "readonly" : "none" }),
      hint: HINT.council,
    });
    valRow("Synthesizer", c.synthesizer === "driver" ? "Driver" : shortLabel(c.synthesizer), {
      left: () => cycleSynth(-1), right: () => cycleSynth(1), hint: HINT.council,
    });
    // NOTE: "Mode: Auto" (council auto-convenes) and its "Rung" are a V3 roadmap item — the
    // shipped engine only convenes the council when the lead calls the council tool. The rows
    // were removed rather than shown as live controls the engine ignores.
  }

  /* ---------- SKIN ---------- */
  function buildSkin(wallRow, add, info, pushNav) {
    info("APPEARANCE · theme skin", "fs-head");
    const current = document.body.classList.contains("theme-modern") ? "modern" : "crt";
    const skins = [
      { id: "crt",    label: "CRT",    desc: "phosphor terminal" },
      { id: "modern", label: "Modern", desc: "glassy minimal UI" },
    ];
    skins.forEach((s) => {
      const w = wallRow();
      const on = current === s.id;
      const box = el("span", "fs-box" + (on ? " on" : ""), on ? "[✓] " : "[ ] ");
      w.cell.appendChild(box);
      w.cell.appendChild(el("span", "fs-mname", s.label));
      w.cell.appendChild(el("span", "fs-needs", "  " + s.desc));
      const navIdx = ST.nav.length;
      const apply = () => {
        if (typeof window.setSkin === "function") window.setSkin(s.id);
        ST.row = navIdx;
        render();   // re-render to update the checkbox states
      };
      const idx = pushNav(w.cell, { enter: apply, left: apply, right: apply, hint: HINT.def });
      w.cell.onclick = () => { ST.row = idx; apply(); };
      add(w.row);
    });
  }

  /* =====================================================================
     HINTS / FLASH
     ===================================================================== */
  function updateHints() {
    if (!ST.hintsCell) return;
    let h;
    if (ST.editing) h = HINT.edit;
    else if (ST.row < 0) h = HINT.tabs;
    else h = (ST.nav[ST.row] && ST.nav[ST.row].hint) || HINT.def;
    ST.hintsCell.innerHTML = h + (ST.flash ? '&nbsp;&nbsp;&nbsp;<span class="fs-flash">' + esc(ST.flash) + "</span>" : "");
  }
  function setFlash(msg, ms) {
    ST.flash = msg || "";
    if (ST.flashT) { clearTimeout(ST.flashT); ST.flashT = null; }
    if (ms) ST.flashT = setTimeout(() => { ST.flash = ""; updateHints(); }, ms);
    updateHints();
  }

  /* =====================================================================
     NAVIGATION + KEYBOARD
     ===================================================================== */
  function setSection(i) {
    ST.section = (i + 4) % 4;
    ST.row = 0; ST.delArm = ""; ST.editing = null;
    render(); // render() clamps row to -1 when the section has no nav rows
  }
  function settingsKeydown(e) {
    if (!ST.open) return false;
    const k = e.key;

    /* editing a vault key form: form owns Enter/Tab/Esc, typing/cursor flow to inputs */
    if (ST.editing) {
      if (k === "Escape") { e.preventDefault(); cancelEdit(); return true; }
      if (k === "Enter") { e.preventDefault(); submitEdit(); return true; }
      if (k === "Tab") { e.preventDefault(); focusNextEditField(); return true; }
      return false;
    }

    if (k === "Escape") {
      e.preventDefault();
      if (ST.delArm) { ST.delArm = ""; render(); }
      else if (ST.row >= 0) { ST.row = -1; render(); }
      else close();
      return true;
    }
    if (k === "Tab") { e.preventDefault(); setSection(ST.section + (e.shiftKey ? -1 : 1)); return true; }

    /* tab row focused */
    if (ST.row < 0) {
      if (k === "ArrowLeft") { e.preventDefault(); setSection(ST.section - 1); return true; }
      if (k === "ArrowRight") { e.preventDefault(); setSection(ST.section + 1); return true; }
      if (k === "ArrowDown" || k === "Enter") { e.preventDefault(); ST.row = 0; render(); return true; }
      if (k !== "Shift" && k !== "Control" && k !== "Alt" && k !== "Meta") e.preventDefault();
      return true; // trap everything else on the tab row
    }

    /* a content row is focused */
    const it = ST.nav[ST.row];
    if (k === "ArrowUp") { e.preventDefault(); ST.delArm = ""; ST.row = (ST.row === 0) ? -1 : ST.row - 1; render(); return true; }
    if (k === "ArrowDown") { e.preventDefault(); ST.delArm = ""; if (ST.row < ST.nav.length - 1) ST.row++; render(); return true; }
    if (k === "ArrowLeft") { e.preventDefault(); if (it && it.left) it.left(); return true; }
    if (k === "ArrowRight") { e.preventDefault(); if (it && it.right) it.right(); return true; }
    if (k === "Enter") { e.preventDefault(); if (it && it.enter) it.enter(); return true; }
    if (it && it.del && (k === "Delete" || k === "Backspace" || (k === "x" && !e.ctrlKey && !e.altKey))) { e.preventDefault(); it.del(); return true; }
    if (k !== "Shift" && k !== "Control" && k !== "Alt" && k !== "Meta") e.preventDefault();
    return true; // modal: trap stray keys so they never reach the prompt / scroll keys
  }

  /* =====================================================================
     OPEN / CLOSE
     ===================================================================== */
  function sectionIndex(s) { return s === "models" ? 1 : s === "council" ? 2 : s === "skin" ? 3 : 0; }
  function open(section) {
    mount();
    ST.open = true;
    ST.section = sectionIndex(section);
    ST.row = -1; ST.delArm = ""; ST.editing = null; setFlash("");
    root.classList.remove("hidden");
    try { if (window.AgentOmegaCommands && window.AgentOmegaCommands.palette && window.AgentOmegaCommands.palette.open) window.AgentOmegaCommands.palette.close(); } catch (_) {}
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) {}
    root.focus();
    ws({ type: "getCouncilConfig" });
    ws({ type: "vaultList" });
    render();
  }
  function close() {
    if (!ST.open) return;
    ST.open = false; ST.editing = null; ST.delArm = "";
    if (root) root.classList.add("hidden");
    try { if (typeof window.focusActive === "function") window.focusActive(); } catch (_) {}
  }

  /* =====================================================================
     SELF-WIRING  (keyboard pipeline · modal flag · WS · palette · gear)
     ===================================================================== */
  function wireKeydown() {
    if (typeof window.registerKeydown === "function") { window.registerKeydown(settingsKeydown, 95); return; }
    window.addEventListener("keydown", (e) => { if (settingsKeydown(e)) e.stopImmediatePropagation(); }, true);
  }
  function wireModalFlag() {
    try {
      const d = Object.getOwnPropertyDescriptor(window, "__ftpModalOpen");
      const orig = d && d.get;
      Object.defineProperty(window, "__ftpModalOpen", {
        configurable: true,
        get() { if (ST.open) return true; return orig ? orig.call(window) : false; },
      });
    } catch (_) {}
  }
  function wireWs() {
    if (window.__ftpSettingsWsWrapped) return;
    if (typeof window.onWs !== "function") return;
    window.__ftpSettingsWsWrapped = true;
    const origOnWs = window.onWs;
    window.onWs = function (m) {
      try { if (onWs(m)) return; } catch (_) {}
      return origOnWs.apply(this, arguments);
    };
  }
  function wirePalette() {
    const C = window.AgentOmegaCommands;
    if (!C || !C.registry || C.registry._settingsCmd) return;
    C.registry._settingsCmd = true;
    C.registry.builtins.push({ kind: "builtin", id: "settings.open", slash: "settings", aliases: ["config", "prefs", "preferences"], keys: "^,", title: "Settings", category: "System", suggested: true });
    try { C.registry.index(); } catch (_) {}
    C.setAction("settings.open", () => open());
  }
  function wireGear() {
    if (document.getElementById("ftpGearBtn")) return;
    const tb = document.getElementById("titlebar"); if (!tb) return;
    const right = tb.querySelector("div:last-child"); if (!right) return;
    const g = el("span", "ctl", "⚙"); g.id = "ftpGearBtn"; g.title = "Settings (/settings · " + (/Mac/.test(navigator.platform || "") ? "⌘," : "Ctrl+,") + ")";
    g.style.cssText = "cursor:default; color:#3f4a44;";
    g.addEventListener("click", (e) => { e.stopPropagation(); open(); });
    right.insertBefore(g, right.firstChild);
  }
  /* Ctrl+, global open accelerator (works even before the palette boots) */
  function wireAccelerator() {
    if (typeof window.registerKeydown === "function") {
      window.registerKeydown((e) => {
        // Cmd+, is THE macOS settings convention; Ctrl+, everywhere (Win key rejected off-mac).
        const isMac = /Mac/.test(navigator.platform || "");
        const mod = isMac ? (e.metaKey || e.ctrlKey) : (e.ctrlKey && !e.metaKey);
        if (!ST.open && mod && !e.altKey && (e.key === "," || e.code === "Comma")) { e.preventDefault(); open(); return true; }
        return false;
      }, 96);
    }
  }

  /* =====================================================================
     CSS  (CRT-phosphor DOS-settings look; inverted selection bar)
     ===================================================================== */
  function injectCss() {
    if (document.getElementById("ftp-settings-css")) return;
    const css = `
    .hidden{ display:none !important; }
    .ftpset-overlay{ position:absolute; inset:0; z-index:70; outline:none;
      background:rgba(3,5,6,.62); display:flex; align-items:center; justify-content:center; }
    .ftpset{ position:relative; width:min(840px,93vw); max-height:92vh; display:flex; flex-direction:column;
      background:#070b0d; color:#b9c7be;
      font-family:'VT323','Segoe UI Symbol',monospace; font-size:21px; line-height:1.32; letter-spacing:.4px;
      text-shadow:0 0 1px rgba(170,225,195,.45), 0 0 7px rgba(110,200,160,.12);
      box-shadow:0 0 46px rgba(0,0,0,.66), 0 0 0 1px rgba(255,180,84,.10), inset 0 0 30px rgba(0,0,0,.5);
      animation:fs-pop .11s ease-out; }
    @keyframes fs-pop{ from{ transform:translateY(-6px); opacity:.4 } to{ transform:none; opacity:1 } }
    /* scanline texture, self-contained so the menu keeps the CRT feel above the global overlays */
    .ftpset::after{ content:""; position:absolute; inset:0; pointer-events:none; z-index:3;
      background-image:repeating-linear-gradient(0deg, rgba(0,0,0,.16) 0, rgba(0,0,0,.16) 1px, transparent 1px, transparent 3px);
      mix-blend-mode:multiply; opacity:.55; }

    .fs-row{ display:flex; align-items:stretch; flex:0 0 auto; }
    .fs-edge{ flex:0 0 auto; display:flex; align-items:center; justify-content:center; color:var(--ac);
      text-shadow:0 0 6px rgba(255,180,84,.30); white-space:pre; }
    .fs-fill{ flex:1 1 0; min-width:0; overflow:hidden; white-space:nowrap; color:var(--ac);
      text-shadow:0 0 6px rgba(255,180,84,.25); }
    .fs-title{ color:var(--ac); padding:0; font-size:21px; letter-spacing:1px;
      text-shadow:0 0 9px rgba(255,180,84,.5); }

    .fs-cell{ flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:.4ch;
      padding:1px 2ch; color:#cdd8cf; white-space:nowrap; overflow:hidden; }
    /* inverted phosphor selection bar */
    .fs-cell.sel{ background:var(--ac); box-shadow:0 0 12px rgba(255,180,84,.35); }
    .fs-cell.sel, .fs-cell.sel *{ color:#07090b !important; text-shadow:none !important; }
    .fs-cell.sel .fs-needs, .fs-cell.sel .fs-vd{ color:#3a2a08 !important; }

    .fs-scroll{ flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; }
    .fs-scroll::-webkit-scrollbar{ width:8px; } .fs-scroll::-webkit-scrollbar-thumb{ background:#1e2d27; }

    /* tabs */
    .fs-tabs{ gap:0; }
    .fs-tab{ color:#7c8b82; padding:0 .3ch; }
    .fs-tab.on{ background:var(--ac); color:#07090b; text-shadow:none; }
    .fs-tab.focus{ box-shadow:0 0 0 2px rgba(255,180,84,.55); }
    .fs-tabsep{ color:#3f4a44; }

    /* info / headers */
    .fs-info{ color:#7c8b82; }
    .fs-head{ color:var(--ac); letter-spacing:1px; text-shadow:0 0 8px rgba(255,180,84,.3); }
    .fs-grp .fs-grp-name{ color:#5fd3dd; }
    .fs-grp .fs-grp-tag{ color:#46544c; font-size:18px; }
    .fs-grp .fs-grp-tag.warn{ color:#caa15a; }

    /* vault */
    .fs-vk{ color:#cdd8cf; }
    .fs-vd{ color:#54655b; letter-spacing:2px; }
    .fs-del{ color:#ff6b6b; }
    .fs-add{ color:var(--ac); }
    .fs-form .fs-input{ flex:1 1 auto; min-width:0; background:rgba(0,0,0,.35); border:1px solid #45554d;
      outline:none; color:#dfeae2; font-family:inherit; font-size:20px; letter-spacing:.5px;
      caret-color:var(--ac); padding:0 8px; }
    .fs-form .fs-input::placeholder{ color:#46544c; }

    /* models */
    .fs-box{ color:#54655b; }
    .fs-box.on{ color:#66dd88; }
    .fs-mname{ color:#cdd8cf; }
    .fs-needs{ color:#7a6a3a; font-size:18px; }
    .dim{ opacity:.5; }
    .fs-btn{ color:#9fb0a6; border:1px solid #2a3a32; padding:0 .2ch; }
    .fs-btn.on{ background:var(--ac); color:#07090b; border-color:var(--ac); text-shadow:none; }

    /* council value rows */
    .fs-key{ color:#7c8b82; flex:0 0 auto; width:13ch; }
    .fs-val{ color:var(--ac); text-shadow:0 0 7px rgba(255,180,84,.28); }
    .fs-arr{ color:#54655b; }

    /* hints */
    .fs-hints{ color:#46544c; font-size:18px; }
    .fs-kc{ color:var(--ac); }
    .fs-flash{ color:#66dd88; text-shadow:0 0 8px rgba(102,221,136,.4); }
    `;
    const s = el("style"); s.id = "ftp-settings-css"; s.textContent = css; document.head.appendChild(s);
  }

  /* =====================================================================
     PUBLIC API + BOOT
     ===================================================================== */
  window.AgentOmegaSettings = { open, close, onWs, _state: ST };

  function boot() {
    mount();
    wireModalFlag();
    wireKeydown();
    wireAccelerator();
    wireWs();
    wirePalette();
    wireGear();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  /* palette / gear may not exist yet if this script loads before them — retry once */
  window.addEventListener("DOMContentLoaded", () => { wirePalette(); wireGear(); wireWs(); });
})();
