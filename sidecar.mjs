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
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const isWin = process.platform === 'win32'
const HERE = path.dirname(fileURLToPath(import.meta.url)) // Node 18+ safe (import.meta.dirname needs 20.11+)
const ENGINE = process.env.AGENT_OMEGA_ENGINE || path.join(HERE, 'engine', isWin ? 'opencode.exe' : 'opencode')
// Test mode: set AGENT_OMEGA_OPENCODE_SRC to the packages/opencode dir to run the engine
// FROM SOURCE via bun — picks up engine edits without a binary rebuild. Unset in
// production → the compiled exe is used.
const BUN = process.env.AGENT_OMEGA_BUN || 'bun'
const OPENCODE_SRC = process.env.AGENT_OMEGA_OPENCODE_SRC || ''
// Config: env first (robust for the bun-standalone sidecar, whose argv indices differ from
// `node script.mjs`), then positional argv (the Windows host passes argv), then defaults.
// The default scratch workspace lives OUTSIDE ~/.agent-omega on purpose: that tree holds the
// vault and is blocked from the model's shell (opencode.json deny "*.agent-omega*"), so a
// workspace there would make every absolute-path command the model runs get denied.
const DEFAULT_WORKDIR = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AgentOmega', 'workspace')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'AgentOmega', 'workspace')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'agent-omega', 'workspace')
let WORKDIR = process.env.AGENT_OMEGA_WORKDIR || process.argv[2] || DEFAULT_WORKDIR
const WS_PORT = Number(process.env.AGENT_OMEGA_WS_PORT || process.argv[3]) || 4599
const API_PORT = WS_PORT + 1   // engine HTTP API rides one above the control socket (unique per instance)
const DEFAULT_MODEL = process.env.AGENT_OMEGA_DEFAULT_MODEL || process.argv[4] || '' // empty => honor opencode.json's model
const PARENT_PID = Number(process.env.AO_PARENT_PID || 0)   // shell PID; sidecar self-exits if the shell dies (no orphaned engine)

try { fs.mkdirSync(WORKDIR, { recursive: true }) } catch (e) { if (e.code !== 'EEXIST') throw e }   // a bun-compiled mkdir can spuriously EEXIST on an already-present dir
// Canonicalize: the engine resolves symlinks in session directories (macOS: /tmp -> /private/tmp),
// and the UI queries /session?directory=<our WORKDIR>. If the strings disagree the session list
// comes back empty even though the session exists. realpath AFTER mkdir so the dir resolves.
try { WORKDIR = fs.realpathSync(WORKDIR) } catch {}

let conn = null, sessionId = null, engineProc = null, restarting = false, lastEngineDown = null
let models = [], agents = [], commands = [], curModel = DEFAULT_MODEL, curAgent = null
let agentConfigId = 'mode', effortConfigId = 'effort', curEffort = '', effortLevels = []   // reasoning-effort config, surfaced where the model supports it
let busy = false
let turnOutput = 0   // meaningful updates seen this turn — 0 at turn-end means the engine swallowed a provider failure
const pendingPerms = new Map()   // toolCallId -> resolve fn

const WS_TOKEN = process.env.AO_WS_TOKEN || ''   // per-launch token from the shell; only the real app window has it
// Per-launch password for the engine's HTTP API (Basic auth). The engine binds 127.0.0.1 but is
// otherwise UNauthenticated, so without this any local process — including a webpage the user has
// open (Origin "null" via a sandboxed iframe / downloaded .html) or a DNS-rebinding attacker —
// could drive the session API and the /pty command endpoint. We pass it to the engine via
// OPENCODE_SERVER_PASSWORD and hand it to the UI over the token-gated WS `ready` message; only the
// legitimate window (which holds AO_WS_TOKEN) can connect to the WS and learn it.
const API_PASSWORD = process.env.AO_API_PASSWORD || crypto.randomUUID().replace(/-/g, '')
const API_USER = 'agent-omega'
const API_AUTH = 'Basic ' + Buffer.from(API_USER + ':' + API_PASSWORD).toString('base64')
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

// Turn a raw provider/engine error into an actionable hint (missing key, unreachable server).
function friendlyError(msg) {
  const m = String(msg || '')
  const prov = (curModel || '').split('/')[0] || 'this provider'
  if (/401|403|unauthor|authentication|api[_ -]?key|x-api-key|invalid.*key|missing.*key|no auth/i.test(m)) {
    // If the user has a key for some OTHER provider, the likely problem is the selected model, not a
    // missing key — point them at model switching instead of telling them to add a key they may have.
    const haveOthers = [...keyedEnv].map(e => Object.keys(PROVIDER_ENV).find(p => PROVIDER_ENV[p] === e)).filter(Boolean)
    if (haveOthers.length && !modelUsable(curModel))
      return 'The selected model (' + prov + ') has no key, but you have a key for ' + haveOthers.join('/') + '. Open Settings (Ctrl+,) → Models (or type /model) and pick a ' + haveOthers[0] + ' model.  [' + m.slice(0, 120) + ']'
    return 'No valid API key for ' + prov + ' — open Settings (Ctrl+,) → Vault and add the key; the engine reloads automatically.  [' + m.slice(0, 160) + ']'
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|ETIMEDOUT|network|econnreset|connect/i.test(m))
    return 'Could not reach ' + prov + ' — is the server/endpoint running and reachable?  [' + m.slice(0, 160) + ']'
  if (/context size|context length|exceeded.*(size|token)|size limit|n_ctx|too many tokens|maximum context/i.test(m))
    return "The local model's context window is too small for Agent Omega's prompt. Restart your server with a larger context and fewer parallel slots — e.g. llama-server -c 32768 --parallel 2 (llama.cpp splits -c across slots, so keep -c/parallel ≥ ~16k).  [" + m.slice(0, 140) + ']'
  return m
}

// Vault -> engine env: read cloud API keys from the DPAPI vault (secrets.ps1) and
// pass them to `opencode acp`, so cloud providers (anthropic/openai/...) and frontier
// council members light up. Honest: a missing/failed key is simply skipped (the
// provider stays dark), never faked. Env var name <- vault key name.
// Vault backend is platform-specific but shares one get/set/list/remove CLI contract, so the
// sidecar only varies the launcher: Windows = powershell -File secrets.ps1 (DPAPI); macOS/other
// = sh secrets.sh (Keychain). Every call-site below stays identical across OSes.
const VAULT_SCRIPT = process.env.AGENT_OMEGA_VAULT || path.join(os.homedir(), '.agent-omega', isWin ? 'secrets.ps1' : 'secrets.sh')
const [VAULT_CMD, VAULT_PRE] = isWin
  ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', VAULT_SCRIPT]]
  : ['sh', [VAULT_SCRIPT]]
// Self-heal the vault script: install the shipped copy if missing, AND refresh it if it differs
// from the shipped one — so an upgrade over a pre-2.3 install can't leave a stale script that
// silently fails every in-app vault write. On macOS the shipped copy is provisioned by the Swift
// shell (the compiled sidecar has no on-disk scripts dir), so this is a no-op there.
function ensureVault() {
  try {
    const src = path.join(HERE, 'scripts', isWin ? 'secrets.ps1' : 'secrets.sh')
    if (fs.existsSync(src)) {
      const cur = fs.existsSync(VAULT_SCRIPT) ? fs.readFileSync(VAULT_SCRIPT, 'utf8') : null
      const shipped = fs.readFileSync(src, 'utf8')
      if (cur !== shipped) { fs.mkdirSync(path.dirname(VAULT_SCRIPT), { recursive: true }); fs.copyFileSync(src, VAULT_SCRIPT); if (!isWin) { try { fs.chmodSync(VAULT_SCRIPT, 0o755) } catch {} } }
    }
  } catch {}
  return fs.existsSync(VAULT_SCRIPT)
}
const COUNCIL_JSON = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode', 'council', 'council.json') // honors XDG_CONFIG_HOME so an isolated instance reads its own council config
// engine-env-var  <-  vault key NAME. The vault names MUST match what the in-app Vault UI
// (ui/crt-settings.js) and setup.mjs store under, or a key the user added never reaches the
// engine. These are the canonical names both of those write.
const VAULT_TO_ENV = {
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  OPENAI_API_KEY: 'OPENAI_API_KEY',
  DEEPSEEK_API_KEY: 'DEEPSEEK_API_KEY',
  ZAI_API_KEY: 'ZAI_API_KEY',
  MOONSHOT_API_KEY: 'KIMI_API_KEY',
  GOOGLE_GENERATIVE_AI_API_KEY: 'GEMINI_API_KEY',
}
// Pre-2.3 installs stored these two under shorter names; fall back to them so an upgrade
// doesn't silently lose an already-stored key.
const VAULT_LEGACY = { OPENAI_API_KEY: 'OPENAI_API', DEEPSEEK_API_KEY: 'DEEPSEEK_API' }
function vaultGet(vaultName) {
  try {
    const v = execFileSync(VAULT_CMD, [...VAULT_PRE, 'get', vaultName], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return /^no secret named/i.test(v) ? '' : v   // secrets.sh prints this sentinel for a missing key; treat as empty so the legacy-name fallback triggers
  } catch { return '' }
}
let keyedEnv = new Set()   // which provider env vars actually have a value this launch (for model auto-select)
function vaultEnv() {
  const out = {}
  ensureVault()
  for (const [envName, vaultName] of Object.entries(VAULT_TO_ENV)) {
    let v = vaultGet(vaultName)
    if (!v && VAULT_LEGACY[vaultName]) v = vaultGet(VAULT_LEGACY[vaultName])
    if (v) out[envName] = v
  }
  keyedEnv = new Set(Object.keys(out))
  log('vault -> engine env: ' + (Object.keys(out).join(', ') || '(none)'))
  return out
}
// A turn that "succeeded" with zero output — diagnose instead of showing nothing.
// The engine swallows provider failures from the ACP stream but DOES write them to its
// own log; read what it logged during THIS turn so the user sees the provider's exact
// words (e.g. deepseek's "Authentication Fails, Your api key: ****xxxx is invalid").
const ENGINE_LOG = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'log', 'opencode.log')
let turnLogOffset = 0
function engineLogSize() { try { return fs.statSync(ENGINE_LOG).size } catch { return 0 } }
function engineErrorSince(offset) {
  try {
    const fd = fs.openSync(ENGINE_LOG, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.min(Math.max(offset, size - 262144), size)   // this turn only, capped read
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const errs = buf.toString('utf8').split('\n').filter(l => l.includes('level=ERROR'))
    if (!errs.length) return ''
    const m = errs[errs.length - 1].match(/error(?:\.error)?="((?:[^"\\]|\\.)*)"/)
    return m ? m[1].replace(/\\"/g, '"').slice(0, 300) : ''
  } catch { return '' }
}
async function emptyTurnError() {
  await new Promise(r => setTimeout(r, 800))   // the engine flushes its log a beat AFTER the turn resolves — give it that beat
  const prov = (curModel || '').split('/')[0] || 'the provider'
  const detail = engineErrorSince(turnLogOffset)
  if (detail) return prov + ' rejected the request: "' + detail + '"  — fix the key in Settings → Vault (paste the raw value, no quotes/spaces; it applies on engine reload). Full log: ' + ENGINE_LOG
  return 'The model returned nothing — ' + prov + "'s API most likely rejected the request. Usual causes: an invalid/expired API key (Settings → Vault: re-paste the raw key, no quotes or spaces), an account with no credit, or a model this key can't access. Exact error, if any: " + ENGINE_LOG
}

// model-id provider prefix -> the env var whose presence means that provider is usable.
const PROVIDER_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', zai: 'ZAI_API_KEY', moonshotai: 'MOONSHOT_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY' }
// Is the CURRENT model workable — used to decide whether to leave the user's choice alone. Local
// counts (an explicit local choice is the user's call) as do free models and any keyed provider.
function modelUsable(modelId) {
  const prov = String(modelId || '').split('/')[0]
  if (prov === 'local' || prov === 'opencode') return true
  const env = PROVIDER_ENV[prov]
  return env ? keyedEnv.has(env) : true   // unknown provider -> don't second-guess
}
// A safe AUTO-SWITCH target: something we can be sure works without further setup — a provider the
// user actually has a key for, or a keyless free model. NOT local/* (its baseURL may be unset).
function modelPickable(modelId) {
  const prov = String(modelId || '').split('/')[0]
  if (prov === 'opencode') return true
  const env = PROVIDER_ENV[prov]
  return env ? keyedEnv.has(env) : false
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
  ensureVault()
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
    if (u && u.sessionUpdate !== 'usage_update') turnOutput++   // text/thought/tool call/plan = real output
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
  if (!curModel && modelOpt && modelOpt.currentValue) curModel = modelOpt.currentValue // adopt the model the engine loaded from opencode.json
  const modeOpt = co.find(o => o.id === 'mode' || o.id === 'agent' || o.category === 'mode')
  agents = (modeOpt && modeOpt.options || []).map(o => ({ value: o.value, name: o.name }))
  if (modeOpt) { curAgent = modeOpt.currentValue; agentConfigId = modeOpt.id || agentConfigId }
  // reasoning-effort option — only present for models that support it (empty list => hide in UI)
  const effOpt = co.find(o => o.id === 'effort' || o.category === 'thought_level')
  effortLevels = (effOpt && effOpt.options || []).map(o => ({ value: o.value, name: o.name }))
  if (effOpt) { curEffort = effOpt.currentValue || curEffort; effortConfigId = effOpt.id || effortConfigId }
  else { effortLevels = []; curEffort = '' }
}

async function newSession() {
  const s = await conn.newSession({ cwd: WORKDIR, mcpServers: [] })
  sessionId = s.sessionId
  extractConfig(s.configOptions)
  let forceModel = false
  if (!curModel) curModel = (models[0] && models[0].value) || 'anthropic/claude-opus-4-8'
  // Auto-select a usable model: if the configured default's provider has no key but the user DID
  // add a key for some other provider, switch to a model that actually works — otherwise a
  // Gemini-only user who kept the shipped anthropic default would fail every turn with a
  // "add the anthropic key" message for a key they don't have (and adding one never switched).
  if (!modelUsable(curModel) && models.length) {
    const alt = models.find(m => modelPickable(m.value))
    if (alt && alt.value !== curModel) {
      log('auto-select model:', curModel, '(no key) ->', alt.value)
      curModel = alt.value
      forceModel = true   // we changed it, so push it to the engine below even without an explicit launch override
    }
  }
  // Force the model to the engine when the launcher passed one (argv[4]) OR we just auto-switched;
  // otherwise leave the engine on the model it loaded from opencode.json.
  if (DEFAULT_MODEL || forceModel) { try { await conn.unstable_setSessionModel({ sessionId, modelId: curModel }) } catch (e) { log('setModel', e.message); broadcast({ type: 'error', message: 'Could not select model "' + curModel + '" — check that its server is running and the model is loaded. (' + e.message + ')' }) } }
  return s
}

async function start() {
  if (!OPENCODE_SRC && !fs.existsSync(ENGINE)) {   // engine preflight — clear message instead of a raw ENOENT
    const getEngine = isWin ? 'download opencode.exe into an engine/ folder (see SETUP.md)' : 'build the engine into engine/opencode (see SETUP.md, macOS section)'
    lastEngineDown = { type: 'engine-down', message: 'Engine not found at ' + ENGINE + ' — ' + getEngine + ', or set AGENT_OMEGA_ENGINE.' }
    log('engine missing:', ENGINE); broadcast(lastEngineDown); return
  }
  const [cmd, baseArgs] = OPENCODE_SRC
    ? [BUN, ['run', '--cwd', OPENCODE_SRC, '--conditions=browser', 'src/index.ts']]
    : [ENGINE, []]
  log('engine:', cmd, baseArgs.join(' '))
  // Strip the WS token AND the API password from the env the engine (and thus the model's shell)
  // inherits: neither is the engine's to know, and the model must never read the API password.
  const { AO_WS_TOKEN: _wsTok, AO_API_PASSWORD: _apiPw, ...engineEnv } = process.env
  // Pin the engine's HTTP API port (deterministic, per-instance) so the UI can call the session
  // API directly; without --port the engine lands on 4096-or-random silently.
  // OPENCODE_SERVER_PASSWORD turns on the engine's Basic auth so the API is NOT an open local RCE
  // (see API_PASSWORD above). --cors null then lets the legitimate file:// UI (Origin "null") read
  // responses; the password still 401s any unauthenticated null-origin / rebinding / local caller.
  const engineFullEnv = { ...engineEnv, ...vaultEnv(), OPENCODE_SERVER_PASSWORD: API_PASSWORD, OPENCODE_SERVER_USERNAME: API_USER }
  const proc = spawn(cmd, [...baseArgs, 'acp', '--cwd', WORKDIR, '--port', String(API_PORT), '--cors', 'null'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: engineFullEnv })
  engineProc = proc
  proc.on('error', e => { log('spawn error', e.message); if (!restarting) { lastEngineDown = { type: 'engine-down', message: e.message }; broadcast(lastEngineDown) } })
  proc.on('exit', c => { log('engine exited', c); if (!restarting) { lastEngineDown = { type: 'engine-down', message: 'engine exited ' + c }; broadcast(lastEngineDown) } })
  conn = new acp.ClientSideConnection((_a) => new UIClient(), acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout)))
  await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } })
  await newSession()
  log('ready: session', sessionId, '| models', models.length, '| agents', agents.length)
  lastEngineDown = null
  broadcast(readyMsg())
}
function readyMsg() { return { type: 'ready', sessionId, model: curModel, agent: curAgent, models, agents, commands, effort: curEffort, effortLevels, apiPort: API_PORT, apiAuth: API_AUTH, workdir: WORKDIR } }

// Re-spawn the engine so a just-changed vault key takes effect (the engine reads keys once, at spawn).
async function restartEngine() {
  restarting = true
  const prev = sessionId   // restore the active session after the respawn instead of dumping the user into a fresh one
  drainPerms(); busy = false
  try { if (engineProc) engineProc.kill() } catch {}
  conn = null; sessionId = null
  await new Promise((r) => setTimeout(r, 350))
  restarting = false
  await start()   // fresh vaultEnv() -> the new/removed key is now reflected
  if (prev && conn) {
    broadcast({ type: 'replay-start', sessionId: prev })
    try {
      const r = await conn.loadSession({ sessionId: prev, cwd: WORKDIR, mcpServers: [] })
      sessionId = prev
      curModel = ''
      extractConfig(r && r.configOptions)
      broadcast({ type: 'replay-end', sessionId })
      broadcast(readyMsg())
    } catch (e) { log('restore-session', e.message); broadcast({ type: 'replay-end', sessionId: prev }) }
  }
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
  else if (lastEngineDown) send(ws, lastEngineDown)   // replay a startup engine failure to a late-connecting UI
  ws.on('message', async (data) => {
    let m; try { m = JSON.parse(data.toString()) } catch { return }
    try {
      switch (m.type) {
        case 'prompt': {
          if (busy || !m.text) return
          busy = true; turnOutput = 0; turnLogOffset = engineLogSize(); broadcast({ type: 'turn-start' })
          // The engine can swallow a provider failure (e.g. a 401 from a bad API key) and
          // resolve the turn with NO output at all — the user would see pure silence. A
          // completed turn with zero meaningful updates is that case: say so.
          try { const r = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: m.text }] }); if (turnOutput === 0) broadcast({ type: 'error', message: await emptyTurnError() }); broadcast({ type: 'turn-end', stopReason: r.stopReason }) }
          catch (e) { broadcast({ type: 'error', message: friendlyError(e.message) }) }
          finally { busy = false }
          break
        }
        case 'command': {
          if (busy || !m.name) return
          busy = true; turnOutput = 0; turnLogOffset = engineLogSize(); broadcast({ type: 'turn-start' })
          try { const r = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: '/' + m.name + (m.args ? ' ' + m.args : '') }] }); if (turnOutput === 0) broadcast({ type: 'error', message: await emptyTurnError() }); broadcast({ type: 'turn-end', stopReason: r.stopReason }) }
          catch (e) { broadcast({ type: 'error', message: friendlyError(e.message) }) }
          finally { busy = false }
          break
        }
        case 'permissionReply': {
          const resolve = pendingPerms.get(m.toolCallId); if (resolve) { pendingPerms.delete(m.toolCallId); resolve({ outcome: { outcome: 'selected', optionId: m.optionId } }) }
          break
        }
        case 'setModel': { const prev = curModel; curModel = m.model; try { await conn.unstable_setSessionModel({ sessionId, modelId: curModel }) } catch (e) { curModel = prev; log('setModel', e.message); broadcast({ type: 'error', message: 'Could not select model "' + m.model + '" — ' + e.message }) } broadcast({ type: 'model', model: curModel }); break }
        case 'setAgent': { const prev = curAgent; curAgent = m.agent; try { await conn.setSessionConfigOption({ sessionId, configId: agentConfigId, value: curAgent }) } catch (e) { curAgent = prev; log('setAgent', e.message); broadcast({ type: 'error', message: 'Could not switch agent — ' + e.message }) } broadcast({ type: 'agent', agent: curAgent }); break }
        case 'setEffort': { if (!effortLevels.length) { broadcast({ type: 'error', message: 'This model has no effort levels.' }); break } const prev = curEffort; curEffort = m.value; try { await conn.setSessionConfigOption({ sessionId, configId: effortConfigId, value: curEffort }) } catch (e) { curEffort = prev; log('setEffort', e.message); broadcast({ type: 'error', message: 'Could not set effort — ' + e.message }) } broadcast({ type: 'effort', effort: curEffort }); break }
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
            if (typeof m.value !== 'string' || m.value === '') { send(ws, { type: 'vaultKeys', error: 'value required' }); break }
            // Pass the secret on STDIN, never as an argv element — argv would land in any thrown
            // error string (execFileSync embeds the full command) and could leak the key value.
            execFileSync(VAULT_CMD, [...VAULT_PRE, 'set', m.name], { input: m.value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
            const note = busy ? 'Key saved — restart the app to apply it (a turn is in progress).' : 'Key saved — engine reloaded.'
            broadcast({ type: 'vaultKeys', names: vaultListNames(), note })
            if (!busy) restartEngine().catch((e) => log('restart', e.message))   // pick up the new key without a manual restart
          } catch (e) { log('vaultSet failed for', m.name, '(exit ' + (e.status ?? '?') + ')'); send(ws, { type: 'vaultKeys', error: 'Could not store key — vault write failed.' }) }
          break
        }
        case 'vaultRemove': {
          try {
            if (typeof m.name !== 'string' || !m.name.trim()) { send(ws, { type: 'vaultKeys', error: 'name required' }); break }
            execFileSync(VAULT_CMD, [...VAULT_PRE, 'remove', m.name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
            const note = busy ? 'Key removed — restart the app to fully apply.' : 'Key removed — engine reloaded.'
            broadcast({ type: 'vaultKeys', names: vaultListNames(), note })
            if (!busy) restartEngine().catch((e) => log('restart', e.message))
          } catch (e) { log('vaultRemove failed for', m.name, '(exit ' + (e.status ?? '?') + ')'); send(ws, { type: 'vaultKeys', error: 'Could not remove key — vault write failed.' }) }
          break
        }
        case 'abort': { try { await conn.cancel({ sessionId }) } catch (e) { log('cancel', e.message) } drainPerms(); busy = false; break }
        case 'new': {
          if (busy) { try { await conn.cancel({ sessionId }) } catch {} drainPerms(); busy = false }   // don't orphan an in-flight turn
          try { await newSession() } catch (e) { log('new', e.message) } broadcast(readyMsg()); break
        }
        case 'findFile': {   // '@' file autocomplete: bounded walk of the session workdir (the ACP build has no HTTP serve)
          const q = String(m.query || '').toLowerCase(), out = []
          const walk = (dir, depth) => {
            if (out.length >= 40 || depth > 6) return
            let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
            for (const e of ents) {
              if (out.length >= 40) break
              if (e.name.startsWith('.') || e.name === 'node_modules') continue
              const full = path.join(dir, e.name), rel = path.relative(WORKDIR, full).split(path.sep).join('/')
              if (e.isDirectory()) { if (!q || rel.toLowerCase().includes(q)) out.push(rel + '/'); walk(full, depth + 1) }
              else if (!q || rel.toLowerCase().includes(q)) out.push(rel)
            }
          }
          try { walk(WORKDIR, 0) } catch (e) { log('findFile', e.message) }
          send(ws, { type: 'findFileResult', rid: m.rid, files: out.slice(0, 20) })
          break
        }
        case 'load': {
          // Switch to an existing session. The engine replays its full history as
          // ordinary update frames between replay-start / replay-end brackets.
          if (typeof m.sessionId !== 'string' || !m.sessionId.trim()) break
          if (busy) { try { await conn.cancel({ sessionId }) } catch {} drainPerms(); busy = false }
          broadcast({ type: 'replay-start', sessionId: m.sessionId })
          try {
            const r = await conn.loadSession({ sessionId: m.sessionId, cwd: WORKDIR, mcpServers: [] })
            sessionId = m.sessionId          // loadSession's response does not echo the id
            curModel = ''                    // adopt the loaded session's own model from configOptions
            extractConfig(r && r.configOptions)
            broadcast({ type: 'replay-end', sessionId })
            broadcast(readyMsg())
          } catch (e) {
            log('load', e.message)
            broadcast({ type: 'replay-end', sessionId: m.sessionId, error: friendlyError(e.message) })
          }
          break
        }
      }
    } catch (e) { log('msg error', e.message) }
  })
})

// Lifecycle: never leave the engine running once the sidecar is going down, and go down
// ourselves if the shell that launched us dies abnormally (crash / kill) without firing its
// normal child-cleanup — otherwise the engine + the bound ports would be orphaned.
function killEngine() { try { if (engineProc) engineProc.kill() } catch {} }
process.on('exit', killEngine)
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { killEngine(); process.exit(0) })
if (PARENT_PID) {
  setInterval(() => {
    try { process.kill(PARENT_PID, 0) }   // signal 0 = liveness probe, never actually signals
    catch { killEngine(); process.exit(0) }
  }, 3000).unref()
}

start().catch(e => { log('start failed', e.message); process.exit(1) })
