// Deterministic ACP fixture for sidecar protocol tests. Its separate control socket
// is only a gate/trace channel; all sidecar interaction remains ACP over stdio.
import net from 'node:net'
import fs from 'node:fs'
import { Writable, Readable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const controlPort = Number(process.env.AO_FAKE_ACP_CONTROL_PORT)
const launchFile = process.env.AO_FAKE_ACP_LAUNCH_FILE
if (launchFile) fs.appendFileSync(launchFile, process.pid + '\n')
const gates = new Map()
const released = new Set()
const sockets = new Set()
const sessionConfig = new Map()
let conn, nextSession = 0

function signal(event, data = {}) {
  const line = JSON.stringify({ event, ...data }) + '\n'
  for (const socket of sockets) socket.write(line)
}
function gate(name) {
  signal('waiting', { name })
  if (released.delete(name)) return Promise.resolve()
  return new Promise((resolve) => gates.set(name, resolve))
}
function stateFor(sessionId) {
  if (!sessionConfig.has(sessionId)) sessionConfig.set(sessionId, { model: 'fake/default', mode: sessionId === 'loaded-b' ? 'review' : 'build', effort: 'medium' })
  return sessionConfig.get(sessionId)
}
const config = (sessionId) => {
  const state = stateFor(sessionId)
  return [
    { id: 'model', currentValue: state.model, options: [{ value: 'fake/default', name: 'Fake default' }, { value: 'fake/selected', name: 'Fake selected' }] },
    { id: 'mode', currentValue: state.mode, options: [{ value: 'build', name: 'Build' }, { value: 'review', name: 'Review' }, { value: 'setup', name: 'Setup' }] },
    { id: 'effort', currentValue: state.effort, options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
  ]
}

class FakeAgent {
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, authMethods: [] } }
  async newSession() {
    const sessionId = 'new-' + (++nextSession)
    signal('newSession', { sessionId })
    // Exercise the actual ACP command-advertisement update. It is gated so
    // the protocol test can prove the command is accepted only after ACP has
    // made it live, rather than relying on startup timing.
    void (async () => {
      await gate('commands:' + sessionId)
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'command-death', description: 'Test terminal command failure' }] } })
      signal('commandsAdvertised', { sessionId })
    })()
    return { sessionId, configOptions: config(sessionId) }
  }
  async loadSession({ sessionId }) {
    signal('loadSession', { sessionId })
    await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replay:' + sessionId } } })
    await gate('load:' + sessionId)
    return { configOptions: config(sessionId) }
  }
  async setSessionConfigOption({ sessionId, configId, value }) {
    signal('setConfig', { sessionId, configId, value })
    if (value === 'fake/selected') await gate('selector')
    if (configId === 'mode' && value === 'build') await gate('setupFlip')
    const state = stateFor(sessionId)
    if (configId === 'model') state.model = value
    else if (configId === 'mode') state.mode = value
    else if (configId === 'effort') state.effort = value
    return { configOptions: config(sessionId) }
  }
  async prompt({ sessionId, prompt }) {
    const text = prompt?.[0]?.text || ''
    signal('prompt', { sessionId, text })
    if (text === 'old-prompt') { await gate('oldPrompt'); return { stopReason: 'end_turn' } }
    if (text === 'permission') {
      const outcome = await conn.requestPermission({ sessionId, toolCall: { toolCallId: 'perm-1', title: 'Permission', kind: 'other' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] })
      signal('permissionOutcome', { outcome: outcome.outcome?.outcome })
      return { stopReason: 'end_turn' }
    }
    if (text === '/command-death') throw new Error('ACP connection closed')
    if (text === 'setup') {
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'setup-finish-1', title: 'setup_finish', kind: 'execute', status: 'completed' } })
      return { stopReason: 'end_turn' }
    }
    if (text === 'setup-restart') {
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'setup-restart-1', title: 'setup_add_model', kind: 'execute', status: 'completed' } })
      return { stopReason: 'end_turn' }
    }
    return { stopReason: 'end_turn' }
  }
  async cancel({ sessionId }) { signal('cancel', { sessionId }); return {} }
}

const server = net.createServer((socket) => {
  sockets.add(socket); socket.setEncoding('utf8')
  socket.on('error', () => {}) // readiness probes may disconnect before receiving control-ready
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      let message; try { message = JSON.parse(line) } catch { continue }
      if (message.type === 'release') {
        const resolve = gates.get(message.name); gates.delete(message.name)
        if (resolve) resolve(); else released.add(message.name)
      } else if (message.type === 'crash') {
        process.exit(9)
      }
    }
  })
  socket.on('close', () => sockets.delete(socket))
  signal('control-ready')
  // A reconnecting harness may attach after ACP reached a deterministic gate.
  // Re-announce held gates so test ordering remains event-driven, not timed.
  for (const name of gates.keys()) signal('waiting', { name })
})
server.listen(controlPort, '127.0.0.1')
conn = new acp.AgentSideConnection(() => new FakeAgent(), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
