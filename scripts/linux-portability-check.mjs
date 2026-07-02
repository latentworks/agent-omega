#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const failures = []

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

function pass(ok, message) {
  if (!ok) failures.push(message)
}

const pkg = JSON.parse(read('package.json'))
pass(pkg.scripts && pkg.scripts['check:linux-portability'] === 'node scripts/linux-portability-check.mjs', 'package.json must expose check:linux-portability')
pass(pkg.scripts && pkg.scripts['start:linux'] === 'node scripts/run-linux.mjs', 'package.json must expose start:linux')
pass(exists('scripts/run-linux.mjs'), 'scripts/run-linux.mjs must exist')
pass(exists('scripts/smoke-linux.mjs'), 'scripts/smoke-linux.mjs must exist')
pass(exists('SETUP-LINUX.md'), 'SETUP-LINUX.md must exist')
pass(exists('vault/file-vault.mjs'), 'Linux file vault must exist')

const sidecar = read('sidecar.mjs')
pass(!/const\s+ENGINE\s*=\s*process\.env\.AGENT_OMEGA_ENGINE\s*\|\|\s*path\.join\(HERE,\s*['"]engine['"],\s*['"]opencode\.exe['"]\)/.test(sidecar), 'sidecar.mjs must not default only to engine/opencode.exe')
pass(/isWin \? 'opencode\.exe' : 'opencode'/.test(sidecar) && /commandOnPath/.test(sidecar), 'sidecar.mjs must use a platform engine resolver (bundled path or PATH opencode)')
pass(/isLinux/.test(sidecar) && /fileVault\.get/.test(sidecar), 'sidecar.mjs must route Linux vault reads env-first to the file vault')
pass(!/execFileSync\(['"]powershell['"]/.test(sidecar), 'sidecar.mjs must not call PowerShell unconditionally')

const setup = read('setup.mjs')
pass(/process\.platform\s*===\s*['"]win32['"]/.test(setup), 'setup.mjs must branch on platform')
pass(!/execFileSync\(['"]powershell['"]/.test(setup), 'setup.mjs must not require PowerShell on Linux')
pass(/start:linux/.test(setup), 'setup.mjs Linux final instruction must mention npm run start:linux')

const launcher = read('scripts/run-linux.mjs')
pass(/host=browser/.test(launcher) && /xdg-open/.test(launcher), 'Linux launcher must open app.html in browser mode')
pass(/AO_WS_TOKEN/.test(launcher), 'Linux launcher must generate/pass websocket token')

const ui = read('ui/app.html')
pass(/HOST_KIND/.test(ui) && /browser/.test(ui), 'ui/app.html must detect browser host mode')

const setupLinux = read('SETUP-LINUX.md')
pass(/npm install/.test(setupLinux) && /npm run start:linux/.test(setupLinux), 'SETUP-LINUX.md must include Linux install and launch commands')
pass(/native Linux desktop shell/i.test(setupLinux) && /(not shipped|does not ship)/i.test(setupLinux), 'SETUP-LINUX.md must state native Linux desktop shell is not shipped')
pass(/chmod \+x \.\/engine\/opencode/.test(setupLinux), 'SETUP-LINUX.md must document chmod +x ./engine/opencode')

const setupWin = read('SETUP.md')
pass(/Windows desktop/.test(setupWin) || /Windows 10\/11/.test(setupWin), 'SETUP.md must remain Windows desktop setup')

const csproj = read('AgentOmega.csproj')
pass(/net8\.0-windows/.test(csproj) && /UseWindowsForms/.test(csproj), 'AgentOmega.csproj must remain explicitly Windows-only')

if (failures.length) {
  console.error('Linux portability check: FAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}

console.log('Linux portability check: PASS')
