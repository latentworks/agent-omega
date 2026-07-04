import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measure } from '../../scripts/attach/wrap.mjs'
import * as U from '../../scripts/attach/ui.mjs'

const allFit = (rows, w) => { for (const r of rows) assert.ok(measure(r) <= w, `"${r}" = ${measure(r)} > ${w}`) }

test('headerBox: box integrity + fits width (60 and 44)', () => {
  for (const w of [60, 44]) {
    const rows = U.headerBox('ses_abc', 'model-x', w)
    allFit(rows, w)
    assert.ok(rows[0].includes('╭') && rows[0].includes('╮'), 'top border')
    assert.ok(rows[rows.length - 1].includes('╰') && rows[rows.length - 1].includes('╯'), 'bottom border')
  }
})
test('assistantBlock: bullet on row 0, hang-indent, fits', () => {
  const rows = U.assistantBlock('a fairly long assistant response that must wrap across several lines at this width for sure', 40)
  allFit(rows, 40)
  assert.ok(rows[0].startsWith('⏺ '), 'bullet')
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].startsWith('  '), 'hang indent row ' + i)
})
test('inputBox: bordered at 60, borderless below 30, cursor inside', () => {
  const wide = U.inputBox('hi', 2, 60)
  allFit(wide.rows, 60)
  assert.ok(wide.rows[0].includes('╭'), 'bordered')
  assert.ok(wide.cursorRow >= 1 && wide.cursorCol >= 4, 'cursor inside box')
  const narrow = U.inputBox('hi', 2, 26)
  allFit(narrow.rows, 26)
  assert.ok(!narrow.rows.some((r) => r.includes('╭')), 'narrow drops borders')
})
test('selectMenu: pointer on selected, numbered, fits', () => {
  const rows = U.selectMenu({ title: 'Permission required', question: 'Do X?', options: ['Allow', 'Deny'], selected: 0, hint: 'esc' }, 50)
  allFit(rows, 50)
  assert.ok(rows.some((r) => r.includes('❯') && r.includes('1. Allow')), 'pointer + option 1')
  assert.ok(rows.some((r) => r.includes('2. Deny')), 'option 2')
})
test('spinner mirror cycle, each fits', () => {
  for (let t = 0; t < 12; t++) assert.ok(measure(U.spinnerLine(t, 'Working', 3, 60)) <= 60)
})
test('footer fills to width; drops left hint below 44', () => {
  assert.ok(measure(U.footerLine('/ for commands', 'model live', 60)) <= 60)
  assert.ok(!U.footerLine('/ for commands', 'model live', 38).includes('for commands'), 'narrow drops left hint')
})
test('errorBlock wraps long messages (no truncation)', () => {
  const rows = U.errorBlock('a very long error message that definitely exceeds the available width and must wrap somewhere', 30)
  allFit(rows, 30)
  assert.ok(rows.length > 1 && rows.join(' ').includes('exceeds'))
})
