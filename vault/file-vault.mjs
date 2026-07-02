import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const VAULT_PATH = process.env.AGENT_OMEGA_FILE_VAULT || path.join(os.homedir(), '.agent-omega', 'vault.json')

function readVault() {
  try {
    const raw = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function writeVault(obj) {
  fs.mkdirSync(path.dirname(VAULT_PATH), { recursive: true })
  const tmp = VAULT_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(tmp, 0o600) } catch {}
  fs.renameSync(tmp, VAULT_PATH)
  try { fs.chmodSync(VAULT_PATH, 0o600) } catch {}
}

export function get(name) {
  const value = readVault()[name]
  return typeof value === 'string' ? value : ''
}

export function list() {
  return Object.keys(readVault()).sort()
}

export function set(name, value) {
  const vault = readVault()
  vault[name] = value
  writeVault(vault)
}

export function remove(name) {
  const vault = readVault()
  delete vault[name]
  writeVault(vault)
}

export const pathForDocs = VAULT_PATH

