import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_TURN_TIMEOUT_MS,
  canonicalTurnTimeoutMs,
  gatePollTimeoutMs,
  lifecycleView,
  artifactReviewLabel,
  omegaLifecyclePassed,
  RAW_ARM_LOG_MARKER,
  writeRawArmLogMarker,
} from '../live/task-quality-campaign.mjs'

const HARNESS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'live', 'task-quality-campaign.mjs')
const EIGHTY_B_LANE = { label: 'lane-80b', modelID: 'qwen3-coder-80b' }
const THIRTY_FIVE_B_LANE = { label: 'lane-35b', modelID: 'qwen3.6-35b' }
const OLD_DEFAULT_MS = 120000

// A terminal self-close: the engine records reviewedArtifact but never an
// artifactReview. This is the exact shape that made the old viewer render
// "no review" precisely when a self-attested close had in fact happened.
function selfCloseData() {
  return {
    phase: 'artifact-reviewed',
    approval: true,
    receipts: [{ id: 'r1' }],
    pendingExecutions: [],
    reviewedArtifact: { digest: 'abc123', generation: 4, receiptCount: 1, causallyAddressed: true },
    artifactReview: null,
  }
}

// A pass verdict: the current engine shape, an explicit artifactReview object.
function passVerdictData() {
  return {
    phase: 'artifact-reviewed',
    approval: true,
    receipts: [{ id: 'r1' }],
    pendingExecutions: [],
    artifactReview: { verdict: 'pass' },
  }
}

function approvalGate() {
  return {
    ok: true,
    state: { data: { phase: 'awaiting-approval', addressReceipt: { route: { kind: 'crap' } }, repairedPlan: { steps: 3 } } },
  }
}

function lifecycleFrom(data) {
  return { ok: true, state: { data }, view: lifecycleView({ revision: 7, generation: 4, data }) }
}

// ---------------------------------------------------------------------------
// FIX-4 (A4.1): the pre-GO gate at BOTH call sites derives its timeout from the
// lane's canonical turn timeout, not the old 120 s pollLifecycle default.
// ---------------------------------------------------------------------------

test('FIX-4/A4.1: gatePollTimeoutMs equals the lane canonical turn timeout for both lanes', () => {
  assert.equal(gatePollTimeoutMs(EIGHTY_B_LANE), canonicalTurnTimeoutMs(EIGHTY_B_LANE))
  assert.equal(gatePollTimeoutMs(THIRTY_FIVE_B_LANE), canonicalTurnTimeoutMs(THIRTY_FIVE_B_LANE))
})

test('FIX-4/A4.1: the 80B gate uses the long watchdog, not the 120 s default', () => {
  assert.equal(gatePollTimeoutMs(EIGHTY_B_LANE), MAX_TURN_TIMEOUT_MS)
  assert.equal(MAX_TURN_TIMEOUT_MS, 1_200_000)
  assert.notEqual(gatePollTimeoutMs(EIGHTY_B_LANE), OLD_DEFAULT_MS)
})

test('FIX-4/A4.1: a non-80B lane still gets its full 300 s turn timeout, above the old default', () => {
  assert.equal(gatePollTimeoutMs(THIRTY_FIVE_B_LANE), 300000)
  assert.ok(gatePollTimeoutMs(THIRTY_FIVE_B_LANE) > OLD_DEFAULT_MS)
})

test('FIX-4/A4.1: canonicalTurnTimeoutMs matches on modelID case-insensitively', () => {
  assert.equal(canonicalTurnTimeoutMs({ modelID: 'QWEN3-CODER-80B' }), MAX_TURN_TIMEOUT_MS)
})

test('FIX-4/A4.1: pollLifecycle default is aligned to the turn watchdog, not 120000', () => {
  // Both gate call sites pass gatePollTimeoutMs(lane) explicitly; the shared
  // default guards any other caller. Assert the source default at the definition.
  const source = fs.readFileSync(HARNESS_PATH, 'utf8')
  assert.match(source, /async function pollLifecycle\(context, predicate, timeoutMs = MAX_TURN_TIMEOUT_MS\)/)
  assert.doesNotMatch(source, /timeoutMs = 120000/)
})

// ---------------------------------------------------------------------------
// FIX-6 (A6.2): the viewer collapses both artifact-review shapes into one label.
// A self-close reads as 'self-attested' instead of silently "no review".
// ---------------------------------------------------------------------------

test('FIX-6/A6.2: artifactReviewLabel reports the verdict for the current shape', () => {
  assert.equal(artifactReviewLabel(passVerdictData()), 'pass')
})

test('FIX-6/A6.2: artifactReviewLabel labels a legacy self-close as self-attested', () => {
  assert.equal(artifactReviewLabel(selfCloseData()), 'self-attested')
})

test('FIX-6/A6.2: artifactReviewLabel returns null only for a genuine absence', () => {
  assert.equal(artifactReviewLabel({ phase: 'planning' }), null)
  assert.equal(artifactReviewLabel(null), null)
  assert.equal(artifactReviewLabel(undefined), null)
})

test('FIX-6/A6.2: lifecycleView surfaces self-attested for a self-close (the old bug returned null)', () => {
  const view = lifecycleView({ revision: 7, generation: 4, data: selfCloseData() })
  assert.equal(view.present, true)
  assert.equal(view.phase, 'artifact-reviewed')
  assert.equal(view.artifactReview, 'self-attested')
})

test('FIX-6/A6.2: lifecycleView surfaces the verdict for the current shape', () => {
  const view = lifecycleView({ revision: 7, generation: 4, data: passVerdictData() })
  assert.equal(view.artifactReview, 'pass')
})

test('FIX-6/A6.2: lifecycleView reports not-present when there is no data', () => {
  assert.deepEqual(lifecycleView(null), { present: false })
  assert.deepEqual(lifecycleView({ data: 'not-an-object' }), { present: false })
})

// ---------------------------------------------------------------------------
// FIX-6: omega pass logic accepts BOTH artifact-review shapes at the terminal.
// ---------------------------------------------------------------------------

test('FIX-6: omegaLifecyclePassed accepts a pass-verdict terminal', () => {
  assert.equal(omegaLifecyclePassed(lifecycleFrom(passVerdictData()), approvalGate()), true)
})

test('FIX-6: omegaLifecyclePassed accepts a self-close terminal (old logic failed it)', () => {
  assert.equal(omegaLifecyclePassed(lifecycleFrom(selfCloseData()), approvalGate()), true)
})

test('FIX-6: omegaLifecyclePassed still fails when neither review shape is present', () => {
  const data = passVerdictData()
  delete data.artifactReview
  // No reviewedArtifact and no artifactReview => genuinely unreviewed => fail,
  // proving the review shape is the deciding factor with all else held valid.
  assert.equal(omegaLifecyclePassed(lifecycleFrom(data), approvalGate()), false)
})

test('FIX-6: omegaLifecyclePassed fails when the pre-GO approval gate never reached CRAP', () => {
  const gate = approvalGate()
  gate.state.data.addressReceipt.route.kind = 'clean'
  assert.equal(omegaLifecyclePassed(lifecycleFrom(passVerdictData()), gate), false)
})

// ---------------------------------------------------------------------------
// FIX-6: the raw-control arm stamps an unambiguous marker into its log so an
// empty file is never mistaken for a silently crashed plugin.
// ---------------------------------------------------------------------------

test('FIX-6: writeRawArmLogMarker round-trips the marker into a fresh log path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-arm-marker-'))
  try {
    const logPath = path.join(dir, 'nested', 'task-quality.log')
    writeRawArmLogMarker(logPath)
    const written = fs.readFileSync(logPath, 'utf8')
    assert.equal(written, RAW_ARM_LOG_MARKER + '\n')
    assert.match(written, /raw-control arm/)
    assert.match(written, /plugin not loaded/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-6: RAW_ARM_LOG_MARKER carries no absolute path or personal identifier', () => {
  assert.equal(typeof RAW_ARM_LOG_MARKER, 'string')
  assert.ok(RAW_ARM_LOG_MARKER.length > 0)
  assert.doesNotMatch(RAW_ARM_LOG_MARKER, /[A-Za-z]:\\|\/Users\/|\/home\//)
})

// ---------------------------------------------------------------------------
// Import-side-effect guard: importing the campaign module must not trip the CLI
// usage/exit-2 branch (which would poison the whole `node --test` run).
// ---------------------------------------------------------------------------

test('the campaign module imports without triggering CLI dispatch', () => {
  assert.notEqual(process.exitCode, 2)
})
