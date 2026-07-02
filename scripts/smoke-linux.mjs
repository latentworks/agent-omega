#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-omega-linux-smoke-'))
const env = {
  ...process.env,
  HOME: tmp,
  XDG_CONFIG_HOME: path.join(tmp, '.config'),
  AGENT_OMEGA_FILE_VAULT: path.join(tmp, '.agent-omega', 'vault.json'),
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
run(['--check', 'vault/index.mjs'])
run(['--check', 'vault/linux-env.mjs'])
run(['--check', 'vault/file-vault.mjs'])
run(['--check', 'vault/windows-dpapi.mjs'])
run(['setup.mjs', '--non-interactive', '--source', 'local', '--url', 'http://127.0.0.1:8080/v1'])

const vaultProbe = "import * as v from './vault/index.mjs'; v.set('OPENAI_API','file-key'); if (v.get('OPENAI_API') !== 'file-key') throw new Error('file vault get failed'); if (v.get('ANTHROPIC_API_KEY') !== 'smoke-env-key') throw new Error('env vault get failed'); const names = v.list(); if (!names.includes('OPENAI_API')) throw new Error('vault list failed'); if (!names.includes('ANTHROPIC_API_KEY')) throw new Error('env vault canonical name missing'); if (names.includes('OPENAI_API_KEY')) throw new Error('env var name leaked into vault list'); v.remove('OPENAI_API'); if (v.get('OPENAI_API')) throw new Error('vault remove failed')"
run(['--input-type=module', '--eval', vaultProbe])

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
check(pkg.scripts && pkg.scripts['check:linux-portability'], 'package script check:linux-portability missing')
check(pkg.scripts && pkg.scripts['start:linux'], 'package script start:linux missing')

const ui = fs.readFileSync(path.join(ROOT, 'ui', 'app.html'), 'utf8')
check(/WS_PORT/.test(ui) && /new WebSocket/.test(ui), 'ui/app.html websocket config missing')
check(/HOST_KIND/.test(ui) && /browser/.test(ui), 'ui/app.html browser host mode missing')

for (const rel of ['sidecar.mjs', 'setup.mjs', 'scripts/run-linux.mjs', 'vault/index.mjs']) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  if (rel !== 'scripts/run-linux.mjs') check(!/execFileSync\(['"]powershell['"]/.test(text), rel + ' must not call PowerShell directly')
}

if (failures.length) {
  console.error('Linux smoke: FAIL')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}

console.log('Linux smoke: PASS')
