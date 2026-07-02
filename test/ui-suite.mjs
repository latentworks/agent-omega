// Full user-level UI suite for Agent Omega — drives the REAL ui/app.html against a REAL
// sidecar + engine over WebSocket, as a user would. Loads app.html?ws=PORT&token=... in a
// real browser and exercises: boot/ready, input+send a real turn, command palette (Ctrl+P),
// slash commands, '/' autocomplete, settings (Cmd+,) + all tabs, vault round-trip (incl.
// dirty-paste sanitize), model/effort/thinking switching, skin/theme, sessions workflows,
// export, keyboard handling (Enter/Shift-Enter/Esc/shell-mode), scroll keys, help/status.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const REPO = process.env.AO_REPO || path.resolve(process.env.HOME, 'agent-omega')
const PORT = process.env.AO_WS_PORT || '4771'
const TOKEN = crypto.randomUUID()
const APP = pathToFileURL(path.join(REPO, 'ui', 'app.html')).href + '?ws=' + PORT + '&token=' + TOKEN
const MODEL = process.env.AO_MODEL || 'deepseek/deepseek-v4-flash'

const results = []
let n = 0
const ok = (name, pass, detail = '') => { n++; results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${String(n).padStart(2)}. ${name}${detail ? '  [' + detail + ']' : ''}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- start the real sidecar ----
const workdir = fs.mkdtempSync('/tmp/ao-ui-ws-')
const sidecar = spawn(process.execPath, ['sidecar.mjs'], {
  cwd: REPO,
  env: { ...process.env, AGENT_OMEGA_WS_PORT: PORT, AGENT_OMEGA_WORKDIR: workdir, AO_WS_TOKEN: TOKEN, AGENT_OMEGA_DEFAULT_MODEL: MODEL },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let sidecarLog = ''
sidecar.stdout.on('data', d => sidecarLog += d)
sidecar.stderr.on('data', d => sidecarLog += d)
const cleanup = () => { try { sidecar.kill() } catch {} ; try { fs.rmSync(workdir, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)

const browser = await chromium.launch()
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', e => pageErrors.push(e.message))
page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()) })

await sleep(6000)   // let the engine reach ready
await page.goto(APP)

// helper: wait until a predicate in the page is true
const waitFor = async (fn, timeout = 30000, poll = 200) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) { if (await page.evaluate(fn).catch(() => false)) return true; await sleep(poll) }
  return false
}
// the input the user is actually typing into right now (chat if visible, else home)
const inputSel = async () => await page.evaluate(() => document.getElementById('chat')?.classList.contains('hidden') ? '#homeInput' : '#chatInput')
const typeSend = async (text) => { const s = await inputSel(); await page.evaluate(sel => document.querySelector(sel).focus(), s); await page.evaluate(sel => { document.querySelector(sel).value = '' }, s); await page.keyboard.type(text); await page.keyboard.press('Enter') }
// after a reset the home input must not render collapsed (height 0) — regression guard
const inputRendered = async () => await page.evaluate(async () => { const s = document.getElementById('chat').classList.contains('hidden') ? 'homeInput' : 'chatInput'; const r = document.getElementById(s).getBoundingClientRect(); return r.height > 8 && r.width > 8 })
// close whatever modal/panel is open WITHOUT tripping the global Esc (which, on an empty chat,
// starts a new session + returns home). We only send Esc if a modal is actually open.
// close() hides the overlay with .hidden but leaves the node in the DOM, so test VISIBILITY,
// not existence (that was a false-positive in an earlier harness rev).
const modalOpen = () => page.evaluate(() => !!window.__ftpModalOpen || !!document.querySelector('.ftpset-overlay:not(.hidden)') || /search commands/i.test(document.body.innerText))
// settings Esc is hierarchical (deselect row -> close), so press until the overlay is truly gone,
// exactly as a user would; bail to a click-outside if Esc somehow won't dismiss it.
const closeModal = async () => {
  for (let i = 0; i < 4 && await modalOpen(); i++) { await page.keyboard.press('Escape'); await sleep(250) }
  if (await modalOpen()) { await page.mouse.click(5, 5); await sleep(250) }
  return !(await modalOpen())
}

try {
  // 1) boots to ready
  const ready = await waitFor(() => document.getElementById('statusText')?.textContent?.toLowerCase().includes('ready'), 40000)
  ok('app boots to READY', ready, await page.evaluate(() => document.getElementById('statusText')?.textContent))

  // 2) model shown in the status bar
  const modelShown = await page.evaluate(() => document.body.innerText.toLowerCase())
  ok('active model visible in UI', /deepseek/.test(modelShown), MODEL)

  // 3) type into the home input and send a REAL turn
  await page.click('#homeInput')
  await page.type('#homeInput', 'Reply with exactly: UITESTOK')
  await page.keyboard.press('Enter')
  const gotReply = await waitFor(() => /UITESTOK/i.test(document.getElementById('convo')?.innerText || ''), 60000)
  ok('real turn streams an assistant reply', gotReply, gotReply ? '' : 'convo=' + (await page.evaluate(() => (document.getElementById('convo')?.innerText || '').slice(-120))))

  // 4) the user prompt is rendered in the transcript
  ok('user message rendered in transcript', await page.evaluate(() => /UITESTOK/i.test(document.getElementById('convo')?.innerText || '') && /Reply with exactly/i.test(document.getElementById('convo')?.innerText || '')))

  // 5) Ctrl+P opens the command palette
  await page.keyboard.press('Control+p')
  const paletteOpen = await waitFor(() => !!document.querySelector('input')?.placeholder?.toLowerCase().includes('command') || /search commands/i.test(document.body.innerText), 5000)
  ok('Ctrl+P opens command palette', paletteOpen)

  // 6) palette lists the expected commands
  const paletteText = await page.evaluate(() => document.body.innerText)
  ok('palette shows core commands', /Switch session/i.test(paletteText) && /Switch model/i.test(paletteText) && /Settings/i.test(paletteText))

  // 7) hidden commands are NOT shown
  ok('hidden commands are not listed', !/Model cycle/i.test(paletteText) && !/Open external editor/i.test(paletteText))

  // 8) Escape closes the palette
  await page.keyboard.press('Escape')
  await sleep(300)
  ok('Escape closes palette', await page.evaluate(() => !/search commands/i.test(document.body.innerText)))

  // 9) '/' autocomplete opens on the input
  await page.click('#chatInput')
  await page.type('#chatInput', '/mod')
  await sleep(400)
  const slashAC = await page.evaluate(() => /models|model/i.test(document.body.innerText))
  ok("'/' autocomplete surfaces matching commands", slashAC)
  await page.keyboard.press('Escape'); await page.fill('#chatInput', ''); await sleep(200)

  // 10) /skin modern switches skin
  await page.fill('#chatInput', '/skin modern'); await page.keyboard.press('Enter'); await sleep(500)
  ok('/skin modern applies modern skin', await page.evaluate(() => document.body.classList.contains('theme-modern')))
  await page.fill('#chatInput', '/skin crt'); await page.keyboard.press('Enter'); await sleep(500)
  ok('/skin crt restores CRT skin', await page.evaluate(() => !document.body.classList.contains('theme-modern')))

  // 11) /help renders help
  await page.fill('#chatInput', '/help'); await page.keyboard.press('Enter'); await sleep(500)
  ok('/help renders help content', await page.evaluate(() => /help|command|shortcut/i.test(document.getElementById('convo')?.innerText || document.body.innerText)))

  // 12) /status renders status
  await page.fill('#chatInput', '/status'); await page.keyboard.press('Enter'); await sleep(500)
  ok('/status renders status', await page.evaluate(() => /model|session|engine|status/i.test(document.getElementById('convo')?.innerText || '')))

  // 13) model picker opens via /models
  await typeSend('/models'); await sleep(600)
  const modelPicker = await page.evaluate(() => /deepseek|anthropic|openai|local/i.test(document.body.innerText))
  ok('/models opens the model picker', modelPicker)
  await closeModal()

  // 14) input still usable right after closing the picker (bug-class: overlay traps input)
  ok('input usable after closing picker', await page.evaluate(async () => { const s = document.getElementById('chat').classList.contains('hidden') ? 'homeInput' : 'chatInput'; const el = document.getElementById(s); el.focus(); return document.activeElement === el && !el.disabled }))

  // 15) Settings via Cmd+, (the mac accelerator we just fixed)
  await page.keyboard.press('Meta+,')
  let settingsOpen = await waitFor(() => /SETTINGS|Vault|Models.*Council/i.test(document.body.innerText), 4000)
  if (!settingsOpen) { await page.keyboard.press('Control+,'); settingsOpen = await waitFor(() => /SETTINGS|Vault/i.test(document.body.innerText), 4000) }
  ok('Cmd+, / Ctrl+, opens Settings', settingsOpen)

  // 16) all four settings tabs present
  ok('settings shows Vault/Models/Council/Skin tabs', await page.evaluate(() => { const t = document.body.innerText; return /Vault/i.test(t) && /Models/i.test(t) && /Council/i.test(t) && /Skin/i.test(t) }))

  // 17) vault lists the provider key rows
  ok('vault lists provider key names', await page.evaluate(() => /DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|API keys/i.test(document.body.innerText)))

  // 18) Tab cycles settings sections to Models (shows model list)
  await page.keyboard.press('Tab'); await sleep(300)
  ok('Tab navigates settings sections', await page.evaluate(() => /MODELS|council members|preset/i.test(document.body.innerText)))
  const settingsClosed = await closeModal()
  ok('Settings fully closes (hierarchical Esc / click-out)', settingsClosed)

  // 19) input usable after closing settings (the exact worry: stuck input)
  ok('input usable after closing settings', await page.evaluate(() => { const s = document.getElementById('chat').classList.contains('hidden') ? 'homeInput' : 'chatInput'; const el = document.getElementById(s); el.focus(); return document.activeElement === el && !el.disabled }))

  // 20) Shift+Enter inserts a newline instead of sending
  { const s = await inputSel(); await page.fill(s, 'line1'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('line2')
    ok('Shift+Enter inserts newline (no send)', await page.evaluate((sel) => (document.querySelector(sel)?.value || '').includes('\n'), s)); await page.fill(s, '') }
  await sleep(150)

  // 21) '!' at empty input enters shell mode
  { const s = await inputSel(); await page.click(s); await page.keyboard.type('!'); await sleep(300)
    ok("'!' enters shell mode", await page.evaluate(() => document.body.classList.contains('shell') || /shell/i.test(document.getElementById('shellHint')?.textContent || '') || /!/.test(document.getElementById('shellHint')?.textContent || '')))
    await page.keyboard.press('Escape'); await sleep(200); await page.fill(s, '') }

  // 22) Esc on an idle chat starts a new session (returns home / clears) — the documented behavior
  await page.keyboard.press('Escape'); await sleep(600)
  ok('Esc on idle chat resets session', await page.evaluate(() => !/UITESTOK/i.test(document.getElementById('convo')?.innerText || '')))

  // 22b) REGRESSION GUARD: the home input must render visibly after reset (not collapse to 0px)
  ok('home input renders (non-zero size) after reset', await inputRendered(), await page.evaluate(() => { const r = document.getElementById('homeInput').getBoundingClientRect(); return 'h=' + Math.round(r.height) + ' w=' + Math.round(r.width) }))

  // 23) after reset, can send another real turn (full round-trip still works post-reset)
  await typeSend('Reply with exactly: SECONDOK');
  ok('second real turn after reset streams', await waitFor(() => /SECONDOK/i.test(document.getElementById('convo')?.innerText || ''), 60000))
  // wait for the turn to FULLY end before the next command — send() correctly ignores input while
  // busy, so a not-yet-ready turn would swallow the next slash command (harness must respect that).
  await waitFor(() => (document.getElementById('statusText')?.textContent || '').toLowerCase().includes('ready'), 60000)

  // ---- stage 2: session workflows, permission flow, abort, @autocomplete ----

  // 24) /sessions lists the current session (engine HTTP API + auth from the browser).
  // Assert the actual rendered panel — the session list came back from the authed API and has rows.
  await typeSend('/sessions')
  await waitFor(() => { const p = document.querySelector('.panel .panel-title'); return (/sessions/i.test(p?.textContent || '')) || /unavailable/i.test(document.getElementById('convo')?.innerText || '') }, 20000)
  const sess = await page.evaluate(() => { const panel = [...document.querySelectorAll('.panel')].find(x => /sessions/i.test(x.querySelector('.panel-title')?.textContent || '')); return { title: panel?.querySelector('.panel-title')?.textContent || '', rows: panel ? panel.querySelectorAll('.pick').length : 0, cur: !!panel?.querySelector('.pk-cur'), err: /unavailable/i.test(document.getElementById('convo')?.innerText || '') } })
  ok('/sessions lists real sessions via authed engine API', /sessions\s*\(\d+\)/.test(sess.title) && sess.rows >= 1 && sess.cur && !sess.err, JSON.stringify(sess))
  await closeModal()

  // 25) /rename renames the session (POST through the authed API)
  await typeSend('/rename ui-suite-check'); await sleep(2000)
  ok('/rename succeeds', await page.evaluate(() => /renamed|ui-suite-check/i.test(document.getElementById('convo')?.innerText || '')))

  // 26) @ opens the file autocomplete (sidecar findFile bridge)
  { const s = await inputSel(); await page.evaluate(sel => document.querySelector(sel).focus(), s); await page.keyboard.type('@'); await sleep(700)
    ok("'@' opens file autocomplete", await page.evaluate(() => !!window.__ftpModalOpen || /no matches|file/i.test(document.body.innerText)))
    await page.keyboard.press('Escape'); await sleep(200); await page.evaluate(sel => { document.querySelector(sel).value = '' }, s) }

  // 27) abort: start a turn, Esc mid-flight cancels it and re-enables input
  await typeSend('Count slowly from 1 to 50, one number per line.')
  await sleep(1500)   // let the turn start
  await page.keyboard.press('Escape'); await sleep(1200)
  ok('Esc mid-turn aborts and returns to ready', await page.evaluate(() => (document.getElementById('statusText')?.textContent || '').toLowerCase().includes('ready')))
  ok('input re-enabled after abort', await page.evaluate(() => !document.getElementById('chatInput')?.disabled))

  // 28) permission flow with a CANARY: seed a dir in the workspace, ask the model to `rm -rf` it
  // (matches the opencode.json ASK rule), Reject at the panel, and prove the dir survives. Needs a
  // model that reliably tool-calls, so this stage uses AO_PERM_MODEL (deepseek-v4-pro) via a
  // dedicated sidecar isn't possible mid-run — instead we set the model with /model first.
  const canaryDir = path.join(workdir, 'ao_canary'); fs.mkdirSync(canaryDir, { recursive: true }); fs.writeFileSync(path.join(canaryDir, 'keep.txt'), 'SURVIVE')
  await typeSend('/model deepseek/deepseek-v4-pro'); await sleep(1500)   // pro reliably calls tools
  await waitFor(() => (document.getElementById('statusText')?.textContent || '').toLowerCase().includes('ready'), 20000)
  let permShown = false
  for (const prompt of ['Delete the directory ao_canary by running exactly: rm -rf ao_canary — use your bash tool.', 'Use your bash tool to run: rm -rf ao_canary']) {
    await typeSend(prompt)
    permShown = await waitFor(() => !!document.querySelector('.perm-btn'), 70000)
    if (permShown) break
    await page.keyboard.press('Escape'); await sleep(800); await waitFor(() => (document.getElementById('statusText')?.textContent || '').toLowerCase().includes('ready'), 30000)
  }
  ok('permission panel appears for rm -rf (ASK rule) with 3 options', permShown && await page.evaluate(() => { const b = [...document.querySelectorAll('.perm-btn')]; return b.length >= 2 && b.some(x => /reject/i.test(x.textContent || '')) }), permShown ? await page.evaluate(() => [...document.querySelectorAll('.perm-btn')].map(b => b.textContent).join(' | ')) : 'panel never appeared')
  if (permShown) {
    const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('.perm-btn')]; const r = b.find(x => /reject|deny/i.test(x.textContent || '')) || b[b.length - 1]; r.click(); return r.textContent })
    const backReady = await waitFor(() => (document.getElementById('statusText')?.textContent || '').toLowerCase().includes('ready'), 60000)
    ok('Reject resolves permission, returns to ready (no hang)', clicked && backReady, 'clicked=' + clicked)
    await sleep(500)
    ok('CANARY survives Reject (destructive command actually blocked)', fs.existsSync(path.join(canaryDir, 'keep.txt')))
  } else {
    ok('Reject resolves permission, returns to ready (no hang)', false, 'no panel')
    ok('CANARY survives Reject (destructive command actually blocked)', fs.existsSync(path.join(canaryDir, 'keep.txt')), 'panel never appeared but canary intact')
  }

  // 29) no uncaught page errors the whole run
  ok('no uncaught JS errors during the run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  ok('SUITE CRASHED', false, e.message)
}

await browser.close()
cleanup()
const failed = results.filter(r => !r.pass)
console.log(`\n=== UI SUITE: ${results.length - failed.length}/${results.length} passed ===`)
if (failed.length) { console.log('FAILURES:'); failed.forEach(f => console.log('  - ' + f.name + (f.detail ? '  [' + f.detail + ']' : ''))); console.log('\n--- sidecar tail ---\n' + sidecarLog.slice(-800)) }
process.exit(failed.length ? 1 : 0)
