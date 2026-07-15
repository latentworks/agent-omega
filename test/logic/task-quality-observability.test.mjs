import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWarnOnce,
  summarizeReviewRoute,
  withRouteObservability,
} from '../../config-template/opencode/task-quality/observability.mjs'

// FIX-6: bare catches that previously swallowed diagnostics now surface the first
// failure once per process instead of staying silent. The factory gives each test
// a fresh, isolated emitter (the plugin uses a process-wide singleton).

test('FIX-6: warnOnce surfaces the first failure once and suppresses the rest for the process', () => {
  const lines = []
  const warnOnce = createWarnOnce((text) => lines.push(text))

  const first = warnOnce('task-quality.log append', new Error('EACCES: permission denied'))
  const second = warnOnce('task-quality.log append', new Error('EACCES: permission denied'))
  const third = warnOnce('other.scope', new Error('different failure'))

  assert.equal(first, true) // first failure was surfaced
  assert.equal(second, false) // subsequent failures are suppressed
  assert.equal(third, false)
  assert.equal(lines.length, 1) // exactly one diagnostic reached the sink
  assert.match(lines[0], /task-quality\.log append failed/)
  assert.match(lines[0], /EACCES: permission denied/)
  assert.match(lines[0], /further diagnostics suppressed/)
  assert.ok(lines[0].endsWith('\n'))
})

test('FIX-6: warnOnce stays non-fatal when its own diagnostic sink throws', () => {
  const warnOnce = createWarnOnce(() => {
    throw new Error('stderr is closed')
  })
  // The terminal guard must swallow the sink failure — emitting a diagnostic can
  // never itself crash the plugin. It still reports the attempt as handled.
  let result
  assert.doesNotThrow(() => {
    result = warnOnce('task-quality.log append', new Error('original failure'))
  })
  assert.equal(result, true)
  // And it remains one-shot: the next call is suppressed and also non-fatal.
  assert.doesNotThrow(() => {
    assert.equal(warnOnce('task-quality.log append', new Error('later failure')), false)
  })
})

test('FIX-6: warnOnce stringifies a non-Error thrown value instead of losing it', () => {
  const lines = []
  const warnOnce = createWarnOnce((text) => lines.push(text))
  warnOnce('task-quality.snapshot read', 'a bare string failure')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /task-quality\.snapshot read failed/)
  assert.match(lines[0], /a bare string failure/)
})

// Lever O — review-route observability. The engine returns WHY same-model CRAP
// fired (reason) and whether a clean-room review actually ran (kind/health), but
// the lifecycle layer drops those before persisting. These assert the wrapper
// records the full route AND can never alter the value or crash the review path.

test('Lever O: summarizeReviewRoute captures the dropped CRAP reason and flattens object models', () => {
  const crap = summarizeReviewRoute({
    kind: 'crap',
    model: 'local/qwen3-coder-80b',
    reason: 'HSS was not requested by the loader-attested Agent Omega plugin; using same-model C.R.A.P.',
  })
  assert.equal(crap.kind, 'crap')
  assert.equal(crap.model, 'local/qwen3-coder-80b')
  assert.match(crap.reason, /HSS was not requested/)

  const hss = summarizeReviewRoute({
    kind: 'subagent',
    agent: 'helper2',
    model: { providerID: 'asus', modelID: 'coder-30b' },
    health: 'validated-by-completed-clean-room-review',
    attempts: [{ agent: 'helper2', reason: 'eligible' }],
  })
  assert.equal(hss.model, 'asus/coder-30b') // object model flattened to provider/model
  assert.equal(hss.agent, 'helper2')
  assert.equal(hss.health, 'validated-by-completed-clean-room-review')
  assert.deepEqual(hss.attempts, ['helper2:eligible'])

  // Garbage / partial values never throw and never fabricate fields.
  assert.equal(summarizeReviewRoute(null), null)
  assert.equal(summarizeReviewRoute('nope'), null)
  const bare = summarizeReviewRoute({ kind: 'crap', model: 'local/x' })
  assert.ok(!('reason' in bare) && !('agent' in bare) && !('health' in bare))
})

test('Lever O: withRouteObservability logs the full route but returns the review value unchanged', async () => {
  const lines = []
  const ret = { route: { kind: 'crap', model: 'local/qwen3-coder-80b', reason: 'No eligible HSS helper completed the bounded clean-room review; using same-model C.R.A.P.' }, plainReport: 'r' }
  // Shape the base like the REAL createLifecycleAdapter return: an Object.freeze
  // object literal with canReview:true plus all five methods as own enumerable
  // props. This locks the {...base} spread against a future adapter refactor that
  // would move methods to a prototype (which the spread would silently drop).
  const base = Object.freeze({
    canReview: true,
    review: async () => ret,
    get: async () => 'G',
    update: async () => 'U',
    resumeWithReview: async () => 'R',
    isExecutionLive: async () => true,
  })
  const wrapped = withRouteObservability(base, (m) => lines.push(m))

  const out = await wrapped.review({ any: 'input' })
  assert.equal(out, ret) // EXACT same object — provably inert to the caller
  assert.equal(lines.length, 1)
  assert.match(lines[0], /"kind":"crap"/)
  assert.match(lines[0], /No eligible HSS helper completed/)
  // canReview flag (which the plugin's `active` check depends on) and every
  // non-review method are preserved as identical references; wrapper is frozen.
  assert.equal(wrapped.canReview, true)
  assert.equal(wrapped.get, base.get)
  assert.equal(wrapped.update, base.update)
  assert.equal(wrapped.resumeWithReview, base.resumeWithReview)
  assert.equal(wrapped.isExecutionLive, base.isExecutionLive)
  assert.ok(Object.isFrozen(wrapped))
})

test('Lever O: withRouteObservability is non-fatal (hostile route accessor, throwing log)', async () => {
  // A route whose reason getter throws must not break review() or lose the value.
  const hostileRoute = { kind: 'crap', model: 'local/x' }
  Object.defineProperty(hostileRoute, 'reason', { enumerable: true, get() { throw new Error('boom') } })
  const base = { review: async () => ({ route: hostileRoute, ok: true }) }
  const wrapped = withRouteObservability(base, () => {})
  const out = await wrapped.review({})
  assert.equal(out.ok, true)

  // A log() that throws must not break review() either.
  const base2 = { review: async () => ({ route: { kind: 'crap', model: 'local/x' }, ok: 2 }) }
  const wrapped2 = withRouteObservability(base2, () => { throw new Error('log dead') })
  const out2 = await wrapped2.review({})
  assert.equal(out2.ok, 2)
})

test('Lever O: withRouteObservability passes a null / no-review base through unchanged (old-engine safety)', () => {
  assert.equal(withRouteObservability(null, () => {}), null)
  const noReview = { get: async () => 1 }
  assert.equal(withRouteObservability(noReview, () => {}), noReview)
})
