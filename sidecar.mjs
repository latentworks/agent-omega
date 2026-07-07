// AgentOmega ACP sidecar — the engine driver for true terminal parity.
// Spawns `opencode acp`, speaks ACP as the CLIENT, and bridges to the UI over a
// local WebSocket. Handles: turns, live updates, interactive PERMISSIONS, model
// + agent switching, the live command list, and client fs read/write.
import { spawn, execFileSync } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import * as acp from '@agentclientprotocol/sdk'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
let setupPendingRestart = false, setupFinished = false   // Omega Setup: a setup_* tool call drives an auto-reload after config changes + a hand-back to normal Omega on finish
let onboardBusy = false   // Omega first-run: guard against a double key-submit while one onboarding attempt is in flight
let busy = false
let turnOutput = 0   // meaningful updates seen this turn — 0 at turn-end means the engine swallowed a provider failure
const pendingPerms = new Map()   // toolCallId -> resolve fn
// Per-turn identity: busy/turnOutput are single globals, so a cancelled or superseded turn whose
// conn.prompt() only SETTLES later must not touch the live turn's state (false empty-turn error,
// premature turn-end, or unlocking busy under the next turn). Each turn stamps currentTurn; a
// continuation only acts if it is still the current turn. new/load/abort/crash reset currentTurn=0.
let turnSeq = 0, currentTurn = 0
// Engine-generation guard: each spawn bumps engineGen. A stale exit/error event (the error+exit
// pair for one proc, or an old proc we intentionally replaced during a restart) is ignored unless
// it matches the current generation — so a delayed exit can't trigger a spurious second restart.
let engineGen = 0
let engineReviving = false   // an auto-restart after a crash is in flight (lets error copy say "restarting" not "restart the app")
let crashRestartCount = 0, lastCrashAt = 0, crashRestartTimer = null
let lastSessionBeforeCrash = null   // the session the user was on when the engine last died — restored by a MANUAL restart after the crash budget is spent (sessionId is already null by then)
let restartInFlight = null           // coalesces overlapping restartEngine() triggers (WS 'restart' racing a vault auto-restart) so we spawn ONE engine, never two + an orphan
let replaying = false                // true only while a loadSession's history is replaying through sessionUpdate — exempts those chunks from the tail-chunk bleed guard
// How many times to auto-restart a crashing engine within the window before giving up (0 disables
// auto-restart: the sidecar just reports engine-down and waits for a manual app restart).
const MAX_CRASH_RESTARTS = Number(process.env.AO_MAX_CRASH_RESTARTS) >= 0 ? Math.floor(Number(process.env.AO_MAX_CRASH_RESTARTS)) : 5
const CRASH_WINDOW_MS = 60000

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

// Attach descriptor: a user-only file so a terminal client the owner opens over SSH (see
// scripts/attach.mjs) can find this instance's loopback port + token + engine API port and join
// the LIVE session. It exposes nothing to the network — the socket stays loopback-bound; the file
// is readable only by the logged-in user (same trust level as that user, who can already reach
// loopback). PER-INSTANCE (keyed by pid) so several running instances (desktop app, a test, a
// harness) don't clobber one shared file; removed on exit. AGENT_OMEGA_ATTACH pins an exact path.
const ATTACH_DIR = process.env.AGENT_OMEGA_ATTACH_DIR || path.join(os.homedir(), '.agent-omega', 'instances')
const ATTACH_FILE = process.env.AGENT_OMEGA_ATTACH || path.join(ATTACH_DIR, process.pid + '.json')
function writeAttachDescriptor() {
  try {
    const dir = path.dirname(ATTACH_FILE)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(ATTACH_FILE, JSON.stringify({ port: WS_PORT, apiPort: API_PORT, token: WS_TOKEN, pid: process.pid, cwd: WORKDIR }), { mode: 0o600 })
    // The descriptor holds the control-socket token, so it MUST stay user-only. writeFileSync's
    // mode is masked by umask AND ignored on filesystems with a permissive default ACL (some
    // NAS/network mounts create 0777 regardless) — chmod explicitly, and lock the dir too, so a
    // world-readable token can't leak the live session on a shared box. Same guard the file vault uses.
    try { fs.chmodSync(ATTACH_FILE, 0o600) } catch {}
    try { fs.chmodSync(dir, 0o700) } catch {}
  } catch (e) { console.error('[sidecar] attach descriptor write failed', e.message) }
}
function removeAttachDescriptor() { try { fs.unlinkSync(ATTACH_FILE) } catch {} }
writeAttachDescriptor()

// A quick loopback probe: 'open' if something is listening, 'refused' if the port is definitively
// empty, 'timeout' if inconclusive. Used to age out stale attach descriptors.
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
// Cleanup never runs on the shell's HARD kill (Program.cs pr.Kill(true) = TerminateProcess → no
// exit/signal handler fires → removeAttachDescriptor is skipped), so descriptors leak one per app
// close and accumulate forever; PID reuse then resurrects them as phantom instances in attach.mjs.
// Sweep on startup: delete any descriptor whose owning pid is DEAD, or whose recorded control port
// is definitively empty (a reused pid that's alive but isn't our sidecar). We never delete on an
// inconclusive timeout, so a slow-but-live sibling instance is left intact. Best-effort, async,
// non-blocking — it must never delay or fail sidecar boot.
async function sweepStaleDescriptors() {
  try {
    const dir = path.dirname(ATTACH_FILE)
    let ents; try { ents = fs.readdirSync(dir) } catch { return }
    for (const name of ents) {
      if (!name.endsWith('.json')) continue
      const fp = path.join(dir, name)
      if (fp === ATTACH_FILE) continue                       // never touch our own live descriptor
      let d; try { d = JSON.parse(fs.readFileSync(fp, 'utf8')) }
      catch { try { fs.unlinkSync(fp) } catch {}; continue }   // unparseable → junk
      const pid = Number(d && d.pid), port = Number(d && d.port)
      let dead = false
      if (!pid) dead = true
      else { try { process.kill(pid, 0) } catch (e) { if (e.code === 'ESRCH') dead = true } }   // ESRCH = gone; EPERM = alive but not ours
      if (!dead && port) { if (await probePort(port) === 'refused') dead = true }               // pid alive but nothing on its port → reused pid
      if (dead) { try { fs.unlinkSync(fp); log('swept stale attach descriptor', name) } catch {} }
    }
  } catch (e) { log('descriptor sweep', e.message) }
}
sweepStaleDescriptors()

const clients = new Set()
function send(ws, m) { try { if (ws.readyState === 1) ws.send(JSON.stringify(m)) } catch {} }
function broadcast(m) { const s = JSON.stringify(m); for (const c of clients) { try { if (c.readyState === 1) c.send(s) } catch {} } }
function log(...a) { console.error('[sidecar]', ...a) }

// Turn a raw provider/engine error into an actionable hint (missing key, unreachable server).
function friendlyError(msg) {
  const m = String(msg || '')
  const prov = (curModel || '').split('/')[0] || 'this provider'
  // Engine process itself is gone (crash / killed): the ACP stream closes and every write EPIPEs.
  // Do NOT blame the provider's network (the /connect/ pattern below would otherwise match "ACP
  // connection closed") — the endpoint is fine, the local engine died. Say so, and note the
  // auto-restart when one is underway so the user just retries instead of relaunching the app.
  const engineDead = !engineProc || engineProc.exitCode !== null || engineProc.killed
  if ((engineDead && /connection closed|EPIPE|stream|closed|ended|abort|ECONNRESET/i.test(m)) || /ACP connection closed/i.test(m))
    return engineReviving
      ? 'The engine stopped unexpectedly and is restarting automatically — retry in a moment.  [' + m.slice(0, 140) + ']'
      : 'The engine has stopped — restart Agent Omega.  [' + m.slice(0, 140) + ']'
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

// True while the engine is gone / going down (crash, kill, or an in-flight auto/manual restart). The
// in-flight turn's own catch uses this to STAY SILENT: handleEngineGone / restartEngine own the single
// authoritative engine-down message ("restarting automatically…" or "keeps crashing — restart"), so
// the turn must not race a contradictory "restart Agent Omega" line onto the transcript ahead of it.
function engineGoneOrRestarting() {
  return engineReviving || restarting || !engineProc || engineProc.exitCode !== null || engineProc.killed
}
// When the engine is KILLED externally, the ACP stream closes and the pending prompt rejects with one
// of these reasons BEFORE Node's 'exit' event fires — so engineProc.exitCode is still null and the
// check above hasn't tripped yet. Recognise the engine-death shape of the rejection itself so the turn
// still stays silent (handleEngineGone fires a beat later and owns the message). This is the LOCAL ACP
// channel dying, distinct from a provider HTTP error (fetch failed / ECONNREFUSED / 401), which stays
// loud and actionable.
function isEngineDeathError(msg) {
  return /ACP connection|connection closed|EPIPE|stream (closed|ended)|premature close/i.test(String(msg || ''))
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
const CONFIG_DIR = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')   // honors XDG_CONFIG_HOME so an isolated instance reads its own config (council, onboarding marker, AGENTS.md)
const COUNCIL_JSON = path.join(CONFIG_DIR, 'opencode', 'council', 'council.json')
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
  // pass through any additional *_API_KEY the setup flow stored for a NEW provider (e.g. GROQ_API_KEY),
  // 1:1 name->env, so a provider configured via /customize actually receives its key when the engine spawns.
  try {
    const known = new Set([...Object.keys(VAULT_TO_ENV), ...Object.values(VAULT_TO_ENV)])
    for (const name of vaultListNames()) { if (/^[A-Z0-9]+(_[A-Z0-9]+)*_API_KEY$/.test(name) && !known.has(name) && !out[name]) { const v = vaultGet(name); if (v) out[name] = v } }
  } catch {}
  keyedEnv = new Set(Object.keys(out))
  log('vault -> engine env: ' + (Object.keys(out).join(', ') || '(none)'))
  return out
}
// Sanitize a pasted API key before it's stored. Copy/paste (esp. from chat apps) drags in
// junk that the provider then rejects with an opaque 401: surrounding quotes, a zero-width
// space or BOM, stray whitespace/newlines. Strip all of it. We do NOT alter interior
// characters (case, dashes) — only remove what can never be part of a real key.
function sanitizeSecret(raw) {
  let v = String(raw)
  v = v.replace(/[\u200B-\u200D\uFEFF\u2060\u00A0]/g, '')   // zero-width chars, BOM, word-joiner, non-breaking space
  v = v.replace(/[\x00-\x1F\x7F]/g, '')                       // ASCII control chars incl. stray CR / LF / TAB
  v = v.trim()
  // strip one layer of surrounding matched quotes (a paste like: "sk-..." or 'sk-...')
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1).trim()
  return v
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
// Pure message builder (no I/O) so the diagnosis logic is unit-testable. `prov` is the model's
// provider prefix, `detail` is the exact error the engine logged this turn (may be empty).
function buildEmptyTurnMessage(prov, detail) {
  const isLocal = prov === 'local' || prov === 'opencode'   // keyless: 'local' uses apiKey 'local-noauth', so there is no key to "fix"
  const keyed = !!PROVIDER_ENV[prov]                        // a cloud provider that authenticates with a vault API key
  const authShaped = /401|403|unauthor|authentication|api[_ -]?key|invalid.*key|missing.*key|no auth|credit|quota|expired|payment/i.test(detail)
  if (detail) {
    // Only steer to the Vault when the failure is actually auth-shaped, or the provider is a keyed
    // cloud one. For a keyless local server a "Not Found"/route error means the model name or
    // baseURL is wrong — sending the user to re-paste a key they don't have is a dead end (WS-05).
    if (isLocal && !authShaped)
      return prov + ' returned an error: "' + detail + '"  — check the local server: is the model you selected actually loaded there, and is its baseURL correct? Full log: ' + ENGINE_LOG
    const advice = (authShaped || keyed)
      ? '  — fix the key in Settings → Vault (paste the raw value, no quotes/spaces; it applies on engine reload).'
      : ''
    return prov + ' rejected the request: "' + detail + '"' + advice + ' Full log: ' + ENGINE_LOG
  }
  if (isLocal)
    return 'The model returned nothing — the local server (' + prov + ') accepted the request but produced no output. Check that the model is loaded and healthy and its context window is large enough. Exact error, if any: ' + ENGINE_LOG
  return 'The model returned nothing — ' + prov + "'s API most likely rejected the request. Usual causes: an invalid/expired API key (Settings → Vault: re-paste the raw key, no quotes or spaces), an account with no credit, or a model this key can't access. Exact error, if any: " + ENGINE_LOG
}
async function emptyTurnError() {
  await new Promise(r => setTimeout(r, 800))   // the engine flushes its log a beat AFTER the turn resolves — give it that beat
  const prov = (curModel || '').split('/')[0] || 'the provider'
  return buildEmptyTurnMessage(prov, engineErrorSince(turnLogOffset))
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

// ======================= Omega first-run onboarding =======================
// A fresh install ships providers but no keys -> no model works and every turn fails. Detect that
// and let the UI collect + validate ONE key via a non-model card (the chicken-and-egg: no model can
// run the setup conversation until a key exists), then hand off to the Phase 1 setup agent. All the
// validate/store/config logic is imported from the LIVE setup plugin's lib.mjs (Node-safe, dual-
// runtime) so onboarding and /customize never diverge.
const ONBOARD_MARKER = path.join(CONFIG_DIR, 'opencode', 'omega-onboard.json')
const GLOBAL_CONFIG = path.join(CONFIG_DIR, 'opencode', 'opencode.json')
const ONBOARD_PROVIDERS = [
  { id: 'anthropic',  label: 'Anthropic · Claude', keyName: 'ANTHROPIC_API_KEY', kind: 'key', placeholder: 'sk-ant-…' },
  { id: 'openai',     label: 'OpenAI · GPT',       keyName: 'OPENAI_API_KEY',    kind: 'key', placeholder: 'sk-…' },
  { id: 'deepseek',   label: 'DeepSeek',           keyName: 'DEEPSEEK_API_KEY',  kind: 'key', placeholder: 'sk-…' },
  { id: 'moonshotai', label: 'Moonshot · Kimi',    keyName: 'KIMI_API_KEY',      kind: 'key', placeholder: 'sk-…' },
  { id: 'zai',        label: 'Z.ai · GLM',         keyName: 'ZAI_API_KEY',       kind: 'key', placeholder: '…' },
  { id: 'local',      label: 'Local server',       kind: 'url',                  placeholder: 'http://127.0.0.1:8080/v1' },
]
const ONBOARD_RECOMMENDED = 'anthropic'
let _setupLib = null, _setupLibTried = false
async function loadSetupLib() {
  if (_setupLibTried) return _setupLib
  _setupLibTried = true
  try { _setupLib = await import(pathToFileURL(path.join(CONFIG_DIR, 'opencode', 'setup', 'lib.mjs')).href) }
  catch (e) { log('onboard: setup lib import failed (' + e.message + ') — validation degrades to store-only'); _setupLib = null }
  return _setupLib
}
function onboardDismissed() { try { return !!JSON.parse(fs.readFileSync(ONBOARD_MARKER, 'utf8')).dismissed } catch { return false } }
// needs onboarding iff: no key reached the engine AND no provider is self-sufficient (a local
// baseURL or a literal inline apiKey) AND the user hasn't dismissed the card. Statically decidable
// from live key presence + config content — never a "has run before" flag.
function computeOnboard() {
  if (keyedEnv.size > 0) return { needed: false }
  try {
    const cfg = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf8'))
    const provs = cfg.provider || {}
    const enabled = Array.isArray(cfg.enabled_providers) ? cfg.enabled_providers : Object.keys(provs)
    for (const pid of enabled) {
      const o = (provs[pid] || {}).options || {}
      const url = String(o.baseURL || '').trim()
      const key = String(o.apiKey || '')
      if (key && !/^\{env:/.test(key) && key !== 'local-noauth') return { needed: false }   // an inline literal key works with no vault
      if (url && (key === '' || key === 'local-noauth')) return { needed: false }             // a local no-auth server works with no key (a cloud baseURL + {env:} key does NOT)
    }
  } catch {}
  if (onboardDismissed()) return { needed: false }
  return { needed: true }
}
function firstRunMsg() { return { type: 'first-run', needed: computeOnboard().needed, providers: ONBOARD_PROVIDERS, recommended: ONBOARD_RECOMMENDED } }
function broadcastOnboard() { try { broadcast(firstRunMsg()) } catch (e) { log('onboard broadcast', e.message) } }
// store a key WITHOUT restarting (onboarding does its own restart). Secret on STDIN, never argv.
function vaultStore(name, cleanVal) { execFileSync(VAULT_CMD, [...VAULT_PRE, 'set', name], { input: cleanVal, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) }
// best default model for a provider from the LIVE list: first pickable model of that provider, else
// first pickable overall (mirrors newSession's auto-select). '' if nothing is usable yet.
function pickModelFor(providerId) {
  const mine = models.find((m) => String(m.value).startsWith(providerId + '/') && modelPickable(m.value))
  if (mine) return mine.value
  const any = models.find((m) => modelPickable(m.value))
  return any ? any.value : ''
}
// run one slash-command turn (the body of the WS 'command' case) — reused for the onboarding handoff.
async function runCommandTurn(name, args) {
  if (!conn || busy) return
  setupPendingRestart = false; setupFinished = false
  const myTurn = ++turnSeq; currentTurn = myTurn
  busy = true; turnOutput = 0; turnLogOffset = engineLogSize(); broadcast({ type: 'turn-start' })
  try { const r = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: '/' + name + (args ? ' ' + args : '') }] }); if (myTurn === currentTurn) { if (turnOutput === 0) broadcast({ type: 'error', message: await emptyTurnError() }); broadcast({ type: 'turn-end', stopReason: r.stopReason }) } }
  catch (e) { if (myTurn === currentTurn && !engineGoneOrRestarting() && !isEngineDeathError(e.message)) broadcast({ type: 'error', message: friendlyError(e.message) }) }
  finally { if (myTurn === currentTurn) busy = false }
  if (myTurn === currentTurn) await afterSetupTurn()
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
      // hide opencode's built-in /customize-opencode — Omega's own /customize replaces it (showing both confuses users)
      commands = (u.availableCommands || u.commands || []).filter((c) => { const n = (c && (c.name || c.id)) || c; return String(n).toLowerCase() !== 'customize-opencode' })
      broadcast({ type: 'commands', commands })
      return
    }
    // Tail-chunk bleed guard: new/abort/load supersede a turn by setting currentTurn=0, but the engine
    // can still have a few buffered assistant chunks in flight for that dead turn. Drop them so a
    // cancelled turn's text can't render AFTER the fresh 'ready'/next turn. Replayed history (loadSession,
    // which streams through this same path) is exempt — it legitimately arrives with no active turn.
    if (!replaying && currentTurn === 0 && u && (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk')) return
    if (u && u.sessionUpdate !== 'usage_update') turnOutput++   // text/thought/tool call/plan = real output
    // Omega Setup: the setup tools run in THIS (driver) session, so watch its ACP tool-call stream here.
    // Match on the tool NAME only (u.title = the tool id) — NOT the whole payload, since a skill body /
    // args could mention a tool name. Fire on the call; the action runs at turn end (the tool has settled
    // by then). A mutating setup tool -> reload; finish -> hand back. A stale flag from an aborted/errored
    // turn is dropped at the next turn's start (see the turn-start clears), and the plugin's error paths
    // don't change config, so a no-op reload is harmless.
    if (u && curAgent === 'setup' && u.sessionUpdate === 'tool_call' && typeof u.title === 'string') {
      if (u.title === 'setup_finish') setupFinished = true
      else if (/^setup_(add_model|set_key|add_skill|set_effort)$/.test(u.title)) setupPendingRestart = true
    }
    broadcast({ type: 'update', update: u })
  }
  async writeTextFile(p) { try { fs.writeFileSync(p.path, p.content ?? '') } catch (e) { log('writeTextFile', p.path, e.message); broadcast({ type: 'error', message: 'Write to ' + p.path + ' failed: ' + e.message }); throw e } return {} }
  async readTextFile(p) { try { return { content: fs.readFileSync(p.path, 'utf8') } } catch (e) { log('readTextFile', p.path, e.message); throw e } }
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
  // Guarantee the AGENTS.md system prompt reaches the model. opencode's file-discovery for a GLOBAL
  // AGENTS.md is unreliable — it ignores XDG_CONFIG_HOME/OPENCODE_CONFIG_DIR for AGENTS.md when any
  // other AGENTS.md exists (opencode issues #7003 / #11534 / #22020), so on a fresh install the
  // shipped heart silently never loads. We inject it EXPLICITLY via opencode.json's `instructions`
  // field (which IS honored), pointed at this resolved absolute path. Same config-dir convention as
  // the council/vault lookups above (XDG_CONFIG_HOME || ~/.config).
  const _cfgDir = CONFIG_DIR
  // Forward slashes ONLY: opencode substitutes {env:AGENT_OMEGA_AGENTS} into the config TEXT before
  // JSON-parsing, so a Windows backslash path (C:\...) would be an invalid JSON escape and break the
  // whole config load. Normalize to '/'.
  const _agentsPath = path.join(_cfgDir, 'opencode', 'AGENTS.md').replace(/\\/g, '/')
  const engineFullEnv = { ...engineEnv, ...vaultEnv(), OPENCODE_SERVER_PASSWORD: API_PASSWORD, OPENCODE_SERVER_USERNAME: API_USER, AGENT_OMEGA_AGENTS: _agentsPath }
  const proc = spawn(cmd, [...baseArgs, 'acp', '--cwd', WORKDIR, '--port', String(API_PORT), '--cors', 'null'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: engineFullEnv })
  engineProc = proc
  const myGen = ++engineGen           // this spawn's generation; a later spawn bumps it and orphans these handlers
  let gone = false                    // error AND exit can both fire for one proc — collapse to a single handling
  const onGone = (reason) => { if (gone) return; gone = true; handleEngineGone(reason, myGen) }
  proc.on('error', e => { log('spawn error', e.message); onGone('spawn error: ' + e.message) })
  proc.on('exit', c => { log('engine exited', c); onGone('engine exited ' + c) })
  conn = new acp.ClientSideConnection((_a) => new UIClient(), acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout)))
  await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } })
  await newSession()
  log('ready: session', sessionId, '| models', models.length, '| agents', agents.length)
  lastEngineDown = null
  engineReviving = false   // the engine is back up; error copy stops advertising an in-flight restart
  broadcast(readyMsg())
  broadcastOnboard()   // after every (re)start, with fresh keyedEnv: tell the UI whether first-run onboarding is needed
  subscribeEngineEvents(myGen)   // start/refresh the toast->notice forwarder for this engine generation (PLG-4)
}

// A plugin's client.tui.showToast (e.g. skill-router's one-time "classifier inert" notice) is
// published on the engine's HTTP event bus but NEVER crosses the ACP channel the sidecar bridges,
// so it's invisible in the WebView host. Subscribe to the engine's loopback /event SSE (Basic-auth,
// same API port the UI uses) and re-broadcast toast events to the UI as {type:'notice'} frames the
// app renders as a sysLine (PLG-4). Generation-guarded + aborted on engine restart so an old stream
// can't outlive its engine.
let eventAbort = null
// Fix 2 — surface subagent (child-session) activity. A subagent turn runs in a CHILD session inside the
// engine; its live output publishes to the /event bus (same working directory → passes the stream's
// directory filter) but NEVER crosses the ACP channel the sidecar bridges (ACP carries only the driver's
// own session — which is why the UI otherwise sees just a static "task" line). So we tap /event here,
// learn each child from its session.created.parentID, and forward the child's parts to the UI as
// {type:'subagent'} frames. The driver's task tool part carries state.metadata.sessionId (= the child) and
// its callID (which the engine also uses as the ACP toolCallId — see acp/event.ts), tying a panel to the
// exact task line the UI already renders. All payload shapes below are verified from real /event captures.
const childSessions = new Map()   // childSessionID -> { parentID, title }
function slimSubPart(part) {
  const o = { id: part.id, type: part.type }
  if (part.type === 'text') o.text = String(part.text || '').slice(0, 8000)
  else if (part.type === 'reasoning') o.text = String(part.text || '').slice(0, 4000)
  else if (part.type === 'tool') {
    const st = part.state || {}
    o.tool = part.tool; o.callID = part.callID; o.status = st.status || ''
    const inp = st.input || {}
    // one-line hint: whatever locating field the tool carries (path / command / pattern / description)
    o.hint = String(inp.filePath || inp.path || inp.command || inp.pattern || inp.description || st.title || '').slice(0, 160)
  }
  return o
}
function forwardEngineEvent(evt) {
  try {
    const type = evt && evt.type
    const p = (evt && (evt.properties || evt.body)) || {}
    // plugin toast -> sysLine notice (PLG-4)
    if (typeof type === 'string' && type.indexOf('toast') !== -1) {
      if (p.message) broadcast({ type: 'notice', message: String(p.message), title: p.title || '', variant: p.variant || 'info' })
      return
    }
    // a child (subagent) session was spawned — remember it, tell the UI to open a nested panel
    if (type === 'session.created') {
      const info = p.info || {}
      if (info.parentID) {
        childSessions.set(info.id, { parentID: info.parentID, title: info.title || '' })
        broadcast({ type: 'subagent', phase: 'created', childId: info.id, parentId: info.parentID, title: info.title || '' })
      }
      return
    }
    if (type === 'message.part.updated') {
      const part = p.part || {}
      const sid = part.sessionID
      // driver's task tool part -> tie the child to the task line (callID) + relay its status
      if (part.type === 'tool' && part.tool === 'task') {
        const cid = part.state && part.state.metadata && part.state.metadata.sessionId
        if (cid) broadcast({ type: 'subagent', phase: 'link', childId: cid, callID: part.callID, status: (part.state && part.state.status) || '' })
        return
      }
      // a known child's own part -> forward as behind-the-scenes activity
      if (sid && childSessions.has(sid)) broadcast({ type: 'subagent', phase: 'part', childId: sid, part: slimSubPart(part) })
      return
    }
    // child went idle -> its turn finished
    if (type === 'session.idle') {
      const sid = p.sessionID
      if (sid && childSessions.has(sid)) { broadcast({ type: 'subagent', phase: 'end', childId: sid }); childSessions.delete(sid) }
      return
    }
  } catch {}
}
async function subscribeEngineEvents(gen) {
  try {
    if (eventAbort) { try { eventAbort.abort() } catch {} }
    const ac = new AbortController(); eventAbort = ac
    const res = await fetch('http://127.0.0.1:' + API_PORT + '/event', { headers: { Authorization: API_AUTH, Accept: 'text/event-stream' }, signal: ac.signal })
    if (!res.ok || !res.body) { log('event stream unavailable: HTTP', res.status); return }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
    while (true) {
      if (gen !== engineGen) { try { reader.cancel() } catch {}; return }   // a newer engine superseded this stream
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let evt; try { evt = JSON.parse(payload) } catch { continue }
        forwardEngineEvent(evt)
      }
    }
  } catch (e) { if (!(e && e.name === 'AbortError')) log('event stream', e.message) }
}

// The engine process died (crash / external kill / failed spawn) — NOT an intentional restartEngine
// kill, which sets `restarting` and owns its own lifecycle. Surface it loudly, tear down the dead
// session state so a reconnecting client isn't handed a stale "ready" (WS-01), settle any in-flight
// turn, then attempt an auto-restart with exponential backoff (capped, so a permanently-broken
// engine can't spin forever).
function handleEngineGone(reason, gen) {
  if (restarting) return               // an intentional restart is draining this exit; it will re-broadcast state
  if (gen !== engineGen) return        // a stale event from a superseded generation
  engineReviving = true                // mark revival at the very START so any in-flight turn's friendlyError says "restarting", not "restart the app" (the exhausted-budget branch below flips it back off)
  const wasBusy = busy
  const prev = sessionId               // the session the user was on — restore it after the engine comes back
  lastSessionBeforeCrash = prev        // stash it: after the crash budget is spent sessionId is null, so a MANUAL restart falls back to this to avoid dumping the user into a blank session
  conn = null; sessionId = null; busy = false; currentTurn = 0   // clear so WS 'connect'/'new'/'load'/prompt stop masking the dead engine
  drainPerms()
  const now = Date.now()
  if (now - lastCrashAt > CRASH_WINDOW_MS) crashRestartCount = 0   // a long-stable engine that finally dies starts the counter fresh
  lastCrashAt = now
  if (crashRestartCount >= MAX_CRASH_RESTARTS) {
    engineReviving = false
    lastEngineDown = { type: 'engine-down', message: 'The engine keeps crashing (' + reason + ') and could not be restarted after ' + MAX_CRASH_RESTARTS + ' attempts — please restart Agent Omega.' }
    log('engine gone, giving up after', MAX_CRASH_RESTARTS, 'restarts'); broadcast(lastEngineDown)
    if (wasBusy) broadcast({ type: 'turn-end', stopReason: 'engine-down' })
    return
  }
  crashRestartCount++
  engineReviving = true
  lastEngineDown = { type: 'engine-down', message: 'The engine stopped unexpectedly (' + reason + ') — restarting automatically…' }
  log('engine gone:', reason, '-> auto-restart', crashRestartCount + '/' + MAX_CRASH_RESTARTS)
  broadcast(lastEngineDown)
  if (wasBusy) broadcast({ type: 'turn-end', stopReason: 'engine-down' })   // unstick the UI's generating state
  const delay = Math.min(400 * 2 ** (crashRestartCount - 1), 8000)
  if (crashRestartTimer) clearTimeout(crashRestartTimer)
  const prevAgentGone = curAgent   // survive a crash mid-setup: re-apply setup mode after auto-recovery
  crashRestartTimer = setTimeout(() => { crashRestartTimer = null; autoRecover(prev, prevAgentGone).catch(e => log('auto-recover failed', e.message)) }, delay)
}

// Reload the session the user was on (if any) after the engine comes back, so a crash mid-work
// doesn't dump them into a blank session — mirrors restartEngine's restore path.
async function restoreSession(prev, prevAgent) {
  if (!prev || !conn || sessionId === prev) return
  broadcast({ type: 'replay-start', sessionId: prev })
  replaying = true   // history streams through sessionUpdate with no active turn — exempt it from the tail-chunk guard
  try {
    const wasSetup = (prevAgent === 'setup')   // snapshot from BEFORE start()/extractConfig reset curAgent — re-apply setup so a mid-setup reload stays in setup mode
    const r = await conn.loadSession({ sessionId: prev, cwd: WORKDIR, mcpServers: [] })
    sessionId = prev
    curModel = ''
    extractConfig(r && r.configOptions)
    if (wasSetup && conn) { try { curAgent = 'setup'; await conn.setSessionConfigOption({ sessionId, configId: agentConfigId, value: 'setup' }) } catch (e) { log('restore setup mode', e.message) } }
    broadcast({ type: 'replay-end', sessionId })
    broadcast(readyMsg())
  } catch (e) { log('restore-session', e.message); broadcast({ type: 'replay-end', sessionId: prev }) }
  finally { replaying = false }
}

async function autoRecover(prev, prevAgent) {
  await start()          // fresh engine + new session; broadcasts ready (and clears engineReviving on success)
  await restoreSession(prev, prevAgent)
}
function readyMsg() { return { type: 'ready', sessionId, model: curModel, agent: curAgent, models, agents, commands, effort: curEffort, effortLevels, apiPort: API_PORT, apiAuth: API_AUTH, workdir: WORKDIR } }
// The engine is not currently connected (crashed and mid-restart, or never came up). Return the
// honest engine-down notice instead of letting a handler run against a null conn and either throw
// an opaque error or (worse) mask the outage with a fake success.
function engineDownNow() { return lastEngineDown || { type: 'engine-down', message: 'The engine is not running — ' + (engineReviving ? 'it is restarting, retry in a moment.' : 'restart Agent Omega.') } }

// Re-spawn the engine so a just-changed vault key takes effect (the engine reads keys once, at spawn).
async function restartEngine() {
  // Re-entrancy guard: a WS 'restart' can race a vaultSet/vaultRemove auto-restart. Without this both
  // would kill+respawn, spawning two engines and orphaning one. Coalesce — a second trigger joins the
  // in-flight restart instead of starting its own (the single respawn's vaultEnv() already sees every
  // key written before it, so nothing is lost).
  if (restartInFlight) return restartInFlight
  restartInFlight = (async () => {
    restarting = true
    const prev = sessionId || lastSessionBeforeCrash   // fall back to the pre-crash session so a manual restart after the crash budget is spent still restores it (sessionId is null by then)
    const prevAgent = curAgent   // snapshot before start()->extractConfig resets it, so restoreSession can re-apply setup mode
    drainPerms(); busy = false
    try { if (engineProc) engineProc.kill() } catch {}
    conn = null; sessionId = null
    await new Promise((r) => setTimeout(r, 350))
    restarting = false
    await start()   // fresh vaultEnv() -> the new/removed key is now reflected
    await restoreSession(prev, prevAgent)
  })()
  try { return await restartInFlight } finally { restartInFlight = null }
}

// After a setup-mode turn settles: hand back to normal Omega if the agent called finish, then reload the
// engine if a setup tool changed config/keys/skills (the engine only reads those at spawn). busy is false
// here (called post-turn), so restartEngine never kills a live turn.
async function afterSetupTurn() {
  if (setupFinished) {
    setupFinished = false
    const vals = (agents || []).map((a) => a && (a.value || a.name || a)).filter(Boolean)
    const back = vals.includes('build') ? 'build' : (vals.find((v) => v !== 'setup') || 'build')
    try { curAgent = back; if (conn) await conn.setSessionConfigOption({ sessionId, configId: agentConfigId, value: back }); broadcast({ type: 'agent', agent: back }) } catch (e) { log('setup finish flip', e.message) }
  }
  if (setupPendingRestart) {
    setupPendingRestart = false
    try { await restartEngine(); broadcast({ type: 'notice', message: 'Reloaded — your setup changes are live.', variant: 'info' }) } catch (e) { log('setup reload', e.message) }
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
  if (sessionId) { send(ws, readyMsg()); send(ws, firstRunMsg()) }   // late-joining UI gets the onboarding state too
  else if (lastEngineDown) send(ws, lastEngineDown)   // replay a startup engine failure to a late-connecting UI
  ws.on('message', async (data) => {
    let m; try { m = JSON.parse(data.toString()) } catch { return }
    try {
      switch (m.type) {
        case 'prompt': {
          if (!conn) { broadcast({ type: 'error', message: 'The engine is reloading — try again in a moment.' }); if (typeof busy !== 'undefined') busy = false; break }
          if (busy || !m.text) return
          if (!conn) { broadcast(engineDownNow()); break }   // don't run against a dead engine — say it's down
          setupPendingRestart = false; setupFinished = false   // drop any stale setup flags from an aborted/crashed prior turn before this one runs
          const myTurn = ++turnSeq; currentTurn = myTurn
          busy = true; turnOutput = 0; turnLogOffset = engineLogSize(); broadcast({ type: 'turn-start' })
          // The engine can swallow a provider failure (e.g. a 401 from a bad API key) and
          // resolve the turn with NO output at all — the user would see pure silence. A
          // completed turn with zero meaningful updates is that case: say so.
          // The myTurn===currentTurn guards keep a turn that was superseded by new/load/abort/crash
          // (which conn.prompt only SETTLES after) from firing a stale empty-turn error, a premature
          // turn-end, or unlocking busy under the turn that replaced it.
          try { const r = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: m.text }] }); if (myTurn === currentTurn) { if (turnOutput === 0) broadcast({ type: 'error', message: await emptyTurnError() }); broadcast({ type: 'turn-end', stopReason: r.stopReason }) } }
          catch (e) { if (myTurn === currentTurn && !engineGoneOrRestarting() && !isEngineDeathError(e.message)) broadcast({ type: 'error', message: friendlyError(e.message) }) }   // engine gone/restarting -> handleEngineGone owns the one authoritative message; don't add a contradictory "restart the app" line
          finally { if (myTurn === currentTurn) busy = false }
          if (myTurn === currentTurn) await afterSetupTurn()
          break
        }
        case 'command': {
          if (!conn) { broadcast({ type: 'error', message: 'The engine is reloading — try again in a moment.' }); if (typeof busy !== 'undefined') busy = false; break }
          if (busy || !m.name) return
          if (!conn) { broadcast(engineDownNow()); break }
          // An unknown /command resolves as a zero-output turn, which emptyTurnError would misattribute
          // to an invalid API key — so a typo like /verfy tells the user to re-paste their key. Reject
          // it up front against the engine's live command list instead (fail open if we have no list).
          if (commands.length && !commands.some(c => c && (c.name === m.name || c.id === m.name))) {
            broadcast({ type: 'error', message: 'Unknown command /' + m.name + ' — type /commands to see the available commands.' })
            break
          }
          // Omega Setup: /customize and /init switch the session to the setup agent AND make it stick
          // (a bare cmd.agent frontmatter only covers this one command turn — the next plain message reverts).
          if ((m.name === 'customize' || m.name === 'init') && curAgent !== 'setup') {
            try { curAgent = 'setup'; await conn.setSessionConfigOption({ sessionId, configId: agentConfigId, value: 'setup' }); broadcast({ type: 'agent', agent: 'setup' }) }
            catch (e) { log('setup enter', e.message) }
          }
          await runCommandTurn(m.name, m.args)
          break
        }
        case 'permissionReply': {
          const resolve = pendingPerms.get(m.toolCallId); if (resolve) { pendingPerms.delete(m.toolCallId); resolve({ outcome: { outcome: 'selected', optionId: m.optionId } }) }
          break
        }
        case 'setModel': {
          if (!conn) { broadcast({ type: 'error', message: 'The engine is reloading — try again in a moment.' }); if (typeof busy !== 'undefined') busy = false; break }
          const prev = curModel; curModel = m.model
          // Switch via set-config-option, whose response carries the FRESH configOptions, rather
          // than unstable_setSessionModel (empty response): after a mid-session model change the
          // effort levels/variants differ, so re-extract and re-broadcast so the effort control
          // stays in sync instead of going stale. (configId 'model' — same parse as the model picker.)
          try { const r = await conn.setSessionConfigOption({ sessionId, configId: 'model', value: curModel }); extractConfig(r && r.configOptions); broadcast(readyMsg()) }
          catch (e) { curModel = prev; log('setModel', e.message); broadcast({ type: 'error', message: 'Could not select model "' + m.model + '" — ' + e.message }); broadcast({ type: 'model', model: curModel }) }
          break
        }
        case 'setAgent': { if (!conn) { broadcast({ type: 'error', message: 'The engine is reloading — try again in a moment.' }); if (typeof busy !== 'undefined') busy = false; break } const prev = curAgent; curAgent = m.agent; try { await conn.setSessionConfigOption({ sessionId, configId: agentConfigId, value: curAgent }) } catch (e) { curAgent = prev; log('setAgent', e.message); broadcast({ type: 'error', message: 'Could not switch agent — ' + e.message }) } broadcast({ type: 'agent', agent: curAgent }); break }
        case 'setEffort': { if (!conn) { broadcast({ type: 'error', message: 'The engine is reloading — try again in a moment.' }); if (typeof busy !== 'undefined') busy = false; break } if (!effortLevels.length) { broadcast({ type: 'error', message: 'This model has no effort levels.' }); break } const prev = curEffort; curEffort = m.value; try { await conn.setSessionConfigOption({ sessionId, configId: effortConfigId, value: curEffort }) } catch (e) { curEffort = prev; log('setEffort', e.message); broadcast({ type: 'error', message: 'Could not set effort — ' + e.message }) } broadcast({ type: 'effort', effort: curEffort }); break }
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
            const cleanVal = sanitizeSecret(m.value)
            if (typeof m.value !== 'string' || cleanVal === '') { send(ws, { type: 'vaultKeys', error: 'value required' }); break }
            const scrubbed = cleanVal !== String(m.value).trim()   // paste carried quotes/hidden chars we removed
            // Pass the secret on STDIN, never as an argv element — argv would land in any thrown
            // error string (execFileSync embeds the full command) and could leak the key value.
            execFileSync(VAULT_CMD, [...VAULT_PRE, 'set', m.name], { input: cleanVal, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
            const note = (scrubbed ? 'Cleaned stray quotes/hidden characters from the paste. ' : '') + (busy ? 'Key saved — restart the app to apply it (a turn is in progress).' : 'Key saved — engine reloaded.')
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
        case 'onboardKey': {   // Omega first-run: validate a pasted cloud key -> store -> reload -> hand off to the setup agent
          if (onboardBusy) return
          onboardBusy = true
          try {
            const prov = ONBOARD_PROVIDERS.find((p) => p.id === m.provider && p.kind === 'key')
            if (!prov) { send(ws, { type: 'onboard-result', ok: false, error: 'Unknown provider.' }); break }
            const val = sanitizeSecret(m.value)
            if (!val) { send(ws, { type: 'onboard-result', ok: false, error: 'No key entered.' }); break }
            send(ws, { type: 'onboard-status', stage: 'validating' })   // per-client: a 2nd window's idle card must not flicker through this window's progress
            let softNote = ''
            const lib = await loadSetupLib()
            if (lib && lib.validateKey) {
              const v = await lib.validateKey(prov.keyName, val)
              if (v.known && v.ok === false && !v.soft) { send(ws, { type: 'onboard-result', ok: false, error: 'That key was rejected by ' + prov.label + ' (' + v.why + '). Nothing was stored — check it and try again.' }); break }
              if (v.known && v.soft) softNote = ' (could not fully verify online — stored anyway)'
            }
            send(ws, { type: 'onboard-status', stage: 'saving' })
            try { vaultStore(prov.keyName, val) } catch (e) { log('onboard store', e.message); send(ws, { type: 'onboard-result', ok: false, error: 'Could not store the key to the vault.' }); break }
            broadcast({ type: 'vaultKeys', names: vaultListNames() })
            send(ws, { type: 'onboard-status', stage: 'reloading' })
            try { await restartEngine() } catch (e) { send(ws, { type: 'onboard-result', ok: false, error: 'The engine did not come back after saving the key.' }); break }
            const model = pickModelFor(prov.id)
            if (model) {
              curModel = model
              try { await conn.setSessionConfigOption({ sessionId, configId: 'model', value: model }) } catch (e) { log('onboard setModel', e.message) }
              try { const l2 = await loadSetupLib(); if (l2 && l2.patchConfig) await l2.patchConfig(null, { model }) } catch (e) { log('onboard persist model', e.message) }
            }
            broadcast(readyMsg())
            send(ws, { type: 'onboard-result', ok: true, provider: prov.id, model })   // result BEFORE the card-close broadcast, so the "done" state is seen
            broadcastOnboard()   // needed:false -> closes the card in every window
            try { curAgent = 'setup'; await conn.setSessionConfigOption({ sessionId, configId: agentConfigId, value: 'setup' }); broadcast({ type: 'agent', agent: 'setup' }) } catch (e) { log('onboard enter setup', e.message) }
            await runCommandTurn('customize', 'FIRST_RUN: a working ' + prov.label + ' key was just validated and stored (default model ' + (model || 'set') + ')' + softNote + '. Do NOT ask for that key again. Warmly greet the user for their very first launch in one or two lines, offer to prove the model with setup_test_model, then guide them through the rest of setup.')
          } finally { onboardBusy = false }
          break
        }
        case 'onboardLocal': {   // Omega first-run: point at a local server instead of a cloud key
          if (onboardBusy) return
          onboardBusy = true
          try {
            const url = String(m.baseUrl || '').trim()
            if (!/^https?:\/\//.test(url)) { send(ws, { type: 'onboard-result', ok: false, error: 'Enter a URL like http://127.0.0.1:8080/v1' }); break }
            send(ws, { type: 'onboard-status', stage: 'validating' })
            const lib = await loadSetupLib()
            if (lib && lib.pingProvider) { const p = await lib.pingProvider({ kind: 'openai', baseURL: url }); if (!p.ok) { send(ws, { type: 'onboard-result', ok: false, error: 'Could not reach ' + url + ' (' + p.why + '). Start the server and try again.' }); break } }
            let modelId = ''
            try { const r = await fetch(url.replace(/\/$/, '') + '/models', { signal: AbortSignal.timeout(8000) }); const j = await r.json(); modelId = (j && j.data && j.data[0] && j.data[0].id) || '' } catch {}   // bounded: a server that handshakes but never flushes /models must not wedge the card
            const guessedModel = !modelId
            if (!modelId) modelId = 'local-model'
            send(ws, { type: 'onboard-status', stage: 'saving' })
            const l2 = await loadSetupLib()
            if (l2 && l2.patchConfig) await l2.patchConfig(null, { provider: { local: { options: { baseURL: url, apiKey: 'local-noauth' }, models: { [modelId]: { name: modelId } } } }, model: 'local/' + modelId })
            send(ws, { type: 'onboard-status', stage: 'reloading' })
            try { await restartEngine() } catch (e) { send(ws, { type: 'onboard-result', ok: false, error: 'The engine did not come back.' }); break }
            curModel = 'local/' + modelId
            try { await conn.setSessionConfigOption({ sessionId, configId: 'model', value: curModel }) } catch (e) { log('onboard local setModel', e.message) }   // mirror onboardKey: pin the session's model, don't rely on config inheritance
            broadcast(readyMsg())
            send(ws, { type: 'onboard-result', ok: true, provider: 'local', model: curModel })
            broadcastOnboard()
            try { curAgent = 'setup'; await conn.setSessionConfigOption({ sessionId, configId: agentConfigId, value: 'setup' }); broadcast({ type: 'agent', agent: 'setup' }) } catch (e) { log('onboard enter setup', e.message) }
            const localNote = guessedModel ? ' I could not auto-detect the model name, so I used a placeholder — if the first test fails, tell the user to set the exact model id with /model.' : ''
            await runCommandTurn('customize', 'FIRST_RUN: a local model server at ' + url + ' was reached and set as the default (' + curModel + ').' + localNote + ' Warmly greet the user for their first launch, offer setup_test_model to prove it, then guide setup.')
          } finally { onboardBusy = false }
          break
        }
        case 'onboardSkip': {   // Omega first-run: "I'll set it up myself" -> persist a dismiss marker, close the card
          try { fs.mkdirSync(path.dirname(ONBOARD_MARKER), { recursive: true }); fs.writeFileSync(ONBOARD_MARKER, JSON.stringify({ dismissed: true }) + '\n') } catch (e) { log('onboard skip', e.message) }
          broadcastOnboard()
          break
        }
        case 'abort': { currentTurn = 0; try { await conn.cancel({ sessionId }) } catch (e) { log('cancel', e.message) } drainPerms(); busy = false; break }
        case 'restart': {
          // Manual engine restart — the app's engine-down "Restart engine" button (WS-01). Reset the
          // crash budget so a user-initiated restart isn't blocked by a prior give-up, cancel any
          // pending auto-restart, then relaunch via the shared restartEngine() path.
          if (crashRestartTimer) { clearTimeout(crashRestartTimer); crashRestartTimer = null }
          crashRestartCount = 0
          restartEngine().catch((e) => { log('manual restart', e.message); broadcast(engineDownNow()) })
          break
        }
        case 'new': {
          if (busy) { currentTurn = 0; try { await conn.cancel({ sessionId }) } catch {} drainPerms(); busy = false }   // don't orphan an in-flight turn
          if (!conn) { broadcast(engineDownNow()); break }   // engine is down — don't fake a fresh 'ready' on a dead session (WS-01)
          try { await newSession(); broadcast(readyMsg()) }
          catch (e) { log('new', e.message); broadcast(engineDownNow()) }   // newSession failed (engine likely just died): report it, don't mask with a stale ready
          break
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
          if (busy) { currentTurn = 0; try { await conn.cancel({ sessionId }) } catch {} drainPerms(); busy = false }
          if (!conn) { broadcast(engineDownNow()); break }   // engine is down — don't open a replay bracket that can't close
          broadcast({ type: 'replay-start', sessionId: m.sessionId })
          replaying = true   // exempt the replayed history from the tail-chunk guard (it streams with no active turn)
          try {
            const r = await conn.loadSession({ sessionId: m.sessionId, cwd: WORKDIR, mcpServers: [] })
            sessionId = m.sessionId          // loadSession's response does not echo the id
            curModel = ''                    // adopt the loaded session's own model from configOptions
            extractConfig(r && r.configOptions)
            broadcast({ type: 'replay-end', sessionId })
            broadcast(readyMsg())
          } catch (e) {
            log('load', e.message)
            // A missing/foreign session surfaces the engine's opaque "Internal error: OpenCode service
            // failure" — name it here (not in friendlyError, where the same string could mean other
            // things on a prompt path) so the user gets an actionable message (WS-06).
            const notFound = /Internal error: OpenCode service|session not found|no such session|unknown session|not found/i.test(e.message || '')
            const msg = notFound ? 'Session not found — it may have been deleted or belongs to a different workspace.' : friendlyError(e.message)
            broadcast({ type: 'replay-end', sessionId: m.sessionId, error: msg })
          } finally { replaying = false }
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
process.on('exit', () => { killEngine(); removeAttachDescriptor() })
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { killEngine(); removeAttachDescriptor(); process.exit(0) })
if (PARENT_PID) {
  setInterval(() => {
    try { process.kill(PARENT_PID, 0) }   // signal 0 = liveness probe, never actually signals
    catch { killEngine(); process.exit(0) }
  }, 3000).unref()
}

start().catch(e => { log('start failed', e.message); process.exit(1) })
