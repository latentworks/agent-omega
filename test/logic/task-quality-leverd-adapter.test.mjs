import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createLifecycleAdapter, structuredReviewReport } from '../../config-template/opencode/task-quality/adapter.mjs'

// Lever D wedge fix (independent-reviewer diversity). Before the fix, a FIRST
// review that came back as a STRUCTURED non-pass verdict — the exact shape an
// isolated 30B reviewer returns, versus a same-model CRAP report — made the
// adapter THROW. captureTerminalPlan swallowed that throw, left the lifecycle
// in `planning` with no deliverable report, and the awaiting-plan-repair
// recovery could never engage: a ~40-minute dead hang. These tests pin the new
// contract: an attested structured non-pass is converted into a bounded plain
// report (so it reuses the proven CRAP delivery path), it stays fail-CLOSED,
// and it never masks a transport failure or flattens a real pass.

const DIGEST = 'a'.repeat(64)

function adapterFor(reviewPayload) {
  const internal = {
    async get() { return null },
    async update() { return null },
    async review(input) { return reviewPayload(input) },
  }
  return createLifecycleAdapter(null, internal, [])
}

function structuredNonPass(overrides = {}) {
  return (input) => ({
    route: { kind: 'subagent', model: { providerID: 'asus30b', modelID: 'qwen3-coder-30b' }, health: 'validated', ...overrides.route },
    submission: { kind: input.submission.kind, digest: input.submission.digest },
    review: {
      status: 'complete',
      reviewID: 'review-indep-1',
      completedAt: 42,
      toolCalls: 3,
      result: {
        verdict: 'needs_changes',
        summary: 'The plan edits files outside src and never runs the failing parsePort tests.',
        findings: [
          { severity: 'blocking', message: 'Step 2 writes to README.md, violating the src-only constraint.', evidence: 'plan step 2' },
          { severity: 'blocking', message: 'No step runs the parsePort tests to validate the repair.', evidence: 'acceptance criteria omit the suite' },
        ],
        dispositions: [],
      },
      ...overrides.review,
    },
  })
}

test('leverD: a structured non-pass FIRST review converts to a CRAP-transport plain report instead of throwing', async () => {
  const adapter = adapterFor(structuredNonPass())
  const out = await adapter.review({ submission: { kind: 'plan', digest: DIGEST } })

  // Did NOT throw and did NOT return the raw structured result (which would let
  // captureTerminalPlan fall through to recordPlan and APPROVE a rejected plan).
  assert.ok(out.plainReport, 'expected a converted plainReport, not a throw or a fail-open result')
  assert.equal(out.result, undefined, 'must not return the raw structured result (fail-open path)')

  // Transport is forced to crap (the only shape the durable delivery record and
  // engine resume handler accept) but the true reviewer identity is preserved.
  assert.equal(out.route.kind, 'crap')
  assert.equal(out.plainReport.model, 'asus30b/qwen3-coder-30b', 'independent reviewer provenance preserved')
  assert.equal(out.plainReport.reviewID, 'review-indep-1')
  assert.equal(out.plainReport.completedAt, 42)
  assert.equal(out.plainReport.toolCount, 3)

  // The synthesized report is bounded, digest-bound, and carries the verdict +
  // each evidence-cited finding as an actionable checklist.
  assert.match(out.plainReport.text, /needs_changes/)
  assert.match(out.plainReport.text, /README\.md/)
  assert.match(out.plainReport.text, /parsePort tests/)
  assert.ok(Buffer.byteLength(out.plainReport.text, 'utf8') <= 24 * 1024)
  assert.equal(out.plainReport.reportDigest, createHash('sha256').update(out.plainReport.text, 'utf8').digest('hex'))
})

test('leverD: conversion stays fail-CLOSED when the review lacks a valid engine identity', async () => {
  // No engine-owned reviewID → no deliverable pending record can be forged →
  // fall back to the original fail-closed throw rather than approving anything.
  const adapter = adapterFor(structuredNonPass({ review: { reviewID: '' } }))
  await assert.rejects(
    adapter.review({ submission: { kind: 'plan', digest: DIGEST } }),
    /repair the submitted plan before requesting approval/,
  )
})

test('leverD: conversion stays fail-CLOSED when completion provenance is missing', async () => {
  const adapter = adapterFor(structuredNonPass({ review: { completedAt: 0 } }))
  await assert.rejects(
    adapter.review({ submission: { kind: 'plan', digest: DIGEST } }),
    /repair the submitted plan before requesting approval/,
  )
})

test('leverD: a structured PASS first review is unchanged — no plain report, real result returned', async () => {
  const adapter = adapterFor((input) => ({
    route: { kind: 'subagent', model: { providerID: 'asus30b', modelID: 'qwen3-coder-30b' }, health: 'validated' },
    submission: { kind: input.submission.kind, digest: input.submission.digest },
    review: {
      status: 'complete',
      reviewID: 'review-indep-pass',
      completedAt: 7,
      toolCalls: 1,
      result: { verdict: 'pass', summary: 'plan is sound', findings: [], dispositions: [] },
    },
  }))
  const out = await adapter.review({ submission: { kind: 'plan', digest: DIGEST } })
  assert.equal(out.plainReport, undefined)
  assert.ok(out.result)
  assert.equal(out.result.verdict, 'pass')
})

test('leverD: an incomplete (non-complete) review still throws the transport-failure error, not the repair error', async () => {
  // A transport/infra failure must never be laundered into a plan-repair signal.
  const adapter = adapterFor((input) => ({
    route: { kind: 'subagent', model: { providerID: 'asus30b', modelID: 'qwen3-coder-30b' }, health: 'validated' },
    submission: { kind: input.submission.kind, digest: input.submission.digest },
    review: { status: 'failed', failure: { code: 'timeout', message: 'reviewer stalled' } },
  }))
  await assert.rejects(
    adapter.review({ submission: { kind: 'plan', digest: DIGEST } }),
    /isolated review failed/,
  )
})

test('leverD: structuredReviewReport renders a non-empty verdict header even with no findings', () => {
  const text = structuredReviewReport('blocked', { summary: '', findings: [] })
  assert.match(text, /Independent plan review verdict: blocked/)
  assert.ok(text.trim().length > 0)
})

test('leverD: structuredReviewReport bounds an oversized finding set under 24KB', () => {
  const findings = Array.from({ length: 5000 }, (_, i) => ({ severity: 'blocking', message: `finding ${i} ` + 'x'.repeat(40), evidence: 'e'.repeat(40) }))
  const text = structuredReviewReport('needs_changes', { summary: 'many issues', findings })
  assert.ok(Buffer.byteLength(text, 'utf8') <= 24 * 1024, 'must be byte-bounded for the durable record')
  assert.match(text, /\[truncated\]/)
})

test('leverD: an artifact non-pass FIRST review stays on the fail-closed throw path (conversion is plan-scoped)', async () => {
  // The independent-review CRAP conversion is deliberately scoped to PLAN
  // first-reviews. An artifact non-pass must NOT be converted into a plainReport
  // (its repair wording and approval semantics differ from a plan's); it keeps
  // the original fail-closed throw, and the throw names the artifact — never
  // laundering artifact feedback through the plan-worded report path.
  const adapter = adapterFor(structuredNonPass())
  await assert.rejects(
    adapter.review({ submission: { kind: 'artifact', digest: DIGEST } }),
    (err) => {
      assert.match(err.message, /repair the submitted artifact before requesting approval/)
      assert.doesNotMatch(err.message, /submitted plan/)
      return true
    },
  )
})
