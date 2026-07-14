import test from 'node:test'
import assert from 'node:assert/strict'
import { createWarnOnce } from '../../config-template/opencode/task-quality/observability.mjs'

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
