#!/usr/bin/env node
// Agent Omega — terminal ATTACH client.
//
// Run this over SSH (e.g. from Termius over Tailscale) to drive/watch the ALREADY-RUNNING
// desktop Agent Omega from a plain terminal. It joins the LIVE session the desktop window is
// showing (it never spins up a new one), replays the last N messages so the thread "pops up",
// then streams everything live — prompts, output, and interactive permission approvals — the
// same JSON the graphical UI uses, just rendered as text.
//
// It talks only to the loopback control socket, using the port+token the running sidecar wrote
// to ~/.agent-omega/instances/<pid>.json — so nothing is exposed to the network; SSH is what gets you
// onto the machine. Requires the desktop app to be running (that's where the session lives).
//
//   node scripts/attach.mjs            # attach, show last 20, go live
//   ATTACH_HISTORY=50 node scripts/attach.mjs
//   ATTACH_DEBUG=1 ...                 # dump raw frames (for troubleshooting)
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import net from 'node:net'

const HISTORY_N = Number(process.env.ATTACH_HISTORY || 20)
const DEBUG = ['1', 'true'].includes(process.env.ATTACH_DEBUG || '')
const ATTACH_DIR = process.env.AGENT_OMEGA_ATTACH_DIR || path.join(os.homedir(), '.agent-omega', 'instances')

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`

function pidAlive(pid) { if (!pid) return true; try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
// A quick loopback probe of a descriptor's control port: 'open' if something is listening, 'refused'
// if the port is definitively empty, 'timeout' if inconclusive. pidAlive alone is defeated by PID
// reuse (a dead sidecar's pid gets reused by firefox/edge/etc.), which resurrects the descriptor as
// a phantom instance — so we also verify the port actually accepts a connection at list time.
function probePort(port) {
  return new Promise((resolve) => {
    let done = false
    const sock = net.connect({ host: '127.0.0.1', port })
    const fin = (r) => { if (done) return; done = true; try { sock.destroy() } catch {}; resolve(r) }
    sock.on('connect', () => fin('open'))
    sock.on('error', (e) => fin(e && e.code === 'ECONNREFUSED' ? 'refused' : 'timeout'))
    sock.setTimeout(400, () => fin('timeout'))
  })
}
// Optional selector: `attach.mjs <arg>` where arg is a descriptor .json path, a port, or a
// substring of the instance's cwd — to go straight to one instance among several.
const ARG = process.argv[2] || process.env.AGENT_OMEGA_ATTACH || ''
function matchesArg(d) {
  if (!ARG) return true
  if (String(d.port) === ARG) return true
  return !!(d.cwd && d.cwd.toLowerCase().includes(ARG.toLowerCase()))
}
// Discover LIVE instances: scan the per-instance dir (or a pinned .json path), keep only
// descriptors whose process is still alive (so a clobbered/stale one can't misroute), then filter
// by the selector arg if given.
async function liveInstances() {
  const pinned = ARG && ARG.toLowerCase().endsWith('.json') && fs.existsSync(ARG)
  const files = pinned
    ? [ARG]
    : (() => { try { return fs.readdirSync(ATTACH_DIR).filter(f => f.endsWith('.json')).map(f => path.join(ATTACH_DIR, f)) } catch { return [] } })()
  const cand = []
  for (const f of files) {
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d && d.port && pidAlive(d.pid) && (pinned || matchesArg(d))) cand.push(d) } catch {}
  }
  // pidAlive can pass on a REUSED pid whose recorded port belongs to nothing — probe each survivor's
  // control port and drop any that definitively refuses. Keep on an inconclusive timeout so a
  // slow-but-live sibling instance is never dropped (mirrors the sidecar's startup sweep).
  const out = []
  for (const d of cand) {
    if (await probePort(d.port) !== 'refused') out.push(d)
  }
  return out
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' })

async function pickInstance() {
  const live = await liveInstances()
  if (live.length === 0) {
    console.error(red('No running Agent Omega instance found.'))
    console.error(dim(`(nothing live in ${ATTACH_DIR} — start the desktop app first, then re-run this.)`))
    process.exit(1)
  }
  if (live.length === 1) return live[0]
  console.log(bold('Multiple Agent Omega instances are running — pick one:'))
  live.forEach((d, i) => console.log(`   [${i + 1}] pid ${d.pid}  port ${d.port}  ${dim(d.cwd || '')}`))
  const ans = await new Promise((res) => rl.question('choose 1-' + live.length + ': ', res))
  const n = parseInt(ans, 10)
  return (n >= 1 && n <= live.length) ? live[n - 1] : live[0]
}

const d = await pickInstance()
let sessionId = null, apiPort = d.apiPort, curModel = '', busy = false, historyDone = false, ws = null, quitting = false
let apiAuth = ''   // Basic auth for the engine REST API (from ready) — the engine requires it (RCE fix)
let commands = [], cmdsHinted = false   // the engine's available slash commands (from ready / commands broadcast)
let models = []   // available models [{value,name}] from ready — for /model switching
let atLineStart = true   // track whether the cursor is at the start of a line (for clean interleaving)

function out(s) { process.stdout.write(s); atLineStart = s.endsWith('\n') }
function line(s = '') { if (!atLineStart) out('\n'); out(s + '\n') }

// ---- history: pull the last N messages straight from the engine REST API (loopback, unauth) ----
async function replayHistory() {
  if (historyDone || !sessionId || !apiPort) return
  historyDone = true
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/session/${sessionId}/message`, apiAuth ? { headers: { Authorization: apiAuth } } : undefined)
    if (!r.ok) { line(dim(`(couldn't load history: HTTP ${r.status})`)); return }
    const j = await r.json()
    const msgs = Array.isArray(j) ? j : (j.data || j.messages || [])
    const recent = msgs.slice(-HISTORY_N)
    if (!recent.length) line(dim('── (no earlier messages in this session) ──'))
    else {
      line(dim(`── last ${recent.length} message(s) ${'─'.repeat(Math.max(2, 40 - recent.length))}`))
      for (const m of recent) renderHistoryMessage(m)
    }
    line(dim('── live · type to send · /help for commands ' + '─'.repeat(8)))
  } catch (e) { line(dim(`(couldn't load history: ${e.message})`)) }
}

const SKIP_PART = new Set(['step-start', 'step-finish', 'step', 'snapshot', 'patch'])   // structural markers, not content
function textOfParts(parts) {
  const t = []
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue
    if (SKIP_PART.has(p.type)) continue
    if (typeof p.text === 'string' && p.text.trim()) t.push(p.text)
    else if (p.type && p.type !== 'text') t.push(dim(`[${p.type}${p.tool || p.name ? ':' + (p.tool || p.name) : ''}]`))
  }
  return t.join('')
}
function renderHistoryMessage(m) {
  const role = (m && m.info && m.info.role) || m.role || '?'
  const body = textOfParts(m.parts).trim()
  if (!body) return
  const who = role === 'user' ? cyan('you') : role === 'assistant' ? bold('omega') : dim(role)
  line(`${who}  ${body}`)
}

// ---- live frame rendering (shapes observed from the real engine stream) ----
function renderUpdate(u) {
  if (!u || typeof u !== 'object') return
  if (DEBUG) line(dim('RAW ' + JSON.stringify(u).slice(0, 300)))
  const kind = u.sessionUpdate || u.type || ''
  // thinking chunks: hidden unless ATTACH_THOUGHTS
  if (/thought/i.test(kind) && !process.env.ATTACH_THOUGHTS) return
  // a titled beat (tool call / skill load / status) → its own line
  const title = (u.toolCall && u.toolCall.title) || u.title
  if (title) { line(dim('  · ' + title)); return }
  // streaming assistant text delta
  const text = (u.content && typeof u.content.text === 'string' && u.content.text)
    || (typeof u.text === 'string' && u.text)
    || (u.delta && u.delta.text) || ''
  if (text) { if (atLineStart) out(bold('omega  ')); out(text) }
}

// ---- permission prompt: render + let the user choose inline ----
let pendingPerm = null
function renderPermission(m) {
  pendingPerm = m
  line()
  line(yellow('⚠ permission needed: ') + (m.title || m.kind || '(action)'))
  const opts = m.options || []
  opts.forEach((o, i) => line(`   [${i + 1}] ${o.name || o.optionId}`))
  out(yellow('choose 1-' + opts.length + ' (or /deny): '))
  atLineStart = false
}
function answerPermission(choice) {
  const m = pendingPerm; if (!m) return false
  const opts = m.options || []
  let opt = null
  if (/^\/deny$/i.test(choice)) opt = opts.find(o => /den|reject|no/i.test(o.name || o.optionId)) || opts[opts.length - 1]
  else { const n = parseInt(choice, 10); if (n >= 1 && n <= opts.length) opt = opts[n - 1] }
  if (!opt) { out(yellow('choose 1-' + opts.length + ' (or /deny): ')); return true }
  ws.send(JSON.stringify({ type: 'permissionReply', toolCallId: m.toolCallId, optionId: opt.optionId }))
  line(dim('  → ' + (opt.name || opt.optionId)))
  pendingPerm = null
  return true
}

function onMessage(data) {
  let m; try { m = JSON.parse(data.toString()) } catch { return }
  switch (m.type) {
    case 'ready':
      sessionId = m.sessionId; apiPort = m.apiPort || apiPort; curModel = m.model || curModel
      if (m.apiAuth) apiAuth = m.apiAuth   // set BEFORE replayHistory so the history fetch is authenticated
      if (Array.isArray(m.commands)) commands = m.commands
      if (Array.isArray(m.models)) models = m.models
      if (!historyDone) { line(dim(`attached to ${sessionId}  ·  model ${curModel}`)); replayHistory() }
      hintCommands()
      break
    case 'commands': if (Array.isArray(m.commands)) { commands = m.commands; hintCommands() } break
    case 'update': renderUpdate(m.update); break
    case 'permission': renderPermission(m); break
    case 'turn-start': busy = true; break
    case 'turn-end': busy = false; line(); line(dim('· ready ·')); break
    case 'error': busy = false; line(red('error: ') + (m.message || '')); break
    case 'engine-down': line(red('engine down: ') + (m.message || '')); break
    case 'model': curModel = m.model; line(dim('model → ' + curModel)); break
    case 'agent': line(dim('agent → ' + m.agent)); break
    case 'effort': line(dim('effort → ' + m.effort)); break
    case 'replay-start': line(dim('(reloading session…)')); break
    case 'replay-end': break
    default: break   // commands/vaultKeys/councilConfig etc. — not needed for terminal driving
  }
}

// Local (client) commands vs the ENGINE's slash commands: anything that isn't one of these local
// ones is forwarded to the agent as a real slash command (/tdd, /verify, /init, /compact, …).
const LOCAL_CMDS = new Set(['quit', 'q', 'abort', 'new', 'model', 'models', 'help', 'h', 'commands', 'cmds'])
const HELP = [
  'client commands:',
  '  /model            list models; /model <number|name> to SWITCH the model',
  '  /commands /cmds   list the agent\'s slash commands',
  '  /abort            stop the current turn',
  '  /new              start a fresh session (leaves the current one)',
  '  /quit  /q         detach (leaves the desktop session running)',
  '  /help             this',
  'any other /command is sent to the agent (e.g. /tdd, /verify).',
  'anything without a leading / is sent as a prompt.',
].join('\n')

function listModels() {
  if (!models.length) { line(dim('(no models reported by this session)')); return }
  models.forEach((m, i) => {
    const cur = (m.value === curModel || m.name === curModel)
    const num = String(i + 1).padStart(2)
    line('  ' + (cur ? cyan(num) : bold(num)) + '. ' + (m.name || m.value) + dim('  ' + m.value) + (cur ? cyan('  ← current') : ''))
  })
  line(dim('to switch, type the NUMBER:  /model <number>   (e.g.  /model 5)'))
}
function switchModel(arg) {
  if (!models.length) { line(dim('(no models available to switch to)')); return }
  const a = arg.trim().toLowerCase()
  let target = null
  // 1) a number is the easy, unambiguous path
  const n = parseInt(arg, 10)
  if (String(n) === arg.trim() && n >= 1 && n <= models.length) target = models[n - 1]
  // 2) an EXACT id/name match wins over substrings (so "gpt-5.5" doesn't clash with "gpt-5.5-pro")
  if (!target) target = models.find((m) => (m.value || '').toLowerCase() === a || (m.name || '').toLowerCase() === a)
  // 3) fall back to substring; if several match, show their NUMBERS so the choice is one keystroke
  if (!target) {
    const hits = models.map((m, i) => ({ m, i })).filter(({ m }) => (m.value || '').toLowerCase().includes(a) || (m.name || '').toLowerCase().includes(a))
    if (hits.length === 1) target = hits[0].m
    else if (hits.length > 1) {
      line(dim(`"${arg}" matches ${hits.length} — type the number:`))
      hits.forEach(({ m, i }) => line('  ' + bold('/model ' + (i + 1)) + '   ' + (m.name || m.value) + dim('  ' + m.value)))
      return
    } else { line(dim(`no model matches "${arg}" — type /model to see the list`)); return }
  }
  ws.send(JSON.stringify({ type: 'setModel', model: target.value }))
  line(dim('switching → ' + (target.name || target.value)))
}
function cmdName(c) { return String((c && (c.name || c.command)) || '').replace(/^\//, '') }
function hintCommands() {
  if (cmdsHinted || !commands.length) return
  cmdsHinted = true
  line(dim(`(/model to change model · /commands for the ${commands.length} agent commands · /help)`))
}
function listCommands() {
  if (!commands.length) { line(dim('(no slash commands reported by this session)')); return }
  line(dim('agent slash commands:'))
  for (const c of commands) {
    const n = cmdName(c); if (!n) continue
    const desc = (c && (c.description || c.desc)) || ''
    line('  /' + n + (desc ? dim('  — ' + desc) : ''))
  }
}

function handleInput(raw) {
  const t = raw.trim()
  if (!t) return
  if (pendingPerm) { answerPermission(t); return }
  if (t.startsWith('/')) {
    const [head, ...rest] = t.slice(1).split(/\s+/)
    const name = head.toLowerCase()
    const args = rest.join(' ')
    if (name === 'quit' || name === 'q') { quitting = true; line(dim('detached.')); try { ws.close() } catch {}; rl.close(); process.exit(0) }
    else if (name === 'abort') { ws.send(JSON.stringify({ type: 'abort' })); line(dim('· abort sent ·')) }
    else if (name === 'new') { ws.send(JSON.stringify({ type: 'new' })); line(dim('· new session ·')) }
    else if (name === 'model' || name === 'models') { if (args) switchModel(args); else { line(dim('current model: ' + curModel)); listModels() } }
    else if (name === 'commands' || name === 'cmds') listCommands()
    else if (name === 'help' || name === 'h') line(dim(HELP))
    else {
      // forward to the agent as a real slash command
      if (busy) { line(dim('(a turn is in progress — wait for "· ready ·" or /abort)')); return }
      ws.send(JSON.stringify({ type: 'command', name: head, args }))
      line(cyan('you  ') + '/' + head + (args ? ' ' + args : ''))
      atLineStart = true
    }
    return
  }
  if (busy) { line(dim('(a turn is in progress — wait for "· ready ·" or /abort)')); return }
  ws.send(JSON.stringify({ type: 'prompt', text: t }))
  line(cyan('you  ') + t)
  atLineStart = true
}

function connect() {
  const url = `ws://127.0.0.1:${d.port}` + (d.token ? `?token=${encodeURIComponent(d.token)}` : '')
  ws = new WebSocket(url)
  ws.on('open', () => line(dim('connected — waiting for session…')))
  ws.on('message', onMessage)
  ws.on('error', (e) => line(red('socket error: ') + e.message))
  ws.on('close', () => {
    if (quitting) return
    line(dim('· disconnected — retrying in 2s (Ctrl-C to quit) ·'))
    historyDone = false
    setTimeout(connect, 2000)
  })
}

line(bold('Agent Omega — terminal attach'))
connect()
rl.on('line', handleInput)
rl.on('SIGINT', () => { quitting = true; line(dim('detached.')); process.exit(0) })
