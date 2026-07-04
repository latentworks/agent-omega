#!/usr/bin/env node
// scripts/install-connect.mjs — installs the one-word connect command `omg` (+ `omega` synonym) so
// SSHing in and typing `omg` attaches to the running desktop app. Plan §3.8/§5.6. Idempotent.
//   node scripts/install-connect.mjs          install
//   node scripts/install-connect.mjs --remove  uninstall
//   node scripts/install-connect.mjs --force   overwrite even if `omg` already resolves elsewhere
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ATTACH = path.join(REPO, 'scripts', 'attach.mjs')
const BIN = path.join(os.homedir(), '.agent-omega', 'bin')
const NAMES = ['omg', 'omega']
const remove = process.argv.includes('--remove')
const force = process.argv.includes('--force')
const win = process.platform === 'win32'
const MARK_A = '# >>> agent-omega connect >>>'
const MARK_B = '# <<< agent-omega connect <<<'

function resolvesElsewhere(cmd) {
  try {
    const out = execSync((win ? 'where ' : 'command -v ') + cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return out && !out.split('\n').every((line) => line.toLowerCase().includes(BIN.toLowerCase()))
  } catch { return false }
}

function writeLaunchers() {
  fs.mkdirSync(BIN, { recursive: true })
  if (win) {
    for (const n of NAMES) {
      fs.writeFileSync(path.join(BIN, n + '.cmd'), `@echo off\r\nnode "${ATTACH}" %*\r\n`)
      fs.writeFileSync(path.join(BIN, n + '.ps1'), `#!/usr/bin/env pwsh\r\n& node "${ATTACH}" @args\r\n`)
    }
  } else {
    for (const n of NAMES) { const p = path.join(BIN, n); fs.writeFileSync(p, `#!/bin/sh\nexec node "${ATTACH}" "$@"\n`); fs.chmodSync(p, 0o755) }
  }
}
function removeLaunchers() {
  for (const n of NAMES) for (const ext of ['', '.cmd', '.ps1']) { try { fs.unlinkSync(path.join(BIN, n + ext)) } catch {} }
}

function winPath(add) {
  const esc = BIN.replace(/'/g, "''")
  const ps = add
    ? `$p=[Environment]::GetEnvironmentVariable('Path','User'); if($p -notlike '*${esc}*'){ [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';')+';${esc}'), 'User'); 'added' } else { 'present' }`
    : `$p=[Environment]::GetEnvironmentVariable('Path','User'); $n=($p.Split(';') | Where-Object { $_ -and $_ -ne '${esc}' }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$n,'User'); 'removed'`
  const tmp = path.join(os.tmpdir(), 'ao-path-' + process.pid + '.ps1')
  fs.writeFileSync(tmp, ps)
  try { const r = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: 'utf8' }).trim(); return r } finally { try { fs.unlinkSync(tmp) } catch {} }
}
function unixPath(add) {
  const block = `\n${MARK_A}\nexport PATH="$PATH:${BIN}"\n${MARK_B}\n`
  const files = ['.zshrc', '.bashrc', '.profile'].map((f) => path.join(os.homedir(), f))
  let touched = false
  const exist = files.filter((f) => fs.existsSync(f))
  const targets = exist.length ? exist : [path.join(os.homedir(), '.profile')]
  for (const f of targets) {
    let cur = ''; try { cur = fs.readFileSync(f, 'utf8') } catch {}
    const stripped = cur.replace(new RegExp(`\\n?${MARK_A}[\\s\\S]*?${MARK_B}\\n?`, 'g'), '')
    fs.writeFileSync(f, add ? stripped + block : stripped)
    touched = true
  }
  return touched ? (add ? 'added' : 'removed') : 'none'
}

if (remove) {
  removeLaunchers()
  const r = win ? winPath(false) : unixPath(false)
  console.log(`✓ removed omg/omega launchers + PATH entry (${r}). Open a new shell to see it gone.`)
  process.exit(0)
}

if (!force && resolvesElsewhere('omg')) {
  console.error(`✗ 'omg' already resolves to something else on this machine. Re-run with --force to install anyway (it will shadow the other via PATH order), or rename.`)
  process.exit(1)
}
writeLaunchers()
const pr = win ? winPath(true) : unixPath(true)
console.log(`✓ installed: type \x1b[1momg\x1b[0m after SSHing in to attach (\x1b[2momega\x1b[0m also works).`)
console.log(`  launchers: ${BIN}`)
console.log(`  PATH: ${pr}. \x1b[1mOpen a NEW shell/SSH session\x1b[0m for it to take effect.`)
console.log(`  Termius tip: set the host's on-connect command to \x1b[1momg\x1b[0m to land straight in the agent.`)
