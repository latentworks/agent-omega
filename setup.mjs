#!/usr/bin/env node
// Agent Omega - first-run setup wizard.
// Installs the plugin config + encrypted vault, checks the engine, and configures your
// model + API key so you never hand-edit opencode.json. Run once from the repo root:
//     node setup.mjs
// Non-interactive (for scripts/tests):
//     node setup.mjs --non-interactive --source anthropic --key sk-...
//     node setup.mjs --non-interactive --source local --url http://127.0.0.1:8080/v1
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url)) // Node 18+ (import.meta.dirname needs 20.11+)
const HOME = os.homedir()
const CFG_DIR = path.join(HOME, '.config', 'opencode')
const VAULT_DIR = path.join(HOME, '.agent-omega')
const args = process.argv.slice(2)
const NONINT = args.includes('--non-interactive')
const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined }

if (Number(process.versions.node.split('.')[0]) < 18) { console.error('Agent Omega setup needs Node 18+ (found ' + process.version + ')'); process.exit(1) }

// provider id -> { vault key NAME the sidecar reads, default model, label }
const PROVIDERS = {
  anthropic:  { vault: 'ANTHROPIC_API_KEY', model: 'anthropic/claude-opus-4-8',  label: 'Anthropic (Claude)' },
  openai:     { vault: 'OPENAI_API',        model: 'openai/gpt-5.5',             label: 'OpenAI (ChatGPT)' },
  google:     { vault: 'GEMINI_API_KEY',    model: 'google/gemini-3.5-flash',    label: 'Google (Gemini)' },
  deepseek:   { vault: 'DEEPSEEK_API',      model: 'deepseek/deepseek-v4-pro',   label: 'DeepSeek' },
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

  // 1) plugin config -> ~/.config/opencode
  const tmpl = path.join(HERE, 'config-template', 'opencode')
  if (!existsSync(CFG_DIR)) {
    cpSync(tmpl, CFG_DIR, { recursive: true })
    console.log('  installed plugin config -> ' + CFG_DIR)
  } else {
    console.log('  ' + CFG_DIR + ' already exists - leaving it (delete it to reinstall from the template)')
  }

  // 2) encrypted vault script -> ~/.agent-omega/secrets.ps1
  if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true })
  const vaultScript = path.join(VAULT_DIR, 'secrets.ps1')
  copyFileSync(path.join(HERE, 'scripts', 'secrets.ps1'), vaultScript)
  console.log('  installed encrypted vault -> ' + vaultScript)

  // 3) engine check
  const engine = process.env.AGENT_OMEGA_ENGINE || path.join(HERE, 'engine', 'opencode.exe')
  console.log(existsSync(engine)
    ? '  engine found -> ' + engine
    : '  engine NOT found - download opencode.exe from the release into ./engine/ (see SETUP.md)')

  // 4) model + key
  let source = flag('source')
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
      execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', vaultScript, 'set', info.vault, String(key)], { stdio: ['ignore', 'pipe', 'pipe'] })
      console.log('  stored key in the encrypted vault (' + info.vault + ')')
    } else {
      console.log('  no key entered - add it later via the app, or store the ' + info.vault + ' vault entry')
    }
    cfg.model = info.model
    console.log('  model -> ' + info.model)
  }

  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  console.log('\n  wrote ' + cfgPath)
  console.log('\nSetup complete. Build + launch:\n  dotnet build -c Release\n  .\\bin\\Release\\net8.0-windows\\agent-omega.exe\n')
  if (rl) rl.close()
}

main().catch((e) => { console.error('setup failed:', e.message); process.exit(1) })
