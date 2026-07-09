// iterate-loop/loop.mjs — the escalation state machine that forces "write a test, run it,
// read the failure, fix the ROOT CAUSE, repeat" and climbs rungs (iterate → change strategy
// → [web search] → report to user) instead of letting the agent stop on unchecked code.
//
// The module reads its caps + web-rung from env AT IMPORT. Clear those vars first, then import
// dynamically, so the "bare install" assertions (MAX_SHOTS=3, HARD_CAP=12, web off) are hermetic
// and can't be flipped by an ambient env or a CI runner that happens to set one.
import { test } from 'node:test'
import assert from 'node:assert/strict'

for (const k of ['ITERATE_MAX_SHOTS', 'ITERATE_HARD_CAP', 'ITERATE_WEB_SEARCH', 'AGENT_OMEGA_ANONWEB', 'AGENT_OMEGA_ANONWEB_VENV']) delete process.env[k]
const { MAX_SHOTS, HARD_CAP, WEB_SEARCH, newState, observeTool, decideIdle } = await import('../../config-template/opencode/iterate-loop/loop.mjs')

const fail = (output = 'exit 1\nError: boom') => ({ output }) // reads as a failed test
const pass = () => ({ output: 'ok, all good' })

test('default caps and web rung reflect a bare install (no anon-web env)', () => {
  assert.equal(MAX_SHOTS, 3)
  assert.equal(HARD_CAP, 12)
  assert.equal(WEB_SEARCH, false) // no AGENT_OMEGA_ANONWEB* env → web rung off, ladder goes strategy → user
})

test('observeTool: an edit flags codeChanged and invalidates the prior test result', () => {
  const s = newState()
  observeTool(s, { tool: 'bash', args: { command: 'npm test' }, output: pass() })
  assert.equal(s.lastTest, 'pass')
  observeTool(s, { tool: 'edit', args: { filePath: 'src/a.js' } })
  assert.equal(s.codeChanged, true)
  assert.equal(s.lastTest, 'none', 'a new edit invalidates the earlier pass')
})

test('observeTool: a passing no-op after a failure must NOT mask the failure', () => {
  const s = newState()
  observeTool(s, { tool: 'edit', args: { filePath: 'a.js' } })
  observeTool(s, { tool: 'bash', args: { command: 'npm test' }, output: fail() })
  assert.equal(s.lastTest, 'fail')
  observeTool(s, { tool: 'bash', args: { command: 'npm test' }, output: pass() })
  assert.equal(s.lastTest, 'fail', 'only a fresh edit (→none) may clear a fail')
})

test('decideIdle: nothing to verify → let the turn finish', () => {
  assert.equal(decideIdle(null), null)
  assert.equal(decideIdle(newState()), null) // no code changed
  const passed = newState(); passed.codeChanged = true; passed.lastTest = 'pass'
  assert.equal(decideIdle(passed), null) // a test ran and passed
})

test('decideIdle: code changed but no test run yet → nudge', () => {
  const s = newState(); s.codeChanged = true; s.lastTest = 'none'
  assert.equal(decideIdle(s).action, 'nudge')
})

test('decideIdle: failing tests climb iterate → iterate → escalate → report-user (web off)', () => {
  const s = newState(); s.codeChanged = true; s.lastTest = 'fail'
  const actions = []
  for (let i = 0; i < 6; i++) { s.lastTest = 'fail'; actions.push(decideIdle(s).action) }
  // MAX_SHOTS=3: two iterates then a strategy escalation; repeat; web off → straight to the user
  assert.deepEqual(actions, ['iterate', 'iterate', 'escalate', 'iterate', 'iterate', 'report-user'])
  assert.equal(s.reported, true)
  assert.equal(decideIdle(s), null, 'once reported to the user, stop re-prompting')
})

test('decideIdle: HARD_CAP is an absolute safety valve against an infinite loop', () => {
  const s = newState(); s.codeChanged = true; s.lastTest = 'none'; s.prompts = HARD_CAP
  const d = decideIdle(s)
  assert.equal(d.action, 'report-user')
  assert.equal(s.reported, true)
})
