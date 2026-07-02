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
// to ~/.agent-omega/attach.json — so nothing is exposed to the network; SSH is what gets you
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

const HISTORY_N = Number(process.env.ATTACH_HISTORY || 20)
const DEBUG = ['1', 'true'].includes(process.env.ATTACH_DEBUG || '')
const ATTACH_FILE = process.env.AGENT_OMEGA_ATTACH || path.join(os.homedir(), '.agent-omega', 'attach.json')

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`

function readDescriptor() {
  let raw
  try { raw = fs.readFileSync(ATTACH_FILE, 'utf8') }
  catch { return null }
  try { return JSON.parse(raw) } catch { return null }
}

const d = readDescriptor()
if (!d || !d.port) {
  console.error(red('Agent Omega does not appear to be running.'))
  console.error(dim(`(no attach descriptor at ${ATTACH_FILE} — start the desktop app first, then re-run this.)`))
  process.exit(1)
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' })
let sessionId = null, apiPort = d.apiPort, curModel = '', busy = false, historyDone = false, ws = null, quitting = false
let atLineStart = true   // track whether the cursor is at the start of a line (for clean interleaving)

function out(s) { process.stdout.write(s); atLineStart = s.endsWith('\n') }
function line(s = '') { if (!atLineStart) out('\n'); out(s + '\n') }

// ---- history: pull the last N messages straight from the engine REST API (loopback, unauth) ----
async function replayHistory() {
  if (historyDone || !sessionId || !apiPort) return
  historyDone = true
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/session/${sessionId}/message`)
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
      if (!historyDone) { line(dim(`attached to ${sessionId}  ·  model ${curModel}`)); replayHistory() }
      break
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

const HELP = [
  'commands:',
  '  /quit  /q      detach (leaves the desktop session running)',
  '  /abort         stop the current turn',
  '  /new           start a fresh session (careful — leaves the current one)',
  '  /model         show the current model',
  '  /help          this',
  'anything else you type is sent to the agent as a prompt.',
].join('\n')

function handleInput(raw) {
  const t = raw.trim()
  if (!t) return
  if (pendingPerm) { answerPermission(t); return }
  if (t.startsWith('/')) {
    const cmd = t.slice(1).toLowerCase()
    if (cmd === 'quit' || cmd === 'q') { quitting = true; line(dim('detached.')); try { ws.close() } catch {}; rl.close(); process.exit(0) }
    else if (cmd === 'abort') { ws.send(JSON.stringify({ type: 'abort' })); line(dim('· abort sent ·')) }
    else if (cmd === 'new') { ws.send(JSON.stringify({ type: 'new' })); line(dim('· new session ·')) }
    else if (cmd === 'model') line(dim('model: ' + curModel))
    else if (cmd === 'help' || cmd === 'h') line(dim(HELP))
    else line(dim('unknown command; /help'))
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
