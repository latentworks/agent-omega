import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRouteHandoff } from '../../config-template/opencode/task-quality/handoff.mjs'
import { PHASE, createLifecycle, digestPlan, hasCurrentApproval, recordArtifactReview, recordExecutionPermissionRejected, recordExecutionStarted, recordReceipt, recordRepairedPlan, recordUserDecision, reconstructLifecycle } from '../../config-template/opencode/task-quality/lifecycle.mjs'
import { admitTaskQualityTool, ARTIFACT_CONTROL_TOOL, CONTROL_TOOL } from '../../config-template/opencode/task-quality/admission.mjs'
import { createLifecycleAdapter, normalizeSnapshot } from '../../config-template/opencode/task-quality/adapter.mjs'

const handoff = buildRouteHandoff({ sessionID: 'ses-1', messageID: 'msg-task', messages: ['Build the feature'], skillNames: ['brainstorming'], routedAt: 1 })
const planText = 'Plan'
const passReview = Object.freeze({ route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'plan', digest: digestPlan(planText) }, result: { verdict: 'pass', summary: 'No supported gaps.', findings: [], dispositions: [] } })

test('router handoff is structured and qualifies only from the existing router skill result', () => {
  assert.equal(handoff.qualifies, true)
  assert.equal(handoff.qualificationReason, 'skill-router:brainstorming')
  const miss = buildRouteHandoff({ sessionID: 'ses-1', messageID: 'msg-chat', messages: ['thanks'], skillNames: [], routedAt: 2 })
  assert.equal(miss.qualifies, false)
  assert.notEqual(miss.taskKey, handoff.taskKey)
})

test('repaired plan digest is canonical and creates a new exact approval generation', () => {
  const initial = createLifecycle(handoff, { now: 10 })
  assert.throws(() => recordRepairedPlan(initial, '1. Inspect\r\n2. Change'), /completed isolated plan review/)
  assert.throws(() => recordRepairedPlan(initial, '1. Inspect\r\n2. Change', { review: passReview, acceptanceCriteria: ['Build is green'] }), /engine-calculated reviewed-plan digest/)
  const reviewedPlan = '1. Inspect\r\n2. Change'
  const reviewedDigest = digestPlan(reviewedPlan)
  assert.throws(() => recordRepairedPlan(initial, reviewedPlan, { review: { ...passReview, submission: { kind: 'plan', digest: reviewedDigest } }, reviewedDigest: digestPlan('different plan'), acceptanceCriteria: ['Build is green'] }), /does not match the exact repaired plan content/)
  const repaired = recordRepairedPlan(initial, reviewedPlan, { review: { ...passReview, submission: { kind: 'plan', digest: reviewedDigest } }, reviewedDigest, acceptanceCriteria: ['Build is green'], now: 20 })
  assert.equal(repaired.phase, PHASE.AWAITING_APPROVAL)
  assert.equal(repaired.generation, 2)
  assert.equal(repaired.repairedPlan.digest, reviewedDigest)
  assert.equal(hasCurrentApproval(repaired), false)
})

test('only an explicit external-user go approves the exact current generation', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff, { now: 10 }), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'], now: 20 })
  assert.equal(recordUserDecision(repaired, { origin: 'internal-subagent', messageID: 'msg-internal', text: 'go', expectedGeneration: 2 }).ok, false)
  assert.equal(recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-user', text: 'can we go?', expectedGeneration: 2 }).ok, false)
  assert.equal(recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-user', text: 'go for it', expectedGeneration: 1 }).reason, 'stale-plan-generation')
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-user', text: 'Go for gold.', expectedGeneration: 2, now: 30 })
  assert.equal(approved.ok, true)
  assert.equal(approved.lifecycle.phase, PHASE.APPROVED)
  assert.equal(approved.lifecycle.approval.planDigest, repaired.repairedPlan.digest)
  assert.equal(hasCurrentApproval(approved.lifecycle), true)
})

test('different routed task reconstructs with a new generation and drops stale approval', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'approved', expectedGeneration: repaired.generation }).lifecycle
  const nextHandoff = buildRouteHandoff({ sessionID: 'ses-1', messageID: 'msg-next', messages: ['Fix a bug'], skillNames: ['debugging'] })
  const next = reconstructLifecycle(approved, nextHandoff)
  assert.equal(next.phase, PHASE.PLANNING)
  assert.equal(next.generation, approved.generation + 1)
  assert.equal(next.approval, null)
})

test('admission fails closed for missing, stale, and unknown state while allowing only the loader-attested lifecycle checkpoint', () => {
  assert.equal(admitTaskQualityTool({ tool: 'read', capability: 'read' }).decision, 'allow')
  assert.equal(admitTaskQualityTool({ tool: 'mcp_new', capability: 'unknown' }).decision, 'deny')
  assert.equal(admitTaskQualityTool({ tool: CONTROL_TOOL, source: 'plugin', capability: 'unknown' }).decision, 'deny')
  assert.equal(admitTaskQualityTool({ tool: CONTROL_TOOL, source: 'mcp', capability: 'unknown', trustedControl: CONTROL_TOOL }).decision, 'deny')
  assert.equal(admitTaskQualityTool({ tool: CONTROL_TOOL, source: 'plugin', capability: 'read', trustedControl: CONTROL_TOOL }).decision, 'allow')
  assert.equal(admitTaskQualityTool({ tool: CONTROL_TOOL, source: 'plugin', capability: 'unknown', trustedControl: 'other-control' }).decision, 'deny')
  assert.equal(admitTaskQualityTool({ tool: CONTROL_TOOL, source: 'plugin', capability: 'unknown', trustedControl: CONTROL_TOOL }).decision, 'allow')
  assert.equal(admitTaskQualityTool({ tool: ARTIFACT_CONTROL_TOOL, source: 'plugin', capability: 'unknown', trustedControl: ARTIFACT_CONTROL_TOOL }).decision, 'allow')
  assert.equal(admitTaskQualityTool({ tool: ARTIFACT_CONTROL_TOOL, source: 'plugin', capability: 'unknown', trustedControl: CONTROL_TOOL }).decision, 'deny')
  assert.equal(admitTaskQualityTool({ tool: 'edit', capability: 'mutate', lifecycle: null }).decision, 'deny')
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  assert.equal(admitTaskQualityTool({ tool: 'edit', capability: 'mutate', lifecycle: repaired }).decision, 'deny')
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'ship it', expectedGeneration: repaired.generation }).lifecycle
  assert.equal(admitTaskQualityTool({ tool: 'edit', capability: 'mutate', lifecycle: approved }).decision, 'allow')
})

test('artifact review is receipt-bound, digest-bound, terminal, and duplicate receipt delivery is idempotent', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go for it', expectedGeneration: repaired.generation }).lifecycle
  const receipt = { callID: 'call-proof', tool: 'bash', kind: 'verification', outputDigest: digestPlan('tests passed'), outputBytes: 12, capturedAt: 50 }
  const started = recordExecutionStarted(approved, { callID: 'call-proof', tool: 'bash', startedAt: 49 })
  const withReceipt = recordReceipt(started, receipt, { now: 51 })
  assert.equal(withReceipt.receipts.length, 1)
  assert.equal(recordReceipt(withReceipt, receipt, { now: 52 }), withReceipt)
  assert.throws(() => recordReceipt(withReceipt, { ...receipt, outputDigest: digestPlan('different') }), /different evidence/)
  const artifact = 'Changed the implementation and observed the focused proof pass.'
  const review = { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'artifact', digest: digestPlan(artifact) }, result: { verdict: 'pass', summary: 'Evidence sufficient.', findings: [] } }
  const complete = recordArtifactReview(withReceipt, artifact, { review, reviewedDigest: digestPlan(artifact), now: 60 })
  assert.equal(complete.phase, PHASE.ARTIFACT_REVIEWED)
  assert.equal(complete.reviewedArtifact.receiptCount, 1)
  assert.equal(hasCurrentApproval(complete), false)
  assert.throws(() => recordArtifactReview(withReceipt, artifact, { review, reviewedDigest: digestPlan('other') }), /does not match/)
})

test('only a matching durable permission rejection settles its exact precommit', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go for it', expectedGeneration: repaired.generation }).lifecycle
  const started = recordExecutionStarted(approved, { callID: 'call-permission', tool: 'edit', startedAt: 40 })
  const settled = recordExecutionPermissionRejected(started, { callID: 'call-permission', tool: 'edit', now: 41 })
  assert.equal(settled.pendingExecutions.length, 0)
  assert.equal(recordExecutionPermissionRejected(settled, { callID: 'call-permission', tool: 'edit' }), settled)
  assert.throws(() => recordExecutionPermissionRejected(started, { callID: 'call-permission', tool: 'bash' }), /does not match/)
})

test('engine adapter uses the attested lifecycle/review bridge and exposes missing review as unavailable', async () => {
  const calls = []
  const internal = {
    get: async (sessionID) => { calls.push(['get', sessionID]); return { revision: 2, generation: 4, data: { phase: 'planning' } } },
    update: async (input) => { calls.push(['update', input]); return { ...input, revision: 3 } },
    review: async (input) => { calls.push(['review', input]); return { route: { kind: 'crap', model: 'local/model' }, submission: input.submission, review: { status: 'complete', result: { verdict: 'pass', findings: [], dispositions: [] } } } },
  }
  const adapter = createLifecycleAdapter({}, internal, [{ agent: 'helper2' }])
  assert.equal(adapter.canReview, true)
  assert.deepEqual(normalizeSnapshot(await adapter.get('ses-1')), { revision: 2, generation: 4, data: { phase: 'planning' } })
  await adapter.update({ sessionID: 'ses-1', expectedRevision: 2, expectedGeneration: 4, generation: 5, data: {} })
  await adapter.review({ sessionID: 'ses-1', contract: 'x', acceptanceCriteria: ['y'], submission: { kind: 'plan', content: 'z', digest: 'd' } })
  assert.deepEqual(calls.map((item) => item[0]), ['get', 'update', 'review'])
  assert.equal(createLifecycleAdapter({}, { ...internal, review: undefined }), null)
  const mismatched = createLifecycleAdapter({}, {
    ...internal,
    review: async () => ({ route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'plan', digest: 'wrong' }, review: { status: 'complete', result: { verdict: 'pass' } } }),
  })
  await assert.rejects(() => mismatched.review({ sessionID: 'ses-1', submission: { kind: 'plan', content: 'z', digest: 'd' } }), /canonical submitted artifact digest/)
})
