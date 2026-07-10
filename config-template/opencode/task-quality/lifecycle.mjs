// Pure lifecycle transitions. Persistence is supplied by the engine adapter so
// all authority is revision/generation checked in the dedicated engine table.
import { digestText } from './handoff.mjs'

export const TASK_QUALITY_POLICY_VERSION = 'agent-omega/task-quality@1'
export const PHASE = Object.freeze({
  PLANNING: 'planning',
  AWAITING_APPROVAL: 'awaiting-approval',
  APPROVED: 'approved',
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
    repairedPlan: null,
    approval: null,
    pendingExecutions: Object.freeze([]),
    receipts: Object.freeze([]),
    artifactReview: null,
    reviewedArtifact: null,
    createdAt: nowValue(now),
    updatedAt: nowValue(now),
  })
}

// Existing data is reused only for the exact routed task. A different routed
// task gets a new monotonic generation so an older approval cannot bleed over.
export function reconstructLifecycle(existing, handoff, { now = Date.now() } = {}) {
  const previousGeneration = Number.isSafeInteger(existing?.generation) ? existing.generation : 0
  if (existing?.taskKey === handoff?.taskKey && existing?.version === 1) return existing
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
    acceptanceCriteria: normalizeCriteria(acceptanceCriteria),
    repairedPlan,
    approval: null,
    updatedAt: nowValue(now),
  })
}

export function parseExplicitDecision(text) {
  const value = String(text || '').trim().toLowerCase()
  if (!value || value.includes('?')) return null
  if (/\b(?:no|don't|do not|not yet|hold|stop|wait|decline|reject)\b/.test(value)) return 'no-go'
  if (/\b(?:go(?:\s+(?:ahead|for it|for gold))?|approve(?:d)?|proceed|ship it)\b/.test(value)) return 'go'
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

export function hasCurrentApproval(lifecycle) {
  return Boolean(
    lifecycle?.version === 1 &&
      lifecycle.phase === PHASE.APPROVED &&
      lifecycle.repairedPlan?.generation === lifecycle.generation &&
      lifecycle.approval?.generation === lifecycle.generation &&
      lifecycle.approval?.planDigest === lifecycle.repairedPlan?.digest,
  )
}

export function hasUnsettledExecution(lifecycle) {
  return Array.isArray(lifecycle?.pendingExecutions) && lifecycle.pendingExecutions.length > 0
}

const PENDING_EXECUTION_LIMIT = 24

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
  return Object.freeze({ ...lifecycle, pendingExecutions: Object.freeze(pending.filter((item) => item?.callID !== callID)), updatedAt: nowValue(now) })
}

const RECEIPT_LIMIT = 24
const DIGEST = /^[a-f0-9]{64}$/

function normalizeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') throw new TypeError('a sanitized receipt is required')
  const callID = String(receipt.callID || '')
  const tool = String(receipt.tool || '')
  const kind = receipt.kind === 'verification' ? 'verification' : receipt.kind === 'tool' ? 'tool' : ''
  const outputDigest = String(receipt.outputDigest || '')
  const outputBytes = receipt.outputBytes
  const capturedAt = receipt.capturedAt
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(callID)) throw new TypeError('receipt call identity is invalid')
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(tool)) throw new TypeError('receipt tool identity is invalid')
  if (!kind || !DIGEST.test(outputDigest)) throw new TypeError('receipt must contain a canonical output digest')
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 0 || outputBytes > 1_000_000) throw new TypeError('receipt output size is invalid')
  if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0) throw new TypeError('receipt timestamp is invalid')
  return Object.freeze({ callID, tool, kind, outputDigest, outputBytes, capturedAt })
}

// Receipts never contain arguments, paths, output, metadata, attachments, or
// model text. They are bounded provenance for a later clean-room artifact
// review. Replaying the same completed tool call is idempotent; a different
// payload for the same call ID fails closed instead of silently overwriting it.
export function recordReceipt(lifecycle, receipt, { now = Date.now() } = {}) {
  if (!hasCurrentApproval(lifecycle)) throw new Error('a current explicit approval is required before recording execution receipts')
  const nextReceipt = normalizeReceipt(receipt)
  const existing = Array.isArray(lifecycle.receipts) ? lifecycle.receipts : []
  const prior = existing.find((item) => item?.callID === nextReceipt.callID)
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(nextReceipt)) throw new Error('a receipt already exists for this call identity with different evidence')
    const pending = Array.isArray(lifecycle.pendingExecutions) ? lifecycle.pendingExecutions : []
    const remaining = pending.filter((item) => item?.callID !== nextReceipt.callID)
    return remaining.length === pending.length ? lifecycle : Object.freeze({ ...lifecycle, pendingExecutions: Object.freeze(remaining), updatedAt: nowValue(now) })
  }
  const pending = Array.isArray(lifecycle.pendingExecutions) ? lifecycle.pendingExecutions : []
  const execution = pending.find((item) => item?.callID === nextReceipt.callID)
  if (!execution || execution.tool !== nextReceipt.tool) throw new Error('receipt has no matching durable execution precommit')
  const receipts = Object.freeze([...existing, nextReceipt].slice(-RECEIPT_LIMIT))
  return Object.freeze({ ...lifecycle, receipts, pendingExecutions: Object.freeze(pending.filter((item) => item?.callID !== nextReceipt.callID)), updatedAt: nowValue(now) })
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
  if (!hasCurrentApproval(lifecycle)) throw new Error('a current explicit approval is required before artifact review')
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
    reviewedArtifact,
    updatedAt: nowValue(now),
  })
}
