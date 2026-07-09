import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const VAULT_PATH = process.env.AGENT_OMEGA_FILE_VAULT || path.join(os.homedir(), '.agent-omega', 'vault.json')

function readVault() {
  let raw
  try {
    raw = fs.readFileSync(VAULT_PATH, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw new Error('vault file is unreadable at ' + VAULT_PATH + ': ' + e.message)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error('vault file is corrupt at ' + VAULT_PATH + ': ' + e.message)
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function writeVault(obj) {
  fs.mkdirSync(path.dirname(VAULT_PATH), { recursive: true, mode: 0o700 })
  try { fs.chmodSync(path.dirname(VAULT_PATH), 0o700) } catch {}
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

