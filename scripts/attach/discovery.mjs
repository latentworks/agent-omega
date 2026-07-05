// scripts/attach/discovery.mjs
// Instance discovery — logic extracted VERBATIM from the original attach.mjs so transport behavior
// cannot drift (plan §5.2, keep-matrix). Zero behavior change.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

export const ATTACH_DIR = process.env.AGENT_OMEGA_ATTACH_DIR || path.join(os.homedir(), '.agent-omega', 'instances')

export function pidAlive(pid) {
  if (!pid) return true
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// 'open' if something is listening, 'refused' if definitively empty, 'timeout' if inconclusive.
// Defeats PID reuse: a dead sidecar's descriptor whose port refuses is dropped.
export function probePort(port) {
  return new Promise((resolve) => {
    let done = false
    const sock = net.connect({ host: '127.0.0.1', port })
    const fin = (r) => { if (done) return; done = true; try { sock.destroy() } catch {}; resolve(r) }
    sock.on('connect', () => fin('open'))
    sock.on('error', (e) => fin(e && e.code === 'ECONNREFUSED' ? 'refused' : 'timeout'))
    sock.setTimeout(400, () => fin('timeout'))
  })
}

function matchesArg(d, arg) {
  if (!arg) return true
  if (String(d.port) === arg) return true
  return !!(d.cwd && d.cwd.toLowerCase().includes(arg.toLowerCase()))
}

// Discover LIVE instances: alive pid + port not-refused, filtered by an optional selector arg
// (a .json path = pinned, a port, or a cwd substring).
export async function liveInstances(arg = '', dir = ATTACH_DIR) {
  const pinned = arg && arg.toLowerCase().endsWith('.json') && fs.existsSync(arg)
  const files = pinned
    ? [arg]
    : (() => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)) } catch { return [] } })()
  const cand = []
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (d && d.port && pidAlive(d.pid) && (pinned || matchesArg(d, arg))) cand.push(d)
    } catch {}
  }
  const out = []
  for (const d of cand) { if ((await probePort(d.port)) !== 'refused') out.push(d) }
  return out
}
