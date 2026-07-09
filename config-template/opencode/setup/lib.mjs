// setup/lib.mjs — helpers for the bounded setup tools. Runs on Bun (node: builtins + global fetch OK).
// Kept separate so setup/index.js can export ONLY its default plugin function (opencode loads every
// export of a plugin file as a plugin — engram gotcha).
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, mkdirSync, readdirSync, chmodSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const isWin = process.platform === 'win32'
const isLinux = !isWin && process.platform !== 'darwin'
// Linux ships no OS keychain/DPAPI vault script, so the secrets.{sh,ps1} path fails there. Read/write
// the same 0600 JSON file vault the sidecar uses (vault/file-vault.mjs), inlined because this shipped
// plugin can't import the repo module. Honors AGENT_OMEGA_FILE_VAULT like the sidecar/file-vault.
const fileVaultPath = () => process.env.AGENT_OMEGA_FILE_VAULT || path.join(os.homedir(), '.agent-omega', 'vault.json')
function fileVaultRead() { try { const o = JSON.parse(readFileSync(fileVaultPath(), 'utf8')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {} } catch (e) { if (e.code === 'ENOENT') return {}; throw e } }
function fileVaultWrite(obj) {
  const vp = fileVaultPath(); mkdirSync(path.dirname(vp), { recursive: true, mode: 0o700 })
  const tmp = vp + '.tmp'; writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch {}; renameSync(tmp, vp); try { chmodSync(vp, 0o600) } catch {}
}

export function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode')
}
export function configFile() { return path.join(configDir(), 'opencode.json') }
export function readConfig() { return JSON.parse(readFileSync(configFile(), 'utf8')) }

// vault key NAME -> engine env var (mirror sidecar VAULT_TO_ENV)
export const VAULT_TO_ENV = {
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY', OPENAI_API_KEY: 'OPENAI_API_KEY',
  DEEPSEEK_API_KEY: 'DEEPSEEK_API_KEY', ZAI_API_KEY: 'ZAI_API_KEY',
  KIMI_API_KEY: 'MOONSHOT_API_KEY', GEMINI_API_KEY: 'GOOGLE_GENERATIVE_AI_API_KEY',
}

// provider id -> the vault key it authenticates with (builtin providers are env-keyed natively, i.e.
// they carry NO options.apiKey ref in config — so key presence must be inferred from the provider id)
export const PROVIDER_KEY = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', moonshotai: 'KIMI_API_KEY', zai: 'ZAI_API_KEY', google: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY' }

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

// key NAME -> the provider's own validation endpoint (a 401/403 there = a genuinely bad key). Names not
// in this map are NEVER hard-rejected — we can't tell, so we store and say "couldn't validate".
const KEY_VALIDATION = {
  ANTHROPIC_API_KEY: { url: 'https://api.anthropic.com/v1/models', h: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  OPENAI_API_KEY: { url: 'https://api.openai.com/v1/models', h: (k) => ({ authorization: 'Bearer ' + k }) },
  DEEPSEEK_API_KEY: { url: 'https://api.deepseek.com/models', h: (k) => ({ authorization: 'Bearer ' + k }) },
  KIMI_API_KEY: { url: 'https://api.moonshot.ai/v1/models', h: (k) => ({ authorization: 'Bearer ' + k }) },
  ZAI_API_KEY: { url: 'https://api.z.ai/api/paas/v4/models', h: (k) => ({ authorization: 'Bearer ' + k }) },
  GROQ_API_KEY: { url: 'https://api.groq.com/openai/v1/models', h: (k) => ({ authorization: 'Bearer ' + k }) },
  GEMINI_API_KEY: { url: 'https://generativelanguage.googleapis.com/v1beta/models?key=', h: () => ({}), keyInUrl: true },
}
export async function validateKey(name, key) {
  const t = KEY_VALIDATION[name]
  if (!t) return { known: false }
  try {
    const url = t.keyInUrl ? t.url + encodeURIComponent(key) : t.url
    const r = await withTimeout(fetch(url, { headers: t.h(key) }), 12000)
    if (r.ok) return { known: true, ok: true }
    if (r.status === 401 || r.status === 403 || (name === 'GEMINI_API_KEY' && r.status === 400)) return { known: true, ok: false, why: 'key rejected (' + r.status + ')' }
    return { known: true, ok: false, soft: true, why: 'could not confirm the key (HTTP ' + r.status + ')' }
  } catch (e) { return { known: true, ok: false, soft: true, why: 'could not reach the provider to validate (' + (e.message || e) + ')' } }
}

// recursive merge; arrays + primitives REPLACE (matches the engine's mergeDeep semantics)
// __proto__/constructor/prototype are skipped outright — a patch built from JSON.parse can carry
// "__proto__" as a literal own key, and recursing/assigning into it would walk onto the real
// Object.prototype and pollute every plain object in the process.
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
export function deepMerge(target, patch) {
  for (const k of Object.keys(patch)) {
    if (UNSAFE_MERGE_KEYS.has(k)) continue
    const v = patch[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v)
    else target[k] = v
  }
  return target
}

// Safe config write: prefer the engine's schema-validated writer; fall back to atomic direct write
// (backup + revalidate). The engine picks the new config up on the restart the sidecar triggers.
export async function patchConfig(client, patch) {
  try {
    const fn = client && client.global && client.global.config && client.global.config.update
    if (typeof fn === 'function') { await fn.call(client.global.config, { body: patch }); return { via: 'engine' } }
  } catch (e) { /* fall through */ }
  const f = configFile()
  const cur = JSON.parse(readFileSync(f, 'utf8'))
  const next = deepMerge(cur, patch)
  const text = JSON.stringify(next, null, 2)
  JSON.parse(text) // validate serialized form
  const tmp = f + '.tmp', bak = f + '.bak.' + process.pid
  copyFileSync(f, bak)
  writeFileSync(tmp, text, 'utf8')
  JSON.parse(readFileSync(tmp, 'utf8')) // re-parse before commit
  renameSync(tmp, f)
  return { via: 'direct', backup: bak }
}

// jsonc landmine: globalConfigFile() prefers opencode.jsonc; the engine auto-seeds a {$schema} stub.
// If the live file is stub-only, retire it so writes land in the real opencode.json. Leave a real one.
export function migrateJsoncStub() {
  const j = path.join(configDir(), 'opencode.jsonc')
  if (!existsSync(j)) return { migrated: false }
  try {
    const obj = JSON.parse(readFileSync(j, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
    const keys = Object.keys(obj || {})
    if (keys.length === 0 || (keys.length === 1 && keys[0] === '$schema')) { renameSync(j, j + '.retired.' + process.pid); return { migrated: true } }
    return { migrated: false, hasKeys: true }
  } catch { return { migrated: false, unparseable: true } }
}

export function vaultPath() {
  if (isLinux) return fileVaultPath()   // Linux always uses the 0600 file vault (honors AGENT_OMEGA_FILE_VAULT); the secrets.{sh,ps1} AGENT_OMEGA_VAULT override doesn't apply here
  if (process.env.AGENT_OMEGA_VAULT) return process.env.AGENT_OMEGA_VAULT
  return path.join(os.homedir(), '.agent-omega', isWin ? 'secrets.ps1' : 'secrets.sh')
}
export function sanitizeSecret(v) {
  return String(v == null ? '' : v).replace(/[​-‍﻿]/g, '').replace(/^\s*["']|["']\s*$/g, '').trim()
}
function vaultCmd(action, name) {
  const vp = vaultPath()
  if (isWin) return ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', vp, action, ...(name ? [name] : [])]]
  return ['sh', [vp, action, ...(name ? [name] : [])]]
}
export function vaultSet(name, value) {
  if (isLinux) { try { const v = fileVaultRead(); v[name] = sanitizeSecret(value); fileVaultWrite(v); return Promise.resolve({ ok: true, out: '' }) } catch (e) { return Promise.resolve({ ok: false, err: e.message }) } }
  return new Promise((res) => {
    const [cmd, args] = vaultCmd('set', name)
    const child = execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => res({ ok: !err, out: ((stdout || '') + (stderr || '')).trim(), err: err && err.message }))
    try { child.stdin.write(sanitizeSecret(value)); child.stdin.end() } catch {}
  })
}
export function vaultList() {
  // Linux reads keys from the env FIRST (SETUP-LINUX.md), then the file vault — union both so the
  // setup agent doesn't tell a user with `export ANTHROPIC_API_KEY=…` that their key is missing.
  if (isLinux) { try {
    const fromFile = Object.keys(fileVaultRead())
    const fromEnv = Object.keys(VAULT_TO_ENV).filter((name) => process.env[VAULT_TO_ENV[name]])
    return Promise.resolve([...new Set([...fromFile, ...fromEnv])].sort())
  } catch { return Promise.resolve([]) } }
  return new Promise((res) => {
    const [cmd, args] = vaultCmd('list')
    execFile(cmd, args, { timeout: 15000 }, (err, stdout) => res(err ? [] : String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)))
  })
}

export function runDoctor() {
  return new Promise((res) => {
    const doctor = path.join(configDir(), 'doctor.mjs')
    if (!existsSync(doctor)) return res({ ok: false, out: 'doctor.mjs not found in config dir' })
    execFile('node', [doctor], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => res({ ok: !err, out: ((stdout || '') + (stderr || '')).trim() }))
  })
}

export async function providersLive(client) {
  try {
    const fn = client && client.config && client.config.providers
    if (typeof fn === 'function') { const r = await fn.call(client.config, {}); return (r && (r.data || r)) || null }
  } catch {}
  return null
}

// validation ping straight at a provider (used pre-restart, since a new key isn't in engine env yet)
export async function pingProvider({ kind, baseURL, apiKey }) {
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
  try {
    if (kind === 'anthropic') {
      const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) }), 12000)
      if (r.status === 401 || r.status === 403) return { ok: false, why: 'key rejected (' + r.status + ')' }
      return { ok: r.ok || r.status === 400, why: r.ok ? 'ok' : 'reachable (' + r.status + ')' }
    }
    // openai-compatible (cloud or local): GET /models
    const url = (baseURL || 'https://api.openai.com/v1').replace(/\/$/, '') + '/models'
    const r = await withTimeout(fetch(url, { headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {} }), 12000)
    if (r.status === 401 || r.status === 403) return { ok: false, why: 'key rejected (' + r.status + ')' }
    return { ok: r.ok, why: r.ok ? 'ok' : 'unreachable (' + r.status + ')' }
  } catch (e) { return { ok: false, why: e.message === 'timeout' ? 'timed out' : ('unreachable: ' + e.message) } }
}

// REAL end-to-end test through the engine (the shipping path). Robust to SDK response shape.
export async function testModelViaEngine(client, directory, providerID, modelID, timeoutS = 90) {
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
  let sessionID
  try {
    let created
    try { created = await withTimeout(client.session.create({ body: { directory, title: 'setup: model test' } }), 15000) }
    catch { created = await withTimeout(client.session.create(), 15000) }
    sessionID = created && (created.data ? created.data.id : created.id)
    if (!sessionID) return { ok: false, error: 'could not create a test session' }
    const t0 = Date.now()
    const resp = await withTimeout(client.session.prompt({ path: { id: sessionID }, body: { model: { providerID, modelID }, parts: [{ type: 'text', text: 'Reply with exactly: OK' }] } }), timeoutS * 1000)
    const info = (resp && (resp.data || resp)) || {}
    const err = info.error || (info.info && info.info.error)
    if (err) return { ok: false, error: typeof err === 'string' ? err : JSON.stringify(err) }
    let text = extractText(info)
    if (!text.trim()) { // fall back to reading the session messages
      try { const m = await client.session.messages({ path: { id: sessionID } }); const msgs = (m && (m.data || m)) || []; const last = [...msgs].reverse().find((x) => (x.info ? x.info.role : x.role) === 'assistant'); if (last) text = extractText(last) } catch {}
    }
    return { ok: !!text.trim(), text: text.trim().slice(0, 80), ms: Date.now() - t0 }
  } catch (e) {
    const msg = String(e && e.message || e)
    const why = /401|unauthor|invalid.*key/i.test(msg) ? 'key rejected' : /ECONNREFUSED|fetch failed|unreachable/i.test(msg) ? 'server not reachable' : /timeout/i.test(msg) ? 'timed out' : msg
    return { ok: false, error: why }
  } finally {
    if (sessionID) { try { await client.session.delete({ path: { id: sessionID } }) } catch {} }
  }
}
function extractText(node) {
  const parts = (node && (node.parts || (node.info && node.parts) || (node.data && node.data.parts))) || []
  return (Array.isArray(parts) ? parts : []).filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ')
}

// skills on disk (so freshly-added, not-yet-loaded ones show up)
export function listSkillsOnDisk() {
  const dir = path.join(configDir(), 'skill')
  const out = []
  try {
    for (const name of readdirSync(dir)) {
      const f = path.join(dir, name, 'SKILL.md')
      if (!existsSync(f)) continue
      const head = readFileSync(f, 'utf8').slice(0, 400)
      const desc = (head.match(/description:\s*(.+)/) || [])[1] || ''
      out.push({ name, description: desc.trim() })
    }
  } catch {}
  return out
}
export function skillNameOk(n) { return /^[a-z0-9][a-z0-9-]{1,40}$/.test(n) }
export function writeSkill(name, description, body, commandMd) {
  if (!skillNameOk(name)) throw new Error('invalid skill name (use kebab-case, a-z 0-9 -)')
  const base = path.join(configDir(), 'skill', name)
  const resolved = path.resolve(base)
  if (!resolved.startsWith(path.resolve(path.join(configDir(), 'skill')))) throw new Error('path escapes the skill dir')
  mkdirSync(base, { recursive: true })
  const front = `---\nname: ${name}\ndescription: ${description}\n---\n\n`
  writeFileSync(path.join(base, 'SKILL.md'), front + (body || ''), 'utf8')
  const paths = [path.join(base, 'SKILL.md')]
  if (commandMd) { const cf = path.join(configDir(), 'command', name + '.md'); writeFileSync(cf, commandMd, 'utf8'); paths.push(cf) }
  return paths
}
