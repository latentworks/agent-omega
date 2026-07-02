#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

if (process.platform === 'win32') {
  console.error('Linux browser-mode launcher is not for Windows; use the Windows desktop build.')
  process.exit(1)
}

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('Agent Omega Linux browser mode needs Node 18+ (found ' + process.version + ')')
  process.exit(1)
}

const sidecar = path.join(ROOT, 'sidecar.mjs')
const app = path.join(ROOT, 'ui', 'app.html')
if (!fs.existsSync(sidecar)) { console.error('Missing sidecar.mjs at ' + sidecar); process.exit(1) }
if (!fs.existsSync(app)) { console.error('Missing ui/app.html at ' + app); process.exit(1) }

const workspace = process.env.AGENT_OMEGA_WORKSPACE || path.join(os.homedir(), '.agent-omega', 'workspace')
const port = String(Number(process.env.AGENT_OMEGA_PORT || 4599) || 4599)
const token = randomUUID()
fs.mkdirSync(workspace, { recursive: true })

const child = spawn(process.execPath, [sidecar, workspace, port], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, AO_WS_TOKEN: token },
})

const url = pathToFileURL(app).href + '?host=browser&ws=' + encodeURIComponent(port) + '&token=' + encodeURIComponent(token)
const opener = spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
opener.on('error', () => {
  console.error('Could not run xdg-open. Open this URL manually:')
  console.error(url)
})
opener.unref()

function stop() {
  try { child.kill() } catch {}
}

process.on('SIGINT', () => { stop(); process.exit(130) })
process.on('SIGTERM', () => { stop(); process.exit(143) })
child.on('exit', code => process.exit(code || 0))

