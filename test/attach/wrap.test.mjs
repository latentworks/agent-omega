import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measure, wrap, wrapHang, truncate } from '../../scripts/attach/wrap.mjs'

test('measure ignores ANSI', () => {
  assert.equal(measure('\x1b[31mhi\x1b[0m'), 2)
  assert.equal(measure('plain'), 5)
  assert.equal(measure(''), 0)
})
test('measure counts CJK/emoji as width 2', () => {
  assert.equal(measure('日本'), 4)
  assert.equal(measure('a日b'), 4)
})
test('wrap: every line fits width (ASCII prose)', () => {
  const lines = wrap('the quick brown fox jumps over the lazy dog', 10)
  for (const l of lines) assert.ok(measure(l) <= 10, `"${l}" measured ${measure(l)}`)
})
test('wrap: preserves words across a break', () => {
  const src = 'the quick brown fox'
  assert.equal(wrap(src, 9).join(' ').replace(/\s+/g, ' ').trim(), src)
})
test('wrap: hard-breaks an over-long token, losing no chars', () => {
  const src = 'supercalifragilisticexpialidocious'
  const lines = wrap(src, 8)
  for (const l of lines) assert.ok(measure(l) <= 8)
  assert.equal(lines.join(''), src)
})
test('wrap: CJK never exceeds width', () => {
  for (const l of wrap('日本語テストです', 5)) assert.ok(measure(l) <= 5)
})
test('wrap: ANSI is transparent to width', () => {
  const lines = wrap('\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m \x1b[34mblue\x1b[0m', 6)
  for (const l of lines) assert.ok(measure(l) <= 6)
})
test('wrap: explicit newlines split', () => {
  assert.deepEqual(wrap('a\nb', 10), ['a', 'b'])
})
test('wrapHang: continuation lines indented and still fit width', () => {
  const lines = wrapHang('alpha beta gamma delta epsilon zeta', 12, 2)
  for (let i = 0; i < lines.length; i++) {
    assert.ok(measure(lines[i]) <= 12, `row ${i} = ${measure(lines[i])}`)
    if (i > 0) assert.ok(lines[i].startsWith('  '), `row ${i} not indented`)
  }
})
test('truncate: fits width with ellipsis; short strings untouched', () => {
  assert.ok(measure(truncate('hello world this is long', 8)) <= 8)
  assert.equal(truncate('short', 10), 'short')
})
// Property test: random strings (incl. ANSI + CJK), every wrapped row must fit — the K-invariant.
test('property: 400 random strings, no wrapped row exceeds width', () => {
  const chars = ['a', 'b', ' ', ' ', 'x', '日', '本', '\x1b[31m', '\x1b[0m', '😀', 'z']
  for (let n = 0; n < 400; n++) {
    let s = ''
    const len = 1 + Math.floor((n * 7 + 3) % 40)   // deterministic, no Math.random
    for (let i = 0; i < len; i++) s += chars[(n * 13 + i * 5) % chars.length]
    const width = 3 + ((n * 3) % 20)
    for (const l of wrap(s, width)) {
      assert.ok(measure(l) <= width, `n=${n} w=${width} row measured ${measure(l)} > ${width}`)
    }
  }
})
