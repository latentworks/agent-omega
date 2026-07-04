import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInput } from '../../scripts/attach/input.mjs'

function mk(overrides = {}) {
  const events = []
  const h = {
    onRepaint: () => {}, onPrompt: (t) => events.push(['prompt', t]), onAbort: () => events.push(['abort']),
    onExit: () => events.push(['exit']), onExitArm: () => events.push(['exitArm']), onExitDisarm: () => {},
    onMenuPick: (i) => events.push(['pick', i]), onMenuCancel: () => events.push(['cancel']),
    onRedraw: () => events.push(['redraw']), onSlash: () => events.push(['slash']), isBusy: () => false, ...overrides,
  }
  return { inp: createInput(h), events }
}

test('typing builds the buffer', () => {
  const { inp } = mk(); inp._feed('hello')
  assert.equal(inp.buffer().buf, 'hello'); assert.equal(inp.buffer().cursor, 5)
})
test('Enter submits as a prompt and clears', () => {
  const { inp, events } = mk(); inp._feed('hi there'); inp._feed('\r')
  assert.deepEqual(events, [['prompt', 'hi there']]); assert.equal(inp.buffer().buf, '')
})
test('bracketed paste inserts verbatim (newlines kept), does NOT submit', () => {
  const { inp, events } = mk(); inp._feed('\x1b[200~line1\nline2\nline3\x1b[201~')
  assert.equal(inp.buffer().buf, 'line1\nline2\nline3'); assert.deepEqual(events, [])
})
test('paste split across two data chunks still assembles', () => {
  const { inp, events } = mk(); inp._feed('\x1b[200~part-one '); inp._feed('part-two\x1b[201~')
  assert.equal(inp.buffer().buf, 'part-one part-two'); assert.deepEqual(events, [])
})
test('backspace deletes before cursor', () => {
  const { inp } = mk(); inp._feed('abc'); inp._feed('\x7f'); assert.equal(inp.buffer().buf, 'ab')
})
test('left arrow then insert places at cursor', () => {
  const { inp } = mk(); inp._feed('ac'); inp._feed('\x1b[D'); inp._feed('b'); assert.equal(inp.buffer().buf, 'abc')
})
test('menu: digit picks that option', () => {
  const { inp, events } = mk(); inp.setMenu(3); inp._feed('2'); assert.deepEqual(events, [['pick', 1]])
})
test('menu: down arrow moves, Enter picks current', () => {
  const { inp, events } = mk(); inp.setMenu(3); inp._feed('\x1b[B'); inp._feed('\r'); assert.deepEqual(events, [['pick', 1]])
})
test('Esc in menu cancels', () => {
  const { inp, events } = mk(); inp.setMenu(2); inp._feed('\x1b'); assert.deepEqual(events, [['cancel']])
})
test('Esc while busy aborts', () => {
  const { inp, events } = mk({ isBusy: () => true }); inp._feed('\x1b'); assert.deepEqual(events, [['abort']])
})
test('Ctrl+C empty: arms once, exits on second', () => {
  const { inp, events } = mk(); inp._feed('\x03'); assert.deepEqual(events, [['exitArm']])
  inp._feed('\x03'); assert.deepEqual(events, [['exitArm'], ['exit']])
})
test('multiline: trailing backslash + Enter inserts newline, no submit', () => {
  const { inp, events } = mk(); inp._feed('line1\\'); inp._feed('\r'); inp._feed('line2')
  assert.equal(inp.buffer().buf, 'line1\nline2'); assert.deepEqual(events, [])
})
test('history round-trips across instances (persisted to disk)', () => {
  const tmp = path.join(os.tmpdir(), 'ao-hist-' + process.pid + '.json')
  try { fs.unlinkSync(tmp) } catch {}
  process.env.AGENT_OMEGA_ATTACH_HISTORY = tmp
  const a = mk().inp; a._feed('first\r'); a._feed('second\r')
  const b = mk().inp                       // fresh instance re-reads the file
  b._feed('\x1b[A'); assert.equal(b.buffer().buf, 'second')
  b._feed('\x1b[A'); assert.equal(b.buffer().buf, 'first')
  try { fs.unlinkSync(tmp) } catch {}; delete process.env.AGENT_OMEGA_ATTACH_HISTORY
})
