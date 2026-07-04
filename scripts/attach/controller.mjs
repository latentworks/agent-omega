// scripts/attach/controller.mjs
// Wires discovery + transport + protocol + ui/painter + input into a live client.
// Rich mode (TTY) drives the Claude-Code painter; plain mode (non-TTY/dumb/ATTACH_PLAIN) uses ui-plain.
import { liveInstances } from './discovery.mjs'
import { createTransport, fetchHistory } from './transport.mjs'
import { normalize, textOfParts, roleOf } from './protocol.mjs'
import { createPlainUI } from './ui-plain.mjs'
import { createInput } from './input.mjs'
import * as U from './ui.mjs'

const HISTORY_N = Number(process.env.ATTACH_HISTORY || 20)
const HELP = [
  'client commands:',
  '  /model            list/switch model (/model <n|name>)',
  '  /commands         list the agent slash commands',
  '  /abort            stop the current turn (or Esc)',
  '  /new              start a fresh session',
  '  /quit  /q         detach (desktop keeps running)',
  'any other /command is sent to the agent (/verify, /tdd, …); plain text is a prompt.',
]

export async function run() {
  const ARG = process.argv[2] || process.env.AGENT_OMEGA_ATTACH || ''
  const forceRich = ['1', 'true'].includes(process.env.ATTACH_FORCE_RICH || '')   // test hook: rich path without a real TTY
  const rich = forceRich || (!!process.stdout.isTTY && process.env.TERM !== 'dumb' && !['1', 'true'].includes(process.env.ATTACH_PLAIN || ''))
  const live = await liveInstances(ARG)
  if (!live.length) { process.stderr.write('\x1b[31mNo running Agent Omega instance found.\x1b[0m\n(start the desktop app first, then re-run.)\n'); process.exit(1) }
  const d = live.length === 1 ? live[0] : await pickInstance(live)
  return rich ? runRich(d) : runPlain(d)
}

async function pickInstance(live) {
  process.stdout.write('Multiple Agent Omega instances are running:\n')
  live.forEach((x, i) => process.stdout.write(`   ${i + 1}. pid ${x.pid}  port ${x.port}  ${x.cwd || ''}\n`))
  process.stdout.write('choose 1-' + live.length + ': ')
  const ans = await new Promise((res) => { process.stdin.setEncoding('utf8'); process.stdin.once('data', (s) => res(s)) })
  const n = parseInt(ans, 10)
  return (n >= 1 && n <= live.length) ? live[n - 1] : live[0]
}

// --------------------------------------------------------------------- rich mode
function runRich(d) {
  const cols = () => process.stdout.columns || 80
  const rows = () => process.stdout.rows || 24
  const painter = U.createPainter({ write: (s) => process.stdout.write(s), cols, rows })
  const now = () => Date.now()
  const st = {
    sessionId: null, model: '', apiPort: d.apiPort, apiAuth: '', commands: [], models: [],
    busy: false, conn: 'connecting', streamBuf: '', streaming: false, hasBullet: false,
    menu: null, pendingPerm: null, spin: 0, turnStart: 0, historyDone: false, exit: false, busyFlash: false,
  }
  let paintQueued = false, spinTimer = null
  const commit = (r) => painter.commit(r)
  const elapsed = () => (st.turnStart ? Math.round((now() - st.turnStart) / 1000) : 0)
  function schedule() { if (paintQueued) return; paintQueued = true; setTimeout(() => { paintQueued = false; paint() }, 16) }

  // ---- streaming commit ----
  function commitAssistant(text) { if (!text) return; commit(st.hasBullet ? U.continuationBlock(text, cols()) : U.assistantBlock(text, cols())); st.hasBullet = true }
  function drainStream() { const nl = st.streamBuf.lastIndexOf('\n'); if (nl < 0) return; commitAssistant(st.streamBuf.slice(0, nl)); st.streamBuf = st.streamBuf.slice(nl + 1) }
  function flushStream() { if (st.streamBuf) commitAssistant(st.streamBuf); st.streamBuf = ''; st.streaming = false; st.hasBullet = false }

  // ---- live region (cursor offset applied in exactly one place — steer #2) ----
  function footer() {
    let right
    if (st.conn === 'reconnecting') right = U.metaLine('◌ reconnecting…', cols())
    else if (st.conn === 'down') right = U.errorLine('engine down', cols())
    else right = U.liveTag(st.model)
    let left
    if (st.menu) left = st.menu.hint || ''
    else if (st.busyFlash) left = 'a turn is in progress — esc aborts'
    else if (st.exit) left = 'press ctrl+c again to detach'
    else if (st.busy) left = 'turn in progress'
    else left = '/ for commands · \\↵ newline'
    return U.footerLine(left, right, cols())
  }
  function buildLive() {
    const w = cols()
    if (st.menu) return { lines: [...U.selectMenu(st.menu, w), footer()], cursor: null, menu: true }
    const lines = []
    if (st.streaming && st.streamBuf) { const tail = st.hasBullet ? U.continuationBlock(st.streamBuf, w) : U.assistantBlock(st.streamBuf, w); for (const r of tail) lines.push(r) }
    if (st.busy) lines.push(U.spinnerLine(st.spin, U.spinnerVerbFor(elapsed()), elapsed(), w))
    lines.push('')
    const ib = U.inputBox(input.buffer().buf, input.buffer().cursor, w)
    const boxStart = lines.length
    for (const r of ib.rows) lines.push(r)
    lines.push(footer())
    return { lines, cursor: { row: boxStart + ib.cursorRow, col: ib.cursorCol }, menu: false }
  }
  function paint() { drainStream(); if (st.menu) st.menu.selected = input.menuIndex(); const lr = buildLive(); painter.paint(lr.lines, lr.cursor, lr.menu) }

  // ---- input actions ----
  const input = createInput({
    isBusy: () => st.busy,
    onRepaint: schedule,
    onPrompt: (t) => (t.startsWith('/') ? slash(t) : sendPrompt(t)),
    onBusyEnter: () => flashBusy(),
    onAbort: () => { transport.abort(); commit([U.metaLine('· abort sent ·', cols())]); schedule() },
    onExit: () => shutdown(0),
    onExitArm: () => { st.exit = true; schedule() },
    onExitDisarm: () => { st.exit = false; schedule() },
    onRedraw: () => { process.stdout.write('\x1b[2J\x1b[H'); painter.reset(); paint() },
    onMenuPick: menuPick,
    onMenuCancel: menuCancel,
    onSlash: () => {},
  })
  function flashBusy() { st.busyFlash = true; schedule(); setTimeout(() => { st.busyFlash = false; schedule() }, 3000) }
  function sendPrompt(t) {
    const ok = transport.prompt(t)
    commit(U.userBlock(t, cols())); commit([''])
    if (!ok) commit([U.metaLine('(not sent — reconnecting; resend when live)', cols())])
    schedule()
  }
  function slash(t) {
    const [head, ...rest] = t.slice(1).split(/\s+/); const name = head.toLowerCase(); const args = rest.join(' ')
    if (name === 'quit' || name === 'q') return shutdown(0)
    if (name === 'help' || name === 'h') { for (const l of HELP) commit([U.metaLine(l, cols())]); return schedule() }
    if (name === 'abort') { transport.abort(); commit([U.metaLine('· abort sent ·', cols())]); return schedule() }
    if (name === 'new') { transport.newSession(); commit([U.metaLine('· new session ·', cols())]); return schedule() }
    if (name === 'commands' || name === 'cmds') { listCommands(); return schedule() }
    if (name === 'model' || name === 'models') return args ? switchModel(args) : openModelMenu()
    const ok = transport.command(head, args)
    commit(U.userBlock('/' + head + (args ? ' ' + args : ''), cols())); commit([''])
    if (!ok) commit([U.metaLine('(not sent — reconnecting)', cols())])
    schedule()
  }
  function listCommands() {
    if (!st.commands.length) return commit([U.metaLine('(no slash commands reported)', cols())])
    commit([U.metaLine('agent slash commands:', cols())])
    for (const c of st.commands) { const n = String((c && (c.name || c.command)) || '').replace(/^\//, ''); if (n) commit([U.metaLine('  /' + n + (c.description ? '  — ' + c.description : ''), cols())]) }
  }
  function switchModel(arg) {
    const a = arg.trim().toLowerCase(); let t = null; const n = parseInt(arg, 10)
    if (String(n) === arg.trim() && n >= 1 && n <= st.models.length) t = st.models[n - 1]
    if (!t) t = st.models.find((m) => (m.value || '').toLowerCase() === a || (m.name || '').toLowerCase() === a)
    if (!t) { const hits = st.models.filter((m) => (m.value || '').toLowerCase().includes(a) || (m.name || '').toLowerCase().includes(a)); if (hits.length === 1) t = hits[0]; else { commit([U.metaLine(hits.length ? `"${arg}" matches ${hits.length} — /model for the list` : `no model matches "${arg}"`, cols())]); return schedule() } }
    transport.setModel(t.value); commit([U.metaLine('switching → ' + (t.name || t.value), cols())]); schedule()
  }
  function openModelMenu() {
    if (!st.models.length) { commit([U.metaLine('(no models reported)', cols())]); return schedule() }
    st.menu = { kind: 'model', title: 'Select model', question: 'Switch the model for this session', options: st.models.map((m) => (m.name || m.value) + (m.value === st.model ? '  (current)' : '')), selected: Math.max(0, st.models.findIndex((m) => m.value === st.model)), hint: '↑/↓ + enter · number · esc cancels' }
    input.setMenu(st.models.length); schedule()
  }
  function openPermission(ev) { st.pendingPerm = ev; st.menu = { kind: 'perm', title: 'Permission required', question: ev.title, options: ev.options.map((o) => o.name), selected: 0, hint: '↑/↓ + enter · number · esc denies' }; input.setMenu(ev.options.length); schedule() }
  function menuPick(i) {
    const m = st.menu; if (!m) return
    if (m.kind === 'perm') { const opt = st.pendingPerm.options[i]; transport.permissionReply(st.pendingPerm.toolCallId, opt.optionId); const name = opt.name; closeMenu(); commit([U.metaLine('  ' + U.glyph.elbow + '  ' + name, cols())]) }
    else if (m.kind === 'model') { const t = st.models[i]; transport.setModel(t.value); closeMenu(); commit([U.metaLine('model → ' + (t.name || t.value), cols())]) }
    schedule()
  }
  function menuCancel() {
    const m = st.menu; if (!m) return
    if (m.kind === 'perm') { const opts = st.pendingPerm.options; const deny = opts.find((o) => /den|reject|no/i.test(o.name)) || opts[opts.length - 1]; transport.permissionReply(st.pendingPerm.toolCallId, deny.optionId); commit([U.metaLine('  ' + U.glyph.elbow + '  ' + deny.name, cols())]) }
    closeMenu(); schedule()
  }
  function closeMenu() { st.menu = null; st.pendingPerm = null; input.setCompose() }

  // ---- frames ----
  const transport = createTransport(d, {
    onOpen: () => { st.conn = 'live'; schedule() },
    onClose: () => { st.conn = 'reconnecting'; st.busy = false; stopSpin(); if (st.menu) closeMenu(); schedule() },  // clear pending perm — steer #6/risk7
    onError: () => {},
    onFrame: (m) => onEvent(normalize(m)),
  })
  function onEvent(ev) {
    if (!ev) return
    switch (ev.kind) {
      case 'ready': {
        const same = st.sessionId && st.sessionId === ev.sessionId
        st.sessionId = ev.sessionId; st.model = ev.model || st.model; st.apiPort = ev.apiPort || st.apiPort
        if (ev.apiAuth) st.apiAuth = ev.apiAuth              // BEFORE replay (RCE auth) — steer #6
        if (ev.commands) st.commands = ev.commands
        if (ev.models) st.models = ev.models
        st.conn = 'live'
        if (!st.historyDone) { commit(U.headerBox(st.sessionId, st.model, cols())); commit(['']); replay() }
        else if (!same) { commit([U.ruleLine('new session', cols()), '']); st.historyDone = false; if (st.menu) closeMenu(); replay() }
        else commit([U.ruleLine('reconnected', cols())])
        schedule(); break
      }
      case 'commands': st.commands = ev.commands; break
      case 'text': st.streaming = true; st.streamBuf += ev.text; schedule(); break
      case 'tool': flushStream(); commit(['']); commit(U.toolBlock(ev.title, cols())); commit(['']); schedule(); break
      case 'thinking': flushStream(); commit(U.thinkingBlock(ev.text, cols())); schedule(); break
      case 'permission': flushStream(); openPermission(ev); break
      case 'turn-start': st.busy = true; st.turnStart = now(); startSpin(); schedule(); break
      case 'turn-end': st.busy = false; stopSpin(); flushStream(); commit(['']); schedule(); break
      case 'error': st.busy = false; stopSpin(); flushStream(); commit(U.errorBlock(ev.message, cols())); schedule(); break
      case 'engine-down': st.conn = 'down'; commit(U.errorBlock('engine down: ' + ev.message, cols())); schedule(); break
      case 'model': st.model = ev.model; commit([U.metaLine('model → ' + ev.model, cols())]); schedule(); break
      case 'agent': commit([U.metaLine('agent → ' + ev.agent, cols())]); schedule(); break
      case 'effort': commit([U.metaLine('effort → ' + ev.effort, cols())]); schedule(); break
      case 'replay-start': commit([U.metaLine('(reloading session…)', cols())]); schedule(); break
      case 'raw': commit([U.metaLine('RAW ' + ev.text, cols())]); schedule(); break
    }
  }
  async function replay() {
    st.historyDone = true
    try {
      const msgs = await fetchHistory(st.apiPort, st.sessionId, st.apiAuth, HISTORY_N)
      if (!msgs.length) commit([U.ruleLine('no earlier messages', cols())])
      else { commit([U.ruleLine(`last ${msgs.length} messages`, cols()), '']); for (const m of msgs) { const b = textOfParts(m.parts).trim(); if (!b) continue; commit(roleOf(m) === 'user' ? U.userBlock(b, cols()) : U.assistantBlock(b, cols())); commit(['']) } }
      commit([U.ruleLine('live', cols()), ''])
    } catch (e) { commit([U.metaLine('(history unavailable: ' + e.message + ')', cols())]) }
    schedule()
  }

  function startSpin() { stopSpin(); spinTimer = setInterval(() => { st.spin++; schedule() }, 120) }
  function stopSpin() { if (spinTimer) clearInterval(spinTimer); spinTimer = null }
  function shutdown(code) { stopSpin(); try { input.stop() } catch {} try { transport.close() } catch {} process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[0m\n'); process.exit(code) }
  process.on('exit', () => { try { process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[0m') } catch {} })
  process.on('SIGTERM', () => shutdown(0))
  process.on('uncaughtException', (e) => { try { process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[0m\n' + String((e && e.stack) || e) + '\n') } catch {}; process.exit(1) })
  if (process.stdout.on) process.stdout.on('resize', () => paint())   // best-effort erase w/ stale count (steer #3); Ctrl+L = hard resync

  input.start(); transport.connect(); paint()
}

// --------------------------------------------------------------------- plain mode (degraded, D19)
function runPlain(d) {
  const ui = createPlainUI({ write: (s) => process.stdout.write(s) })
  const st = { sessionId: null, model: '', apiPort: d.apiPort, apiAuth: '', historyDone: false, pendingPerm: null }
  const transport = createTransport(d, {
    onOpen: () => {}, onError: () => {}, onClose: () => ui.metaReconnect(),
    onFrame: (m) => {
      const ev = normalize(m); if (!ev) return
      switch (ev.kind) {
        case 'ready': st.sessionId = ev.sessionId; st.model = ev.model || st.model; st.apiPort = ev.apiPort || st.apiPort; if (ev.apiAuth) st.apiAuth = ev.apiAuth
          if (!st.historyDone) { st.historyDone = true; ui.header(st.sessionId, st.model); replayPlain() } break
        case 'text': ui.assistant(ev.text); break
        case 'tool': ui.tool(ev.title); break
        case 'thinking': ui.thinking(ev.text); break
        case 'permission': st.pendingPerm = ev; ui.permission(ev.title, ev.options); break
        case 'turn-end': ui.turnEnd(); break
        case 'error': ui.error(ev.message); break
        case 'engine-down': ui.engineDown(ev.message); break
        case 'model': st.model = ev.model; ui.meta('model → ' + ev.model); break
        case 'agent': ui.meta('agent → ' + ev.agent); break
        case 'effort': ui.meta('effort → ' + ev.effort); break
      }
    },
  })
  async function replayPlain() {
    try { const msgs = await fetchHistory(st.apiPort, st.sessionId, st.apiAuth, HISTORY_N); ui.rule(`last ${msgs.length} messages`); for (const m of msgs) { const b = textOfParts(m.parts).trim(); if (b) (roleOf(m) === 'user' ? ui.user(b) : (ui.assistant(b), ui.line())) } ui.rule('live') } catch { ui.meta('(history unavailable)') }
  }
  import('node:readline').then(({ default: readline }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' })
    rl.on('line', (raw) => {
      const t = raw.trim(); if (!t) return
      if (st.pendingPerm) { const opts = st.pendingPerm.options; let opt; if (/^\/deny$/i.test(t)) opt = opts.find((o) => /den|reject|no/i.test(o.name)) || opts[opts.length - 1]; else { const n = parseInt(t, 10); if (n >= 1 && n <= opts.length) opt = opts[n - 1] } if (!opt) { ui.out('choose 1-' + opts.length + ' (or /deny): '); return } transport.permissionReply(st.pendingPerm.toolCallId, opt.optionId); ui.permissionAnswered(opt.name); st.pendingPerm = null; return }
      if (t === '/quit' || t === '/q') process.exit(0)
      if (t.startsWith('/')) { const [h, ...r] = t.slice(1).split(/\s+/); transport.command(h, r.join(' ')); ui.user('/' + h); return }
      transport.prompt(t); ui.user(t)
    })
  })
  transport.connect()
}
