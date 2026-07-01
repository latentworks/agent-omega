// AgentOmega ACP sidecar — the engine driver for true terminal parity.
// Spawns `opencode acp`, speaks ACP as the CLIENT, and bridges to the UI over a
// local WebSocket. Handles: turns, live updates, interactive PERMISSIONS, model
// + agent switching, the live command list, and client fs read/write.
import { spawn, execFileSync } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WebSocketServer } from 'ws'
import * as acp from '@agentclientprotocol/sdk'

const isWin = process.platform === 'win32'
const ENGINE = process.env.AGENT_OMEGA_ENGINE || path.join(import.meta.dirname, 'engine', isWin ? 'opencode.exe' : 'opencode')
// Test mode: set AGENT_OMEGA_OPENCODE_SRC to the packages/opencode dir to run the engine
// FROM SOURCE via bun — picks up engine edits without a binary rebuild. Unset in
// production → the compiled exe is used.
const BUN = process.env.AGENT_OMEGA_BUN || 'bun'
const OPENCODE_SRC = process.env.AGENT_OMEGA_OPENCODE_SRC || ''
// Config comes from env first (robust across node / bun-standalone / OS), then positional argv
// (the Windows host passes argv), then defaults. A bun-compiled binary's argv indices are not the
// same as `node script.mjs …`, so positional args alone are unreliable on macOS.
const WORKDIR = process.env.AGENT_OMEGA_WORKDIR || process.argv[2] || path.join(os.homedir(), '.agent-omega', 'workspace')
const WS_PORT = Number(process.env.AGENT_OMEGA_WS_PORT || process.argv[3]) || 4599
const DEFAULT_MODEL = process.env.AGENT_OMEGA_DEFAULT_MODEL || process.argv[4] || 'anthropic/claude-opus-4-8'

try { fs.mkdirSync(WORKDIR, { recursive: true }) } catch (e) { if (e.code !== 'EEXIST') throw e }   // a bun-compiled mkdir can spuriously EEXIST on an already-present dir

let conn = null, sessionId = null, engineProc = null, restarting = false
let models = [], agents = [], commands = [], curModel = DEFAULT_MODEL, curAgent = null
let busy = false
const pendingPerms = new Map()   // toolCallId -> resolve fn

const WS_TOKEN = process.env.AO_WS_TOKEN || ''   // per-launch token from Program.cs; only the real app window has it
const wss = new WebSocketServer({
  host: '127.0.0.1', port: WS_PORT,               // loopback only — never expose the control socket to the LAN
  verifyClient: (info) => {                       // + reject any local process / browser page that lacks the launch token
    if (!WS_TOKEN) return true                     // no token (dev/standalone run) -> allow
    try { return new URL(info.req.url, 'ws://127.0.0.1').searchParams.get('token') === WS_TOKEN } catch { return false }
  },
})
wss.on('error', (e) => { console.error('[sidecar] wss error (port in use? second instance?)', e.message); process.exit(1) })  // fail cleanly, no unhandled crash
const clients = new Set()
function send(ws, m) { try { if (ws.readyState === 1) ws.send(JSON.stringify(m)) } catch {} }
function broadcast(m) { const s = JSON.stringify(m); for (const c of clients) { try { if (c.readyState === 1) c.send(s) } catch {} } }
function log(...a) { console.error('[sidecar]', ...a) }

// Vault -> engine env: read cloud API keys from the DPAPI vault (secrets.ps1) and
// pass them to `opencode acp`, so cloud providers (anthropic/openai/...) and frontier
// council members light up. Honest: a missing/failed key is simply skipped (the
// provider stays dark), never faked. Env var name <- vault key name.
// Vault backend is platform-specific but shares one get/set/list/rm CLI contract, so the
// sidecar only varies the launcher: Windows = powershell -File secrets.ps1 (DPAPI); macOS/
// other = sh secrets.sh (Keychain). Every call-site below stays identical across OSes.
const VAULT_SCRIPT = process.env.AGENT_OMEGA_VAULT || path.join(os.homedir(), '.agent-omega', isWin ? 'secrets.ps1' : 'secrets.sh')
const [VAULT_CMD, VAULT_PRE] = isWin ? ['powershell', ['-NoProfile', '-File', VAULT_SCRIPT]] : ['sh', [VAULT_SCRIPT]]
const COUNCIL_JSON = path.join(os.homedir(), '.config', 'opencode', 'council', 'council.json')
const VAULT_TO_ENV = {
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  OPENAI_API_KEY: 'OPENAI_API',
  DEEPSEEK_API_KEY: 'DEEPSEEK_API',
  ZAI_API_KEY: 'ZAI_API_KEY',
  MOONSHOT_API_KEY: 'KIMI_API_KEY',
  GOOGLE_GENERATIVE_AI_API_KEY: 'GEMINI_API_KEY',
}
function vaultEnv() {
  const out = {}
  for (const [envName, vaultName] of Object.entries(VAULT_TO_ENV)) {
    try {
      const v = execFileSync(VAULT_CMD, [...VAULT_PRE, 'get', vaultName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (v && !/^no secret named/i.test(v)) out[envName] = v
    } catch {}
  }
  log('vault -> engine env: ' + (Object.keys(out).join(', ') || '(none)'))
  return out
}

// ---- Settings layer: council.json (read/merge/write) + vault (via secrets.ps1) ----
// Safe read: a missing or corrupt file yields {} rather than crashing the sidecar.
function readCouncil() {
  let raw
  try { raw = JSON.parse(fs.readFileSync(COUNCIL_JSON, 'utf8')) }
  catch (e) { log('council read', e.message); raw = {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {}
  return raw
}
// Atomic write: temp file + rename so a crash mid-write can never leave a half-written
// (council-bricking) file in place.
function writeCouncil(obj) {
  const tmp = COUNCIL_JSON + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, COUNCIL_JSON)
}
// Validate an incoming patch field-by-field. Only known fields are checked; ANY invalid
// value rejects the WHOLE write ({ok:false}) so a bad UI payload can't corrupt the roster.
// Unknown top-level fields are untouched (preserved by the merge in the handler).
function validateCouncilPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'config must be an object' }
  const clean = {}
  if ('rounds' in patch) {
    const n = patch.rounds
    if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: 'rounds must be an integer 1-5' }
    clean.rounds = n
  }
  if ('synthesizer' in patch) {
    const s = patch.synthesizer
    if (typeof s !== 'string' || !s.trim()) return { ok: false, error: 'synthesizer must be a non-empty string' }
    clean.synthesizer = s
  }
  if ('memberAccess' in patch) {
    if (patch.memberAccess !== 'none' && patch.memberAccess !== 'readonly') return { ok: false, error: "memberAccess must be 'none' or 'readonly'" }
    clean.memberAccess = patch.memberAccess
  }
  if ('mode' in patch) {
    if (patch.mode !== 'manual' && patch.mode !== 'auto') return { ok: false, error: "mode must be 'manual' or 'auto'" }
    clean.mode = patch.mode
  }
  if ('rung' in patch) {
    if (!['minimal', 'moderate', 'partner'].includes(patch.rung)) return { ok: false, error: "rung must be 'minimal', 'moderate', or 'partner'" }
    clean.rung = patch.rung
  }
  if ('members' in patch) {
    if (!Array.isArray(patch.members)) return { ok: false, error: 'members must be an array' }
    const cm = []
    for (const it of patch.members) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) return { ok: false, error: 'each member must be an object' }
      if (typeof it.model !== 'string' || !it.model.trim()) return { ok: false, error: 'each member needs a non-empty model string' }
      // Spread first so any extra per-member fields survive; then normalise label/model.
      cm.push({ ...it, label: typeof it.label === 'string' ? it.label : '', model: it.model })
    }
    clean.members = cm
  }
  return { ok: true, clean }
}
// List vault key NAMES only (never values). secrets.ps1 prints one name per line, or the
// sentinel "(vault empty)". Args go through execFileSync's array form (no shell) so a key
// name can't inject a command.
function vaultListNames() {
  const out = execFileSync(VAULT_CMD, [...VAULT_PRE, 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.split(/\r?\n/).map(s => s.trim()).filter(s => s && s !== '(vault empty)')
}

class UIClient {
  async requestPermission(p) {
    const tcid = (p.toolCall && (p.toolCall.toolCallId || p.toolCall.id)) || ('perm_' + pendingPerms.size)
    const options = (p.options || []).map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
    broadcast({ type: 'permission', toolCallId: tcid, title: (p.toolCall && p.toolCall.title) || '', kind: (p.toolCall && p.toolCall.kind) || '', rawInput: (p.toolCall && p.toolCall.rawInput) || null, locations: (p.toolCall && p.toolCall.locations) || [], options })
    return await new Promise((resolve) => {
      pendingPerms.set(tcid, resolve)   // store the raw resolver so it can be selected OR cancelled (drainPerms)
    })
  }
  async sessionUpdate(pp) {
    const u = pp.update
    if (u && u.sessionUpdate === 'available_commands_update') {
      commands = u.availableCommands || u.commands || []
      broadcast({ type: 'commands', commands })
      return
    }
    broadcast({ type: 'update', update: u })
  }
  async writeTextFile(p) { try { fs.writeFileSync(p.path, p.content ?? '') } catch (e) { log('writeTextFile', e.message) } return {} }
  async readTextFile(p) { try { return { content: fs.readFileSync(p.path, 'utf8') } } catch { return { content: '' } } }
}

// Resolve every outstanding permission with a 'cancelled' outcome so a disconnect/abort
// can never leave the engine blocked waiting on a UI that's gone.
function drainPerms() {
  for (const resolve of pendingPerms.values()) { try { resolve({ outcome: { outcome: 'cancelled' } }) } catch {} }
  pendingPerms.clear()
}

function extractConfig(co) {
  co = co || []
  const modelOpt = co.find(o => o.id === 'model')
  models = (modelOpt && modelOpt.options || []).map(o => ({ value: o.value, name: o.name }))
  const modeOpt = co.find(o => o.id === 'mode' || o.id === 'agent' || o.category === 'mode')
  agents = (modeOpt && modeOpt.options || []).map(o => ({ value: o.value, name: o.name }))
  if (modeOpt) curAgent = modeOpt.currentValue
}

async function newSession() {
  const s = await conn.newSession({ cwd: WORKDIR, mcpServers: [] })
  sessionId = s.sessionId
  extractConfig(s.configOptions)
  try { await conn.unstable_setSessionModel({ sessionId, modelId: curModel }) } catch (e) { log('setModel', e.message); broadcast({ type: 'error', message: 'Could not select model "' + curModel + '" — check that its server is running and the model is loaded. (' + e.message + ')' }) }
  return s
}

async function start() {
  const [cmd, baseArgs] = OPENCODE_SRC
    ? [BUN, ['run', '--cwd', OPENCODE_SRC, '--conditions=browser', 'src/index.ts']]
    : [ENGINE, []]
  log('engine:', cmd, baseArgs.join(' '))
  const proc = spawn(cmd, [...baseArgs, 'acp', '--cwd', WORKDIR], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, ...vaultEnv() } })
  engineProc = proc
  proc.on('error', e => { log('spawn error', e.message); if (!restarting) broadcast({ type: 'engine-down', message: e.message }) })
  proc.on('exit', c => { log('engine exited', c); if (!restarting) broadcast({ type: 'engine-down', message: 'engine exited ' + c }) })
  conn = new acp.ClientSideConnection((_a) => new UIClient(), acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout)))
  await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } })
  await newSession()
  log('ready: session', sessionId, '| models', models.length, '| agents', agents.length)
  broadcast(readyMsg())
}
function readyMsg() { return { type: 'ready', sessionId, model: curModel, agent: curAgent, models, agents, commands } }

// Re-spawn the engine so a just-changed vault key takes effect (the engine reads keys once, at spawn).
async function restartEngine() {
  restarting = true
  drainPerms(); busy = false
  try { if (engineProc) engineProc.kill() } catch {}
  conn = null; sessionId = null
  await new Promise((r) => setTimeout(r, 350))
  restarting = false
  await start()   // fresh vaultEnv() -> the new/removed key is now reflected
}

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => {
    clients.delete(ws)
    if (clients.size === 0 && busy) {   // UI gone mid-turn — don't strand the engine on a permission no one can answer
      drainPerms()
      if (conn) conn.cancel({ sessionId }).catch(() => {})
    }
  })
  if (sessionId) send(ws, readyMsg())
  ws.on('message', async (data) => {
    let m; try { m = JSON.parse(data.toString()) } catch { return }
    try {
      switch (m.type) {
        case 'prompt': {
          if (busy || !m.text) return
          busy = true; broadcast({ type: 'turn-start' })
          try { const r = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: m.text }] }); broadcast({ type: 'turn-end', stopReason: r.stopReason }) }
          catch (e) { broadcast({ type: 'error', message: e.message }) }
          finally { busy = false }
          break
        }
        case 'command': {
          if (busy || !m.name) return
          busy = true; broadcast({ type: 'turn-start' })
          try { const r = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: '/' + m.name + (m.args ? ' ' + m.args : '') }] }); broadcast({ type: 'turn-end', stopReason: r.stopReason }) }
          catch (e) { broadcast({ type: 'error', message: e.message }) }
          finally { busy = false }
          break
        }
        case 'permissionReply': {
          const resolve = pendingPerms.get(m.toolCallId); if (resolve) { pendingPerms.delete(m.toolCallId); resolve({ outcome: { outcome: 'selected', optionId: m.optionId } }) }
          break
        }
        case 'setModel': { const prev = curModel; curModel = m.model; try { await conn.unstable_setSessionModel({ sessionId, modelId: curModel }) } catch (e) { curModel = prev; log('setModel', e.message); broadcast({ type: 'error', message: 'Could not select model "' + m.model + '" — ' + e.message }) } broadcast({ type: 'model', model: curModel }); break }
        case 'setAgent': { const prev = curAgent; curAgent = m.agent; try { await conn.setSessionConfigOption({ sessionId, type: 'mode', value: curAgent }) } catch (e) { curAgent = prev; log('setAgent', e.message); broadcast({ type: 'error', message: 'Could not switch agent — ' + e.message }) } broadcast({ type: 'agent', agent: curAgent }); break }
        case 'getCouncilConfig': {
          try { send(ws, { type: 'councilConfig', config: readCouncil() }) }
          catch (e) { log('getCouncilConfig', e.message); send(ws, { type: 'councilConfig', error: e.message }) }
          break
        }
        case 'setCouncilConfig': {
          try {
            const v = validateCouncilPatch(m.config)
            if (!v.ok) { send(ws, { type: 'councilConfig', error: v.error }); break }
            const merged = { ...readCouncil(), ...v.clean }   // merge: preserves _comment + unknown fields
            writeCouncil(merged)
            broadcast({ type: 'councilConfig', config: merged })   // all windows stay in sync
          } catch (e) { log('setCouncilConfig', e.message); send(ws, { type: 'councilConfig', error: e.message }) }
          break
        }
        case 'vaultList': {
          try { send(ws, { type: 'vaultKeys', names: vaultListNames() }) }
          catch (e) { log('vaultList', e.message); send(ws, { type: 'vaultKeys', error: e.message }) }
          break
        }
        case 'vaultSet': {
          try {
            if (typeof m.name !== 'string' || !m.name.trim()) { send(ws, { type: 'vaultKeys', error: 'name required' }); break }
            // Empty value would make secrets.ps1 drop to an interactive Read-Host prompt and HANG the sidecar.
            if (typeof m.value !== 'string' || m.value === '') { send(ws, { type: 'vaultKeys', error: 'value required' }); break }
            execFileSync(VAULT_CMD, [...VAULT_PRE, 'set', m.name, m.value], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
            const note = busy ? 'Key saved — restart the app to apply it (a turn is in progress).' : 'Key saved — engine reloaded. If your first cloud call still fails, restart the app.'
            broadcast({ type: 'vaultKeys', names: vaultListNames(), note })
            if (!busy) restartEngine().catch((e) => log('restart', e.message))   // pick up the new key without a manual restart
          } catch (e) { log('vaultSet', e.message); send(ws, { type: 'vaultKeys', error: e.message }) }
          break
        }
        case 'vaultRemove': {
          try {
            if (typeof m.name !== 'string' || !m.name.trim()) { send(ws, { type: 'vaultKeys', error: 'name required' }); break }
            execFileSync(VAULT_CMD, [...VAULT_PRE, 'rm', m.name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
            const note = busy ? 'Key removed — restart the app to fully apply.' : 'Key removed — engine reloaded.'
            broadcast({ type: 'vaultKeys', names: vaultListNames(), note })
            if (!busy) restartEngine().catch((e) => log('restart', e.message))
          } catch (e) { log('vaultRemove', e.message); send(ws, { type: 'vaultKeys', error: e.message }) }
          break
        }
        case 'abort': { try { await conn.cancel({ sessionId }) } catch (e) { log('cancel', e.message) } drainPerms(); busy = false; break }
        case 'new': {
          if (busy) { try { await conn.cancel({ sessionId }) } catch {} drainPerms(); busy = false }   // don't orphan an in-flight turn
          try { await newSession() } catch (e) { log('new', e.message) } broadcast(readyMsg()); break
        }
      }
    } catch (e) { log('msg error', e.message) }
  })
})

start().catch(e => { log('start failed', e.message); process.exit(1) })
