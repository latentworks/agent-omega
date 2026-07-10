import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configuredReviewerCandidates } from '../../config-template/opencode/task-quality/reviewer.mjs'
import { buildCrapEnvelope, parseCrapResult, renderCrapPrompt } from '../../config-template/opencode/task-quality/crap.mjs'

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

test('CRAP parser retains supported findings/dispositions and drops guesses or orphaned dispositions', () => {
  const parsed = parseCrapResult(JSON.stringify({
    verdict: 'needs-repair', summary: 'One real issue.',
    findings: [
      { id: 'F1', severity: 'high', requirement: 'No unsafe selection.', evidence: 'helper had bash.', failureScenario: 'Reviewer can mutate.', },
      { id: 'guess', severity: 'low', requirement: 'maybe bad' },
    ],
    dispositions: [
      { findingID: 'F1', status: 'needs-repair', reason: 'Remove bash.' },
      { findingID: 'guess', status: 'accepted', reason: 'No support.' },
    ],
  }))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.result.findings.map((finding) => finding.id), ['F1'])
  assert.deepEqual(parsed.result.dispositions.map((item) => item.findingID), ['F1'])
  assert.equal(parseCrapResult('not JSON').ok, false)
  assert.equal(parseCrapResult(JSON.stringify({ verdict: 'needs-repair', summary: 'Unsupported concern.', findings: [{ id: 'G1', requirement: 'maybe' }] })).ok, false)
})
