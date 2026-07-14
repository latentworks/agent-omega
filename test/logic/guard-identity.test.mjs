// Launch-free arms of the binary-staleness guard, pinned in the standard
// suite (the launch arms need a built engine binary and live in
// test/live/guard-identity-proof.mjs). Imports the SHIPPED guard from the
// campaign — the campaign's CLI dispatch is entry-guarded, so importing it
// here runs nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { verifyEngineBinaryIdentity } = await import(new URL('../live/task-quality-campaign.mjs', import.meta.url))

const tempDirNames = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('omega-binary-identity-'))

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const deadWithin = async (pid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (alive(pid)) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

test('guard refuses a dirty source tree before launching anything', async () => {
  // name-set, not count: a leak masked by an unrelated dir vanishing must fail
  const before = new Set(tempDirNames())
  const result = await verifyEngineBinaryIdentity(path.join(os.tmpdir(), 'no-such-binary.exe'), 'f'.repeat(40), false)
  assert.equal(result.ok, false)
  assert.match(result.reason, /dirty/)
  // the dirty refusal returns before mkdtemp/spawn — nothing to clean up
  assert.deepEqual(tempDirNames().filter((name) => !before.has(name)), [])
})

test('guard rejects gracefully when the binary cannot launch, and still cleans its temp root', async () => {
  const before = new Set(tempDirNames())
  const missing = path.join(os.tmpdir(), 'guard-identity-missing', 'opencode.exe')
  // Before the child 'error' listener existed, a spawn failure raised an
  // unhandled ChildProcess error event and crashed the process instead of
  // rejecting — this test fails by crashing on a regression.
  await assert.rejects(
    () => verifyEngineBinaryIdentity(missing, 'f'.repeat(40), true),
    /failed to launch|engine exited/,
  )
  // the finally teardown must remove the temp XDG root on the failure path too
  assert.deepEqual(tempDirNames().filter((name) => !before.has(name)), [])
})

test('guard kill path tears down a live engine tree promptly and cleans its temp root', async () => {
  // The guard launches its engine with a fixed first argument of 'serve' and
  // no cwd override, so node.exe as the "binary" resolves a stub script named
  // `serve` from the current directory. The stub announces the guard's
  // expected listening line for dead port 1 and then stays alive: the health
  // probe is refused, and the finally teardown meets a LIVE child — the
  // taskkill -> await-exit -> rm ordering that no launch-free arm reaches.
  const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-killpath-'))
  const pidFile = path.join(stubRoot, 'stub.pid')
  fs.writeFileSync(path.join(stubRoot, 'serve'), [
    "require('node:fs').writeFileSync(process.env.GUARD_KILLPATH_PID_FILE, String(process.pid))",
    "console.log('server listening on http://127.0.0.1:1')",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  const cwdBefore = process.cwd()
  process.env.GUARD_KILLPATH_PID_FILE = pidFile
  process.chdir(stubRoot)
  try {
    // Timing guard, honest scope: the exit-listener-after-taskkill race loses
    // at an ENVIRONMENT-DEPENDENT rate (~1-in-6 teardowns with the real
    // engine, ~0 with this fast stub — measured both ways), so this loop is
    // only an opportunistic catch for that race; the DETERMINISTIC regression
    // tripwire for it is the dying-child test below. What this loop does pin
    // hard, six times over: the live-child teardown stays fast, the tree kill
    // lands, and no temp root leaks. The aggregate assertions stay robust
    // under CPU load: the FASTEST call bounds the machine baseline (an
    // always-slow regression fails it), and the SPREAD catches any single
    // call that paid the ~+5s dead wait without punishing uniform slowness.
    const elapsed = []
    for (let round = 0; round < 6; round++) {
      const before = new Set(tempDirNames())
      const startedAt = Date.now()
      await assert.rejects(
        () => verifyEngineBinaryIdentity(process.execPath, 'f'.repeat(40), true),
        /fetch failed|ECONNREFUSED/i,
      )
      elapsed.push(Date.now() - startedAt)
      const pid = Number(fs.readFileSync(pidFile, 'utf8'))
      assert.ok(Number.isInteger(pid) && pid > 0, `round ${round}: stub never reported its pid`)
      assert.ok(await deadWithin(pid, 3000), `round ${round}: stub pid ${pid} survived the tree kill`)
      // the temp XDG root from this launch must be gone (no NEW dirs by name)
      assert.deepEqual(tempDirNames().filter((name) => !before.has(name)), [], `round ${round}: temp root leaked`)
    }
    const fastest = Math.min(...elapsed)
    const spread = Math.max(...elapsed) - fastest
    assert.ok(fastest < 4500, `fastest guard call took ${fastest}ms — every teardown paid the dead 5s exit wait (${elapsed.join(', ')})`)
    assert.ok(spread < 4000, `guard call spread was ${spread}ms — some teardown paid the dead 5s exit wait (${elapsed.join(', ')})`)
  } finally {
    process.chdir(cwdBefore)
    delete process.env.GUARD_KILLPATH_PID_FILE
    try {
      const orphan = Number(fs.readFileSync(pidFile, 'utf8'))
      if (Number.isInteger(orphan) && orphan > 0 && alive(orphan)) {
        childProcess.spawnSync('taskkill', ['/pid', String(orphan), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      }
    } catch {}
    fs.rmSync(stubRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('guard teardown does not pay the 5s exit wait for a child dying mid-kill', async () => {
  // Deterministic regression tripwire for the exit-listener-after-taskkill
  // race. The live-child stub above almost never loses that race in this fast
  // environment (measured 0-in-18 pre-fix), so this arm manufactures the loss
  // instead: the stub is a REAL http server that answers the guard's health
  // probe (500 -> guard resolves ok:false through the finally teardown) and
  // self-exits ~30ms later — so the child's exit event lands squarely inside
  // the taskkill await. An exit listener attached only AFTER that await has
  // already missed the event and pays the full 5s race timeout nearly every
  // call; the fixed ordering (listener first, exitCode recheck) returns fast.
  const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-dyingchild-'))
  const pidFile = path.join(stubRoot, 'stub.pid')
  fs.writeFileSync(path.join(stubRoot, 'serve'), [
    "require('node:fs').writeFileSync(process.env.GUARD_KILLPATH_PID_FILE, String(process.pid))",
    "const http = require('node:http')",
    "const server = http.createServer((req, res) => { res.statusCode = 500; res.end('x'); setTimeout(() => process.exit(0), 30) })",
    "server.listen(0, '127.0.0.1', () => console.log(`server listening on http://127.0.0.1:${server.address().port}`))",
    '',
  ].join('\n'))
  const cwdBefore = process.cwd()
  process.env.GUARD_KILLPATH_PID_FILE = pidFile
  process.chdir(stubRoot)
  try {
    for (let round = 0; round < 2; round++) {
      const before = new Set(tempDirNames())
      const startedAt = Date.now()
      const result = await verifyEngineBinaryIdentity(process.execPath, 'f'.repeat(40), true)
      const elapsed = Date.now() - startedAt
      assert.equal(result.ok, false, `round ${round}: guard accepted the stub`)
      assert.match(result.reason, /health returned 500/, `round ${round}: unexpected reason: ${result.reason}`)
      assert.ok(elapsed < 4500, `round ${round}: guard call took ${elapsed}ms — teardown paid the dead 5s exit wait on a dying child`)
      const pid = Number(fs.readFileSync(pidFile, 'utf8'))
      assert.ok(Number.isInteger(pid) && pid > 0, `round ${round}: stub never reported its pid`)
      assert.ok(await deadWithin(pid, 3000), `round ${round}: stub pid ${pid} survived teardown`)
      assert.deepEqual(tempDirNames().filter((name) => !before.has(name)), [], `round ${round}: temp root leaked`)
    }
  } finally {
    process.chdir(cwdBefore)
    delete process.env.GUARD_KILLPATH_PID_FILE
    try {
      const orphan = Number(fs.readFileSync(pidFile, 'utf8'))
      if (Number.isInteger(orphan) && orphan > 0 && alive(orphan)) {
        childProcess.spawnSync('taskkill', ['/pid', String(orphan), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      }
    } catch {}
    fs.rmSync(stubRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
