// Pure lifecycle transitions. Persistence is supplied by the engine adapter so
// all authority is revision/generation checked in the dedicated engine table.
import { digestText } from './handoff.mjs'

export const TASK_QUALITY_POLICY_VERSION = 'agent-omega/task-quality@1'
export const PHASE = Object.freeze({
  PLANNING: 'planning',
  AWAITING_PLAN_REPAIR: 'awaiting-plan-repair',
  AWAITING_APPROVAL: 'awaiting-approval',
  APPROVED: 'approved',
  AWAITING_ARTIFACT_REVIEW: 'awaiting-artifact-review',
  DECLINED: 'declined',
  ARTIFACT_REVIEWED: 'artifact-reviewed',
  ARTIFACT_REVIEW_FAILED: 'artifact-review-failed',
})

function nowValue(now) {
  return Number.isSafeInteger(now) && now > 0 ? now : Date.now()
}

export function digestPlan(plan) {
  if (typeof plan !== 'string' || !plan.trim()) throw new TypeError('repaired plan text is required')
  return digestText(plan)
}

export function createLifecycle(handoff, { generation = 1, now = Date.now() } = {}) {
  if (!handoff?.qualifies || !handoff.taskKey) throw new Error('a qualifying router handoff is required')
  return Object.freeze({
    version: 1,
    policyVersion: TASK_QUALITY_POLICY_VERSION,
    taskKey: handoff.taskKey,
    taskMessageID: handoff.messageID,
    qualificationReason: handoff.qualificationReason,
    taskContract: handoff.taskText,
    acceptanceCriteria: Object.freeze([]),
    phase: PHASE.PLANNING,
    generation,
    planReview: null,
    pendingReview: null,
    addressReceipt: null,
    repairedPlan: null,
    approval: null,
    artifactReviewMessageID: null,
    revocationPending: null,
    pendingExecutions: Object.freeze([]),
    receipts: Object.freeze([]),
    artifactReview: null,
    artifactReviewFailure: null,
    reviewedArtifact: null,
    createdAt: nowValue(now),
    updatedAt: nowValue(now),
  })
}

// Existing data is reused only for the exact routed task. A different routed
// task gets a new monotonic generation so an older approval cannot bleed over.
export function reconstructLifecycle(existing, handoff, { now = Date.now() } = {}) {
  const previousGeneration = Number.isSafeInteger(existing?.generation) ? existing.generation : 0
  // A routed follow-up must not erase an unresolved durable precommit. The
  // exact completion or permission rejection is the only event allowed to
  // settle it, after which the pending scope transition closes authorization.
  if (existing?.version === 1 && hasUnsettledExecution(existing)) return existing
  // The persisted external turn closes mutation before routing runs. Preserve
  // the old task only for that exact message so its artifact review can use the
  // approval and receipts it is meant to audit; later routed turns are new work.
  if (
    existing?.version === 1 &&
    existing.phase === PHASE.AWAITING_ARTIFACT_REVIEW &&
    existing.artifactReviewMessageID &&
    existing.artifactReviewMessageID === handoff?.messageID
  ) return existing
  if (
    existing?.taskKey === handoff?.taskKey &&
    existing?.taskMessageID === handoff?.messageID &&
    existing?.version === 1
  ) return existing
  return createLifecycle(handoff, { generation: previousGeneration + 1, now })
}

function acceptedPlanReview(review) {
  if (!review || typeof review !== 'object' || review.result?.verdict !== 'pass') return null
  const findings = Array.isArray(review.result.findings) ? review.result.findings : []
  const dispositions = Array.isArray(review.result.dispositions) ? review.result.dispositions : []
  const dispositionByFinding = new Map(dispositions.map((item) => [item?.findingID, item?.status]))
  if (findings.some((finding) => dispositionByFinding.get(finding?.id) === 'needs-repair')) return null
  if (!review.route || typeof review.route.kind !== 'string') return null
  const routeModel = typeof review.route.model === 'string'
    ? review.route.model
    : review.route.model?.providerID && review.route.model?.modelID
      ? `${review.route.model.providerID}/${review.route.model.modelID}`
      : ''
  if (!routeModel) return null
  return Object.freeze({
    route: Object.freeze({ kind: review.route.kind, model: routeModel, ...(review.route.agent ? { agent: String(review.route.agent) } : {}) }),
    verdict: 'pass',
    summary: String(review.result.summary || '').slice(0, 6000),
    findings: Object.freeze(findings),
    dispositions: Object.freeze(dispositions),
  })
}

function normalizeCriteria(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new TypeError('at least one acceptance criterion is required')
  const criteria = value.map((item) => String(item || '').trim()).filter(Boolean)
  if (criteria.length !== value.length || criteria.some((item) => item.length > 2000)) throw new TypeError('acceptance criteria must be non-empty concise text')
  return Object.freeze(criteria)
}

export function recordRepairedPlan(lifecycle, plan, { review, acceptanceCriteria, reviewedDigest, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.version !== 1) throw new Error('valid lifecycle is required')
  if (lifecycle.phase !== PHASE.PLANNING || hasUnsettledExecution(lifecycle) || lifecycle.revocationPending) {
    throw new Error('the current task is not eligible for a repaired-plan checkpoint')
  }
  const planReview = acceptedPlanReview(review)
  if (!planReview) throw new Error('a completed isolated plan review with a pass verdict is required before recording the repaired plan')
  if (typeof reviewedDigest !== 'string' || !reviewedDigest) throw new Error('an engine-calculated reviewed-plan digest is required before recording the repaired plan')
  if (reviewedDigest !== digestPlan(plan)) throw new Error('the reviewed-plan digest does not match the exact repaired plan content')
  const generation = lifecycle.generation + 1
  const repairedPlan = Object.freeze({ digest: reviewedDigest, generation, recordedAt: nowValue(now) })
  return Object.freeze({
    ...lifecycle,
    generation,
    phase: PHASE.AWAITING_APPROVAL,
    planReview,
    pendingReview: null,
    addressReceipt: null,
    acceptanceCriteria: normalizeCriteria(acceptanceCriteria),
      repairedPlan,
      approval: null,
      artifactReviewMessageID: null,
      revocationPending: null,
      updatedAt: nowValue(now),
  })
}

function plainReviewRecord(review, kind, reviewedDigest) {
  if (!review?.plainReport || review?.submission?.kind !== kind || review.submission.digest !== reviewedDigest) throw new Error('a completed bound plain-language review report is required')
  const routeModel = typeof review.route?.model === 'string'
    ? review.route.model
    : review.route?.model?.providerID && review.route?.model?.modelID
      ? `${review.route.model.providerID}/${review.route.model.modelID}`
      : ''
  if (!routeModel || typeof review.route?.kind !== 'string') throw new Error('the review report route is not attributable')
  const report = review.plainReport
  if (typeof report.reviewID !== 'string' || typeof report.text !== 'string' || !report.text.trim() || !DIGEST.test(report.reportDigest)) throw new Error('the review report receipt is invalid')
  return Object.freeze({
    kind,
    reviewID: report.reviewID,
    report: report.text,
    reportDigest: report.reportDigest,
    reviewedDigest,
    route: Object.freeze({ kind: review.route.kind, model: routeModel, ...(review.route.agent ? { agent: String(review.route.agent) } : {}) }),
    completedAt: report.completedAt,
    toolCount: report.toolCount,
  })
}

export function recordPendingPlanReview(lifecycle, plan, { review, acceptanceCriteria, reviewedDigest, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.version !== 1 || lifecycle.phase !== PHASE.PLANNING || hasUnsettledExecution(lifecycle) || lifecycle.revocationPending) throw new Error('the current task is not eligible for a plan review report')
  if (reviewedDigest !== digestPlan(plan)) throw new Error('the reviewed-plan digest does not match the exact submitted plan content')
  const pendingReview = plainReviewRecord(review, 'plan', reviewedDigest)
  return Object.freeze({
    ...lifecycle,
    phase: PHASE.AWAITING_PLAN_REPAIR,
    pendingReview: Object.freeze({ ...pendingReview, generation: lifecycle.generation, receivedAt: nowValue(now) }),
    addressReceipt: null,
    acceptanceCriteria: normalizeCriteria(acceptanceCriteria),
    approval: null,
    updatedAt: nowValue(now),
  })
}

export function recordReviewDelivered(lifecycle, { reviewID, reportDigest, messageID, now = Date.now() } = {}) {
  const pending = lifecycle?.pendingReview
  if (!pending || pending.reviewID !== reviewID || pending.reportDigest !== reportDigest) throw new Error('the delivered review does not match the current pending report')
  if (typeof messageID !== 'string' || !messageID) throw new Error('the review delivery requires a durable synthetic message')
  if (pending.delivery) {
    if (pending.delivery.messageID !== messageID) throw new Error('the current review is already bound to a different delivery message')
    return lifecycle
  }
  const receiptWatermark = pending.kind === 'artifact'
    ? Object.freeze({
        count: Array.isArray(lifecycle.receipts) ? lifecycle.receipts.length : 0,
        callIDs: Object.freeze((Array.isArray(lifecycle.receipts) ? lifecycle.receipts : []).map((item) => item.callID)),
        capturedAt: (Array.isArray(lifecycle.receipts) ? lifecycle.receipts : []).reduce((max, item) => Math.max(max, item.capturedAt || 0), 0),
      })
    : undefined
  return Object.freeze({
    ...lifecycle,
    pendingReview: Object.freeze({ ...pending, ...(receiptWatermark ? { receiptWatermark } : {}), delivery: Object.freeze({ messageID, deliveredAt: nowValue(now) }) }),
    updatedAt: nowValue(now),
  })
}

function requirePendingAddress(lifecycle, kind) {
  const pending = lifecycle?.pendingReview
  if (!pending || pending.kind !== kind || pending.generation !== lifecycle.generation) throw new Error(`no current ${kind} review report is awaiting an addressed submission`)
  if (!pending.delivery?.messageID) throw new Error('the current review report has not been durably delivered to the builder')
  return pending
}

export function recordAddressedPlan(lifecycle, plan, { acceptanceCriteria, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.version !== 1 || lifecycle.phase !== PHASE.AWAITING_PLAN_REPAIR || hasUnsettledExecution(lifecycle) || lifecycle.revocationPending) throw new Error('the current task is not awaiting a repaired plan')
  const pending = requirePendingAddress(lifecycle, 'plan')
  const generation = lifecycle.generation + 1
  const addressedDigest = digestPlan(plan)
  const addressReceipt = Object.freeze({ reviewID: pending.reviewID, reportDigest: pending.reportDigest, reviewedDigest: pending.reviewedDigest, addressedDigest, deliveryMessageID: pending.delivery.messageID, addressedAt: nowValue(now), route: pending.route })
  return Object.freeze({
    ...lifecycle,
    generation,
    phase: PHASE.AWAITING_APPROVAL,
    planReview: null,
    pendingReview: null,
    addressReceipt,
    acceptanceCriteria: normalizeCriteria(acceptanceCriteria),
    repairedPlan: Object.freeze({ digest: addressedDigest, generation, recordedAt: nowValue(now) }),
    approval: null,
    artifactReviewMessageID: null,
    revocationPending: null,
    updatedAt: nowValue(now),
  })
}

export function recordPendingArtifactReview(lifecycle, artifact, { review, reviewedDigest, now = Date.now() } = {}) {
  if (!hasArtifactReviewAuthorization(lifecycle) || hasUnsettledExecution(lifecycle)) throw new Error('a current explicit approval with no unresolved execution is required before artifact review')
  if (!Array.isArray(lifecycle.receipts) || lifecycle.receipts.length < 1) throw new Error('at least one sanitized execution or verification receipt is required before artifact review')
  if (reviewedDigest !== digestPlan(artifact)) throw new Error('the reviewed-artifact digest does not match the exact submitted artifact content')
  const pendingReview = plainReviewRecord(review, 'artifact', reviewedDigest)
  return Object.freeze({
    ...lifecycle,
    phase: PHASE.APPROVED,
    pendingReview: Object.freeze({ ...pendingReview, generation: lifecycle.generation, receivedAt: nowValue(now) }),
    addressReceipt: null,
    artifactReview: null,
    reviewedArtifact: null,
    updatedAt: nowValue(now),
  })
}

export function recordAddressedArtifact(lifecycle, artifact, { now = Date.now() } = {}) {
  if (!hasArtifactReviewAuthorization(lifecycle) || hasUnsettledExecution(lifecycle)) throw new Error('the approved artifact repair must have zero unresolved execution')
  const pending = requirePendingAddress(lifecycle, 'artifact')
  const oldIDs = new Set(pending.receiptWatermark?.callIDs || [])
  const newReceipts = (Array.isArray(lifecycle.receipts) ? lifecycle.receipts : []).filter((item) => !oldIDs.has(item.callID))
  if (newReceipts.length < 1) throw new Error('at least one newly settled post-report execution or verification receipt is required')
  const generation = lifecycle.generation + 1
  const addressedDigest = digestPlan(artifact)
  const addressReceipt = Object.freeze({ reviewID: pending.reviewID, reportDigest: pending.reportDigest, reviewedDigest: pending.reviewedDigest, addressedDigest, deliveryMessageID: pending.delivery.messageID, addressedAt: nowValue(now), route: pending.route, postReportReceiptCount: newReceipts.length })
  return Object.freeze({
    ...lifecycle,
    generation,
    phase: PHASE.ARTIFACT_REVIEWED,
    pendingReview: null,
    addressReceipt,
    artifactReview: null,
    reviewedArtifact: Object.freeze({ digest: addressedDigest, generation, receiptCount: lifecycle.receipts.length, recordedAt: nowValue(now), causallyAddressed: true }),
    artifactReviewFailure: null,
    updatedAt: nowValue(now),
  })
}

export function parseExplicitDecision(text) {
  // Approval is a standalone authorization, not a prefix a scope-changing
  // request can borrow while the router is degraded. Keep the accepted forms
  // deliberately small and require every non-whitespace token to be part of
  // the decision itself.
  const value = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim()
  if (!value || value.includes('?')) return null
  if (/^(?:no|don't|do not|not yet|hold|stop|wait|decline|reject)$/.test(value)) return 'no-go'
  if (/^(?:go|go ahead|go for it|go for gold|approve|approved|proceed|ship it)$/.test(value)) return 'go'
  return null
}

export function recordUserDecision(lifecycle, { origin, messageID, text, expectedGeneration, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.version !== 1) return { ok: false, reason: 'missing-lifecycle' }
  if (origin !== 'external-user') return { ok: false, reason: 'approval-requires-external-user-message' }
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== lifecycle.generation) return { ok: false, reason: 'stale-plan-generation' }
  if (lifecycle.phase !== PHASE.AWAITING_APPROVAL || lifecycle.repairedPlan?.generation !== lifecycle.generation) {
    return { ok: false, reason: 'no-current-repaired-plan-awaiting-approval' }
  }
  if (typeof messageID !== 'string' || !messageID) return { ok: false, reason: 'missing-message-identity' }
  const decision = parseExplicitDecision(text)
  if (!decision) return { ok: false, reason: 'ambiguous-user-decision' }
  if (decision === 'no-go') {
    return { ok: true, lifecycle: Object.freeze({ ...lifecycle, phase: PHASE.DECLINED, updatedAt: nowValue(now) }) }
  }
  return {
    ok: true,
    lifecycle: Object.freeze({
      ...lifecycle,
      phase: PHASE.APPROVED,
      approval: Object.freeze({
        messageID,
        recordedAt: nowValue(now),
        generation: lifecycle.generation,
        planDigest: lifecycle.repairedPlan.digest,
      }),
      updatedAt: nowValue(now),
    }),
  }
}

// A new substantive external-user turn is a new scope boundary even when the
// router returns NONE or is unavailable. Close the old authorization before
// any tool from that turn can borrow it. Standalone go/no decisions remain
// eligible for recordUserDecision instead.
export function revokeApprovalForSubstantiveTurn(lifecycle, { origin, messageID, text, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.version !== 1) return { ok: false, reason: 'missing-lifecycle' }
  if (origin !== 'external-user') return { ok: false, reason: 'revocation-requires-external-user-message' }
  if (parseExplicitDecision(text)) return { ok: false, reason: 'standalone-user-decision' }
  if (!hasCurrentApproval(lifecycle)) return { ok: false, reason: 'no-current-approval' }
  if (typeof messageID !== 'string' || !messageID) return { ok: false, reason: 'missing-message-identity' }
  // Once execution has settled, close mutation without destroying the exact
  // approval and receipts needed for a same-task artifact-review follow-up.
  // An unsettled execution retains its approval identity only for settlement.
  // The durable latch immediately disables new mutation, survives routing, and
  // prevents the old approval from becoming live again when settlement lands.
  if (hasUnsettledExecution(lifecycle)) {
    return {
      ok: true,
      lifecycle: Object.freeze({
        ...lifecycle,
        revocationPending: Object.freeze({ messageID, requestedAt: nowValue(now) }),
        updatedAt: nowValue(now),
      }),
    }
  }
  if (Array.isArray(lifecycle.receipts) && lifecycle.receipts.length > 0) {
    return {
      ok: true,
      lifecycle: Object.freeze({
        ...lifecycle,
        phase: PHASE.AWAITING_ARTIFACT_REVIEW,
        artifactReviewMessageID: messageID,
        revocationPending: null,
        updatedAt: nowValue(now),
      }),
    }
  }
  const generation = lifecycle.generation + 1
  return {
    ok: true,
    lifecycle: Object.freeze({
      ...lifecycle,
      phase: PHASE.PLANNING,
      generation,
      planReview: null,
      pendingReview: null,
      addressReceipt: null,
      repairedPlan: null,
      acceptanceCriteria: Object.freeze([]),
      approval: null,
      artifactReviewMessageID: null,
      revocationPending: null,
      receipts: Object.freeze([]),
      artifactReview: null,
      artifactReviewFailure: null,
      reviewedArtifact: null,
      updatedAt: nowValue(now),
    }),
  }
}

export function hasArtifactReviewAuthorization(lifecycle) {
  return Boolean(
    lifecycle?.version === 1 &&
      (lifecycle.phase === PHASE.APPROVED || lifecycle.phase === PHASE.AWAITING_ARTIFACT_REVIEW) &&
      lifecycle.repairedPlan?.generation === lifecycle.generation &&
      lifecycle.approval?.generation === lifecycle.generation &&
      lifecycle.approval?.planDigest === lifecycle.repairedPlan?.digest,
  )
}

export function hasCurrentApproval(lifecycle) {
  return Boolean(
    lifecycle?.version === 1 &&
      lifecycle.phase === PHASE.APPROVED &&
      !lifecycle.revocationPending &&
      lifecycle.repairedPlan?.generation === lifecycle.generation &&
      lifecycle.approval?.generation === lifecycle.generation &&
      lifecycle.approval?.planDigest === lifecycle.repairedPlan?.digest,
  )
}

export function hasUnsettledExecution(lifecycle) {
  return Array.isArray(lifecycle?.pendingExecutions) && lifecycle.pendingExecutions.length > 0
}

function hasSettlementAuthorization(lifecycle) {
  return Boolean(
    lifecycle?.version === 1 &&
      lifecycle.phase === PHASE.APPROVED &&
      lifecycle.repairedPlan?.generation === lifecycle.generation &&
      lifecycle.approval?.generation === lifecycle.generation &&
      lifecycle.approval?.planDigest === lifecycle.repairedPlan?.digest,
  )
}

function finishPendingScopeTransition(lifecycle, { now = Date.now() } = {}) {
  if (!lifecycle?.revocationPending || hasUnsettledExecution(lifecycle)) return lifecycle
  if (Array.isArray(lifecycle.receipts) && lifecycle.receipts.length > 0) {
    return Object.freeze({
      ...lifecycle,
      phase: PHASE.AWAITING_ARTIFACT_REVIEW,
      artifactReviewMessageID: lifecycle.revocationPending.messageID,
      revocationPending: null,
      updatedAt: nowValue(now),
    })
  }
  return Object.freeze({
    ...lifecycle,
    phase: PHASE.PLANNING,
    generation: lifecycle.generation + 1,
    planReview: null,
    pendingReview: null,
    addressReceipt: null,
    repairedPlan: null,
    acceptanceCriteria: Object.freeze([]),
    approval: null,
    artifactReviewMessageID: null,
    revocationPending: null,
    artifactReview: null,
    artifactReviewFailure: null,
    reviewedArtifact: null,
    updatedAt: nowValue(now),
  })
}

export const PENDING_EXECUTION_LIMIT = 24

function normalizePendingExecution(execution) {
  if (!execution || typeof execution !== 'object') throw new TypeError('a durable execution precommit is required')
  const callID = String(execution.callID || '')
  const tool = String(execution.tool || '')
  const startedAt = execution.startedAt
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(callID)) throw new TypeError('execution call identity is invalid')
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(tool)) throw new TypeError('execution tool identity is invalid')
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw new TypeError('execution timestamp is invalid')
  return Object.freeze({ callID, tool, startedAt })
}

// This write intentionally happens before a mutable executor runs. If the
// process dies anywhere after it, the unresolved record blocks all subsequent
// mutation rather than pretending the unknown side effect did not happen.
export function recordExecutionStarted(lifecycle, execution, { now = Date.now() } = {}) {
  if (!hasCurrentApproval(lifecycle)) throw new Error('a current explicit approval is required before execution')
  const next = normalizePendingExecution(execution)
  const existing = Array.isArray(lifecycle.pendingExecutions) ? lifecycle.pendingExecutions : []
  const prior = existing.find((item) => item?.callID === next.callID)
  if (prior) {
    if (prior.tool !== next.tool) throw new Error('execution call identity is already reserved for a different tool')
    return lifecycle
  }
  return Object.freeze({ ...lifecycle, pendingExecutions: Object.freeze([...existing, next].slice(-PENDING_EXECUTION_LIMIT)), updatedAt: nowValue(now) })
}

// An engine-persisted permission rejection is the narrow known-no-side-effect
// outcome. It may settle only its exact precommit; unknown tool failures stay
// pending and therefore fail closed after a crash.
export function recordExecutionPermissionRejected(lifecycle, { callID, tool, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.version !== 1) throw new Error('valid lifecycle is required')
  const pending = Array.isArray(lifecycle.pendingExecutions) ? lifecycle.pendingExecutions : []
  const match = pending.find((item) => item?.callID === callID)
  if (!match) return lifecycle
  if (match.tool !== tool) throw new Error('permission rejection does not match the durable execution precommit')
  const settled = Object.freeze({ ...lifecycle, pendingExecutions: Object.freeze(pending.filter((item) => item?.callID !== callID)), updatedAt: nowValue(now) })
  return finishPendingScopeTransition(settled, { now })
}

const RECEIPT_LIMIT = 24
const DIGEST = /^[a-f0-9]{64}$/

function normalizeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') throw new TypeError('a sanitized receipt is required')
  const callID = String(receipt.callID || '')
  const tool = String(receipt.tool || '')
  const kind = receipt.kind === 'verification' ? 'verification' : receipt.kind === 'tool' ? 'tool' : ''
  const agent = receipt.agent === undefined ? '' : String(receipt.agent)
  const childBuiltinReads = receipt.childBuiltinReads
  const outputDigest = String(receipt.outputDigest || '')
  const outputBytes = receipt.outputBytes
  const capturedAt = receipt.capturedAt
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(callID)) throw new TypeError('receipt call identity is invalid')
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(tool)) throw new TypeError('receipt tool identity is invalid')
  if (!kind || !DIGEST.test(outputDigest)) throw new TypeError('receipt must contain a canonical output digest')
  if (agent && !/^[A-Za-z0-9_.:-]{1,120}$/.test(agent)) throw new TypeError('receipt agent identity is invalid')
  if (childBuiltinReads !== undefined && (!Number.isSafeInteger(childBuiltinReads) || childBuiltinReads < 1 || childBuiltinReads > 10_000)) throw new TypeError('receipt child builtin read count is invalid')
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 0 || outputBytes > 1_000_000) throw new TypeError('receipt output size is invalid')
  if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0) throw new TypeError('receipt timestamp is invalid')
  return Object.freeze({ callID, tool, kind, ...(agent ? { agent } : {}), ...(childBuiltinReads !== undefined ? { childBuiltinReads } : {}), outputDigest, outputBytes, capturedAt })
}

// Receipts never contain arguments, paths, output, arbitrary metadata,
// attachments, or model text. A task receipt may retain only the engine-
// resolved final agent identity after transforms and the engine-attested count
// of completed builtin child reads. They are bounded provenance
// for a later clean-room artifact review. Replaying the same completed tool call is idempotent; a different
// payload for the same call ID fails closed instead of silently overwriting it.
export function recordReceipt(lifecycle, receipt, { now = Date.now() } = {}) {
  if (!hasSettlementAuthorization(lifecycle)) throw new Error('the receipt is not authorized for settlement by the approved task generation')
  const nextReceipt = normalizeReceipt(receipt)
  const existing = Array.isArray(lifecycle.receipts) ? lifecycle.receipts : []
  const prior = existing.find((item) => item?.callID === nextReceipt.callID)
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(nextReceipt)) throw new Error('a receipt already exists for this call identity with different evidence')
    const pending = Array.isArray(lifecycle.pendingExecutions) ? lifecycle.pendingExecutions : []
    const remaining = pending.filter((item) => item?.callID !== nextReceipt.callID)
    if (remaining.length === pending.length) return lifecycle
    const settled = Object.freeze({ ...lifecycle, pendingExecutions: Object.freeze(remaining), updatedAt: nowValue(now) })
    return finishPendingScopeTransition(settled, { now })
  }
  const pending = Array.isArray(lifecycle.pendingExecutions) ? lifecycle.pendingExecutions : []
  const execution = pending.find((item) => item?.callID === nextReceipt.callID)
  if (!execution || execution.tool !== nextReceipt.tool) throw new Error('receipt has no matching durable execution precommit')
  const receipts = Object.freeze([...existing, nextReceipt].slice(-RECEIPT_LIMIT))
  const settled = Object.freeze({ ...lifecycle, receipts, pendingExecutions: Object.freeze(pending.filter((item) => item?.callID !== nextReceipt.callID)), updatedAt: nowValue(now) })
  return finishPendingScopeTransition(settled, { now })
}

function completedArtifactReview(review) {
  if (!review || typeof review !== 'object' || review.submission?.kind !== 'artifact') return null
  if (!review.route || typeof review.route.kind !== 'string' || !review.result || typeof review.result !== 'object') return null
  const routeModel = typeof review.route.model === 'string'
    ? review.route.model
    : review.route.model?.providerID && review.route.model?.modelID
      ? `${review.route.model.providerID}/${review.route.model.modelID}`
      : ''
  const verdict = review.result.verdict
  if (!routeModel || !['pass', 'needs_changes', 'blocked'].includes(verdict)) return null
  const findings = Array.isArray(review.result.findings) ? review.result.findings : []
  return Object.freeze({
    route: Object.freeze({ kind: review.route.kind, model: routeModel, ...(review.route.agent ? { agent: String(review.route.agent) } : {}) }),
    verdict,
    summary: String(review.result.summary || '').slice(0, 6000),
    findings: Object.freeze(findings.slice(0, 64)),
  })
}

export function recordArtifactReview(lifecycle, artifact, { review, reviewedDigest, now = Date.now() } = {}) {
  if (!hasArtifactReviewAuthorization(lifecycle)) throw new Error('a current explicit approval is required before artifact review')
  if (hasUnsettledExecution(lifecycle)) throw new Error('unresolved execution evidence blocks artifact review')
  if (!Array.isArray(lifecycle.receipts) || lifecycle.receipts.length < 1) throw new Error('at least one sanitized execution or verification receipt is required before artifact review')
  if (typeof artifact !== 'string' || !artifact.trim()) throw new TypeError('artifact text is required')
  const artifactReview = completedArtifactReview(review)
  if (!artifactReview) throw new Error('a completed isolated artifact review is required')
  const digest = digestPlan(artifact)
  if (typeof reviewedDigest !== 'string' || reviewedDigest !== digest) throw new Error('the reviewed-artifact digest does not match the exact artifact content')
  const generation = lifecycle.generation + 1
  const reviewedArtifact = artifactReview.verdict === 'pass'
    ? Object.freeze({ digest, generation, receiptCount: lifecycle.receipts.length, recordedAt: nowValue(now) })
    : null
  return Object.freeze({
    ...lifecycle,
    generation,
    phase: artifactReview.verdict === 'pass' ? PHASE.ARTIFACT_REVIEWED : PHASE.ARTIFACT_REVIEW_FAILED,
    artifactReview,
    pendingReview: null,
    addressReceipt: null,
    artifactReviewFailure: null,
    reviewedArtifact,
    updatedAt: nowValue(now),
  })
}

// An engine review that cannot produce a completed, bound result must not
// leave an approved generation looking eligible for a completion claim. This
// records only the local artifact identity and failure reason; it never
// fabricates a reviewer verdict or route.
export function recordArtifactReviewDenied(lifecycle, artifact, { reason, now = Date.now() } = {}) {
  if (!hasArtifactReviewAuthorization(lifecycle)) throw new Error('a current explicit approval is required before artifact review')
  if (hasUnsettledExecution(lifecycle)) throw new Error('unresolved execution evidence blocks artifact review')
  if (!Array.isArray(lifecycle.receipts) || lifecycle.receipts.length < 1) throw new Error('at least one sanitized execution or verification receipt is required before artifact review')
  if (typeof artifact !== 'string' || !artifact.trim()) throw new TypeError('artifact text is required')
  const detail = String(reason || '').replace(/\s+/g, ' ').trim()
  if (!detail) throw new TypeError('artifact review denial reason is required')
  const generation = lifecycle.generation + 1
  return Object.freeze({
    ...lifecycle,
    generation,
    phase: PHASE.ARTIFACT_REVIEW_FAILED,
    artifactReview: null,
    pendingReview: null,
    addressReceipt: null,
    artifactReviewFailure: Object.freeze({
      digest: digestPlan(artifact),
      reason: detail.slice(0, 6000),
      generation,
      recordedAt: nowValue(now),
    }),
    reviewedArtifact: null,
    updatedAt: nowValue(now),
  })
}
