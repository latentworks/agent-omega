import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SECRETS_PS1 = process.env.AGENT_OMEGA_VAULT || path.join(os.homedir(), '.agent-omega', 'secrets.ps1')

function ensureVault() {
  try {
    if (!fs.existsSync(SECRETS_PS1)) {
      const src = path.join(ROOT, 'scripts', 'secrets.ps1')
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(SECRETS_PS1), { recursive: true })
        fs.copyFileSync(src, SECRETS_PS1)
      }
    }
  } catch {}
  return fs.existsSync(SECRETS_PS1)
}

function run(args, stdio = ['ignore', 'pipe', 'pipe']) {
  ensureVault()
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', SECRETS_PS1, ...args], { encoding: 'utf8', stdio })
}

export function get(name) {
  try { return run(['get', name], ['ignore', 'pipe', 'ignore']).trim() }
  catch { return '' }
}

export function list() {
  const out = run(['list'])
  return out.split(/\r?\n/).map(s => s.trim()).filter(s => s && s !== '(vault empty)')
}

export function set(name, value) {
  run(['set', name, value])
}

export function remove(name) {
  run(['remove', name])
}

