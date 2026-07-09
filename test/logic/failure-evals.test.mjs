// verify-guard/failure-evals.mjs — failure classification, secret redaction, and the
// blind-retry escalation ladder (classify → require root cause → force debugging loop).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyFailure, createFailureTracker, buildHarnessMessage,
  isFailureResult, hasFailureExitCode, redactSensitive, buildBehaviorEvalRecord,
} from '../../config-template/opencode/verify-guard/failure-evals.mjs'

test('classifyFailure: each known signature maps to its category', () => {
  const cases = [
    ['EADDRINUSE: address already in use', 'port_in_use'],
    ['Error: Cannot find module "left-pad"', 'missing_dependency'],
    ['SyntaxError: Unexpected token }', 'syntax_or_type_error'],
    ['AssertionError: expected 3 received 4', 'test_assertion_failure'],
    ['EACCES: permission denied', 'permission_or_sandbox'],
    ['connect ECONNREFUSED 127.0.0.1:5432', 'network_or_api'],
    ['Error: operation timed out', 'timeout_or_hang'],
    ['something totally unrecognized happened', 'unknown_failure'],
  ]
  for (const [output, category] of cases) {
    const c = classifyFailure({ tool: 'bash', args: { command: 'x' }, output })
    assert.equal(c.category, category, output)
    assert.ok(c.summary && c.advice, 'summary+advice present')
    assert.ok(c.retryKey.includes(category), 'retryKey carries category')
  }
})

test('redactSensitive: strips API keys, bearer tokens, and key=value secrets', () => {
  assert.ok(!redactSensitive('using sk-abcdef1234567890 now').includes('sk-abcdef'))
  assert.ok(!redactSensitive('Authorization: Bearer supersecrettoken').includes('supersecrettoken'))
  assert.ok(!redactSensitive('run --api-key MYKEY123').includes('MYKEY123'))
  assert.ok(!redactSensitive('password=hunter2').includes('hunter2'))
})

test('classifyFailure: evidence is redacted (a leaked key never reaches the eval record)', () => {
  const c = classifyFailure({ tool: 'bash', args: { command: 'curl' }, output: 'auth failed sk-DEADBEEF12345 boom' })
  assert.ok(!c.evidence.includes('sk-DEADBEEF12345'), 'raw key must not survive into evidence')
})

test('createFailureTracker: repeated identical failures climb the escalation ladder', () => {
  const tr = createFailureTracker()
  const cls = classifyFailure({ tool: 'bash', args: { command: 'npm test' }, output: 'AssertionError: x' })
  const a = tr.noteFailure('sess1', cls)
  const b = tr.noteFailure('sess1', cls)
  const c = tr.noteFailure('sess1', cls)
  assert.equal(a.escalation, 'classify_and_continue')
  assert.equal(b.escalation, 'require_root_cause')
  assert.equal(c.escalation, 'force_debugging_loop')
  assert.ok(b.labels.includes('blind_retry'), '2nd+ occurrence tagged blind_retry')
  // reset drops the session's counters, so the ladder restarts
  tr.reset('sess1')
  assert.equal(tr.noteFailure('sess1', cls).escalation, 'classify_and_continue')
})

test('createFailureTracker: different sessions do not share a counter', () => {
  const tr = createFailureTracker()
  const cls = classifyFailure({ tool: 'bash', args: { command: 'x' }, output: 'ECONNREFUSED' })
  tr.noteFailure('A', cls); tr.noteFailure('A', cls)
  assert.equal(tr.noteFailure('B', cls).escalation, 'classify_and_continue', 'session B starts fresh')
})

test('buildHarnessMessage: message hardens as the repeat count rises', () => {
  const base = classifyFailure({ tool: 'bash', args: {}, output: 'ECONNREFUSED' })
  assert.ok(buildHarnessMessage({ ...base, repeatCount: 1 }).includes(base.advice))
  assert.match(buildHarnessMessage({ ...base, repeatCount: 2 }), /Repeated failure/)
  assert.match(buildHarnessMessage({ ...base, repeatCount: 3 }), /third repeated failure/)
})

test('isFailureResult: a real exit code beats the word-regex fallback', () => {
  assert.equal(isFailureResult({ metadata: { exit: 0 }, output: 'contains the word error' }), false, 'exit 0 wins over a benign "error" word')
  assert.equal(isFailureResult({ metadata: { exit: 1 } }), true)
  assert.equal(isFailureResult({ output: 'Error: boom' }), true, 'no exit code → fall back to word regex')
  assert.equal(isFailureResult({ metadata: { status: 'ok' }, output: '' }), false)
  assert.equal(isFailureResult({ metadata: { status: 200 }, output: 'all good' }), false, 'HTTP-style 200 must not read as a non-zero exit')
})

test('hasFailureExitCode: only a hard non-zero exit, never the word fallback', () => {
  assert.equal(hasFailureExitCode({ metadata: { exit: 2 } }), true)
  assert.equal(hasFailureExitCode({ output: 'AssertionError with no code field' }), false)
})

test('buildBehaviorEvalRecord: stable fields carry through and output is redacted', () => {
  const cls = classifyFailure({ tool: 'bash', args: { command: 'x' }, output: 'ECONNREFUSED' })
  const rec = buildBehaviorEvalRecord({ sessionID: 's', event: 'idle', classification: cls, output: 'leak sk-ABCDEF123456 tail' })
  assert.equal(rec.sessionID, 's')
  assert.equal(rec.category, 'network_or_api')
  assert.ok(!rec.outputTail.includes('sk-ABCDEF123456'), 'record output is redacted')
})
