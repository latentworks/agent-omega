/* first-run.js — Omega first-run onboarding card. A non-model key-entry card that bootstraps a fresh
   install: pick a provider, paste a key (or a local server URL); the sidecar validates, stores, reloads
   the engine, then hands off to the setup agent. Consumes first-run / onboard-status / onboard-result
   over the control WS; sends onboardKey / onboardLocal / onboardSkip.
   Phase 3: skin-matched (CRT phosphor + Modern glass) via --ac + a scoped style block. Stable ids:
   fr-backdrop fr-card fr-providers fr-key fr-url fr-status fr-error fr-submit fr-skip. */
(function () {
  if (window.AgentOmegaOnboard) return
  function ws(o) { try { (window.wsSend || function () {})(o) } catch (_) {} }
  function el(tag, cls, txt) { const e = document.createElement(tag || 'div'); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e }
  let providers = [], recommended = 'anthropic', selected = null, busy = false, shown = false, root = null, backdrop = null

  const CSS = `
  @keyframes frFade{from{opacity:0}to{opacity:1}}
  @keyframes frRise{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}
  #fr-backdrop{position:fixed;inset:0;z-index:30;display:none;align-items:flex-start;justify-content:center;overflow-y:auto;font-family:inherit;
    background:radial-gradient(125% 120% at 50% 0%,rgba(10,16,20,.90) 0%,rgba(4,6,8,.965) 70%);animation:frFade .35s ease}
  #fr-backdrop::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.16) 0,rgba(0,0,0,.16) 1px,transparent 1px,transparent 3px)}
  #fr-card{position:relative;z-index:1;margin:auto;width:min(600px,92vw);color:#cdd8cf;padding:32px 34px 26px;
    background:rgba(8,13,11,.74);border:1px solid var(--ac);animation:frRise .42s cubic-bezier(.2,.8,.2,1);
    box-shadow:0 0 2px var(--ac),0 0 48px rgba(255,180,84,.15),inset 0 0 34px rgba(0,0,0,.5)}
  #fr-card::before{content:"WELCOME";position:absolute;top:-11px;left:22px;padding:0 9px;background:#080b0d;
    color:var(--ac);font-size:15px;letter-spacing:2.5px;text-shadow:0 0 8px rgba(255,180,84,.4)}
  .fr-brand{font-size:50px;line-height:1;letter-spacing:2px;margin-bottom:6px;display:flex;align-items:baseline}
  .fr-brand .a{color:#5c6a60}.fr-brand .o{color:var(--ac);text-shadow:0 0 2px var(--ac),0 0 26px rgba(255,180,84,.42)}
  .fr-title{font-size:22px;color:#e9f2eb;letter-spacing:1px;margin-bottom:9px}
  .fr-sub{font-size:16px;color:#8aa093;line-height:1.5;margin-bottom:22px;max-width:52ch}
  .fr-providers{display:flex;flex-wrap:wrap;gap:9px;margin-bottom:18px}
  .fr-chip{font-family:inherit;font-size:16px;cursor:pointer;padding:8px 14px;letter-spacing:.4px;transition:all .12s;
    background:rgba(8,12,10,.6);border:1px solid #45554d;color:#cdd8cf}
  .fr-chip:hover:not(:disabled){background:rgba(255,180,84,.08);color:#e9f2eb}
  .fr-chip.sel{box-shadow:0 0 0 2px var(--ac) inset;color:var(--ac);border-color:var(--ac)}
  .fr-chip .star{color:var(--ac);margin-left:7px}
  .fr-inwrap{display:flex;align-items:center;padding:0 12px;margin-bottom:8px;
    background:rgba(6,10,12,.7);border:1px solid #45554d;transition:border-color .12s,box-shadow .12s}
  .fr-inwrap:focus-within{border-color:var(--ac);box-shadow:inset 0 0 14px rgba(255,180,84,.08)}
  .fr-mark{color:var(--ac);margin-right:9px;font-size:18px}
  #fr-key,#fr-url{flex:1;min-width:0;background:transparent;border:none;outline:none;color:#dfeae2;
    font-family:inherit;font-size:17px;letter-spacing:.5px;padding:11px 0;caret-color:var(--ac)}
  .fr-status{font-size:15px;color:var(--ac);min-height:20px;text-shadow:0 0 7px rgba(255,180,84,.25)}
  .fr-error{font-size:15px;color:#ff6b6b;min-height:20px;margin-bottom:12px}
  .fr-actions{display:flex;align-items:center;gap:18px}
  #fr-submit{font-family:inherit;font-size:17px;cursor:pointer;padding:10px 26px;letter-spacing:.6px;
    background:rgba(255,180,84,.12);color:var(--ac);border:1px solid var(--ac);transition:box-shadow .14s}
  #fr-submit:hover:not(:disabled){box-shadow:0 0 15px rgba(255,180,84,.32)}
  #fr-submit:disabled{opacity:.45;cursor:default}
  #fr-skip{font-family:inherit;font-size:14px;cursor:pointer;background:transparent;color:#8b9097;border:none;text-decoration:underline}
  #fr-skip:hover:not(:disabled){color:#9fb0a6}
  /* Modern skin */
  body.theme-modern #fr-backdrop{background:rgba(12,14,20,.66);backdrop-filter:blur(12px);font-family:'Geist','Segoe UI',sans-serif}
  body.theme-modern #fr-backdrop::after{display:none}
  body.theme-modern #fr-card{background:rgba(24,26,34,.9);border:1px solid rgba(110,123,255,.32);border-radius:18px;
    box-shadow:0 24px 70px rgba(0,0,0,.55);animation:frRise .42s cubic-bezier(.2,.8,.2,1)}
  body.theme-modern #fr-card::before{display:none}
  body.theme-modern .fr-brand{font-size:38px;text-shadow:none}
  body.theme-modern .fr-brand .o{text-shadow:none}
  body.theme-modern .fr-chip{border-radius:10px;font-family:'Geist',sans-serif;border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.04)}
  body.theme-modern .fr-chip:hover:not(:disabled){background:rgba(110,123,255,.12)}
  body.theme-modern .fr-chip.sel{background:rgba(110,123,255,.16)}
  body.theme-modern .fr-inwrap{border-radius:10px;border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.04)}
  body.theme-modern #fr-key,body.theme-modern #fr-url{font-family:'Geist',sans-serif}
  body.theme-modern .fr-status{text-shadow:none}
  body.theme-modern #fr-submit{border-radius:10px;font-family:'Geist',sans-serif;background:rgba(110,123,255,.16)}
  body.theme-modern #fr-submit:hover:not(:disabled){box-shadow:0 0 16px rgba(110,123,255,.4)}
  body.theme-modern .fr-inwrap:focus-within{box-shadow:inset 0 0 14px rgba(110,123,255,.1)}
  body.theme-modern .fr-sub{color:#8b9097}
  body.theme-modern .fr-brand .a{color:#6b7178}
  .fr-chip:disabled,#fr-skip:disabled,#fr-key:disabled,#fr-url:disabled{opacity:.5;cursor:default}
  @media (prefers-reduced-motion:reduce){#fr-card,#fr-backdrop{animation:none}}
  `

  function ensureRoot() {
    if (root) return root
    if (!document.getElementById('fr-style')) { const s = el('style'); s.id = 'fr-style'; s.textContent = CSS; document.head.appendChild(s) }
    backdrop = el('div'); backdrop.id = 'fr-backdrop'
    root = el('div'); root.id = 'fr-card'
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Welcome to Agent Omega — first-run setup')
    backdrop.appendChild(root)
    document.body.appendChild(backdrop)
    return root
  }
  function setStatus(t) { const s = root && root.querySelector('#fr-status'); if (s) s.textContent = t || '' }
  function setError(t) { const e = root && root.querySelector('#fr-error'); if (e) e.textContent = t || '' }

  function render() {
    const r = ensureRoot(); r.innerHTML = ''
    const brand = el('div', 'fr-brand'); brand.appendChild(el('span', 'a', 'A')); brand.appendChild(el('span', 'o', '/O')); r.appendChild(brand)
    r.appendChild(el('div', 'fr-title', 'Welcome to Agent Omega'))
    r.appendChild(el('div', 'fr-sub', "Let's get you running. Add one API key to begin — or point Omega at a local model server. You can change everything later."))
    const provWrap = el('div', 'fr-providers'); provWrap.id = 'fr-providers'
    providers.forEach((p) => {
      const on = selected && selected.id === p.id
      const chip = el('button', 'fr-chip' + (on ? ' sel' : '')); chip.type = 'button'; chip.dataset.pid = p.id; chip.disabled = busy
      chip.appendChild(el('span', null, p.label))
      if (p.id === recommended) chip.appendChild(el('span', 'star', '★'))
      chip.onclick = () => { if (busy) return; selected = p; render(); const inp = r.querySelector(p.kind === 'url' ? '#fr-url' : '#fr-key'); if (inp) inp.focus() }
      provWrap.appendChild(chip)
    })
    r.appendChild(provWrap)
    if (selected) {
      const isUrl = selected.kind === 'url'
      const wrap = el('div', 'fr-inwrap')
      wrap.appendChild(el('span', 'fr-mark', isUrl ? '↳' : '›'))
      const inp = el('input'); inp.id = isUrl ? 'fr-url' : 'fr-key'; inp.type = isUrl ? 'text' : 'password'
      inp.placeholder = selected.placeholder || (isUrl ? 'http://127.0.0.1:8080/v1' : 'paste your key'); inp.autocomplete = 'off'; inp.spellcheck = false; inp.disabled = busy
      inp.setAttribute('aria-label', isUrl ? 'Local model server URL' : selected.label + ' API key')
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }
      wrap.appendChild(inp); r.appendChild(wrap)
      const hint = el('div', 'fr-sub', isUrl ? 'A llama.cpp / Ollama / LM Studio server — give it a large context window.' : 'Stored encrypted in your local vault, never shown again.')
      hint.style.cssText = 'font-size:13px;margin:0 0 12px 2px'; r.appendChild(hint)
    }
    r.appendChild(Object.assign(el('div', 'fr-status'), { id: 'fr-status' }))
    r.appendChild(Object.assign(el('div', 'fr-error'), { id: 'fr-error' }))
    const actions = el('div', 'fr-actions')
    const submitBtn = el('button', null, busy ? 'Working…' : 'Continue'); submitBtn.id = 'fr-submit'; submitBtn.type = 'button'; submitBtn.disabled = busy || !selected; submitBtn.onclick = submit
    const skip = el('button', null, "I'll set it up myself"); skip.id = 'fr-skip'; skip.type = 'button'; skip.disabled = busy; skip.onclick = () => { if (busy) return; ws({ type: 'onboardSkip' }) }
    actions.appendChild(submitBtn); actions.appendChild(skip); r.appendChild(actions)
  }

  function submit() {
    if (busy || !selected) return
    setError('')
    if (selected.kind === 'url') {
      const url = ((root.querySelector('#fr-url') || {}).value || '').trim()
      if (!/^https?:\/\//.test(url)) { setError('Enter a URL like http://127.0.0.1:8080/v1'); return }
      busy = true; render(); setStatus('Reaching the server…'); ws({ type: 'onboardLocal', baseUrl: url })
    } else {
      const key = (root.querySelector('#fr-key') || {}).value || ''
      if (!key.trim()) { setError('Paste your ' + selected.label + ' key first.'); return }
      busy = true; render(); setStatus('Validating…'); ws({ type: 'onboardKey', provider: selected.id, value: key })
    }
  }

  function show(list, rec) {
    const banner = document.getElementById('engineDown')
    if (banner && !banner.classList.contains('hidden')) return   // the engine-down banner is up — its "Restart engine" button must stay reachable; a later first-run frame re-shows the card
    providers = list || []; recommended = rec || (providers[0] && providers[0].id)
    if (!selected) selected = providers.find((p) => p.id === recommended) || providers[0] || null
    if (shown) { if (busy) { busy = false; render() } if (backdrop) backdrop.style.display = 'flex'; return }   // already up — reconcile a stuck "Working…" from a mid-flow WS drop, else don't wipe a half-typed input
    shown = true; busy = false; ensureRoot(); render(); backdrop.style.display = 'flex'
    const inp = root.querySelector('#fr-key,#fr-url'); if (inp) setTimeout(() => { try { inp.focus() } catch (_) {} }, 40)   // move focus into the card for keyboard users
  }
  function hide() { shown = false; if (backdrop) backdrop.style.display = 'none' }

  const STAGE = { validating: 'Validating your key…', saving: 'Saving securely…', reloading: 'Loading your model…', handoff: 'Starting your setup assistant…' }
  window.AgentOmegaOnboard = {
    onWs(m) {
      if (!m || !m.type) return false
      if (m.type === 'first-run') { if (m.needed) show(m.providers, m.recommended); else hide(); return true }
      if (m.type === 'onboard-status') { setStatus(STAGE[m.stage] || m.stage || ''); return true }
      if (m.type === 'onboard-result') {
        if (m.ok) { setStatus('Done — handing you to your setup assistant.') }
        else { busy = false; render(); setError(m.error || 'Something went wrong. Please try again.') }
        return true
      }
      if (m.type === 'engine-down') { hide(); return false }
      return false
    },
    _state: () => ({ shown, busy, selected: selected && selected.id }),
  }
  // Esc dismisses the card for THIS session only (no permanent skip marker) — a keyboard escape from the
  // gate; it re-appears next launch since nothing was stored. Capture phase so it beats the app's handlers.
  document.addEventListener('keydown', (e) => { if (shown && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide() } }, true)
  // Make the card a real keyboard-modal. __ftpModalOpen is a getter-ONLY accessor (app.html / crt-settings),
  // so a plain assignment is a silent no-op in sloppy-mode script — the app's focus/keydown pipeline would
  // stay live under the card (backdrop click steals focus to the hidden input; Enter fires a real turn).
  // Compose the getter instead (mirrors crt-settings.js) so it ORs in our `shown` flag.
  try {
    const d = Object.getOwnPropertyDescriptor(window, '__ftpModalOpen'), orig = d && d.get
    Object.defineProperty(window, '__ftpModalOpen', { configurable: true, get() { return shown ? true : (orig ? orig.call(window) : false) } })
  } catch (_) {}
})()
