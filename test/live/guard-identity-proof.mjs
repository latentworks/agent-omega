// Behavior proof for the binary-staleness guard, run against the SHIPPED
// harness code: it imports verifyEngineBinaryIdentity / verifiedReleaseIdentity
// from ./task-quality-campaign.mjs (not a copy), launches the real built
// engine binary, and walks every guard verdict the campaign can hit.
//
// Live proof — needs a real engine checkout with a built binary:
//   AGENT_OMEGA_TEST_ENGINE_REPO=<engine repo> node test/live/guard-identity-proof.mjs
//
// Arm 5 writes (and always removes) one untracked marker file in the engine
// repo to prove the dirty-tree hard-abort; everything else is read-only.
// The launch-free arms are also pinned in test/logic/guard-identity.test.mjs,
// which runs in the standard `node --test` suite without any binary.
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENGINE_REPO = process.env.AGENT_OMEGA_TEST_ENGINE_REPO ? path.resolve(process.env.AGENT_OMEGA_TEST_ENGINE_REPO) : null
if (!ENGINE_REPO) {
  console.error('AGENT_OMEGA_TEST_ENGINE_REPO is not set — refusing to guess which engine repo to prove against')
  process.exit(2)
}
const { verifyEngineBinaryIdentity, verifiedReleaseIdentity } = await import(new URL('./task-quality-campaign.mjs', import.meta.url))

const BINARY = path.join(ENGINE_REPO, 'packages', 'opencode', 'dist', 'opencode-windows-x64', 'bin', 'opencode.exe')
const head = childProcess.execSync('git rev-parse HEAD', { cwd: ENGINE_REPO }).toString().trim()
const clean = childProcess.execSync('git status --porcelain', { cwd: ENGINE_REPO }).toString().trim() === ''
console.log(`repo HEAD: ${head}  clean: ${clean}`)

const tempDirNames = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('omega-binary-identity-'))
const tempDirsBefore = new Set(tempDirNames())

let fails = 0
const check = (label, cond, extra = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) fails++ }

// Arm 1: real binary vs real HEAD -> ok:true, identity fields present
const r1 = await verifyEngineBinaryIdentity(BINARY, head, clean)
check('arm1 ok:true vs HEAD', r1.ok === true, r1.ok ? `rev=${r1.build.revision.slice(0, 12)} ver=${r1.binaryVersion}` : r1.reason)
check('arm1 fields for fingerprint', r1.ok === true && typeof r1.build.revision === 'string' && typeof r1.build.sourceDigest === 'string' && typeof r1.binaryVersion === 'string')

// Arm 2: wrong expected revision -> STALE
const r2 = await verifyEngineBinaryIdentity(BINARY, 'f'.repeat(40), true)
check('arm2 STALE on wrong revision', r2.ok === false && /STALE BINARY/.test(r2.reason), r2.reason)

// Arm 3: dirty flag -> refuses without launching
const r3 = await verifyEngineBinaryIdentity(BINARY, head, false)
check('arm3 dirty-tree refusal', r3.ok === false && /dirty/.test(r3.reason), r3.reason)

// Arm 4: full wrapper positive path — the run fingerprint now carries the
// binary's embedded identity, bound to the same engineCommit.
const release = await verifiedReleaseIdentity()
check('arm4 wrapper fingerprint carries binary identity',
  release.binaryRevision === head && release.engineCommit === head &&
  typeof release.binarySourceDigest === 'string' && typeof release.binaryVersion === 'string',
  `binaryRevision=${String(release.binaryRevision).slice(0, 12)} ver=${release.binaryVersion}`)

// Arm 5: full wrapper abort path — a dirty engine tree (reversible untracked
// file) must make the wrapper THROW, not return a fingerprint.
const dirtMarker = path.join(ENGINE_REPO, '.guard-identity-proof-dirty-marker')
fs.writeFileSync(dirtMarker, 'temporary dirty-tree marker for the guard identity proof\n')
try {
  let threw = null
  try { await verifiedReleaseIdentity() } catch (error) { threw = String(error?.message || error) }
  check('arm5 wrapper hard-aborts on dirty tree',
    threw !== null && /engine binary identity preflight failed/.test(threw) && /dirty/.test(threw), threw ?? 'no throw')
} finally {
  fs.rmSync(dirtMarker, { force: true })
}
const cleanAfter = childProcess.execSync('git status --porcelain', { cwd: ENGINE_REPO }).toString().trim() === ''
check('arm5 cleanup: engine tree clean again', cleanAfter)

// Arm 6: guard hygiene — every launch above tore its temp XDG root down.
// Name-set, not count: a leak masked by an unrelated dir vanishing must fail.
const leakedNow = tempDirNames().filter((name) => !tempDirsBefore.has(name))
check('arm6 no leaked omega-binary-identity temp dirs', leakedNow.length === 0, leakedNow.length ? `new dirs: ${leakedNow.join(', ')}` : `before=${tempDirsBefore.size} after=${tempDirNames().length}`)

console.log(fails === 0 ? '\nGUARD IDENTITY PROOF PASSED (shipped harness code)' : `\n${fails} ARM(S) FAILED`)
process.exit(fails === 0 ? 0 : 1)
