import { createHash } from 'node:crypto'

// Thin client adapter for the fork's durable task-quality endpoints. Keeping
// this boundary explicit makes the plugin fail closed on an old engine instead
// of quietly falling back to an in-memory authorization map.
export function createLifecycleAdapter(_client, internal, reviewers = []) {
  // Lifecycle writes are deliberately an in-process, engine-attested bridge.
  // A public HTTP/SDK caller may request a review, but can never forge a
  // lifecycle record or an approval.
  if (!internal || typeof internal.get !== 'function' || typeof internal.update !== 'function' || typeof internal.review !== 'function') return null
  return Object.freeze({
    canReview: true,
    async get(sessionID) {
      return await internal.get(sessionID)
    },
    async update(input) {
      return await internal.update(input)
    },
    async resumeWithReview(input) {
      if (typeof internal.resumeWithReview !== 'function') throw new Error('the installed engine cannot deliver a CRAP report as a fresh durable turn')
      const receipt = await internal.resumeWithReview(input)
      if (!receipt || receipt.reviewID !== input.reviewID || !/^[a-f0-9]{64}$/.test(String(receipt.reportDigest || '')) || typeof receipt.messageID !== 'string' || !receipt.messageID) {
        throw new Error('the engine returned an invalid CRAP delivery receipt')
      }
      return Object.freeze({ reviewID: receipt.reviewID, reportDigest: receipt.reportDigest, messageID: receipt.messageID })
    },
    // Real subagent liveness for the stale-execution sweep. Unlike the durable
    // lifecycle methods this is a graceful enhancement, not a correctness
    // requirement: an engine that predates the capability returns null so the
    // caller degrades to its age-based heuristic instead of failing closed. A
    // present engine returns a strict boolean (true = still running → defer;
    // false = phantom → safe to abandon) and throws only if its own status
    // probe failed, which the caller also treats as "unknown → use the age gate".
    async isExecutionLive(input) {
      if (typeof internal.isExecutionLive !== 'function') return null
      const live = await internal.isExecutionLive(input)
      return typeof live === 'boolean' ? live : null
    },
    async review(input) {
      // HSS candidate order crosses only the loader-attested in-process
      // bridge. Ordinary SDK callers cannot select or probe helpers.
      const response = await internal.review({ ...input, reviewers })
      const payload = response?.data ?? response
      // The engine owns the route, active-model affinity, workspace, immutable
      // receipts, and review execution. Accept only its completed envelope;
      // caller-shaped review objects must never authorize a plan checkpoint.
      if (!payload || !payload.route || !payload.submission || !payload.review) throw new Error('the engine returned an incomplete isolated review result')
      if (
        payload.submission.kind !== input?.submission?.kind ||
        typeof payload.submission.digest !== 'string' ||
        !payload.submission.digest ||
        payload.submission.digest !== input?.submission?.digest
      ) {
        throw new Error('the engine review result does not bind to the canonical submitted artifact digest')
      }
      const routeModel = typeof payload.route.model === 'string'
        ? payload.route.model
        : payload.route.model?.providerID && payload.route.model?.modelID
          ? `${payload.route.model.providerID}/${payload.route.model.modelID}`
          : ''
      if (typeof payload.route.kind !== 'string' || !routeModel) {
        throw new Error('the engine returned an isolated review without an attributable route')
      }
      if (payload.review.status !== 'complete') {
        const failure = payload.review.failure && typeof payload.review.failure === 'object' ? payload.review.failure : payload.review
        const parts = [failure.code, failure.message, failure.reason].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.replace(/\s+/g, ' ').trim().slice(0, 1200))
        const identity = [failure.providerID, failure.modelID].filter((value) => typeof value === 'string' && value).join('/')
        throw new Error(`isolated review ${String(payload.review.status || 'failed')}${identity ? ` on ${identity}` : ''}${parts.length ? `: ${parts.join(': ')}` : ''}`)
      }
      const rereviewID = typeof input?.rereview?.reviewID === 'string' && input.rereview.reviewID ? input.rereview.reviewID : null
      // A healthy HSS structured pass retains the established one-call path.
      // Same-model CRAP deliberately uses an ordinary final text report so
      // thinking providers are not forced through an incompatible tool_choice.
      // A re-review never takes this branch: its CRAP report is parsed into a
      // bound verdict by the engine, and an engine that cannot do that must
      // fail closed below instead of restarting the findings cycle.
      if (!rereviewID && !payload.review.result && payload.route.kind === 'crap') {
        const reportValue = typeof payload.review.report === 'string' ? payload.review.report : payload.review.report?.text
        if (typeof reportValue !== 'string' || !reportValue.trim() || Buffer.byteLength(reportValue, 'utf8') > 24 * 1024) throw new Error('the engine returned a completed CRAP review without a bounded plain-language report')
        const reviewID = payload.review.reviewID ?? payload.review.id ?? payload.reviewID
        const reportDigest = payload.review.reportDigest ?? payload.review.report?.sha256
        if (typeof reviewID !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(reviewID)) throw new Error('the engine returned a CRAP report without a valid engine-owned review identity')
        const calculated = createHash('sha256').update(reportValue, 'utf8').digest('hex')
        if (typeof reportDigest !== 'string' || reportDigest !== calculated) throw new Error('the engine CRAP report digest does not match the exact report text')
        const completedAt = payload.review.completedAt
        const toolCount = payload.review.toolCalls ?? 0
        if (!Number.isSafeInteger(completedAt) || completedAt <= 0 || !Number.isSafeInteger(toolCount) || toolCount < 0) throw new Error('the engine returned a CRAP report without valid completion provenance')
        return {
          route: payload.route,
          submission: payload.submission,
          plainReport: Object.freeze({ reviewID, text: reportValue, reportDigest, completedAt, toolCount, model: routeModel }),
        }
      }
      if (!payload.review.result) {
        throw new Error(rereviewID
          ? 'the engine did not return a bound re-review verdict for the addressed artifact; install the engine matching this release'
          : 'the engine returned an incomplete isolated review result')
      }
      if (rereviewID) {
        // The verdict must be engine-attested against the exact requested
        // re-review. An engine that ignored the rereview input (or an older
        // engine) would return an unbound fresh review here; fail closed so a
        // stand-in review can never settle the locked findings.
        if (payload.review.rereview?.reviewID !== rereviewID) throw new Error('the engine review result is not bound to the requested re-review identity')
        const verdict = payload.review.result.verdict
        if (verdict !== 'pass' && verdict !== 'needs_changes' && verdict !== 'blocked') throw new Error('the engine returned a re-review without a readable verdict')
        // A non-pass re-review is an expected bounded outcome the lifecycle
        // classifies into repair rounds — return it, never flatten it into
        // the transport-failure throw below.
        return { route: payload.route, submission: payload.submission, result: payload.review.result }
      }
      // A non-passing FIRST review is an expected adversarial outcome, not an
      // infrastructure failure. Two naive handlings both break: RETURNING the
      // structured result lets captureTerminalPlan fall through to recordPlan
      // and APPROVE a rejected plan (fail-open); THROWING strands the run in
      // `planning` with no deliverable report, so the awaiting-plan-repair
      // recovery can never engage (the observed wedge). Independent-reviewer
      // mode (reviewer diversity) is exactly where a first review comes back
      // as a structured verdict rather than a same-model CRAP report, so its
      // valuable rejection is precisely what dead-hangs. Convert the attested
      // non-pass verdict into a bounded plain-language report so it reuses the
      // proven CRAP delivery path (recordPendingPlanReview -> resumeWithReview
      // -> awaiting-plan-repair -> plan-repair recovery). This stays
      // fail-CLOSED: the plan is never approved; the builder must address the
      // findings and re-checkpoint. If no deliverable report can be attributed
      // (no engine review identity, empty synthesized report, or missing
      // completion provenance) fall back to the fail-closed throw rather than
      // forging an undeliverable pending record. This conversion is scoped to
      // PLAN first-reviews; an artifact non-pass keeps the original fail-closed
      // throw (its repair wording and approval semantics differ, so extending
      // the independent-review cure to artifacts is a separate, separately
      // proven lever — never an untested behavior change smuggled in here).
      if (payload.review.result.verdict !== 'pass') {
        const verdict = typeof payload.review.result.verdict === 'string' ? payload.review.result.verdict : 'invalid'
        const reviewID = payload.review.reviewID ?? payload.review.id ?? payload.reviewID
        const completedAt = payload.review.completedAt
        const toolCount = payload.review.toolCalls ?? 0
        const reportText = structuredReviewReport(verdict, payload.review.result)
        if (
          payload.submission.kind === 'plan' &&
          typeof reviewID === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(reviewID) &&
          reportText && Buffer.byteLength(reportText, 'utf8') <= 24 * 1024 &&
          Number.isSafeInteger(completedAt) && completedAt > 0 &&
          Number.isSafeInteger(toolCount) && toolCount >= 0
        ) {
          const reportDigest = createHash('sha256').update(reportText, 'utf8').digest('hex')
          // route.kind is forced to 'crap' because that is the only transport
          // the durable delivery record and the engine resume handler accept;
          // route.model still names the true independent reviewer so the
          // rejection's provenance is preserved end to end.
          return {
            route: Object.freeze({ ...payload.route, kind: 'crap' }),
            submission: payload.submission,
            plainReport: Object.freeze({ reviewID, text: reportText, reportDigest, completedAt, toolCount, model: routeModel }),
          }
        }
        const summary = typeof payload.review.result.summary === 'string'
          ? payload.review.result.summary.replace(/\s+/g, ' ').trim().slice(0, 600)
          : ''
        throw new Error(`the isolated review returned ${verdict}${summary ? `: ${summary}` : ''}; repair the submitted ${payload.submission.kind === 'plan' ? 'plan' : 'artifact'} before requesting approval`)
      }
      return { route: payload.route, submission: payload.submission, result: payload.review.result }
    },
  })
}

export function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object') return { revision: 0, generation: 0, data: null }
  return {
    revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
    generation: Number.isSafeInteger(value.generation) ? value.generation : 0,
    data: value.data && typeof value.data === 'object' ? value.data : null,
  }
}

// Render an attested non-pass structured verdict as a bounded plain-language
// report so it can travel the same CRAP delivery path a same-model report uses.
// The engine's structured-result contract already guarantees a non-pass carries
// at least one evidence-cited blocking finding, so presenting the findings as a
// numbered checklist gives the builder concrete, actionable repair targets. The
// output is byte-bounded (<=24KB) to satisfy the durable delivery record and the
// engine resume handler, and is always non-empty (the verdict header alone
// guarantees content) so the caller's non-empty gate can trust it.
export function structuredReviewReport(verdict, result) {
  const summary = typeof result?.summary === 'string' ? result.summary.trim() : ''
  const findings = Array.isArray(result?.findings) ? result.findings : []
  const lines = [`Independent plan review verdict: ${typeof verdict === 'string' && verdict ? verdict : 'needs_changes'}`]
  if (summary) lines.push('', summary)
  if (findings.length) {
    lines.push('', 'Findings to address before requesting approval:')
    findings.forEach((finding, index) => {
      const severity = typeof finding?.severity === 'string' && finding.severity ? finding.severity : 'issue'
      const message = typeof finding?.message === 'string' ? finding.message.trim() : ''
      const evidence = typeof finding?.evidence === 'string' ? finding.evidence.trim() : ''
      lines.push(`${index + 1}. [${severity}] ${message}${evidence ? ` (evidence: ${evidence})` : ''}`.trim())
    })
  }
  let text = lines.join('\n').trim()
  if (!text) return ''
  const MAX = 24 * 1024
  if (Buffer.byteLength(text, 'utf8') > MAX) {
    // Truncate on a UTF-8 boundary and drop any partial replacement char the
    // byte-slice may have introduced, then mark the elision.
    text = `${Buffer.from(text, 'utf8').subarray(0, MAX - 16).toString('utf8').replace(/�+$/u, '')}\n...[truncated]`
  }
  return text
}
