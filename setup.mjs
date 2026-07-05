#!/usr/bin/env node
// Agent Omega - first-run setup wizard.
// Installs the plugin config + encrypted vault, checks the engine, and configures your
// model + API key so you never hand-edit opencode.json. Run once from the repo root:
//     node setup.mjs
// Non-interactive (for scripts/tests):
//     node setup.mjs --non-interactive --source anthropic --key sk-...
//     node setup.mjs --non-interactive --source local --url http://127.0.0.1:8080/v1
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, copyFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url)) // Node 18+ (import.meta.dirname needs 20.11+)
const HOME = os.homedir()
// Honor XDG_CONFIG_HOME so an isolated instance (the launcher sets it) installs to the same
// place its engine reads from, instead of always the shared ~/.config/opencode.
const XDG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')
const CFG_DIR = path.join(XDG, 'opencode')
const VAULT_DIR = path.join(HOME, '.agent-omega')
// Files that hold USER data — never overwritten on an upgrade.
const PRESERVE = (rel) => rel === 'opencode.json' || rel === 'council/council.json' || rel.startsWith('memory/') || /\.(db|db-wal|db-shm|log)$/i.test(rel)
// Distinctive marker that CFG_DIR is an existing Agent Omega install (vs a stranger's own opencode config).
const isAgentOmega = (dir) => existsSync(path.join(dir, 'skill-router', 'index.js')) || existsSync(path.join(dir, 'council', 'index.js'))
const args = process.argv.slice(2)
const NONINT = args.includes('--non-interactive')
const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined }

if (Number(process.versions.node.split('.')[0]) < 18) { console.error('Agent Omega setup needs Node 18+ (found ' + process.version + ')'); process.exit(1) }

// provider id -> { vault key NAME the sidecar reads, default model, label }
// vault key NAMEs MUST match sidecar.mjs VAULT_TO_ENV and the in-app Vault UI, or a stored
// key never reaches the engine.
const PROVIDERS = {
  anthropic:  { vault: 'ANTHROPIC_API_KEY', model: 'anthropic/claude-opus-4-8',  label: 'Anthropic (Claude)' },
  openai:     { vault: 'OPENAI_API_KEY',    model: 'openai/gpt-5.5',             label: 'OpenAI (ChatGPT)' },
  google:     { vault: 'GEMINI_API_KEY',    model: 'google/gemini-3.5-flash',    label: 'Google (Gemini)' },
  deepseek:   { vault: 'DEEPSEEK_API_KEY',  model: 'deepseek/deepseek-v4-pro',   label: 'DeepSeek' },
  moonshotai: { vault: 'KIMI_API_KEY',      model: 'moonshotai/kimi-k2.7-code',  label: 'Kimi (Moonshot)' },
  zai:        { vault: 'ZAI_API_KEY',       model: 'zai/glm-5.2',                label: 'Z.AI (GLM)' },
}

async function main() {
  console.log('\n=== Agent Omega setup ===\n')
  if (!NONINT && !process.stdin.isTTY) { console.error('setup.mjs needs an interactive terminal — or run: node setup.mjs --non-interactive --source <local|anthropic|openai|other> [--key <key>]'); process.exit(1) }
  const rl = NONINT ? null : readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (q, def) => {
    if (NONINT) return def
    const a = (await rl.question(q)).trim()
    return a || def
  }

  // 1) plugin config -> CFG_DIR (fresh install, in-place UPGRADE, or refuse a foreign config)
  const tmpl = path.join(HERE, 'config-template', 'opencode')
  // Runtime artifacts (memory DBs, WAL/SHM, logs, python bytecode) leak into the template when the
  // engine or tests run against it. Never ship them to ANY install — fresh or upgrade — or a stranger
  // receives the developer's engram brain DB and stray caches.
  const RUNTIME_JUNK = (rel) => /(^|\/)__pycache__(\/|$)/.test(rel) || /\.(db|db-wal|db-shm|log|pyc)$/i.test(rel)
  const copyFilter = (isUpgrade) => (s, d) => {
    const rel = path.relative(tmpl, s).replace(/\\/g, '/')
    if (rel === '') return true
    if (RUNTIME_JUNK(rel)) return false                             // never copy runtime junk (fresh install too)
    if (isUpgrade && PRESERVE(rel) && existsSync(d)) return false   // keep the user's config/roster/memory/db
    return true
  }
  // An UPGRADE = CFG_DIR already existed AND is a prior Agent Omega install. Must be decided
  // BEFORE the copy below, because after it the template's marker files always look present.
  const isUpgrade = existsSync(CFG_DIR) && isAgentOmega(CFG_DIR)
  if (!existsSync(CFG_DIR)) {
    cpSync(tmpl, CFG_DIR, { recursive: true, filter: copyFilter(false) })
    console.log('  installed plugin config -> ' + CFG_DIR)
  } else if (isAgentOmega(CFG_DIR)) {
    cpSync(tmpl, CFG_DIR, { recursive: true, force: true, filter: copyFilter(true) })
    console.log('  upgraded Agent Omega plugin config in ' + CFG_DIR + ' (kept your opencode.json, council roster, and memory)')
    // PRESERVE keeps the user's opencode.json, so critical NEW template keys never reach an upgraded
    // install. Patch in the ones that MUST be present — currently the `instructions` injection that
    // guarantees AGENTS.md reaches the model (opencode ignores the config-dir AGENTS.md, #7003/#11534);
    // without it an UPGRADED install silently runs with NO operating instructions (the shipped heart).
    try {
      const up = path.join(CFG_DIR, 'opencode.json')
      const uc = JSON.parse(readFileSync(up, 'utf8'))
      const want = '{env:AGENT_OMEGA_AGENTS}'
      const list = Array.isArray(uc.instructions) ? uc.instructions : []
      if (!list.includes(want)) {
        uc.instructions = [want, ...list]
        writeFileSync(up, JSON.stringify(uc, null, 2) + '\n')
        console.log('  patched opencode.json: restored AGENTS.md system-prompt injection (instructions)')
      }
    } catch (e) { console.error('  WARN: could not ensure `instructions` in opencode.json:', e.message) }
  } else {
    console.error('\n  ' + CFG_DIR + ' already exists and is NOT an Agent Omega install')
    console.error('  (it looks like your own opencode config). Refusing to overwrite it.')
    console.error('  Options: move/rename that folder first, or run Agent Omega isolated by')
    console.error('  setting XDG_CONFIG_HOME to a fresh directory before launching + re-running setup.\n')
    process.exit(1)
  }

  // 2) encrypted vault script -> ~/.agent-omega/ (per-OS backend: DPAPI on Windows, Keychain on macOS)
  const isWin = process.platform === 'win32'
  if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true })
  const vaultScript = path.join(VAULT_DIR, isWin ? 'secrets.ps1' : 'secrets.sh')
  copyFileSync(isWin ? path.join(HERE, 'scripts', 'secrets.ps1') : path.join(HERE, 'mac', 'secrets.sh'), vaultScript)
  if (!isWin) { try { chmodSync(vaultScript, 0o755) } catch {} }
  console.log('  installed encrypted vault -> ' + vaultScript)
  // one launcher contract everywhere: [cmd, ...preArgs] + {get|set|list|remove}
  const vaultCmd = isWin
    ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', vaultScript]
    : ['sh', vaultScript]

  // 3) engine check
  const engineName = isWin ? 'opencode.exe' : 'opencode'
  const engine = process.env.AGENT_OMEGA_ENGINE || path.join(HERE, 'engine', engineName)
  const engineFound = existsSync(engine)
  console.log(engineFound
    ? '  engine found -> ' + engine
    : '  engine NOT found - ' + (isWin ? 'download opencode.exe from the release into ./engine/ (see SETUP.md step 5)' : 'build it into ./engine/opencode (see SETUP.md, macOS section)'))

  // 4) model + key. On an UPGRADE, leave opencode.json (incl. its model) untouched unless the
  // user explicitly opts in — either an explicit --source, or a 'y' at the reconfigure prompt.
  let source = flag('source')
  let reconfigure = !isUpgrade || !!source
  if (isUpgrade && !source) {
    const ans = await ask('Reconfigure your model / API key now? Otherwise opencode.json is left untouched. [y/N]: ', 'n')
    reconfigure = /^y(es)?$/i.test(ans)
  }

  if (!reconfigure) {
    console.log('  kept your existing model + opencode.json untouched (upgrade — nothing reconfigured)')
  } else {
    if (!source) {
      console.log('\nHow do you want to run Agent Omega?')
      console.log('  1) Local model (llama.cpp / Ollama / LM Studio)')
      console.log('  2) Anthropic (Claude)')
      console.log('  3) OpenAI (ChatGPT)')
      console.log('  4) Other cloud (Gemini / DeepSeek / Kimi / GLM)')
      const c = await ask('Choose [1-4] (default 2): ', '2')
      source = { '1': 'local', '2': 'anthropic', '3': 'openai', '4': 'other' }[c] || 'anthropic'
    }

    const cfgPath = path.join(CFG_DIR, 'opencode.json')
    if (!existsSync(cfgPath)) copyFileSync(path.join(tmpl, 'opencode.json'), cfgPath) // self-heal a missing/deleted config
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))

    if (source === 'local') {
      const url = flag('url') || await ask('Local server base URL [http://127.0.0.1:8080/v1]: ', 'http://127.0.0.1:8080/v1')
      if (!cfg.provider) cfg.provider = {}
      if (!cfg.provider.local) cfg.provider.local = { npm: '@ai-sdk/openai-compatible', name: 'Local', options: {}, models: { 'local-model': { name: 'Local model', limit: { context: 32768, output: 8192 } } } }
      cfg.provider.local.options = cfg.provider.local.options || {}
      cfg.provider.local.options.baseURL = url
      cfg.model = 'local/local-model'
      console.log('  model -> local/local-model @ ' + url)
    } else {
      let prov = source
      if (source === 'other') prov = (flag('provider') || await ask('Which? [google/deepseek/moonshotai/zai] (default google): ', 'google'))
      if (!PROVIDERS[prov]) { console.error("  unknown provider '" + prov + "' — use one of: " + Object.keys(PROVIDERS).join(', ')); process.exit(1) }
      const info = PROVIDERS[prov]
      const key = flag('key') || await ask(info.label + ' API key (leave blank to add later in the app): ', '')
      if (key) {
        // Pass the key on STDIN so it never appears in the process command line / any error text.
        execFileSync(vaultCmd[0], [...vaultCmd.slice(1), 'set', info.vault], { input: String(key), stdio: ['pipe', 'pipe', 'pipe'] })
        console.log('  stored key in the encrypted vault (' + info.vault + ')')
      } else {
        console.log('  no key entered - add it later via the app, or store the ' + info.vault + ' vault entry')
      }
      cfg.model = info.model
      console.log('  model -> ' + info.model)
    }

    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
    console.log('\n  wrote ' + cfgPath)
  }
  if (!engineFound) {
    console.log('\nConfig is ready, but setup is NOT complete: the engine binary is still missing.')
    console.log(isWin ? 'Finish SETUP.md step 5 (download opencode.exe into ./engine/), then build + launch:'
                      : 'Build the engine into ./engine/opencode (SETUP.md, macOS section), then build + launch:')
  } else {
    console.log('\nSetup complete. Build + launch:')
  }
  console.log(isWin ? '  dotnet build -c Release\n  .\\bin\\Release\\net8.0-windows\\agent-omega.exe'
                    : '  sh mac/run.sh')
  console.log(isWin
    ? '\nWork on a real project by launching with --workdir "C:\\path\\to\\project" (or set AGENT_OMEGA_WORKDIR); otherwise a scratch workspace under %LOCALAPPDATA%\\AgentOmega is used.\n'
    : '\nWork on a real project by launching with AGENT_OMEGA_WORKDIR=/path/to/project; otherwise a scratch workspace under ~/Library/Application Support/AgentOmega is used.\n')
  if (rl) rl.close()
}

main().catch((e) => { console.error('setup failed:', e.message); process.exit(1) })
