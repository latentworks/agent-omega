import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionTransition } from '../../session-transition.mjs'

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

test('selector success/rejection after new or load is stale and silent', async () => {
  for (const kind of ['new', 'load']) for (const outcome of ['success', 'rejection']) {
    const tx = createSessionTransition(), selector = deferred(), started = deferred()
    const state = { current: 'old', picked: 'old', messages: [] }
    const lease = tx.epoch
    const select = selector.promise.then(() => { if (!tx.current(lease)) return; state.current = 'selected'; state.picked = 'selected'; state.messages.push('ready') }, () => { if (!tx.current(lease)) return; state.messages.push('error') })
    const replacement = tx.replace(async () => { started.resolve(); state.current = kind === 'new' ? 'sticky-confirmed' : 'loaded-config'; state.messages.push(kind) })
    await started.promise
    if (outcome === 'success') selector.resolve(); else selector.reject(new Error('late'))
    await Promise.all([select, replacement])
    assert.deepEqual(state, { current: kind === 'new' ? 'sticky-confirmed' : 'loaded-config', picked: 'old', messages: [kind] }, `${kind}/${outcome}`)
  }
})

test('load cancels then waits for the old prompt before ACP load begins', async () => {
  const tx = createSessionTransition(), prompt = deferred(), events = []
  const turn = tx.startTurn(async () => { events.push('cancel') })
  const running = prompt.promise.finally(() => turn.finish())
  const load = tx.replace(async () => { events.push('load') })
  await Promise.resolve()
  assert.deepEqual(events, ['cancel'])
  prompt.resolve()
  await Promise.all([running, load])
  assert.deepEqual(events, ['cancel', 'load'])
})

test('prompt and command are refused while replacement is active', async () => {
  const tx = createSessionTransition(), gate = deferred(), calls = []
  const replacement = tx.replace(async () => { await gate.promise })
  await Promise.resolve()
  assert.equal(tx.startTurn(() => calls.push('cancel')), null)
  assert.deepEqual(calls, [])
  gate.resolve()
  await replacement
  assert.ok(tx.startTurn(() => calls.push('cancel')), 'turns may start once the replacement settles')
})

test('a selector started after new/load begins is refused before an ACP config call', async () => {
  for (const kind of ['new', 'load']) {
    const tx = createSessionTransition(), gate = deferred(), acpCalls = []
    const replacement = tx.replace(async () => { await gate.promise })
    await Promise.resolve()
    const select = () => {
      if (tx.replacing) return 'refused'
      acpCalls.push('setSessionConfigOption')
      return 'called'
    }
    assert.equal(select(), 'refused', kind)
    assert.deepEqual(acpCalls, [], kind)
    gate.resolve()
    await replacement
  }
})

test('abort does not permit a second tracked turn and replacement waits through the post-turn barrier', async () => {
  const tx = createSessionTransition(), prompt = deferred(), setup = deferred(), events = []
  const turn = tx.startTurn(() => events.push('cancel'))
  const run = prompt.promise.then(async () => { events.push('prompt-settled'); await setup.promise; events.push('setup-settled') }).finally(() => turn.finish())
  await turn.cancel() // the abort path only requests cancellation; it does not discard ownership
  assert.equal(tx.startTurn(() => {}), null, 'a new prompt cannot overwrite an aborted, unsettled turn')
  const replacement = tx.replace(async () => { events.push('replacement') })
  await Promise.resolve()
  assert.deepEqual(events, ['cancel'])
  prompt.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['cancel', 'prompt-settled'])
  setup.resolve()
  await Promise.all([run, replacement])
  assert.deepEqual(events, ['cancel', 'prompt-settled', 'setup-settled', 'replacement'])
})

test('a setup turn can own its restart replacement without awaiting itself', async () => {
  const tx = createSessionTransition(), events = []
  const turn = tx.startTurn(() => events.push('cancel'))
  const restart = tx.replace(async () => { events.push('restart') }, turn)
  await restart
  assert.deepEqual(events, ['restart'])
  assert.equal(tx.startTurn(() => {}), null, 'the setup turn remains tracked until its barrier returns')
  turn.finish()
  assert.ok(tx.startTurn(() => {}), 'a subsequent turn may start after the setup barrier settles')
})

test('stale load closes only its own replay bracket before a queued replacement starts', async () => {
  const tx = createSessionTransition(), gate = deferred(), events = []
  let replay = null
  const beginReplay = (lease, sessionId) => { replay = { lease, sessionId }; events.push('start:' + sessionId) }
  const endReplay = (lease) => { if (replay && replay.lease === lease) { events.push('end:' + replay.sessionId); replay = null } }
  let oldLease
  const oldLoad = tx.replace(async (lease) => {
    oldLease = lease; beginReplay(lease, 'old')
    try { await gate.promise; if (tx.current(lease)) events.push('ready:old') }
    finally { endReplay(lease) }
  })
  await Promise.resolve()
  const fresh = tx.replace(async (lease) => { beginReplay(lease, 'fresh'); endReplay(lease); events.push('ready:fresh') })
  gate.resolve()
  await Promise.all([oldLoad, fresh])
  assert.equal(oldLease, 1)
  assert.deepEqual(events, ['start:old', 'end:old', 'start:fresh', 'end:fresh', 'ready:fresh'])
})

test('sidecar wires transition ownership into ACP callbacks, completion, replay, and packaging', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const sidecar = fs.readFileSync(path.join(root, 'sidecar.mjs'), 'utf8')
  const project = fs.readFileSync(path.join(root, 'AgentOmega.csproj'), 'utf8')
  assert.match(project, /<None Include="session-transition\.mjs" CopyToOutputDirectory="PreserveNewest"\s*\/>/)
  assert.match(sidecar, /p\.sessionId !== sessionId\) return \{ outcome: \{ outcome: 'cancelled' \} \}/)
  assert.match(sidecar, /pp\.sessionId !== sessionId && !replayOwns\(pp\.sessionId\)\) return/)
  assert.match(sidecar, /const message = await emptyTurnError\(\)[\s\S]{0,180}sessionLeaseCurrent\(tracked\.lease\)\) broadcast\(\{ type: 'error'/)
  assert.match(sidecar, /if \(isEngineDeathError\(e\)\) broadcast\(\{ type: 'turn-end', stopReason: 'error' \}\)/)
  assert.match(sidecar, /finally \{ tracked\.finish\(\) \}/)
  assert.match(sidecar, /await restartEngine\(tracked\)/)
  const loadCase = sidecar.slice(sidecar.indexOf("case 'load':"))
  assert.ok(loadCase.includes('beginReplay(lease, m.sessionId)'), 'load opens its replay bracket')
  assert.ok(loadCase.includes('finally { endReplay(lease) }'), 'load closes its replay bracket structurally')
})
