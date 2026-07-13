import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'fake-acp-engine.mjs')
const MANAGED_WINDOWS_RUNTIME = process.platform === 'win32'

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function isolatedChildEnv(parent) {
  return Object.fromEntries(Object.entries(parent).filter(([key]) => !/^(?:AO_|AGENT_OMEGA_)/i.test(key) && !/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(key)))
}
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; server.close(); await once(server, 'close'); return port }
async function portIsFree(port) {
  const server = net.createServer()
  return await new Promise((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}
async function freePortPair() {
  for (;;) {
    const port = await freePort()
    if (await portIsFree(port + 1)) return port
  }
}
async function waitForPort(port, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => { const socket = new net.Socket(); socket.once('error', () => { socket.destroy(); resolve(false) }); socket.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true) }) })
    if (open) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(label + ' did not start')
}
async function eventually(check, diagnostics = () => '') {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { const value = check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)) }
  throw new Error('event did not arrive' + diagnostics())
}

async function harness(t, options = {}) {
  const wsPort = await freePortPair()
  let controlPort
  do { controlPort = await freePort() } while (controlPort === wsPort || controlPort === wsPort + 1)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sidecar-protocol-'))
  const workdir = path.join(root, 'work'), home = path.join(root, 'home'), config = path.join(root, 'config'), data = path.join(root, 'data')
  const env = isolatedChildEnv(process.env)
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data,
    AGENT_OMEGA_VAULT: path.join(root, 'vault.dat'), AGENT_OMEGA_ATTACH: path.join(root, 'attach.json'),
    AGENT_OMEGA_WS_PORT: String(wsPort), AGENT_OMEGA_WORKDIR: workdir,
    AGENT_OMEGA_ENGINE: options.engine || path.join(root, 'missing-engine'), AO_FAKE_ACP_CONTROL_PORT: String(controlPort),
    AO_FAKE_ACP_LAUNCH_FILE: path.join(root, 'engine-launches.log'),
  })
  if (options.foreignConfig) {
    fs.mkdirSync(path.join(config, 'opencode'), { recursive: true })
    fs.writeFileSync(path.join(config, 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['./private.js'] }))
  } else {
    fs.mkdirSync(path.join(config, 'opencode', 'skill-router'), { recursive: true })
    fs.writeFileSync(path.join(config, 'opencode', 'skill-router', 'index.js'), '// Agent Omega marker\n')
    fs.writeFileSync(path.join(config, 'opencode', 'opencode.json'), JSON.stringify({ plugin: ['./skill-router/index.js'] }))
    // Windows owns the managed refresh at sidecar boot. Non-Windows fixture
    // configs model the already-provisioned plugin supplied by their installer.
    if (!MANAGED_WINDOWS_RUNTIME)
      fs.cpSync(path.join(ROOT, 'config-template', 'opencode', 'task-quality'), path.join(config, 'opencode', 'task-quality'), { recursive: true })
  }
  // Set the controlled engine only after stripping inherited Agent Omega overrides.
  env.AGENT_OMEGA_TEST_ENGINE_COMMAND = FIXTURE
  if (options.verifyTaskQuality) env.AO_TEST_VERIFY_TASK_QUALITY = '1'
  let healthServer = null
  if (options.healthMode) {
    const payload = options.healthMode === 'valid'
      ? { healthy: true, taskQuality: { protocol: 2, features: ['tool-admission', 'isolated-review', 'trusted-origin', 'lifecycle-cas', 'plain-review-report', 'review-address-gate', 'review-resume', 'internal-automation', 'deterministic-terminal-review', 'terminal-completion-gate'] } }
      : { healthy: true, taskQuality: { protocol: 0, features: [] } }
    healthServer = http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) })
    healthServer.listen(wsPort + 1, '127.0.0.1')
    await once(healthServer, 'listening')
  }
  const proc = spawn(process.execPath, ['sidecar.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env })
  let ws, control
  t.after(async () => {
    try { ws?.close() } catch {}; try { control?.destroy() } catch {}
    if (proc.exitCode === null) { try { proc.kill() } catch {}; await once(proc, 'exit').catch(() => {}) }
    if (healthServer) { try { healthServer.close() } catch {} }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const stderr = []; proc.stderr.on('data', (data) => stderr.push(String(data)))
  const controlEvents = []; let controlBuffer = ''
  const reconnectControl = async () => {
    for (let deadline = Date.now() + 10000; ; ) {
      const listening = await new Promise((resolve) => { const retry = new net.Socket(); retry.once('error', () => { retry.destroy(); resolve(false) }); retry.connect(controlPort, '127.0.0.1', () => { retry.destroy(); resolve(true) }) })
      if (listening) break
      if (Date.now() >= deadline) throw new Error('fake ACP control socket did not start; sidecar stderr=' + stderr.join(''))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const next = new net.Socket()
    await new Promise((resolve, reject) => { next.once('error', (error) => reject(new Error(error.message + '; sidecar stderr=' + stderr.join('')))); next.connect(controlPort, '127.0.0.1', resolve) })
    control = next
    control.on('error', () => {})
    control.setEncoding('utf8'); control.on('data', (chunk) => { controlBuffer += chunk; let at; while ((at = controlBuffer.indexOf('\n')) >= 0) { const line = controlBuffer.slice(0, at); controlBuffer = controlBuffer.slice(at + 1); try { controlEvents.push(JSON.parse(line)) } catch {} } })
  }
  if (!options.expectIncompatible) await reconnectControl()
  // The fake ACP control socket can become ready before the sidecar's public
  // WebSocket listener on slower Windows runs. Wait for both boundaries;
  // otherwise the test races a valid startup and fails with ECONNREFUSED.
  await waitForPort(wsPort, 'sidecar WebSocket')
  ws = new WebSocket('ws://127.0.0.1:' + wsPort); const messages = []
  ws.on('message', (data) => { try { messages.push(JSON.parse(data)) } catch {} })
  await once(ws, 'open')
  const diagnostics = () => ' control=' + JSON.stringify(controlEvents) + ' ws=' + JSON.stringify(messages) + ' stderr=' + stderr.join('')
  const wait = (check) => eventually(check, diagnostics)
  if (!options.expectIncompatible) await wait(() => messages.find((m) => m.type === 'ready'))
  const send = (message) => ws.send(JSON.stringify(message))
  const release = (name) => control.write(JSON.stringify({ type: 'release', name }) + '\n')
  const crash = async () => { const dying = control; dying.write(JSON.stringify({ type: 'crash' }) + '\n'); await new Promise((resolve) => dying.once('close', resolve)) }
  const launchCount = () => {
    const file = env.AO_FAKE_ACP_LAUNCH_FILE
    if (!fs.existsSync(file)) return 0
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length
  }
  const event = async (name, predicate = () => true) => {
    return await wait(() => controlEvents.find((e) => e.event === name && predicate(e)))
  }
  const eventAfter = async (index, name, predicate = () => true) => {
    return await wait(() => controlEvents.slice(index).find((e) => e.event === name && predicate(e)))
  }
  return { messages, controlEvents, send, release, crash, reconnectControl, event, eventAfter, wait, launchCount, config }
}
const count = (messages, type) => messages.filter((m) => m.type === type).length

test('real sidecar ACP/WS protocol rejects stale selector completion after new and load', { concurrency: false }, async (t) => {
  for (const replacement of [{ type: 'new' }, { type: 'load', sessionId: 'loaded-a' }]) {
    const h = await harness(t); h.send({ type: 'setModel', model: 'fake/selected' }); await h.event('setConfig', (e) => e.value === 'fake/selected')
    h.send(replacement); if (replacement.type === 'load') { await h.event('loadSession', (e) => e.sessionId === 'loaded-a'); await h.event('waiting', (e) => e.name === 'load:loaded-a'); h.release('load:loaded-a') }
    else await h.event('newSession', (e) => e.sessionId === 'new-2')
    h.release('selector')
    await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId !== 'new-1')
    assert.notEqual(h.messages.filter((m) => m.type === 'ready').at(-1).model, 'fake/selected', replacement.type)
  }
})

test('selector mutations serialize and a prompt waits for every earlier confirmed selector', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.send({ type: 'setModel', model: 'fake/selected' })
  await h.event('setConfig', (e) => e.configId === 'model' && e.value === 'fake/selected')
  await h.event('waiting', (e) => e.name === 'selector')
  const controlMark = h.controlEvents.length, messageMark = h.messages.length
  h.send({ type: 'setModel', model: 'fake/default' })
  h.send({ type: 'prompt', text: 'normal' })
  h.send({ type: 'getCouncilConfig' })
  await h.wait(() => h.messages.slice(messageMark).some((m) => m.type === 'councilConfig'))
  assert.equal(h.controlEvents.slice(controlMark).some((e) => e.event === 'setConfig' && e.value === 'fake/default'), false)
  assert.equal(h.controlEvents.slice(controlMark).some((e) => e.event === 'prompt'), false)
  h.release('selector')
  await h.eventAfter(controlMark, 'setConfig', (e) => e.configId === 'model' && e.value === 'fake/default')
  await h.eventAfter(controlMark, 'prompt', (e) => e.text === 'normal')
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.model === 'fake/default')
  const ordered = h.controlEvents.slice(controlMark).filter((e) => e.event === 'setConfig' || e.event === 'prompt')
  assert.deepEqual(ordered.slice(0, 2).map((e) => e.event + ':' + (e.value || e.text)), ['setConfig:fake/default', 'prompt:normal'])
})

test('a command waits for an earlier selector before its ACP turn starts', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.release('commands:new-1')
  await h.event('commandsAdvertised', (e) => e.sessionId === 'new-1')
  await h.wait(() => h.messages.some((m) => (m.type === 'commands' || m.type === 'ready') && m.commands.some((c) => c.name === 'command-death')))
  h.send({ type: 'setModel', model: 'fake/selected' })
  await h.event('waiting', (e) => e.name === 'selector')
  const controlMark = h.controlEvents.length, messageMark = h.messages.length
  h.send({ type: 'command', name: 'command-death' })
  h.send({ type: 'getCouncilConfig' })
  await h.wait(() => h.messages.slice(messageMark).some((m) => m.type === 'councilConfig'))
  assert.equal(h.controlEvents.slice(controlMark).some((e) => e.event === 'prompt'), false)
  h.release('selector')
  await h.eventAfter(controlMark, 'prompt', (e) => e.text === '/command-death')
  await h.wait(() => h.messages.slice(messageMark).some((m) => m.type === 'turn-end' && m.stopReason === 'error'))
})

test('agent and effort selectors share the model selector queue in arrival order', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.send({ type: 'setModel', model: 'fake/selected' })
  await h.event('waiting', (e) => e.name === 'selector')
  const mark = h.controlEvents.length, messageMark = h.messages.length
  h.send({ type: 'setAgent', agent: 'review' })
  h.send({ type: 'setEffort', value: 'high' })
  h.send({ type: 'getCouncilConfig' })
  await h.wait(() => h.messages.slice(messageMark).some((m) => m.type === 'councilConfig'))
  assert.equal(h.controlEvents.slice(mark).some((e) => e.event === 'setConfig'), false)
  h.release('selector')
  await h.eventAfter(mark, 'setConfig', (e) => e.configId === 'mode' && e.value === 'review')
  await h.eventAfter(mark, 'setConfig', (e) => e.configId === 'effort' && e.value === 'high')
  assert.deepEqual(
    h.controlEvents.slice(mark).filter((e) => e.event === 'setConfig').slice(0, 2).map((e) => e.configId + ':' + e.value),
    ['mode:review', 'effort:high'],
  )
  await h.wait(() => h.messages.some((m) => m.type === 'agent' && m.agent === 'review'))
  await h.wait(() => h.messages.some((m) => m.type === 'effort' && m.effort === 'high'))
})

test('a selector received after a turn starts is refused without an ACP config call', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.send({ type: 'prompt', text: 'old-prompt' })
  await h.event('waiting', (e) => e.name === 'oldPrompt')
  const controlMark = h.controlEvents.length, messageMark = h.messages.length
  h.send({ type: 'setModel', model: 'fake/selected' })
  h.send({ type: 'getCouncilConfig' })
  await h.wait(() => h.messages.slice(messageMark).some((m) => m.type === 'councilConfig'))
  assert.equal(h.controlEvents.slice(controlMark).some((e) => e.event === 'setConfig'), false)
  assert.ok(h.messages.slice(messageMark).some((m) => m.type === 'error' && /current response/i.test(m.message)))
  h.release('oldPrompt')
  await h.wait(() => h.messages.slice(messageMark).some((m) => m.type === 'turn-end'))
})

test('turn settlement waits for the exact aborted ACP turn to physically finish', { concurrency: false }, async (t) => {
  const h = await harness(t)
  const mark = h.messages.length
  h.send({ type: 'prompt', text: 'old-prompt' })
  await h.event('waiting', (e) => e.name === 'oldPrompt')
  const started = await h.wait(() => h.messages.slice(mark).find((m) => m.type === 'turn-start'))
  assert.equal(h.messages.slice(mark).some((m) => m.type === 'turn-settled'), false)

  h.send({ type: 'abort' })
  await h.wait(() => h.messages.slice(mark).some((m) => m.type === 'turn-end' && m.stopReason === 'aborted'))
  assert.equal(h.messages.slice(mark).some((m) => m.type === 'turn-settled'), false)

  h.release('oldPrompt')
  const settled = await h.wait(() => h.messages.slice(mark).find((m) => m.type === 'turn-settled'))
  assert.deepEqual(
    { turnId: settled.turnId, sessionId: settled.sessionId, engineGeneration: settled.engineGeneration, sessionLease: settled.sessionLease },
    { turnId: started.turnId, sessionId: started.sessionId, engineGeneration: started.engineGeneration, sessionLease: started.sessionLease },
  )
  assert.equal(h.messages.slice(mark).filter((m) => m.type === 'turn-settled' && m.turnId === started.turnId).length, 1)
})

test('a successful prompt emits one identity-matched settlement after its terminal event', { concurrency: false }, async (t) => {
  const h = await harness(t)
  const mark = h.messages.length
  h.send({ type: 'prompt', text: 'normal' })
  await h.event('prompt', (e) => e.text === 'normal')
  const settled = await h.wait(() => h.messages.slice(mark).find((m) => m.type === 'turn-settled'))
  const lifecycle = h.messages.slice(mark).filter((m) => ['turn-start', 'turn-end', 'turn-settled'].includes(m.type))

  assert.deepEqual(lifecycle.map((m) => m.type), ['turn-start', 'turn-end', 'turn-settled'])
  assert.deepEqual(
    { turnId: lifecycle[0].turnId, sessionId: lifecycle[0].sessionId, engineGeneration: lifecycle[0].engineGeneration, sessionLease: lifecycle[0].sessionLease },
    { turnId: settled.turnId, sessionId: settled.sessionId, engineGeneration: settled.engineGeneration, sessionLease: settled.sessionLease },
  )
  assert.equal(h.messages.slice(mark).filter((m) => m.type === 'turn-start' && m.turnId === settled.turnId).length, 1)
  assert.equal(h.messages.slice(mark).filter((m) => m.type === 'turn-end').length, 1)
  assert.equal(h.messages.slice(mark).filter((m) => m.type === 'turn-settled' && m.turnId === settled.turnId).length, 1)
})

test('fake ACP engine bypasses missing sidecar-engine preflight in an isolated checkout', { concurrency: false }, async (t) => {
  const h = await harness(t, { engine: path.join(os.tmpdir(), 'definitely-missing-agent-omega-engine') })
  assert.equal(h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId, 'new-1')
})

test('sidecar blocks an old engine before it creates a task session', { concurrency: false }, async (t) => {
  const h = await harness(t, { verifyTaskQuality: true, healthMode: 'old', expectIncompatible: true })
  const down = await h.wait(() => h.messages.find((m) => m.type === 'engine-down'))
  assert.match(down.message, /Task-quality safety update required/i)
  assert.equal(h.controlEvents.some((e) => e.event === 'newSession'), false)
})

test('sidecar refuses a foreign OpenCode config before it can spawn an engine', { concurrency: false, skip: !MANAGED_WINDOWS_RUNTIME }, async (t) => {
  const h = await harness(t, { foreignConfig: true, expectIncompatible: true })
  const down = await h.wait(() => h.messages.find((m) => m.type === 'engine-down'))
  assert.match(down.message, /not an Agent Omega installation/i)
  assert.equal(h.launchCount(), 0)
})

test('sidecar refreshes only its managed task-quality plugin before creating a session', { concurrency: false, skip: !MANAGED_WINDOWS_RUNTIME }, async (t) => {
  const h = await harness(t)
  const config = JSON.parse(fs.readFileSync(path.join(h.config, 'opencode', 'opencode.json'), 'utf8'))
  assert.ok(config.plugin.includes('./task-quality/index.js'))
  assert.equal(
    fs.readFileSync(path.join(h.config, 'opencode', 'task-quality', 'index.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'config-template', 'opencode', 'task-quality', 'index.js'), 'utf8'),
  )
})

test('sidecar admits only a complete task-quality engine report before creating a session', { concurrency: false }, async (t) => {
  const h = await harness(t, { verifyTaskQuality: true, healthMode: 'valid' })
  assert.equal(h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId, 'new-1')
})

test('protocol harness strips inherited AO prefixes and provider credentials case-insensitively', () => {
  const env = isolatedChildEnv({ Path: 'kept', ao_trace: 'x', Agent_Omega_Test: 'x', OpenAI_Api_Key: 'x', PROVIDER_token: 'x', service_SECRET: 'x', ordinary: 'kept' })
  assert.deepEqual(env, { Path: 'kept', ordinary: 'kept' })
})

test('crash recovery cannot overwrite a user replacement queued during its replay', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.send({ type: 'load', sessionId: 'loaded-a' }); await h.event('waiting', (e) => e.name === 'load:loaded-a'); h.release('load:loaded-a')
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId === 'loaded-a')
  const mark = h.controlEvents.length
  await h.crash(); await h.reconnectControl()
  await h.eventAfter(mark, 'waiting', (e) => e.name === 'load:loaded-a')
  h.send({ type: 'new' })
  h.release('load:loaded-a')
  await h.eventAfter(mark, 'newSession', (e) => e.sessionId === 'new-2')
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId === 'new-2')
  assert.equal(h.messages.filter((m) => m.type === 'ready').at(-1).sessionId, 'new-2')
})

test('an older recovery cannot clear the newer recovery promise that replaced it', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.send({ type: 'load', sessionId: 'loaded-a' })
  await h.event('waiting', (e) => e.name === 'load:loaded-a')
  h.release('load:loaded-a')
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId === 'loaded-a')

  let controlMark = h.controlEvents.length
  await h.crash()
  await h.reconnectControl()
  await h.eventAfter(controlMark, 'waiting', (e) => e.name === 'load:loaded-a')

  const downCount = count(h.messages, 'engine-down')
  controlMark = h.controlEvents.length
  await h.crash()
  await h.wait(() => count(h.messages, 'engine-down') > downCount)
  h.send({ type: 'new' })
  await h.reconnectControl()
  // newSession can fire before the control socket reconnects; its held command
  // gate is reannounced and is the durable proof that new-2 exists.
  await h.eventAfter(controlMark, 'waiting', (e) => e.name === 'commands:new-2')
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId === 'new-2')
  assert.equal(h.launchCount(), 3)
})

test('busy crash emits exactly one terminal engine-down turn-end', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.send({ type: 'prompt', text: 'old-prompt' }); await h.event('prompt', (e) => e.text === 'old-prompt')
  const mark = h.messages.length
  await h.crash()
  await h.wait(() => h.messages.slice(mark).some((m) => m.type === 'engine-down'))
  await h.wait(() => h.messages.slice(mark).filter((m) => m.type === 'turn-end' && m.stopReason === 'engine-down').length === 1)
  assert.equal(h.messages.slice(mark).filter((m) => m.type === 'turn-end' && m.stopReason === 'engine-down').length, 1)
  await h.wait(() => h.messages.slice(mark).filter((m) => m.type === 'turn-settled').length === 1)
})

test('new sent before recovery connection exists waits for the one resurrection then wins', { concurrency: false }, async (t) => {
  const h = await harness(t)
  await h.crash(); await h.wait(() => h.messages.some((m) => m.type === 'engine-down')); h.send({ type: 'new' }); await h.reconnectControl()
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId === 'new-2')
})

test('load sent before recovery connection exists waits for resurrection and wins', { concurrency: false }, async (t) => {
  const h = await harness(t)
  await h.crash(); await h.wait(() => h.messages.some((m) => m.type === 'engine-down')); h.send({ type: 'load', sessionId: 'loaded-b' }); await h.reconnectControl()
  await h.event('waiting', (e) => e.name === 'load:loaded-b'); h.release('load:loaded-b')
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId === 'loaded-b')
})

test('competing New then Load during recovery makes Load the sole winning intent', { concurrency: false }, async (t) => {
  const h = await harness(t)
  await h.crash()
  await h.wait(() => h.messages.some((m) => m.type === 'engine-down'))
  h.send({ type: 'new' })
  h.send({ type: 'load', sessionId: 'loaded-b' })
  await h.reconnectControl()
  await h.event('waiting', (e) => e.name === 'load:loaded-b')
  h.release('load:loaded-b')
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId === 'loaded-b')
  assert.equal(h.controlEvents.some((e) => e.event === 'newSession' && e.sessionId === 'new-2'), false)
  assert.equal(h.launchCount(), 2)
})

test('competing Load then New during recovery makes New the sole winning intent', { concurrency: false }, async (t) => {
  const h = await harness(t)
  await h.crash()
  await h.wait(() => h.messages.some((m) => m.type === 'engine-down'))
  h.send({ type: 'load', sessionId: 'loaded-b' })
  h.send({ type: 'new' })
  await h.reconnectControl()
  await h.event('waiting', (e) => e.name === 'commands:new-2')
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId === 'new-2')
  assert.equal(h.controlEvents.some((e) => e.event === 'loadSession' && e.sessionId === 'loaded-b'), false)
  assert.equal(h.launchCount(), 2)
})

test('manual restart cancels auto-recovery and queues Load behind exactly one fresh engine', { concurrency: false }, async (t) => {
  const h = await harness(t)
  const mark = h.controlEvents.length
  const messageMark = h.messages.length
  await h.crash()
  await h.wait(() => h.messages.slice(messageMark).some((m) => m.type === 'engine-down'))
  h.send({ type: 'restart' })
  h.send({ type: 'load', sessionId: 'loaded-b' })
  await h.reconnectControl()
  await h.eventAfter(mark, 'waiting', (e) => e.name === 'load:loaded-b')
  h.release('load:loaded-b')
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').at(-1)?.sessionId === 'loaded-b')
  assert.equal(h.launchCount(), 2)
})

test('real sidecar serializes empty replacement and drains stale permission', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.send({ type: 'prompt', text: 'old-prompt' }); await h.event('prompt', (e) => e.text === 'old-prompt')
  h.send({ type: 'new' }); await h.event('cancel')
  assert.equal((await h.wait(() => true)) && h.messages.filter((m) => m.type === 'ready').at(-1).sessionId, 'new-1')
  h.release('oldPrompt'); await h.event('newSession', (e) => e.sessionId === 'new-2')
  h.send({ type: 'prompt', text: 'permission' }); await h.event('prompt', (e) => e.text === 'permission'); await h.wait(() => h.messages.find((m) => m.type === 'permission'))
  h.send({ type: 'new' }); await h.event('permissionOutcome', (e) => e.outcome === 'cancelled'); await h.event('newSession', (e) => e.sessionId === 'new-3')
  h.send({ type: 'prompt', text: 'normal' }); await h.event('prompt', (e) => e.text === 'normal'); await h.wait(() => h.messages.some((m) => m.type === 'turn-end'))
})

test('real sidecar balances replay brackets across load replacements', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.send({ type: 'load', sessionId: 'loaded-a' }); await h.event('loadSession', (e) => e.sessionId === 'loaded-a'); await h.event('waiting', (e) => e.name === 'load:loaded-a'); h.send({ type: 'new' }); h.release('load:loaded-a'); await h.event('newSession', (e) => e.sessionId === 'new-2')
  await h.wait(() => count(h.messages, 'replay-end') === 1)
  assert.deepEqual(h.messages.filter((m) => /^replay-(start|end)$/.test(m.type)).map((m) => m.type + ':' + m.sessionId), ['replay-start:loaded-a', 'replay-end:loaded-a'])
  let mark = h.controlEvents.length; h.send({ type: 'load', sessionId: 'loaded-a' }); await h.eventAfter(mark, 'loadSession', (e) => e.sessionId === 'loaded-a'); await h.eventAfter(mark, 'waiting', (e) => e.name === 'load:loaded-a'); mark = h.controlEvents.length; h.send({ type: 'load', sessionId: 'loaded-b' }); h.release('load:loaded-a'); await h.eventAfter(mark, 'loadSession', (e) => e.sessionId === 'loaded-b'); await h.eventAfter(mark, 'waiting', (e) => e.name === 'load:loaded-b'); h.release('load:loaded-b')
  await h.wait(() => count(h.messages, 'replay-end') >= 3)
  assert.deepEqual(h.messages.filter((m) => /^replay-(start|end)$/.test(m.type)).slice(-4).map((m) => m.type + ':' + m.sessionId), ['replay-start:loaded-a', 'replay-end:loaded-a', 'replay-start:loaded-b', 'replay-end:loaded-b'])
})

test('real sidecar emits terminal command error and bars stale afterSetup work', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.release('commands:new-1')
  await h.event('commandsAdvertised', (e) => e.sessionId === 'new-1')
  await h.wait(() => h.messages.some((m) => (m.type === 'commands' || m.type === 'ready') && m.commands.some((c) => c.name === 'command-death')))
  const commandMark = h.messages.length
  h.send({ type: 'command', name: 'command-death' }); await h.event('prompt', (e) => e.text === '/command-death'); await h.wait(() => h.messages.slice(commandMark).some((m) => m.type === 'turn-end' && m.stopReason === 'error'))
  await h.wait(() => h.messages.slice(commandMark).filter((m) => m.type === 'turn-settled').length === 1)
  h.send({ type: 'setAgent', agent: 'setup' }); await h.event('setConfig', (e) => e.value === 'setup')
  const setupMark = h.messages.length
  h.send({ type: 'prompt', text: 'setup' }); await h.event('prompt', (e) => e.text === 'setup'); await h.event('setConfig', (e) => e.configId === 'mode' && e.value === 'build')
  await h.wait(() => h.messages.slice(setupMark).some((m) => m.type === 'turn-end'))
  assert.equal(h.messages.slice(setupMark).some((m) => m.type === 'turn-settled'), false)
  const before = count(h.messages, 'agent'); h.send({ type: 'new' }); h.release('setupFlip');
  await h.wait(() => h.messages.slice(setupMark).some((m) => m.type === 'turn-settled'))
  await h.event('newSession', (e) => e.sessionId === 'new-2')
  assert.equal(h.messages.slice(before).some((m) => m.type === 'agent' && m.agent === 'build'), false)
})

test('ordinary setup prompt owns its restart transition without self-awaiting', { concurrency: false }, async (t) => {
  const h = await harness(t)
  h.send({ type: 'setAgent', agent: 'setup' }); await h.event('setConfig', (e) => e.value === 'setup')
  h.send({ type: 'prompt', text: 'setup-restart' }); await h.event('prompt', (e) => e.text === 'setup-restart')
  await h.wait(() => h.launchCount() === 2)
  await h.reconnectControl()
  await h.wait(() => h.messages.filter((m) => m.type === 'ready').length >= 2)
  await h.wait(() => h.messages.some((m) => m.type === 'notice' && /setup changes are live/i.test(m.message)))
})
