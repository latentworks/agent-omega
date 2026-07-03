// doctor.mjs — the engine behind the /doctor slash command.
// Read-only health check for the Agent Omega harness config. Prints PASS/WARN/FAIL lines.
// Never prints secret values (env vars are reported by NAME + set/unset only).
// Never mutates config, memory, git state, or the workspace.
//
// Usage: node doctor.mjs          (root = the directory this script lives in)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = dirname(fileURLToPath(import.meta.url))
const out = []
let fails = 0
const pass = (m) => out.push('PASS ' + m)
const warn = (m) => out.push('WARN ' + m)
const fail = (m) => { out.push('FAIL ' + m); fails++ }
const info = (m) => out.push('INFO ' + m)
const stripBom = (s) => s.replace(/^﻿/, '')

// ---- 1) config parses -----------------------------------------------------------
let cfg = null
const cfgPath = ['opencode.json', 'opencode.jsonc'].map((f) => join(ROOT, f)).find(existsSync)
if (!cfgPath) fail('config: no opencode.json/.jsonc found in ' + ROOT)
else {
  try {
    const raw = stripBom(readFileSync(cfgPath, 'utf8'))
    // tolerate jsonc-style comments if present
    cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
    pass('config: ' + basename(cfgPath) + ' parsed')
  } catch (e) { fail('config: ' + basename(cfgPath) + ' does not parse (' + String(e.message).slice(0, 80) + ')') }
}

// ---- 2) plugin wiring ----------------------------------------------------------
if (cfg) {
  const plugins = Array.isArray(cfg.plugin) ? cfg.plugin : []
  const missing = plugins.filter((p) => !existsSync(join(ROOT, p)))
  if (!plugins.length) warn('plugins: none configured')
  else if (missing.length) fail('plugins: missing file(s): ' + missing.join(', '))
  else pass('plugins: ' + plugins.length + ' configured, all files present')
}

// ---- 3) skills -----------------------------------------------------------------
const skillDir = join(ROOT, 'skill')
let skillNames = []
if (!existsSync(skillDir)) warn('skills: no skill/ directory')
else {
  const dirs = readdirSync(skillDir).filter((d) => { try { return statSync(join(skillDir, d)).isDirectory() } catch { return false } })
  skillNames = dirs.filter((d) => existsSync(join(skillDir, d, 'SKILL.md')))
  const broken = dirs.filter((d) => !existsSync(join(skillDir, d, 'SKILL.md')))
  if (broken.length) warn('skills: missing SKILL.md in: ' + broken.join(', '))
  const noDesc = []
  const emptyBody = []
  for (const d of skillNames) {
    if (d === 'router') continue // the router skill self-excludes; it is not a triggerable entry
    let text = ''
    try { text = stripBom(readFileSync(join(skillDir, d, 'SKILL.md'), 'utf8')) } catch { noDesc.push(d); continue }
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fm || !/^description:\s*\S/m.test(fm[1])) noDesc.push(d)
    if (fm && !text.slice(fm[0].length).trim()) emptyBody.push(d)
  }
  if (noDesc.length) warn('skills: no description in frontmatter (untriggerable via router): ' + noDesc.join(', '))
  if (emptyBody.length) warn('skills: empty body after frontmatter: ' + emptyBody.join(', '))
  if (skillNames.length) {
    if (!broken.length && !noDesc.length) pass('skills: ' + skillNames.length + ' discovered, all have SKILL.md + description')
    else info('skills: ' + skillNames.length + ' discovered, ' + (broken.length + noDesc.length) + ' problem(s) above')
  } else warn('skills: none discovered')
}

// ---- 4) commands (discovery, descriptions, skill wiring) ------------------------
const cmdDir = join(ROOT, 'command')
if (!existsSync(cmdDir)) warn('commands: no command/ directory')
else {
  const files = readdirSync(cmdDir).filter((f) => f.endsWith('.md'))
  let problems = 0
  for (const f of files) {
    const name = '/' + basename(f, '.md')
    let text = ''
    try { text = stripBom(readFileSync(join(cmdDir, f), 'utf8')) } catch { fail('command ' + name + ': unreadable'); problems++; continue }
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fm || !/^description:\s*\S/m.test(fm[1])) { warn('command ' + name + ': no description in frontmatter'); problems++ }
    const refs = new Set()
    for (const re of [/the ['"]([a-z0-9_-]+)['"] skill/gi, /\bskills?\/([a-z0-9_-]+)/gi]) {
      let m; while ((m = re.exec(text)) !== null) refs.add(m[1].toLowerCase())
    }
    for (const s of refs) if (!skillNames.includes(s)) { fail('command ' + name + ': invokes missing skill "' + s + '"'); problems++ }
  }
  if (files.length && !problems) pass('commands: ' + files.length + ' discovered, wiring clean')
  else if (!files.length) warn('commands: none discovered')
  else info('commands: ' + files.length + ' discovered, ' + problems + ' problem(s) above')
}

// ---- 5) providers + env keys (names only, never values) -------------------------
if (cfg && cfg.provider) {
  const enabled = Array.isArray(cfg.enabled_providers) ? cfg.enabled_providers : Object.keys(cfg.provider)
  pass('providers: ' + enabled.length + ' enabled (' + enabled.join(', ') + ')')
  for (const [name, p] of Object.entries(cfg.provider)) {
    const keyRef = p && p.options && typeof p.options.apiKey === 'string' && p.options.apiKey.match(/^\{env:([A-Z0-9_]+)\}$/)
    if (keyRef) info('provider ' + name + ': uses env ' + keyRef[1] + ' (' + (process.env[keyRef[1]] ? 'set' : 'not set in this shell — the app injects it from the vault at launch') + ')')
  }
}

// ---- 5b) default model ----------------------------------------------------------
if (cfg) {
  if (typeof cfg.model !== 'string' || !cfg.model.trim()) {
    fail('default model: cfg.model missing/empty — the engine has no top-level model to start with')
  } else {
    const enabled = Array.isArray(cfg.enabled_providers) ? cfg.enabled_providers : (cfg.provider ? Object.keys(cfg.provider) : [])
    const slash = cfg.model.indexOf('/')
    if (slash < 1) warn('default model: "' + cfg.model + '" is not in provider/model form')
    else {
      const prov = cfg.model.slice(0, slash)
      if (!enabled.includes(prov)) fail('default model: "' + cfg.model + '" points at provider "' + prov + '" not in enabled_providers (' + enabled.join(', ') + ')')
      else if (!(cfg.provider && cfg.provider[prov])) warn('default model: provider "' + prov + '" is enabled but has no provider config block')
      else pass('default model: ' + cfg.model + ' (provider "' + prov + '" enabled and configured)')
    }
  }
}

// ---- 6) local model endpoint reachability ----------------------------------------
async function probe(url, ms = 4000) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms)
    const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(t)
    return r.ok
  } catch { return false }
}
if (cfg && cfg.provider && cfg.provider.local) {
  const base = ((cfg.provider.local.options || {}).baseURL || '').replace(/\/$/, '')
  const helpers = Object.entries(cfg.agent || {}).filter(([, a]) => a && typeof a.model === 'string' && a.model.startsWith('local/'))
  if (!base) warn('local models: provider configured but no baseURL set — point it at your llama.cpp/Ollama/LM Studio server')
  else {
    const ok = await probe(base + '/models')
    if (ok) pass('local models: endpoint reachable (' + base + ')')
    else warn('local models: endpoint NOT reachable (' + base + ') — local models and helper delegation are unavailable')
    if (helpers.length) (ok ? pass : warn)('helpers: ' + helpers.map(([n]) => n).join(', ') + ' -> local endpoint ' + (ok ? 'up' : 'down'))
  }
}

// ---- 7) anon-web bridge -----------------------------------------------------------
{
  const envOk = Boolean(process.env.AGENT_OMEGA_ANONWEB && process.env.AGENT_OMEGA_ANONWEB_VENV)
  const webPy = existsSync(join(ROOT, 'web.py'))
  if (envOk && webPy) pass('anon-web: bridge installed and configured')
  else if (envOk && !webPy) warn('anon-web: env vars set but web.py is missing from the config — bridge broken')
  else info('anon-web: not configured — web search disabled (the default build; the shipped web.py activates only with an anon-web install)')
}

// ---- 8) permissions ---------------------------------------------------------------
if (cfg && cfg.permission) {
  const bash = cfg.permission.bash
  if (bash && typeof bash === 'object') {
    const entries = Object.entries(bash)
    const guarded = entries.filter(([, v]) => v === 'ask' || v === 'deny').length
    if (guarded) pass('permissions: bash has ' + guarded + ' ask/deny rule(s) incl. destructive commands')
    else warn('permissions: bash rules exist but none are ask/deny')
  } else warn('permissions: no bash rules configured')
  if (cfg.permission.webfetch === 'deny') pass('permissions: native webfetch denied (web goes through the gateway only)')
} else if (cfg) warn('permissions: no permission block')

// ---- 9) memory --------------------------------------------------------------------
{
  const mem = join(ROOT, 'memory')
  if (existsSync(join(mem, 'MEMORY.md'))) pass('memory: MEMORY.md present (' + readdirSync(mem).length + ' file(s) in memory/)')
  else if (existsSync(mem)) warn('memory: memory/ exists but no MEMORY.md index')
  else info('memory: no memory/ directory yet (created on first use)')
}

// ---- 9b) engram auto-memory (automatic fact distillation) -------------------------
{
  // Mirror engram's EXTRACT_URL derivation: process.env.ENGRAM_EXTRACT_URL || provider.local.options.baseURL.
  const localBase = cfg && cfg.provider && cfg.provider.local && cfg.provider.local.options && typeof cfg.provider.local.options.baseURL === 'string' ? cfg.provider.local.options.baseURL : ''
  const extractUrl = process.env.ENGRAM_EXTRACT_URL || localBase
  if (!extractUrl) warn('engram auto-memory: no local extraction endpoint (set provider.local.options.baseURL or ENGRAM_EXTRACT_URL) — automatic fact distillation at compaction is OFF (only manual remember + the MEMORY.md index work)')
}

// ---- 10) workspace ----------------------------------------------------------------
{
  let git = false
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }); git = true } catch {}
  info('workspace: ' + process.cwd() + (git ? ' (git repo)' : ' (not a git repo)'))
  try {
    const pkg = JSON.parse(stripBom(readFileSync(join(process.cwd(), 'package.json'), 'utf8')))
    const s = pkg.scripts || {}
    const known = ['test', 'build', 'start', 'dev'].filter((k) => s[k])
    if (known.length) info('workspace: package.json scripts detected: ' + known.join(', '))
  } catch {}
}

console.log(out.join('\n'))
console.log('\n' + (fails ? fails + ' FAILURE(S) — the harness needs attention.' : 'Harness healthy: no failures.'))
process.exit(fails ? 1 : 0)
