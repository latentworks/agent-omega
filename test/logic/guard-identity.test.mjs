// Launch-free arms of the binary-staleness guard, pinned in the standard
// suite (the launch arms need a built engine binary and live in
// test/live/guard-identity-proof.mjs). Imports the SHIPPED guard from the
// campaign — the campaign's CLI dispatch is entry-guarded, so importing it
// here runs nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { verifyEngineBinaryIdentity } = await import(new URL('../live/task-quality-campaign.mjs', import.meta.url))

const leakedTempDirs = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('omega-binary-identity-')).length

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
