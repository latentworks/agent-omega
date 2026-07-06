/* first-run.js — Omega first-run onboarding card. A non-model key-entry card that bootstraps a
   fresh install: pick a provider, paste a key (or point at a local server); the sidecar validates,
   stores, reloads the engine, then hands off to the setup agent. Consumes first-run / onboard-status
   / onboard-result over the control WS; sends onboardKey / onboardLocal / onboardSkip.
   Loaded as a plain module by app.html (window.wsSend must exist). Phase 2 = functional styling on
   the existing --ac var; Phase 3 skins it. Stable ids: fr-backdrop fr-card fr-providers fr-key
   fr-url fr-status fr-error fr-submit fr-skip. */
(function () {
  if (window.AgentOmegaOnboard) return
  function ws(o) { try { (window.wsSend || function () {})(o) } catch (_) {} }
  function el(tag, cls, txt) { const e = document.createElement(tag || 'div'); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e }
  const AC = 'var(--ac)'
  let providers = [], recommended = 'anthropic', selected = null, busy = false, shown = false, root = null, backdrop = null

  function ensureRoot() {
    if (root) return root
    backdrop = el('div'); backdrop.id = 'fr-backdrop'
    backdrop.style.cssText = 'position:fixed; inset:0; z-index:30; display:none; align-items:center; justify-content:center; background:rgba(4,7,9,.82); font-family:inherit;'
    root = el('div'); root.id = 'fr-card'
    root.style.cssText = 'width:min(560px,92vw); background:#0b1013; border:1px solid ' + AC + '; box-shadow:0 0 40px rgba(255,180,84,.16); padding:26px 28px; color:#cfe;'
    backdrop.appendChild(root)
    document.body.appendChild(backdrop)
    return root
  }
  function setStatus(t) { const s = root && root.querySelector('#fr-status'); if (s) s.textContent = t || '' }
  function setError(t) { const e = root && root.querySelector('#fr-error'); if (e) e.textContent = t || '' }

  function render() {
    const r = ensureRoot(); r.innerHTML = ''
    const title = el('div', null, 'Welcome to Agent Omega'); title.style.cssText = 'font-size:22px; color:' + AC + '; letter-spacing:1px; margin-bottom:6px;'
    const sub = el('div', null, 'Add one API key to begin — or point Omega at a local model server. You can change everything later.'); sub.style.cssText = 'font-size:14px; color:#8aa; margin-bottom:18px; line-height:1.45;'
    r.appendChild(title); r.appendChild(sub)

    const provWrap = el('div'); provWrap.id = 'fr-providers'; provWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px;'
    providers.forEach((p) => {
      const on = selected && selected.id === p.id
      const chip = el('button', null, p.label + (p.id === recommended ? '  ★' : '')); chip.type = 'button'; chip.dataset.pid = p.id
      chip.style.cssText = 'font-family:inherit; font-size:14px; cursor:pointer; padding:7px 12px; background:' + (on ? 'rgba(255,180,84,.16)' : 'transparent') + '; color:' + (on ? AC : '#bcd') + '; border:1px solid ' + (on ? AC : '#2a3a33') + ';'
      chip.disabled = busy
      chip.onclick = () => { if (busy) return; selected = p; render(); const inp = r.querySelector(p.kind === 'url' ? '#fr-url' : '#fr-key'); if (inp) inp.focus() }
      provWrap.appendChild(chip)
    })
    r.appendChild(provWrap)

    if (selected) {
      const isUrl = selected.kind === 'url'
      const inp = el('input'); inp.id = isUrl ? 'fr-url' : 'fr-key'; inp.type = isUrl ? 'text' : 'password'
      inp.placeholder = selected.placeholder || (isUrl ? 'http://127.0.0.1:8080/v1' : 'paste your key')
      inp.autocomplete = 'off'; inp.spellcheck = false; inp.disabled = busy
      inp.style.cssText = 'width:100%; box-sizing:border-box; font-family:inherit; font-size:15px; padding:10px 12px; background:#060a0c; color:#dff; border:1px solid #2a3a33; margin-bottom:14px;'
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }
      r.appendChild(inp)
    }

    const status = el('div', null, ''); status.id = 'fr-status'; status.style.cssText = 'font-size:13px; color:' + AC + '; min-height:18px;'
    const error = el('div', null, ''); error.id = 'fr-error'; error.style.cssText = 'font-size:13px; color:#ff6b6b; min-height:18px; margin-bottom:10px;'
    r.appendChild(status); r.appendChild(error)

    const rowb = el('div'); rowb.style.cssText = 'display:flex; align-items:center; gap:14px;'
    const submitBtn = el('button', null, busy ? 'Working…' : 'Continue'); submitBtn.id = 'fr-submit'; submitBtn.type = 'button'
    submitBtn.style.cssText = 'font-family:inherit; font-size:15px; cursor:pointer; padding:9px 22px; background:rgba(255,180,84,.12); color:' + AC + '; border:1px solid ' + AC + ';'
    submitBtn.disabled = busy || !selected; submitBtn.onclick = submit
    const skip = el('button', null, "I'll set it up myself"); skip.id = 'fr-skip'; skip.type = 'button'
    skip.style.cssText = 'font-family:inherit; font-size:13px; cursor:pointer; padding:9px 4px; background:transparent; color:#7c8b82; border:none; text-decoration:underline;'
    skip.disabled = busy; skip.onclick = () => { if (busy) return; ws({ type: 'onboardSkip' }) }
    rowb.appendChild(submitBtn); rowb.appendChild(skip)
    r.appendChild(rowb)
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
    providers = list || []; recommended = rec || (providers[0] && providers[0].id)
    if (!selected) selected = providers.find((p) => p.id === recommended) || providers[0] || null
    if (shown) { if (busy) { busy = false; render() } if (backdrop) backdrop.style.display = 'flex'; return }   // already up — reconcile a stuck "Working…" from a mid-flow WS drop + reconnect, else don't wipe a half-typed input
    shown = true; busy = false; window.__ftpModalOpen = true; ensureRoot(); render(); backdrop.style.display = 'flex'
  }
  function hide() { shown = false; window.__ftpModalOpen = false; if (backdrop) backdrop.style.display = 'none' }

  const STAGE = { validating: 'Validating your key…', saving: 'Saving securely…', reloading: 'Loading your model…', handoff: 'Starting your setup assistant…' }
  window.AgentOmegaOnboard = {
    onWs(m) {
      if (!m || !m.type) return false
      if (m.type === 'first-run') { if (m.needed) show(m.providers, m.recommended); else hide(); return true }
      if (m.type === 'onboard-status') { setStatus(STAGE[m.stage] || m.stage || ''); return true }
      if (m.type === 'onboard-result') {
        if (m.ok) { setStatus('Done — handing you to your setup assistant.') }   // the card closes on the following first-run needed:false
        else { busy = false; render(); setError(m.error || 'Something went wrong. Please try again.') }
        return true
      }
      if (m.type === 'engine-down') { hide(); return false }   // let the engine-down banner also handle it
      return false
    },
    _state: () => ({ shown, busy, selected: selected && selected.id }),   // test hook
  }
})()
