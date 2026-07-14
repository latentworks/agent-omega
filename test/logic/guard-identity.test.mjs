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

const leakedTempDirs = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('omega-binary-identity-')).length

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
  const before = leakedTempDirs()
  const result = await verifyEngineBinaryIdentity(path.join(os.tmpdir(), 'no-such-binary.exe'), 'f'.repeat(40), false)
  assert.equal(result.ok, false)
  assert.match(result.reason, /dirty/)
  // the dirty refusal returns before mkdtemp/spawn — nothing to clean up
  assert.ok(leakedTempDirs() <= before)
})

test('guard rejects gracefully when the binary cannot launch, and still cleans its temp root', async () => {
  const before = leakedTempDirs()
  const missing = path.join(os.tmpdir(), 'guard-identity-missing', 'opencode.exe')
  // Before the child 'error' listener existed, a spawn failure raised an
  // unhandled ChildProcess error event and crashed the process instead of
  // rejecting — this test fails by crashing on a regression.
  await assert.rejects(
    () => verifyEngineBinaryIdentity(missing, 'f'.repeat(40), true),
    /failed to launch|engine exited/,
  )
  // the finally teardown must remove the temp XDG root on the failure path too
  assert.ok(leakedTempDirs() <= before)
})

test('guard kill path tears down a live engine tree promptly and cleans its temp root', async () => {
  // The guard launches its engine with a fixed first argument of 'serve' and
  // no cwd override, so node.exe as the "binary" resolves a stub script named
  // `serve` from the current directory. The stub announces the guard's
  // expected listening line for dead port 1 and then stays alive: the health
  // probe is refused, and the finally teardown meets a LIVE child — the
  // taskkill -> await-exit -> rm ordering that no launch-free arm reaches.
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('omega-binary-identity-')))
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
  const startedAt = Date.now()
  try {
    await assert.rejects(
      () => verifyEngineBinaryIdentity(process.execPath, 'f'.repeat(40), true),
      /fetch failed|ECONNREFUSED/i,
    )
    // Regression tripwire: if the exit listener is attached only after the
    // taskkill await, the child's exit has already fired by then and the
    // teardown pays its full 5s race timeout on every call.
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 4500, `guard call took ${elapsed}ms — teardown paid the dead 5s exit wait`)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0, 'stub never reported its pid')
    assert.ok(await deadWithin(pid, 3000), `stub pid ${pid} survived the tree kill`)
    // the temp XDG root from this launch must be gone (no NEW dirs by name)
    const leaked = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('omega-binary-identity-') && !before.has(name))
    assert.deepEqual(leaked, [])
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
