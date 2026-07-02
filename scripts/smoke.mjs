#!/usr/bin/env node
// Agent Omega — install smoke test. Proves the wiring is sound WITHOUT launching the app or
// spending any model tokens: Node version, config install, vault, engine binary, plugin deps,
// that every shipped plugin actually parses, and that the router/engram endpoints resolve from
// your opencode.json. Prints PASS/FAIL per check; exits non-zero if any hard check fails.
//
//   node scripts/smoke.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const HOME = os.homedir()
const XDG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')
const CFG_DIR = path.join(XDG, 'opencode')
const TEMPLATE = path.join(REPO, 'config-template', 'opencode')
// Prefer the INSTALLED config (what will actually run); fall back to the shipped template.
const PLUGIN_ROOT = existsSync(path.join(CFG_DIR, 'opencode.json')) ? CFG_DIR : TEMPLATE

let failed = 0, warned = 0
const pass = (m) => console.log('  PASS  ' + m)
const warn = (m) => { warned++; console.log('  WARN  ' + m) }
const fail = (m) => { failed++; console.log('  FAIL  ' + m) }

console.log('\n=== Agent Omega smoke test ===')
console.log('  config: ' + PLUGIN_ROOT + (PLUGIN_ROOT === TEMPLATE ? '  (template — run setup.mjs to install)' : ''))

// 1) Node version
{
  const major = Number(process.versions.node.split('.')[0])
  major >= 18 ? pass('Node ' + process.version + ' (>= 18)') : fail('Node ' + process.version + ' is < 18')
}

// 2) opencode.json present + valid + plugins listed
let cfg = null
{
  const p = path.join(PLUGIN_ROOT, 'opencode.json')
  if (!existsSync(p)) fail('opencode.json missing at ' + p)
  else {
    try {
      cfg = JSON.parse(readFileSync(p, 'utf8'))
      const plugins = Array.isArray(cfg.plugin) ? cfg.plugin.length : 0
      plugins >= 1 ? pass('opencode.json valid (' + plugins + ' plugins, model=' + (cfg.model || '?') + ')') : fail('opencode.json lists no plugins')
    } catch (e) { fail('opencode.json is not valid JSON: ' + e.message) }
  }
}

// 3) Vault script present (installed or self-heal source)
{
  const vault = process.env.AGENT_OMEGA_VAULT || path.join(HOME, '.agent-omega', 'secrets.ps1')
  const src = path.join(REPO, 'scripts', 'secrets.ps1')
  if (existsSync(vault)) pass('vault script installed -> ' + vault)
  else if (existsSync(src)) warn('vault not installed yet, but self-heal source exists (' + src + ')')
  else fail('vault script missing (no ' + vault + ' and no scripts/secrets.ps1)')
}

// 4) Engine binary present
{
  const engine = process.env.AGENT_OMEGA_ENGINE || path.join(REPO, 'engine', 'opencode.exe')
  existsSync(engine)
    ? pass('engine binary found -> ' + engine)
    : fail('engine binary NOT found (' + engine + ') — see SETUP.md step 5')
}

// 5) Plugin deps installed
{
  const nm = path.join(PLUGIN_ROOT, 'node_modules')
  existsSync(nm) ? pass('plugin node_modules present') : warn('plugin node_modules missing — run: npm install --prefix config-template/opencode')
}

// 6) Every shipped plugin + skill-support file PARSES (node --check)
{
  const dirs = ['skill-router', 'verify-guard', 'iterate-loop', 'council', 'engram']
  let checked = 0, bad = 0
  for (const d of dirs) {
    const dir = path.join(PLUGIN_ROOT, d)
    if (!existsSync(dir)) { fail('plugin dir missing: ' + d); continue }
    for (const f of readdirSync(dir)) {
      if (!/\.(mjs|js)$/.test(f)) continue
      checked++
      try { execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: ['ignore', 'ignore', 'pipe'] }) }
      catch (e) { bad++; fail('parse error in ' + d + '/' + f + ': ' + String(e.stderr || e.message).split('\n')[0]) }
    }
  }
  if (checked && !bad) pass('all ' + checked + ' plugin files parse')
}

// 7) Skills present + MEMORY.md seed
{
  const skillDir = path.join(PLUGIN_ROOT, 'skill')
  const want = ['brainstorming', 'writing-plans', 'tdd', 'verify', 'debugging', 'code-review', 'run-app', 'orchestration']
  const missing = want.filter((s) => !existsSync(path.join(skillDir, s, 'SKILL.md')))
  missing.length ? fail('missing skills: ' + missing.join(', ')) : pass('all ' + want.length + ' core skills present')
  existsSync(path.join(PLUGIN_ROOT, 'memory', 'MEMORY.md')) ? pass('memory/MEMORY.md seed present') : warn('memory/MEMORY.md missing (file-based memory index)')
}

// 8) Router/engram endpoint derivation (the fix: derive from the local provider, no owner infra)
{
  const local = cfg && cfg.provider && cfg.provider.local
  const baseURL = local && local.options && typeof local.options.baseURL === 'string' ? local.options.baseURL : ''
  if (process.env.ROUTER_EXTRACT_URL || process.env.ENGRAM_EXTRACT_URL) {
    pass('router/engram endpoint set via env override')
  } else if (baseURL) {
    pass('router/engram endpoint derives from local provider -> ' + baseURL.replace(/\/+$/, '') + '/chat/completions')
  } else if (cfg && typeof cfg.model === 'string' && !cfg.model.startsWith('local/')) {
    warn('no local provider configured — skill-router + engram auto-extraction are inert (fine for a cloud-lead setup; set the local provider baseURL to enable them)')
  } else {
    warn('no local provider baseURL found in opencode.json — set provider.local.options.baseURL')
  }
}

console.log('\n=== ' + (failed ? failed + ' FAIL' : 'all checks passed') + (warned ? ', ' + warned + ' warning(s)' : '') + ' ===\n')
process.exit(failed ? 1 : 0)
