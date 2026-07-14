import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildRouteHandoff } from '../../config-template/opencode/task-quality/handoff.mjs'
import { PHASE, REVIEW_HISTORY_LIMIT, REVIEW_REPORT_EXCERPT_BYTES, REVIEW_ROUNDS_CAP, createLifecycle, digestPlan, hasCurrentApproval, recordAddressedArtifact, recordAddressedPlan, recordArtifactRereview, recordArtifactReview, recordArtifactReviewDenied, recordExecutionPermissionRejected, recordExecutionStarted, recordPendingArtifactReview, recordPendingPlanReview, recordReceipt, recordRepairedPlan, recordReviewDelivered, recordUserDecision, reconstructLifecycle, revokeApprovalForSubstantiveTurn } from '../../config-template/opencode/task-quality/lifecycle.mjs'
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
  assert.equal(recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-scope-change', text: 'Go ahead and also delete B.', expectedGeneration: 2 }).reason, 'ambiguous-user-decision')
  assert.equal(recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-user', text: 'go for it', expectedGeneration: 1 }).reason, 'stale-plan-generation')
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-user', text: 'Go for gold.', expectedGeneration: 2, now: 30 })
  assert.equal(approved.ok, true)
  assert.equal(approved.lifecycle.phase, PHASE.APPROVED)
  assert.equal(approved.lifecycle.approval.planDigest, repaired.repairedPlan.digest)
  assert.equal(hasCurrentApproval(approved.lifecycle), true)
})

test('a substantive external-user turn revokes an approved generation while a standalone decision does not', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff, { now: 10 }), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'], now: 20 })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-user', text: 'go', expectedGeneration: repaired.generation, now: 30 }).lifecycle
  assert.equal(revokeApprovalForSubstantiveTurn(approved, { origin: 'external-user', text: 'GO.' }).ok, false)
  assert.equal(revokeApprovalForSubstantiveTurn(approved, { origin: 'internal-subagent', text: 'Build another thing' }).ok, false)
  const revoked = revokeApprovalForSubstantiveTurn(approved, { origin: 'external-user', messageID: 'msg-new-scope', text: 'Build another thing', now: 40 })
  assert.equal(revoked.ok, true)
  assert.equal(revoked.lifecycle.phase, PHASE.PLANNING)
  assert.equal(revoked.lifecycle.generation, approved.generation + 1)
  assert.equal(revoked.lifecycle.repairedPlan, null)
  assert.equal(revoked.lifecycle.approval, null)
  assert.equal(hasCurrentApproval(revoked.lifecycle), false)
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
  const taskPending = recordExecutionStarted(approved, { callID: 'call-direct-task', tool: 'task', startedAt: 30 })
  assert.equal(admitTaskQualityTool({ tool: 'write', capability: 'mutate', lifecycle: taskPending }).decision, 'deny')
  assert.equal(admitTaskQualityTool({ tool: 'write', capability: 'mutate', lifecycle: taskPending, directTaskWrapperCallID: 'call-direct-task' }).decision, 'allow')
  assert.equal(admitTaskQualityTool({ tool: 'write', capability: 'mutate', lifecycle: taskPending, directTaskWrapperCallID: 'other-task' }).decision, 'deny')
  const actionPending = recordExecutionStarted(taskPending, { callID: 'call-write', tool: 'write', startedAt: 31 })
  assert.equal(admitTaskQualityTool({ tool: 'write', capability: 'mutate', lifecycle: actionPending, directTaskWrapperCallID: 'call-direct-task' }).decision, 'deny')
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
  assert.throws(() => recordReceipt(started, { ...receipt, agent: 'bad agent name' }), /agent identity is invalid/)
  assert.throws(() => recordReceipt(started, { ...receipt, childBuiltinReads: 0 }), /child builtin read count is invalid/)
  const artifact = 'Changed the implementation and observed the focused proof pass.'
  const review = { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'artifact', digest: digestPlan(artifact) }, result: { verdict: 'pass', summary: 'Evidence sufficient.', findings: [] } }
  const suspended = revokeApprovalForSubstantiveTurn(withReceipt, { origin: 'external-user', messageID: 'msg-artifact', text: 'Run the final artifact review now.', now: 55 })
  assert.equal(suspended.ok, true)
  assert.equal(suspended.lifecycle.phase, PHASE.AWAITING_ARTIFACT_REVIEW)
  assert.equal(suspended.lifecycle.artifactReviewMessageID, 'msg-artifact')
  assert.equal(suspended.lifecycle.receipts.length, 1)
  assert.equal(admitTaskQualityTool({ tool: 'edit', capability: 'mutate', lifecycle: suspended.lifecycle }).decision, 'deny')
  const complete = recordArtifactReview(suspended.lifecycle, artifact, { review, reviewedDigest: digestPlan(artifact), now: 60 })
  assert.equal(complete.phase, PHASE.ARTIFACT_REVIEWED)
  assert.equal(complete.reviewedArtifact.receiptCount, 1)
  assert.equal(hasCurrentApproval(complete), false)
  assert.throws(() => recordArtifactReview(withReceipt, artifact, { review, reviewedDigest: digestPlan('other') }), /does not match/)
})

test('artifact-review authorization survives routing only for the exact follow-up message', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go', expectedGeneration: repaired.generation }).lifecycle
  const started = recordExecutionStarted(approved, { callID: 'call-proof', tool: 'bash', startedAt: 49 })
  const withReceipt = recordReceipt(started, { callID: 'call-proof', tool: 'bash', kind: 'verification', outputDigest: digestPlan('pass'), outputBytes: 4, capturedAt: 50 })
  const awaiting = revokeApprovalForSubstantiveTurn(withReceipt, { origin: 'external-user', messageID: 'msg-artifact', text: 'Review the artifact.', now: 55 }).lifecycle
  const exact = buildRouteHandoff({ sessionID: 'ses-1', messageID: 'msg-artifact', messages: ['Review the artifact.'], skillNames: ['verification'] })
  assert.equal(reconstructLifecycle(awaiting, exact), awaiting)
  const later = buildRouteHandoff({ sessionID: 'ses-1', messageID: 'msg-later', messages: ['Build something else'], skillNames: ['brainstorming'] })
  const next = reconstructLifecycle(awaiting, later)
  assert.equal(next.phase, PHASE.PLANNING)
  assert.equal(next.approval, null)
  assert.equal(next.generation, awaiting.generation + 1)
})

test('a scope transition latches across unsettled execution and cannot reactivate stale approval', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go', expectedGeneration: repaired.generation }).lifecycle
  const started = recordExecutionStarted(approved, { callID: 'call-write', tool: 'write', startedAt: 49 })
  const latched = revokeApprovalForSubstantiveTurn(started, { origin: 'external-user', messageID: 'msg-next', text: 'Now do something else.', now: 50 }).lifecycle
  assert.equal(latched.pendingExecutions.length, 1)
  assert.equal(latched.revocationPending.messageID, 'msg-next')
  assert.equal(hasCurrentApproval(latched), false)
  const nextHandoff = buildRouteHandoff({ sessionID: 'ses-1', messageID: 'msg-next', messages: ['Now do something else.'], skillNames: ['debugging'] })
  assert.equal(reconstructLifecycle(latched, nextHandoff), latched)
  const settled = recordReceipt(latched, { callID: 'call-write', tool: 'write', kind: 'tool', outputDigest: digestPlan('done'), outputBytes: 4, capturedAt: 51 })
  assert.equal(settled.pendingExecutions.length, 0)
  assert.equal(settled.revocationPending, null)
  assert.equal(settled.phase, PHASE.AWAITING_ARTIFACT_REVIEW)
  assert.equal(settled.artifactReviewMessageID, 'msg-next')
  assert.equal(hasCurrentApproval(settled), false)
})

test('permission rejection closes a pending scope transition without reviving approval', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go', expectedGeneration: repaired.generation }).lifecycle
  const started = recordExecutionStarted(approved, { callID: 'call-edit', tool: 'edit', startedAt: 49 })
  const latched = revokeApprovalForSubstantiveTurn(started, { origin: 'external-user', messageID: 'msg-next', text: 'Change scope.', now: 50 }).lifecycle
  const settled = recordExecutionPermissionRejected(latched, { callID: 'call-edit', tool: 'edit', now: 51 })
  assert.equal(settled.phase, PHASE.PLANNING)
  assert.equal(settled.generation, approved.generation + 1)
  assert.equal(settled.approval, null)
  assert.equal(settled.revocationPending, null)
  assert.equal(hasCurrentApproval(settled), false)
})

test('an incomplete artifact review is durably denied and cannot retain approval', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go for it', expectedGeneration: repaired.generation }).lifecycle
  const started = recordExecutionStarted(approved, { callID: 'call-proof', tool: 'bash', startedAt: 49 })
  const withReceipt = recordReceipt(started, { callID: 'call-proof', tool: 'bash', kind: 'verification', outputDigest: digestPlan('tests passed'), outputBytes: 12, capturedAt: 50 })
  const artifact = 'The engine returned an incomplete isolated review result.'
  const denied = recordArtifactReviewDenied(withReceipt, artifact, { reason: 'the engine returned an incomplete isolated review result', now: 60 })
  assert.equal(denied.phase, PHASE.ARTIFACT_REVIEW_FAILED)
  assert.equal(denied.reviewedArtifact, null)
  assert.equal(denied.artifactReview, null)
  assert.equal(denied.artifactReviewFailure.digest, digestPlan(artifact))
  assert.equal(hasCurrentApproval(denied), false)
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
  const needsRepair = createLifecycleAdapter({}, {
    ...internal,
    review: async (input) => ({ route: { kind: 'subagent', model: { providerID: 'local', modelID: 'reviewer' } }, submission: input.submission, review: { status: 'complete', result: { verdict: 'needs_changes', summary: 'Specify the byte-level writer.', findings: [] } } }),
  })
  await assert.rejects(() => needsRepair.review({ sessionID: 'ses-1', submission: { kind: 'plan', content: 'z', digest: 'd' } }), /isolated review returned needs_changes: Specify the byte-level writer/)
  const unattributed = createLifecycleAdapter({}, {
    ...internal,
    review: async (input) => ({ route: { kind: 'subagent' }, submission: input.submission, review: { status: 'complete', result: { verdict: 'pass', findings: [] } } }),
  })
  await assert.rejects(() => unattributed.review({ sessionID: 'ses-1', submission: { kind: 'plan', content: 'z', digest: 'd' } }), /without an attributable route/)

  const report = 'Break the retry loop. Preserve cobalt-17. ✅'
  const reportDigest = createHash('sha256').update(report, 'utf8').digest('hex')
  const plain = createLifecycleAdapter({}, {
    ...internal,
    review: async (input) => ({
      route: { kind: 'crap', model: { providerID: 'local', modelID: 'builder' } },
      submission: input.submission,
      review: { status: 'complete', report, reportDigest, reviewID: 'review-1', completedAt: 10, toolCalls: 3 },
    }),
    resumeWithReview: async (input) => ({ ...input, reportDigest, messageID: 'msg-review-1' }),
  })
  const plainResult = await plain.review({ sessionID: 'ses-1', submission: { kind: 'plan', content: 'z', digest: 'd' } })
  assert.deepEqual(plainResult.plainReport, { reviewID: 'review-1', text: report, reportDigest, completedAt: 10, toolCount: 3, model: 'local/builder' })
  assert.deepEqual(await plain.resumeWithReview({ sessionID: 'ses-1', reviewID: 'review-1' }), { reviewID: 'review-1', reportDigest, messageID: 'msg-review-1' })
  const oversized = '✅'.repeat(9000)
  const oversizedDigest = createHash('sha256').update(oversized, 'utf8').digest('hex')
  const oversizedAdapter = createLifecycleAdapter({}, {
    ...internal,
    review: async (input) => ({ route: { kind: 'crap', model: 'local/builder' }, submission: input.submission, review: { status: 'complete', report: oversized, reportDigest: oversizedDigest, reviewID: 'review-2', completedAt: 10, toolCalls: 0 } }),
  })
  await assert.rejects(() => oversizedAdapter.review({ sessionID: 'ses-1', submission: { kind: 'plan', content: 'z', digest: 'd' } }), /bounded plain-language report/)
})

test('plain CRAP delivery is engine-attested and the next checkpoint needs no model-authored receipt', () => {
  const initial = createLifecycle(handoff, { generation: 4, now: 1 })
  const plan = '1. Preserve cobalt-17.\n2. Verify restart recovery.'
  const reviewedDigest = digestPlan(plan)
  const review = {
    route: { kind: 'crap', model: 'local/builder' },
    submission: { kind: 'plan', digest: reviewedDigest },
    plainReport: { reviewID: 'review-1', text: 'Preserve cobalt-17.', reportDigest: 'a'.repeat(64), completedAt: 2, toolCount: 1 },
  }
  const pending = recordPendingPlanReview(initial, plan, { review, acceptanceCriteria: ['Restart recovery works.'], reviewedDigest, now: 3 })
  assert.equal(pending.phase, PHASE.AWAITING_PLAN_REPAIR)
  assert.throws(() => recordAddressedPlan(pending, plan, { acceptanceCriteria: ['Restart recovery works.'], now: 4 }), /not been durably delivered/)
  const delivered = recordReviewDelivered(pending, { reviewID: 'review-1', reportDigest: 'a'.repeat(64), messageID: 'msg-review-1', now: 4 })
  assert.equal(recordReviewDelivered(delivered, { reviewID: 'review-1', reportDigest: 'a'.repeat(64), messageID: 'msg-review-1', now: 5 }), delivered)
  const addressed = recordAddressedPlan(delivered, plan, { acceptanceCriteria: ['Restart recovery works.'], now: 6 })
  assert.equal(addressed.phase, PHASE.AWAITING_APPROVAL)
  assert.equal(addressed.planReview, null)
  assert.equal(addressed.addressReceipt.deliveryMessageID, 'msg-review-1')
  assert.equal(addressed.pendingReview, null)
})

test('artifact causal evidence starts only after the review is durably delivered', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go', expectedGeneration: repaired.generation }).lifecycle
  const initialStarted = recordExecutionStarted(approved, { callID: 'call-initial', tool: 'bash', startedAt: 10 })
  const initialSettled = recordReceipt(initialStarted, { callID: 'call-initial', tool: 'bash', kind: 'verification', outputDigest: digestPlan('initial'), outputBytes: 7, capturedAt: 11 })
  const artifact = 'Retry repair with deterministic overflow handling.'
  const report = 'The overflow rule is ambiguous.'
  const review = {
    route: { kind: 'crap', model: 'local/model' },
    submission: { kind: 'artifact', digest: digestPlan(artifact) },
    plainReport: { reviewID: 'review-artifact', text: report, reportDigest: createHash('sha256').update(report).digest('hex'), completedAt: 12, toolCount: 0 },
  }
  const pending = recordPendingArtifactReview(initialSettled, artifact, { review, reviewedDigest: digestPlan(artifact), now: 13 })
  const betweenStarted = recordExecutionStarted(pending, { callID: 'call-between', tool: 'edit', startedAt: 14 })
  const betweenSettled = recordReceipt(betweenStarted, { callID: 'call-between', tool: 'edit', kind: 'tool', outputDigest: digestPlan('between'), outputBytes: 7, capturedAt: 15 })
  const delivered = recordReviewDelivered(betweenSettled, { reviewID: 'review-artifact', reportDigest: review.plainReport.reportDigest, messageID: 'msg-review-artifact', now: 16 })
  assert.deepEqual(delivered.pendingReview.receiptWatermark.callIDs, ['call-initial', 'call-between'])
  assert.throws(() => recordAddressedArtifact(delivered, artifact, { now: 17 }), /newly settled post-report/)
  const afterStarted = recordExecutionStarted(delivered, { callID: 'call-after', tool: 'edit', startedAt: 18 })
  const afterSettled = recordReceipt(afterStarted, { callID: 'call-after', tool: 'edit', kind: 'tool', outputDigest: digestPlan('after'), outputBytes: 5, capturedAt: 19 })
  // FIX-2 A2.4: resubmitting the reviewed bytes unchanged with only tool evidence fails closed.
  assert.throws(() => recordAddressedArtifact(afterSettled, artifact, { now: 20 }), /byte-identical resubmission/)
  const repairedArtifact = 'Retry repair with deterministic overflow handling and an explicit overflow bound.'
  const addressed = recordAddressedArtifact(afterSettled, repairedArtifact, { now: 20 })
  // FIX-2 A2.2: addressing findings is a claim, not a verdict — the artifact
  // parks awaiting a real isolated re-review, findings lock byte-intact.
  assert.equal(addressed.phase, PHASE.AWAITING_ARTIFACT_REREVIEW)
  assert.equal(addressed.generation, afterSettled.generation)
  assert.equal(addressed.pendingReview, afterSettled.pendingReview)
  assert.equal(addressed.artifactReview, null)
  assert.equal(addressed.rereview.reviewID, 'review-artifact')
  assert.equal(addressed.rereview.addressedDigest, digestPlan(repairedArtifact))
  assert.equal(addressed.rereview.postReportReceiptCount, 1)
  assert.deepEqual([...addressed.rereview.newReceiptCallIDs], ['call-after'])
  assert.equal(hasCurrentApproval(addressed), false)
  assert.throws(() => recordAddressedArtifact(addressed, repairedArtifact, { now: 21 }), /zero unresolved execution/)
  const rereview = { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'artifact', digest: digestPlan(repairedArtifact) }, result: { verdict: 'pass', summary: 'Findings addressed.', findings: [] } }
  const reviewed = recordArtifactRereview(addressed, repairedArtifact, { review: rereview, reviewedDigest: digestPlan(repairedArtifact), now: 22 })
  assert.equal(reviewed.phase, PHASE.ARTIFACT_REVIEWED)
  assert.equal(reviewed.generation, addressed.generation + 1)
  assert.equal(reviewed.artifactReview.verdict, 'pass')
  assert.equal(reviewed.addressReceipt.postReportReceiptCount, 1)
  assert.equal(reviewed.addressReceipt.deliveryMessageID, 'msg-review-artifact')
  assert.equal(reviewed.addressReceipt.addressedDigest, digestPlan(repairedArtifact))
  assert.equal(reviewed.reviewedArtifact.causallyAddressed, true)
  assert.equal(reviewed.reviewedArtifact.rereviewed, true)
  assert.equal(reviewed.rereview, null)
  assert.equal(reviewed.reviewRounds, 1)
  assert.equal(hasCurrentApproval(reviewed), false)
})

// FIX-6 A6.1: the addressed review report is no longer discarded — it is moved
// into a bounded reviewHistory in the durable blob, survives a persistence
// round-trip, and survives a later lifecycle update.
test('FIX-6 A6.1: an addressed plan review is preserved in reviewHistory and round-trips through persistence and a later update', () => {
  const initial = createLifecycle(handoff, { generation: 4, now: 1 })
  const plan = '1. Preserve the lower-bound check.\n2. Verify restart recovery.'
  const reviewedDigest = digestPlan(plan)
  const reportText = 'The lower-bound validation is missing; parsePort must reject values below the minimum.'
  const reportDigest = createHash('sha256').update(reportText, 'utf8').digest('hex')
  const review = {
    route: { kind: 'crap', model: 'local/builder' },
    submission: { kind: 'plan', digest: reviewedDigest },
    plainReport: { reviewID: 'review-1', text: reportText, reportDigest, completedAt: 2, toolCount: 1 },
  }
  const pending = recordPendingPlanReview(initial, plan, { review, acceptanceCriteria: ['Restart recovery works.'], reviewedDigest, now: 3 })
  const delivered = recordReviewDelivered(pending, { reviewID: 'review-1', reportDigest, messageID: 'msg-review-1', now: 4 })
  const addressed = recordAddressedPlan(delivered, plan, { acceptanceCriteria: ['Restart recovery works.'], now: 6 })

  assert.equal(addressed.pendingReview, null)
  assert.equal(addressed.reviewHistory.length, 1)
  const entry = addressed.reviewHistory[0]
  assert.equal(entry.kind, 'plan')
  assert.equal(entry.report, reportText)
  assert.equal(entry.reportTruncated, false)
  assert.equal(entry.reportDigest, reportDigest)
  assert.equal(entry.reviewedDigest, reviewedDigest)
  assert.equal(entry.generation, initial.generation)
  // The submitted plan is preserved beside its digest.
  assert.equal(addressed.repairedPlan.submissionExcerpt.text, plan)
  assert.equal(addressed.repairedPlan.submissionExcerpt.truncated, false)

  // Restart-equivalent reload: the store persists the lifecycle as opaque JSON.
  const reloaded = JSON.parse(JSON.stringify(addressed))
  assert.equal(reloaded.reviewHistory[0].report, reportText)
  assert.equal(reloaded.reviewHistory[0].reportDigest, reportDigest)

  // Survives a second lifecycle update (approval), and a second reload.
  const approved = recordUserDecision(reloaded, { origin: 'external-user', messageID: 'msg-go', text: 'go', expectedGeneration: reloaded.generation, now: 7 }).lifecycle
  assert.equal(approved.reviewHistory[0].report, reportText)
  assert.equal(JSON.parse(JSON.stringify(approved)).reviewHistory[0].report, reportText)
})

test('FIX-6 A6.1: an addressed artifact review is preserved in reviewHistory with the submitted artifact excerpt', () => {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go', expectedGeneration: repaired.generation }).lifecycle
  const initialStarted = recordExecutionStarted(approved, { callID: 'call-initial', tool: 'bash', startedAt: 10 })
  const initialSettled = recordReceipt(initialStarted, { callID: 'call-initial', tool: 'bash', kind: 'verification', outputDigest: digestPlan('initial'), outputBytes: 7, capturedAt: 11 })
  const artifact = 'Rejected 0x1F4 and 003000 in parsePort; observed the focused proof pass.'
  const report = 'parsePort still accepts 0x1F4 via a Number() coercion.'
  const reportDigest = createHash('sha256').update(report, 'utf8').digest('hex')
  const review = { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'artifact', digest: digestPlan(artifact) }, plainReport: { reviewID: 'review-artifact', text: report, reportDigest, completedAt: 12, toolCount: 0 } }
  const pending = recordPendingArtifactReview(initialSettled, artifact, { review, reviewedDigest: digestPlan(artifact), now: 13 })
  const delivered = recordReviewDelivered(pending, { reviewID: 'review-artifact', reportDigest, messageID: 'msg-review-artifact', now: 16 })
  const afterStarted = recordExecutionStarted(delivered, { callID: 'call-after', tool: 'bash', startedAt: 18 })
  // A byte-identical resubmission is legal here because the new post-report
  // evidence is a verification receipt (FIX-2 A2.4).
  const afterSettled = recordReceipt(afterStarted, { callID: 'call-after', tool: 'bash', kind: 'verification', outputDigest: digestPlan('after'), outputBytes: 5, capturedAt: 19 })
  const addressed = recordAddressedArtifact(afterSettled, artifact, { now: 20 })

  // FIX-2: the report stays locked in pendingReview until the re-review verdict lands.
  assert.equal(addressed.pendingReview, afterSettled.pendingReview)
  assert.equal(addressed.reviewHistory.length, 0)
  const rereview = { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'artifact', digest: digestPlan(artifact) }, result: { verdict: 'pass', summary: 'Verified against the findings.', findings: [] } }
  const reviewed = recordArtifactRereview(addressed, artifact, { review: rereview, reviewedDigest: digestPlan(artifact), now: 22 })

  assert.equal(reviewed.pendingReview, null)
  assert.equal(reviewed.reviewHistory.length, 1)
  assert.equal(reviewed.reviewHistory[0].kind, 'artifact')
  assert.equal(reviewed.reviewHistory[0].report, report)
  assert.equal(reviewed.reviewHistory[0].reportDigest, reportDigest)
  assert.equal(reviewed.reviewHistory[0].generation, approved.generation)
  assert.equal(reviewed.reviewHistory[0].disposition, 'rereview-pass')
  assert.equal(reviewed.reviewHistory[0].round, 1)
  assert.equal(reviewed.reviewedArtifact.submissionExcerpt.text, artifact)

  const reloaded = JSON.parse(JSON.stringify(reviewed))
  assert.equal(reloaded.reviewHistory[0].report, report)
  assert.equal(reloaded.reviewedArtifact.submissionExcerpt.text, artifact)
})

test('FIX-6: reviewHistory is bounded to REVIEW_HISTORY_LIMIT, dropping the oldest entry', () => {
  const initial = createLifecycle(handoff, { generation: 4, now: 1 })
  const plan = 'Address the finding.'
  const reviewedDigest = digestPlan(plan)
  const reportText = 'newest finding text'
  const reportDigest = createHash('sha256').update(reportText, 'utf8').digest('hex')
  const review = { route: { kind: 'crap', model: 'local/builder' }, submission: { kind: 'plan', digest: reviewedDigest }, plainReport: { reviewID: 'review-n', text: reportText, reportDigest, completedAt: 2, toolCount: 0 } }
  const pending = recordPendingPlanReview(initial, plan, { review, acceptanceCriteria: ['ok'], reviewedDigest, now: 3 })
  const delivered = recordReviewDelivered(pending, { reviewID: 'review-n', reportDigest, messageID: 'msg-n', now: 4 })
  // Pre-seed a full history (unfrozen, as a JSON reload would produce) to prove the cap.
  const seeded = { ...delivered, reviewHistory: Array.from({ length: REVIEW_HISTORY_LIMIT }, (_unused, i) => ({ kind: 'plan', reviewID: `old-${i}`, report: `old report ${i}`, reportDigest: 'a'.repeat(64), generation: i })) }
  const addressed = recordAddressedPlan(seeded, plan, { acceptanceCriteria: ['ok'], now: 6 })
  assert.equal(addressed.reviewHistory.length, REVIEW_HISTORY_LIMIT)
  assert.equal(addressed.reviewHistory[0].reviewID, 'old-1')
  assert.equal(addressed.reviewHistory[REVIEW_HISTORY_LIMIT - 1].reviewID, 'review-n')
  assert.equal(addressed.reviewHistory[REVIEW_HISTORY_LIMIT - 1].report, reportText)
})

test('FIX-6: an oversized review report is truncated to the excerpt budget without splitting UTF-8, keeping a full-text digest', () => {
  const initial = createLifecycle(handoff, { generation: 4, now: 1 })
  const plan = 'Address the oversized finding.'
  const reviewedDigest = digestPlan(plan)
  const bigReport = '✅'.repeat(4000) // 12000 UTF-8 bytes, over the 8 KB budget
  const reportDigest = createHash('sha256').update(bigReport, 'utf8').digest('hex')
  const review = { route: { kind: 'crap', model: 'local/builder' }, submission: { kind: 'plan', digest: reviewedDigest }, plainReport: { reviewID: 'review-big', text: bigReport, reportDigest, completedAt: 2, toolCount: 0 } }
  const pending = recordPendingPlanReview(initial, plan, { review, acceptanceCriteria: ['ok'], reviewedDigest, now: 3 })
  const delivered = recordReviewDelivered(pending, { reviewID: 'review-big', reportDigest, messageID: 'msg-big', now: 4 })
  const addressed = recordAddressedPlan(delivered, plan, { acceptanceCriteria: ['ok'], now: 6 })
  const entry = addressed.reviewHistory[0]
  assert.equal(entry.reportTruncated, true)
  assert.ok(Buffer.byteLength(entry.report, 'utf8') <= REVIEW_REPORT_EXCERPT_BYTES)
  assert.equal(entry.reportBytes, Buffer.byteLength(bigReport, 'utf8'))
  assert.equal(entry.reportDigest, reportDigest) // digest is over the FULL text
  assert.ok(entry.report.includes('bytes elided'))
  assert.ok(!entry.report.includes('�')) // no split multi-byte character
})

// ---------------------------------------------------------------------------
// FIX-2: the artifact re-review loop. Addressing findings never terminates the
// review; only a bound isolated re-review verdict can, and non-pass rounds are
// bounded before an honest terminal DECLINED.
// ---------------------------------------------------------------------------

function approvedWithSeedReceipt() {
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Works'] })
  const approved = recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go', expectedGeneration: repaired.generation }).lifecycle
  const started = recordExecutionStarted(approved, { callID: 'call-seed', tool: 'bash', startedAt: 10 })
  return recordReceipt(started, { callID: 'call-seed', tool: 'bash', kind: 'verification', outputDigest: digestPlan('seed'), outputBytes: 4, capturedAt: 11 })
}

function runReviewCycleToAddressed(state, round) {
  const submitted = `artifact submission for round ${round}`
  const reportText = `re-review finding for round ${round}`
  const reportDigest = createHash('sha256').update(reportText, 'utf8').digest('hex')
  const review = { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'artifact', digest: digestPlan(submitted) }, plainReport: { reviewID: `review-${round}`, text: reportText, reportDigest, completedAt: 12, toolCount: 0 } }
  const pending = recordPendingArtifactReview(state, submitted, { review, reviewedDigest: digestPlan(submitted), now: 13 })
  const delivered = recordReviewDelivered(pending, { reviewID: `review-${round}`, reportDigest, messageID: `msg-review-${round}`, now: 14 })
  const started = recordExecutionStarted(delivered, { callID: `call-repair-${round}`, tool: 'edit', startedAt: 15 })
  const settled = recordReceipt(started, { callID: `call-repair-${round}`, tool: 'edit', kind: 'tool', outputDigest: digestPlan(`repair ${round}`), outputBytes: 8, capturedAt: 16 })
  const addressedText = `artifact addressed in round ${round}`
  return { addressed: recordAddressedArtifact(settled, addressedText, { now: 17 }), addressedText }
}

function boundRereview(addressedText, verdict) {
  return { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'artifact', digest: digestPlan(addressedText) }, result: { verdict, summary: verdict === 'pass' ? 'ok' : 'still failing', findings: [] } }
}

test('FIX-2 A2.5: non-pass re-reviews stay repairable until the cap, then end in an honest DECLINED', () => {
  const base = approvedWithSeedReceipt()
  let state = base
  for (let round = 1; round <= REVIEW_ROUNDS_CAP; round++) {
    const { addressed, addressedText } = runReviewCycleToAddressed(state, round)
    assert.equal(addressed.phase, PHASE.AWAITING_ARTIFACT_REREVIEW)
    state = recordArtifactRereview(addressed, addressedText, { review: boundRereview(addressedText, 'needs_changes'), reviewedDigest: digestPlan(addressedText), now: 18 })
    assert.equal(state.reviewRounds, round)
    if (round < REVIEW_ROUNDS_CAP) {
      // Repairable: same generation, binding intact, repair tools stay legal.
      assert.equal(state.phase, PHASE.ARTIFACT_REVIEW_FAILED)
      assert.equal(state.generation, base.generation)
      assert.equal(state.artifactReviewFailure.kind, 'rereview-non-pass')
      assert.match(state.artifactReviewFailure.reason, /needs_changes/)
      assert.equal(state.pendingReview, null)
      assert.equal(hasCurrentApproval(state), true)
      assert.equal(state.reviewHistory[round - 1].disposition, 'rereview-non-pass')
    }
  }
  assert.equal(state.phase, PHASE.DECLINED)
  assert.equal(state.generation, base.generation + 1)
  assert.equal(state.reviewDecline.reason, 'review-rounds-exhausted')
  assert.equal(state.reviewDecline.rounds, REVIEW_ROUNDS_CAP)
  assert.equal(state.pendingReview, null)
  assert.equal(state.reviewHistory.length, REVIEW_ROUNDS_CAP)
  assert.equal(state.reviewHistory[REVIEW_ROUNDS_CAP - 1].disposition, 'rereview-declined')
  assert.equal(hasCurrentApproval(state), false)
  // The bumped generation broke the approval binding — no fourth attempt.
  assert.throws(() => recordPendingArtifactReview(state, 'another try', { review: boundRereview('another try', 'pass'), reviewedDigest: digestPlan('another try'), now: 19 }), /current explicit approval/)
})

test('FIX-2: an unreadable or unbound re-review fails closed and consumes a round', () => {
  const base = approvedWithSeedReceipt()
  // Round 1: the engine died mid-re-review — no verdict ever arrived.
  const first = runReviewCycleToAddressed(base, 1)
  const failedTransport = recordArtifactRereview(first.addressed, first.addressedText, { reviewedDigest: digestPlan(first.addressedText), failureReason: 'engine transport failure: socket reset', now: 30 })
  assert.equal(failedTransport.phase, PHASE.ARTIFACT_REVIEW_FAILED)
  assert.equal(failedTransport.reviewRounds, 1)
  assert.match(failedTransport.artifactReviewFailure.reason, /socket reset/)
  assert.equal(failedTransport.generation, base.generation)
  assert.equal(hasCurrentApproval(failedTransport), true)
  // Round 2: a 'pass' bound to DIFFERENT bytes cannot terminate the review.
  const second = runReviewCycleToAddressed(failedTransport, 2)
  const unbound = { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'artifact', digest: digestPlan('entirely different bytes') }, result: { verdict: 'pass', summary: 'looks great', findings: [] } }
  const failedUnbound = recordArtifactRereview(second.addressed, second.addressedText, { review: unbound, reviewedDigest: digestPlan(second.addressedText), now: 31 })
  assert.equal(failedUnbound.phase, PHASE.ARTIFACT_REVIEW_FAILED)
  assert.equal(failedUnbound.reviewRounds, 2)
  assert.match(failedUnbound.artifactReviewFailure.reason, /readable bound verdict/)
})

test('FIX-2: re-review identity guards — wrong phase and digest drift both throw', () => {
  const base = approvedWithSeedReceipt()
  assert.throws(() => recordArtifactRereview(base, 'whatever', { review: boundRereview('whatever', 'pass'), reviewedDigest: digestPlan('whatever'), now: 40 }), /no addressed artifact is awaiting re-review/)
  const { addressed, addressedText } = runReviewCycleToAddressed(base, 1)
  const drifted = `${addressedText} drifted`
  assert.throws(() => recordArtifactRereview(addressed, drifted, { review: boundRereview(drifted, 'pass'), reviewedDigest: digestPlan(drifted), now: 41 }), /does not match the exact addressed artifact/)
  assert.throws(() => recordArtifactRereview(addressed, addressedText, { review: boundRereview(addressedText, 'pass'), reviewedDigest: digestPlan(drifted), now: 42 }), /does not match the exact addressed artifact/)
})

test('FIX-2: a durable blob predating round tracking treats prior rounds as zero', () => {
  const base = approvedWithSeedReceipt()
  const { addressed, addressedText } = runReviewCycleToAddressed(base, 1)
  const legacy = JSON.parse(JSON.stringify(addressed))
  delete legacy.reviewRounds
  delete legacy.reviewDecline
  const failed = recordArtifactRereview(legacy, addressedText, { review: boundRereview(addressedText, 'needs_changes'), reviewedDigest: digestPlan(addressedText), now: 50 })
  assert.equal(failed.phase, PHASE.ARTIFACT_REVIEW_FAILED)
  assert.equal(failed.reviewRounds, 1)
})

test('FIX-2: an old terminal review denial stays locked out while its pending report is preserved', () => {
  const base = approvedWithSeedReceipt()
  const submitted = 'artifact submission for denial'
  const reportText = 'finding pending at denial time'
  const reportDigest = createHash('sha256').update(reportText, 'utf8').digest('hex')
  const review = { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'artifact', digest: digestPlan(submitted) }, plainReport: { reviewID: 'review-denied', text: reportText, reportDigest, completedAt: 12, toolCount: 0 } }
  const pending = recordPendingArtifactReview(base, submitted, { review, reviewedDigest: digestPlan(submitted), now: 13 })
  const delivered = recordReviewDelivered(pending, { reviewID: 'review-denied', reportDigest, messageID: 'msg-review-denied', now: 14 })
  const denied = recordArtifactReviewDenied(delivered, submitted, { reason: 'engine died mid-review', now: 15 })
  // Terminal semantics unchanged: the generation bump broke the approval binding.
  assert.equal(denied.phase, PHASE.ARTIFACT_REVIEW_FAILED)
  assert.equal(denied.generation, base.generation + 1)
  assert.equal(hasCurrentApproval(denied), false)
  // FIX-2/FIX-6: the still-pending report was preserved, not discarded.
  assert.equal(denied.pendingReview, null)
  assert.equal(denied.reviewHistory.length, 1)
  assert.equal(denied.reviewHistory[0].disposition, 'superseded-by-denial')
  assert.equal(denied.reviewHistory[0].report, reportText)
})
