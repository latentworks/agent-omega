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
  AWAITING_ARTIFACT_REREVIEW: 'awaiting-artifact-rereview',
  DECLINED: 'declined',
  ARTIFACT_REVIEWED: 'artifact-reviewed',
  ARTIFACT_REVIEW_FAILED: 'artifact-review-failed',
})

function nowValue(now) {
  return Number.isSafeInteger(now) && now > 0 ? now : Date.now()
}

// FIX-6 observability: bounded review-report and submission excerpts are retained
// in the durable blob so plan/artifact review text survives past the pending
// window for forensics. This is additive persistence only — the state machine's
// phase transitions and authorization checks are unchanged.
export const REVIEW_HISTORY_LIMIT = 8
export const REVIEW_REPORT_EXCERPT_BYTES = 8192
const SUBMISSION_EXCERPT_BYTES = 8192

// FIX-2: an addressed artifact must survive a real isolated re-review before
// any terminal verdict exists. Repair rounds are bounded so an artifact the
// reviewer keeps rejecting ends as an honest DECLINED instead of looping.
export const REVIEW_ROUNDS_CAP = 3

// UTF-8 byte-bounded head excerpt. Never splits a multi-byte sequence, and the
// retained text (head + marker) never exceeds maxBytes. The digest kept beside
// the excerpt is always over the full text, so truncation is detectable.
function boundedExcerpt(text, maxBytes) {
  const source = typeof text === 'string' ? text : ''
  const full = Buffer.from(source, 'utf8')
  if (full.length <= maxBytes) return Object.freeze({ text: source, truncated: false, fullBytes: full.length })
  let end = Math.max(0, maxBytes - 64)
  while (end > 0 && (full[end] & 0xc0) === 0x80) end--
  const head = full.subarray(0, end).toString('utf8')
  const elided = full.length - end
  return Object.freeze({ text: `${head}\n[...${elided} bytes elided...]`, truncated: true, fullBytes: full.length })
}

function buildSubmissionExcerpt(text) {
  const excerpt = boundedExcerpt(text, SUBMISSION_EXCERPT_BYTES)
  return Object.freeze({ text: excerpt.text, truncated: excerpt.truncated, bytes: excerpt.fullBytes })
}

function reviewHistoryEntry(pending, now, extra = {}) {
  const excerpt = boundedExcerpt(pending?.report, REVIEW_REPORT_EXCERPT_BYTES)
  return Object.freeze({
    kind: pending.kind,
    route: pending.route,
    reviewID: pending.reviewID,
    reviewedDigest: pending.reviewedDigest,
    report: excerpt.text,
    reportTruncated: excerpt.truncated,
    reportBytes: excerpt.fullBytes,
    reportDigest: pending.reportDigest,
    generation: pending.generation,
    ...extra,
    recordedAt: nowValue(now),
  })
}

function appendReviewHistory(existing, entry) {
  const prior = Array.isArray(existing) ? existing : []
  return Object.freeze([...prior, entry].slice(-REVIEW_HISTORY_LIMIT))
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
    reviewHistory: Object.freeze([]),
    rereview: null,
    reviewRounds: 0,
    reviewDecline: null,
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
    (existing.phase === PHASE.AWAITING_ARTIFACT_REVIEW || existing.phase === PHASE.AWAITING_ARTIFACT_REREVIEW) &&
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
  const repairedPlan = Object.freeze({ digest: reviewedDigest, generation, recordedAt: nowValue(now), submissionExcerpt: buildSubmissionExcerpt(plan) })
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
    // FIX-6: the addressed report is no longer discarded — it is preserved as a
    // bounded forensic excerpt in reviewHistory before pendingReview clears.
    pendingReview: null,
    reviewHistory: appendReviewHistory(lifecycle.reviewHistory, reviewHistoryEntry(pending, now)),
    addressReceipt,
    acceptanceCriteria: normalizeCriteria(acceptanceCriteria),
    repairedPlan: Object.freeze({ digest: addressedDigest, generation, recordedAt: nowValue(now), submissionExcerpt: buildSubmissionExcerpt(plan) }),
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
    // FIX-6: if a prior report was still pending (e.g. after a scope
    // revocation), preserve its bounded excerpt before overwriting it.
    reviewHistory: lifecycle.pendingReview ? appendReviewHistory(lifecycle.reviewHistory, reviewHistoryEntry(lifecycle.pendingReview, now, { disposition: 'superseded-by-fresh-review' })) : lifecycle.reviewHistory,
    addressReceipt: null,
    artifactReview: null,
    artifactReviewFailure: null,
    reviewedArtifact: null,
    rereview: null,
    updatedAt: nowValue(now),
  })
}

export function recordAddressedArtifact(lifecycle, artifact, { now = Date.now() } = {}) {
  if (!hasArtifactReviewAuthorization(lifecycle) || hasUnsettledExecution(lifecycle)) throw new Error('the approved artifact repair must have zero unresolved execution')
  const pending = requirePendingAddress(lifecycle, 'artifact')
  const oldIDs = new Set(pending.receiptWatermark?.callIDs || [])
  const newReceipts = (Array.isArray(lifecycle.receipts) ? lifecycle.receipts : []).filter((item) => !oldIDs.has(item.callID))
  if (newReceipts.length < 1) throw new Error('at least one newly settled post-report execution or verification receipt is required')
  const addressedDigest = digestPlan(artifact)
  if (addressedDigest === pending.reviewedDigest && !newReceipts.some((item) => item.kind === 'verification')) throw new Error('a byte-identical resubmission needs at least one new verification receipt proving the findings were addressed')
  // FIX-2: addressing findings is a claim, not a verdict. The addressed
  // artifact parks in AWAITING_ARTIFACT_REREVIEW until a real isolated
  // re-review returns a bound verdict — the builder can never self-terminate
  // the review by resubmitting. pendingReview (the findings lock) is kept
  // byte-intact so the re-reviewer judges against the original findings.
  return Object.freeze({
    ...lifecycle,
    phase: PHASE.AWAITING_ARTIFACT_REREVIEW,
    rereview: Object.freeze({ reviewID: pending.reviewID, addressedDigest, addressedAt: nowValue(now), postReportReceiptCount: newReceipts.length, newReceiptCallIDs: Object.freeze(newReceipts.map((item) => item.callID)), submissionExcerpt: buildSubmissionExcerpt(artifact) }),
    updatedAt: nowValue(now),
  })
}

// FIX-2: the only exit from AWAITING_ARTIFACT_REREVIEW. A bound 'pass' mints
// the terminal ARTIFACT_REVIEWED verdict; anything else — explicit non-pass,
// digest-unbound result, or an unreadable/failed re-review (failureReason) —
// fails closed and consumes a bounded repair round. Rounds below the cap land
// in repairable ARTIFACT_REVIEW_FAILED (no generation bump, binding intact);
// exhausting the cap ends as an honest terminal DECLINED.
export function recordArtifactRereview(lifecycle, artifact, { review, reviewedDigest, failureReason, roundsCap = REVIEW_ROUNDS_CAP, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.version !== 1 || lifecycle.phase !== PHASE.AWAITING_ARTIFACT_REREVIEW) throw new Error('no addressed artifact is awaiting re-review')
  if (hasUnsettledExecution(lifecycle)) throw new Error('unresolved execution evidence blocks artifact re-review')
  const pending = lifecycle.pendingReview
  if (!pending || pending.kind !== 'artifact' || pending.generation !== lifecycle.generation || !pending.delivery?.messageID) throw new Error('the addressed artifact has no bound delivered review to re-review against')
  const rr = lifecycle.rereview
  if (!rr || rr.reviewID !== pending.reviewID) throw new Error('the addressed-resubmission record does not match the pending review')
  if (typeof artifact !== 'string' || !artifact.trim()) throw new TypeError('artifact text is required')
  const digest = digestPlan(artifact)
  if (typeof reviewedDigest !== 'string' || reviewedDigest !== digest || digest !== rr.addressedDigest) throw new Error('the re-reviewed digest does not match the exact addressed artifact content')
  const cap = Number.isSafeInteger(roundsCap) && roundsCap > 0 ? roundsCap : REVIEW_ROUNDS_CAP
  const priorRounds = Number.isSafeInteger(lifecycle.reviewRounds) && lifecycle.reviewRounds >= 0 ? lifecycle.reviewRounds : 0
  const round = priorRounds + 1
  const rereviewRecord = completedArtifactReview(review)
  const bound = rereviewRecord && review.submission.digest === digest ? rereviewRecord : null
  if (bound?.verdict === 'pass') {
    const generation = lifecycle.generation + 1
    const addressReceipt = Object.freeze({ reviewID: pending.reviewID, reportDigest: pending.reportDigest, reviewedDigest: pending.reviewedDigest, addressedDigest: rr.addressedDigest, deliveryMessageID: pending.delivery.messageID, addressedAt: rr.addressedAt, route: pending.route, postReportReceiptCount: rr.postReportReceiptCount })
    return Object.freeze({
      ...lifecycle,
      generation,
      phase: PHASE.ARTIFACT_REVIEWED,
      pendingReview: null,
      reviewHistory: appendReviewHistory(lifecycle.reviewHistory, reviewHistoryEntry(pending, now, { disposition: 'rereview-pass', addressedDigest: rr.addressedDigest, round })),
      addressReceipt,
      artifactReview: bound,
      artifactReviewFailure: null,
      reviewedArtifact: Object.freeze({ digest, generation, receiptCount: Array.isArray(lifecycle.receipts) ? lifecycle.receipts.length : 0, recordedAt: nowValue(now), causallyAddressed: true, rereviewed: true, submissionExcerpt: buildSubmissionExcerpt(artifact) }),
      rereview: null,
      reviewRounds: round,
      updatedAt: nowValue(now),
    })
  }
  const reason = bound
    ? `the isolated re-review returned ${bound.verdict}${bound.summary ? `: ${bound.summary}` : ''}`
    : String(failureReason || 'the isolated re-review did not return a readable bound verdict').replace(/\s+/g, ' ').trim()
  if (round >= cap) {
    const generation = lifecycle.generation + 1
    return Object.freeze({
      ...lifecycle,
      generation,
      phase: PHASE.DECLINED,
      pendingReview: null,
      reviewHistory: appendReviewHistory(lifecycle.reviewHistory, reviewHistoryEntry(pending, now, { disposition: 'rereview-declined', addressedDigest: rr.addressedDigest, round })),
      addressReceipt: null,
      artifactReview: null,
      artifactReviewFailure: null,
      reviewedArtifact: null,
      rereview: null,
      reviewRounds: round,
      reviewDecline: Object.freeze({ reason: 'review-rounds-exhausted', detail: reason.slice(0, 6000), rounds: round, recordedAt: nowValue(now) }),
      updatedAt: nowValue(now),
    })
  }
  return Object.freeze({
    ...lifecycle,
    phase: PHASE.ARTIFACT_REVIEW_FAILED,
    pendingReview: null,
    reviewHistory: appendReviewHistory(lifecycle.reviewHistory, reviewHistoryEntry(pending, now, { disposition: 'rereview-non-pass', addressedDigest: rr.addressedDigest, round })),
    addressReceipt: null,
    artifactReview: null,
    artifactReviewFailure: Object.freeze({ kind: 'rereview-non-pass', digest, reason: reason.slice(0, 6000), round, generation: lifecycle.generation, recordedAt: nowValue(now) }),
    reviewedArtifact: null,
    rereview: null,
    reviewRounds: round,
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

// The autonomous-loop counterpart of recordUserDecision's GO. In interactive use
// a human types "go" after a plan clears review; in an unattended loop no such
// message ever arrives, so a fully-reviewed plan strands at AWAITING_APPROVAL
// forever ("you may not work" with no road back). This edge is that road back:
// it mints an approval binding IDENTICAL in shape to a human GO, so every
// downstream gate (settlement, artifact review, completion refusal) behaves
// exactly as if a person had approved. It is strictly ADDITIVE and weakens no
// gate — the plan still had to pass plan-review to reach AWAITING_APPROVAL, and
// completion still has to pass the isolated artifact review. It is invoked only
// under the autonomous config flag at the caller, so interactive human-GO is
// unchanged. There is deliberately no autonomous no-go: declining is a stop with
// a road back, handled by the review machinery, never a silent auto-decline.
export function recordAutonomousApproval(lifecycle, { messageID, expectedGeneration, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.version !== 1) return { ok: false, reason: 'missing-lifecycle' }
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration !== lifecycle.generation) return { ok: false, reason: 'stale-plan-generation' }
  if (lifecycle.phase !== PHASE.AWAITING_APPROVAL || lifecycle.repairedPlan?.generation !== lifecycle.generation) {
    return { ok: false, reason: 'no-current-repaired-plan-awaiting-approval' }
  }
  if (typeof messageID !== 'string' || !messageID) return { ok: false, reason: 'missing-message-identity' }
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
        artifactReviewFailure: null,
        rereview: null,
        reviewRounds: 0,
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
      rereview: null,
      reviewRounds: 0,
      reviewDecline: null,
      updatedAt: nowValue(now),
    }),
  }
}

// FIX-2: ARTIFACT_REVIEW_FAILED joins these predicates ONLY while the
// generation binding is intact — a repairable non-pass re-review round never
// bumps the generation, so the original approval still covers the repair.
// Every terminal failure path bumps the generation, which breaks the binding
// conjuncts below, so old terminal FAILED states stay locked out unchanged.
export function hasArtifactReviewAuthorization(lifecycle) {
  return Boolean(
    lifecycle?.version === 1 &&
      (lifecycle.phase === PHASE.APPROVED || lifecycle.phase === PHASE.AWAITING_ARTIFACT_REVIEW || lifecycle.phase === PHASE.ARTIFACT_REVIEW_FAILED) &&
      lifecycle.repairedPlan?.generation === lifecycle.generation &&
      lifecycle.approval?.generation === lifecycle.generation &&
      lifecycle.approval?.planDigest === lifecycle.repairedPlan?.digest,
  )
}

export function hasCurrentApproval(lifecycle) {
  return Boolean(
    lifecycle?.version === 1 &&
      (lifecycle.phase === PHASE.APPROVED || lifecycle.phase === PHASE.ARTIFACT_REVIEW_FAILED) &&
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
      (lifecycle.phase === PHASE.APPROVED || lifecycle.phase === PHASE.ARTIFACT_REVIEW_FAILED) &&
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
      artifactReviewFailure: null,
      rereview: null,
      reviewRounds: 0,
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
    rereview: null,
    reviewRounds: 0,
    reviewDecline: null,
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

// The autonomous-loop counterpart of recordExecutionPermissionRejected for a
// precommit that can never settle on its own — a crashed or phantom execution
// whose real side effect is UNKNOWN. A permission rejection is the narrow
// known-no-side-effect case, so it legitimately keeps the approval live; an
// abandon must assume the tool may already have mutated, so it must NOT leave
// mutation authorized. It sets the durable revocation latch FIRST (which
// immediately disables new mutation through hasCurrentApproval's
// !revocationPending conjunct), removes the exact named precommit, then routes
// through the SAME settlement machinery every other path uses:
//   receipts exist -> AWAITING_ARTIFACT_REVIEW: the work already produced gets
//     its isolated review; the plan/approval bindings stay intact so that review
//     is reachable, but the phase is no longer APPROVED so mutation stays denied.
//   no receipts    -> fresh PLANNING at generation+1: nothing was produced, so
//     the task re-plans from a clean slate.
// Either branch re-authorizes mutation only after a NEW review/approval — this
// is a road back from a permanent freeze, never a fail-open re-authorization
// over unknown on-disk state. If OTHER precommits are still pending, the shared
// transition stays latched (fail-closed) until they too settle. This edge is
// invoked only under the autonomous caller flag; interactive runs are unchanged.
// The forensic breadcrumb (which call was abandoned and why) is emitted by the
// caller's log layer, so no new field is added to the persisted lifecycle shape.
export function abandonStaleExecution(lifecycle, { callID, messageID, now = Date.now() } = {}) {
  if (!lifecycle || lifecycle.version !== 1) return { ok: false, reason: 'missing-lifecycle' }
  if (typeof callID !== 'string' || !callID) return { ok: false, reason: 'missing-call-identity' }
  if (typeof messageID !== 'string' || !messageID) return { ok: false, reason: 'missing-message-identity' }
  const pending = Array.isArray(lifecycle.pendingExecutions) ? lifecycle.pendingExecutions : []
  const match = pending.find((item) => item?.callID === callID)
  if (!match) return { ok: false, reason: 'no-matching-stale-execution' }
  const latched = Object.freeze({
    ...lifecycle,
    revocationPending: Object.freeze({ messageID, requestedAt: nowValue(now) }),
    pendingExecutions: Object.freeze(pending.filter((item) => item?.callID !== callID)),
    updatedAt: nowValue(now),
  })
  return { ok: true, lifecycle: finishPendingScopeTransition(latched, { now }) }
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
    ? Object.freeze({ digest, generation, receiptCount: lifecycle.receipts.length, recordedAt: nowValue(now), submissionExcerpt: buildSubmissionExcerpt(artifact) })
    : null
  return Object.freeze({
    ...lifecycle,
    generation,
    phase: artifactReview.verdict === 'pass' ? PHASE.ARTIFACT_REVIEWED : PHASE.ARTIFACT_REVIEW_FAILED,
    artifactReview,
    // FIX-2/FIX-6: a still-pending report must not vanish when a terminal
    // structured review lands over it — preserve its bounded excerpt first.
    pendingReview: null,
    reviewHistory: lifecycle.pendingReview ? appendReviewHistory(lifecycle.reviewHistory, reviewHistoryEntry(lifecycle.pendingReview, now, { disposition: 'superseded-by-terminal-review' })) : lifecycle.reviewHistory,
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
    reviewHistory: lifecycle.pendingReview ? appendReviewHistory(lifecycle.reviewHistory, reviewHistoryEntry(lifecycle.pendingReview, now, { disposition: 'superseded-by-denial' })) : lifecycle.reviewHistory,
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
