import * as fileVault from './file-vault.mjs'
import * as linuxEnv from './linux-env.mjs'
import * as windowsDpapi from './windows-dpapi.mjs'

export const VAULT_TO_ENV = linuxEnv.VAULT_TO_ENV

const isWindows = process.platform === 'win32'

export function get(name) {
  if (isWindows) return windowsDpapi.get(name)
  return linuxEnv.get(name) || fileVault.get(name)
}

export function list() {
  const names = isWindows
    ? windowsDpapi.list()
    : [...linuxEnv.list(), ...fileVault.list()]
  return Array.from(new Set(names)).sort()
}

export function set(name, value) {
  if (isWindows) return windowsDpapi.set(name, value)
  return fileVault.set(name, value)
}

export function remove(name) {
  if (isWindows) return windowsDpapi.remove(name)
  return fileVault.remove(name)
}

export function env() {
  const out = {}
  for (const [vaultName, envName] of Object.entries(VAULT_TO_ENV)) {
    const value = get(vaultName)
    if (value) out[envName] = value
  }
  return out
}

