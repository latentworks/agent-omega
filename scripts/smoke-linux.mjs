#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-omega-linux-smoke-'))
const vaultPath = path.join(tmp, '.agent-omega', 'vault.json')
const env = {
  ...process.env,
  HOME: tmp,
  XDG_CONFIG_HOME: path.join(tmp, '.config'),
  AGENT_OMEGA_FILE_VAULT: vaultPath,
  ANTHROPIC_API_KEY: 'smoke-env-key',
}
const failures = []

function run(args, options = {}) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', ...options })
  if (res.status !== 0) failures.push('node ' + args.join(' ') + '\n' + (res.stderr || res.stdout || '').trim())
}

function check(ok, message) {
  if (!ok) failures.push(message)
}

check(Number(process.versions.node.split('.')[0]) >= 18, 'Node 18+ required')
run(['--check', 'sidecar.mjs'])
run(['--check', 'setup.mjs'])
run(['--check', 'scripts/run-linux.mjs'])
run(['--check', 'vault/file-vault.mjs'])
run(['setup.mjs', '--non-interactive', '--source', 'local', '--url', 'http://127.0.0.1:8080/v1'])

// File-vault roundtrip: set/get/list/remove + 0600 on the file. (Env-first resolution lives in
// sidecar.mjs vaultGet and is asserted structurally below — the sidecar can't be imported
// side-effect-free, it binds the control socket at module load.)
const vaultProbe = "import * as v from './vault/file-vault.mjs'; import fs from 'node:fs'; v.set('OPENAI_API_KEY','file-key'); if (v.get('OPENAI_API_KEY') !== 'file-key') throw new Error('file vault get failed'); if (!v.list().includes('OPENAI_API_KEY')) throw new Error('vault list failed'); const mode = fs.statSync(process.env.AGENT_OMEGA_FILE_VAULT).mode & 0o777; if (mode !== 0o600) throw new Error('vault file mode ' + mode.toString(8) + ' != 600'); v.remove('OPENAI_API_KEY'); if (v.get('OPENAI_API_KEY')) throw new Error('vault remove failed')"
run(['--input-type=module', '--eval', vaultProbe])

const sidecarText = fs.readFileSync(path.join(ROOT, 'sidecar.mjs'), 'utf8')
check(/isLinux/.test(sidecarText) && /fileVault\.get/.test(sidecarText), 'sidecar.mjs must route Linux vault reads env-first to the file vault')
check(/AO_PARENT_PID/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'run-linux.mjs'), 'utf8')), 'launcher must pass AO_PARENT_PID for orphan reaping')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
check(pkg.scripts && pkg.scripts['check:linux-portability'], 'package script check:linux-portability missing')
check(pkg.scripts && pkg.scripts['start:linux'], 'package script start:linux missing')

const ui = fs.readFileSync(path.join(ROOT, 'ui', 'app.html'), 'utf8')
check(/WS_PORT/.test(ui) && /new WebSocket/.test(ui), 'ui/app.html websocket config missing')
check(/HOST_KIND/.test(ui) && /browser/.test(ui), 'ui/app.html browser host mode missing')

for (const rel of ['sidecar.mjs', 'setup.mjs', 'scripts/run-linux.mjs']) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  if (rel !== 'scripts/run-linux.mjs') check(!/execFileSync\(['"]powershell['"]/.test(text), rel + ' must not call PowerShell unconditionally')
}

if (failures.length) {
  console.error('Linux smoke: FAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}

console.log('Linux smoke: PASS')
