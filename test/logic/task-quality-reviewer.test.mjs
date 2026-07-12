import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configuredReviewerCandidates } from '../../config-template/opencode/task-quality/reviewer.mjs'
import { buildCrapEnvelope, renderCrapPrompt, validateCrapReport } from '../../config-template/opencode/task-quality/crap.mjs'

test('reviewer policy: provides a managed order, explicit opt-out, and no fabricated health state', () => {
  assert.deepEqual(configuredReviewerCandidates(), [{ agent: 'helper2' }, { agent: 'helper1' }])
  assert.deepEqual(configuredReviewerCandidates({ reviewers: [] }), [])
  assert.deepEqual(
    configuredReviewerCandidates({ reviewers: [{ agent: 'helper1' }, { agent: 'helper1' }, { agent: 'bad agent' }, { agent: 'helper2', enabled: false }] }),
    [{ agent: 'helper1' }],
  )
})

test('CRAP envelope is allow-list-only and excludes builder context, rationale, earlier review, and hidden reasoning', () => {
  const envelope = buildCrapEnvelope({
    contract: 'Add a safe resolver.',
    acceptanceCriteria: ['No unsafe reviewer selection.'],
    submission: { kind: 'plan', content: '1. Resolve health.', digest: 'abc' },
    evidence: [{ kind: 'receipt', reference: 'test', summary: 'Focused tests pass.' }],
    builderConversation: 'LEAK-CONVERSATION',
    builderRationale: 'LEAK-RATIONALE',
    priorReview: 'LEAK-REVIEW',
    hiddenReasoning: 'LEAK-THINKING',
  })
  const prompt = renderCrapPrompt(envelope)
  for (const marker of ['LEAK-CONVERSATION', 'LEAK-RATIONALE', 'LEAK-REVIEW', 'LEAK-THINKING']) assert.doesNotMatch(prompt, new RegExp(marker))
  assert.ok(Object.isFrozen(envelope))
  assert.deepEqual(Object.keys(envelope).sort(), ['acceptanceCriteria', 'contract', 'evidence', 'protocol', 'submission'])
})

test('CRAP report validation preserves complete plain language verbatim and binds its digest', () => {
  const report = 'Gap one.\r\n\r\nRepair it exactly. ✅'
  const parsed = validateCrapReport(report)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.report, report)
  assert.equal(validateCrapReport(report, parsed.reportDigest).ok, true)
  assert.equal(validateCrapReport(report, '0'.repeat(64)).ok, false)
  assert.equal(validateCrapReport('   ').ok, false)
  assert.doesNotMatch(renderCrapPrompt(buildCrapEnvelope({ contract: 'x', acceptanceCriteria: ['y'], submission: { kind: 'plan', content: 'z', digest: 'd' } })), /JSON only/)
})
