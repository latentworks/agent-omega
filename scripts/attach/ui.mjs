// scripts/attach/ui.mjs
// The Claude-Code-style renderer. (1) pure block builders (content,width)->row string(s) — golden-tested;
// (2) createPainter(): commits permanent rows into native scrollback and erase/redraws ONLY the bottom
// live region with EXACT row counting (plan §3.1/§5.3; risk 1). All output via one injected write().
import * as T from './theme.mjs'
import { wrap, measure, truncate } from './wrap.mjs'

export const glyph = T.glyph
const g = T.glyph
const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - measure(s)))

// ---------------------------------------------------------------- pure builders

export function ruleLine(label, width) {
  if (!label) return T.dim(truncate(g.rule.repeat(Math.max(4, width)), width))
  const text = ` ${label} `
  const fill = Math.max(2, width - measure(text) - 4)
  return T.dim(truncate('  ' + g.rule.repeat(2) + text + g.rule.repeat(fill), width))  // 2-space indent (mockups)
}
export function boxTop(title, width) {
  const inner = width - 2
  let bar
  if (title) { const t = ` ${title} `; bar = g.h + t + g.h.repeat(Math.max(1, inner - 1 - measure(t))) }
  else bar = g.h.repeat(inner)
  return T.borderc(g.tl + truncate(bar, inner) + g.tr)
}
export const boxBottom = (width) => T.borderc(g.bl + g.h.repeat(Math.max(2, width - 2)) + g.br)
export function boxRow(content, width) {
  return T.borderc(g.v) + ' ' + padEnd(truncate(content, width - 4), width - 4) + ' ' + T.borderc(g.v)
}
// wrap `content` across as many box rows as needed (finding 11 — no truncation of real content)
export function boxRows(content, width) { return wrap(content, width - 4).map((r) => boxRow(r, width)) }

export function markdownLite(text) {
  const out = []
  let inFence = false
  for (const raw of String(text).split('\n')) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; out.push(T.dim(raw.trim())); continue }
    if (inFence) {
      if (/^\s*\+/.test(raw)) out.push(T.okc('  ' + raw))
      else if (/^\s*-(?!-)/.test(raw)) out.push(T.errc('  ' + raw))
      else out.push(T.dim('  ' + raw))
      continue
    }
    let s = raw
    s = s.replace(/^(#{1,6})\s+(.*)$/, (_, h, r) => T.bold(r))
    s = s.replace(/\*\*([^*]+)\*\*/g, (_, r) => T.bold(r))
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, p, r) => p + T.italic(r))
    s = s.replace(/`([^`]+)`/g, (_, r) => T.infoc(r))
    out.push(s)
  }
  return out.join('\n')
}
function proseBlock(prefix, text, width, { md = false } = {}) {
  const body = md ? markdownLite(text) : text
  const wrapped = wrap(body, Math.max(1, width - 2))
  return (wrapped.length ? wrapped : ['']).map((ln, i) => (i === 0 ? prefix + ln : '  ' + ln))
}
export function userBlock(text, width) {
  return (wrap(text, Math.max(1, width - 2)) || ['']).map((ln, i) => T.dim((i === 0 ? '> ' : '  ') + ln))
}
// assistant responses are marked with the Ω sparkle (accent) — the Agent Omega brand mark (theme-aware: Ω in CRT, O in ASCII)
export function assistantBlock(text, width) { return proseBlock(T.accent(g.sparkle) + ' ', text, width, { md: true }) }
export function continuationBlock(text, width) { return proseBlock('  ', text, width, { md: true }) }
export function toolBlock(title, width) {
  const m = /^(\w+)(\(.*)$/.exec(title)
  const styled = m ? T.bold(m[1]) + m[2] : title
  return proseBlock(T.okc(g.bullet) + ' ', styled, width)
}
export function thinkingBlock(text, width) {
  const rows = [T.accent(g.sparkle) + ' ' + T.accent('Thinking…')]   // label once, then dim-italic trace
  for (const r of wrap(text, Math.max(1, width - 2))) rows.push('  ' + T.dim(T.italic(r)))
  return rows
}
// continuation of a thinking burst already begun (no fresh label; dim-italic, indent 2)
export function thinkingCont(text, width) { return wrap(text, Math.max(1, width - 2)).map((r) => '  ' + T.dim(T.italic(r))) }
export const metaLine = (text, width) => T.dim(truncate(text, width))                        // single line (footer/inline)
export const metaBlock = (text, width) => wrap(text, width).map((r) => T.dim(r))               // wrapped (transcript)
export const errorLine = (text, width) => T.errc(truncate(g.cross + ' ' + text, width))        // single line (footer)
export function errorBlock(text, width) {                                                      // wrapped (transcript, finding 16)
  return wrap(text, Math.max(1, width - 2)).map((r, i) => T.errc((i === 0 ? g.cross + ' ' : '  ') + r))
}

const SPIN_VERBS = ['Working', 'Crunching', 'Cooking', 'Churning', 'Wrangling', 'Grinding', 'Chewing', 'Hustling']
export const spinnerVerbFor = (t) => SPIN_VERBS[Math.floor(t / 8) % SPIN_VERBS.length]
export function spinnerLine(tick, verb, elapsedS, width) {
  const idx = tick % g.spinner.length                            // forward cycle (braille dots)
  const paren = width < 50 ? `(esc · ${elapsedS}s)` : `(esc to interrupt · ${elapsedS}s)`
  return T.accent(g.spinner[idx]) + ' ' + T.accent(verb + '…') + ' ' + T.dim(paren)
}

// input box → { rows, cursorRow (index into rows), cursorCol }. Narrow (<30) drops borders (D24, finding 14).
export function inputBox(buf, cursor, width) {
  const bordered = width >= 30
  const contentW = Math.max(1, (bordered ? width - 4 : width) - 2)
  const logical = buf.length ? buf.split('\n') : ['']
  const rows = []
  logical.forEach((ln, li) => { const segs = wrap(ln, contentW); (segs.length ? segs : ['']).forEach((seg, si) => rows.push((li === 0 && si === 0 ? '> ' : '  ') + seg)) })
  const before = buf.slice(0, cursor)
  const bl = before.split('\n')
  let cr = 0
  for (let i = 0; i < bl.length - 1; i++) cr += Math.max(1, wrap(bl[i], contentW).length)
  const segs = (wrap(bl[bl.length - 1], contentW).length ? wrap(bl[bl.length - 1], contentW) : [''])
  cr += segs.length - 1
  const cc = measure(segs[segs.length - 1])
  const MAX = 8
  const start = Math.max(0, rows.length - MAX)
  const shown = rows.slice(start)
  if (!bordered) {
    const out = shown.map((r) => T.dim(r)).concat([T.dim(g.rule.repeat(width))])
    return { rows: out, cursorRow: Math.max(0, cr - start), cursorCol: 2 + cc }
  }
  const out = [boxTop('', width), ...shown.map((r) => boxRow(r, width)), boxBottom(width)]
  return { rows: out, cursorRow: 1 + Math.max(0, cr - start), cursorCol: 4 + cc }
}

// Inner-scrolls when there are more than maxVisible options, so the menu box always fits the screen
// (a taller-than-terminal menu breaks the live-region erase → the stacking glitch on mobile).
export function selectMenu({ title, question, options, selected, hint, maxVisible = 8 }, width) {
  const rows = [boxTop(title, width)]
  if (question) { rows.push(boxRow('', width)); for (const r of boxRows(T.warnc(question), width)) rows.push(r) }
  rows.push(boxRow('', width))
  const n = options.length
  const start = n > maxVisible ? Math.max(0, Math.min((selected | 0) - (maxVisible >> 1), n - maxVisible)) : 0
  const end = Math.min(n, start + maxVisible)
  if (start > 0) rows.push(boxRow(T.dim(`  ↑ ${start} more`), width))
  for (let i = start; i < end; i++) rows.push(boxRow(`${i === selected ? T.accent(g.pointer) : ' '} ${i + 1}. ${options[i]}`, width))
  if (end < n) rows.push(boxRow(T.dim(`  ↓ ${n - end} more`), width))
  rows.push(boxRow('', width), boxBottom(width))
  if (hint) rows.push('  ' + T.dim(hint))
  return rows
}

export function footerLine(left, right, width) {
  const r = right || ''
  if (width < 44) return ' ' + truncate(r, Math.max(1, width - 1))
  const l = left ? T.dim(left) : ''
  const gap = Math.max(1, width - measure(l) - measure(r) - 1)
  return ' ' + l + ' '.repeat(gap) + r
}
export const liveTag = (model) => (model ? model + ' ' : '') + T.okc(g.bullet + ' live')

const shortId = (s) => (s ? String(s).slice(0, 16) : '—')
export function headerBox(sessionId, model, width) {
  return [
    boxTop('', width),
    ...boxRows(T.accent(g.sparkle) + ' ' + T.bold('Agent Omega') + ' — attached to the live desktop session', width),
    boxRow('', width),
    boxRow('  ' + T.dim('session ') + T.infoc(shortId(sessionId)) + '   ' + T.dim('model ') + T.infoc(model || '—'), width),
    ...boxRows('  ' + T.dim('/help for commands · /quit detaches (desktop keeps running)'), width),
    boxBottom(width),
  ]
}

// ---------------------------------------------------------------- painter (stateful)

const CSI = '\x1b['
export function createPainter({ write, cols, rows }) {
  let cursorUpFromTop = 0, firstPaint = true, pendingCommit = [], inMenu = false
  const termRows = () => (rows ? (rows() || 0) : 0) || 9999
  const commit = (r) => { for (const x of (Array.isArray(r) ? r : [r])) pendingCommit.push(x) }

  // Primary-buffer paint: erase the previous live region (exact row count) and redraw. NO menus here.
  function paint(liveLines, cursor) {
    const cap = termRows() - 1   // never let the live region be taller than the screen (finding 4)
    if (cap > 2 && liveLines.length > cap) { const drop = liveLines.length - cap; liveLines = liveLines.slice(drop); if (cursor) cursor = { row: cursor.row - drop, col: cursor.col } }
    const lastRow = liveLines.length - 1
    let out = ''
    if (!firstPaint) { const up = Math.min(Math.max(0, cursorUpFromTop), termRows() - 1); if (up > 0) out += CSI + up + 'A'; out += '\r' + CSI + '0J' }
    else out += '\r'
    firstPaint = false
    for (const r of pendingCommit) out += r + '\r\n'
    pendingCommit = []
    out += liveLines.join('\r\n')
    const tr = Math.max(0, Math.min(cursor ? cursor.row : lastRow, lastRow))
    const tc = cursor ? Math.max(0, cursor.col) : 0
    const up = lastRow - tr
    if (up > 0) out += CSI + up + 'A'
    out += '\r' + (tc > 0 ? CSI + tc + 'C' : '') + CSI + '?25h'
    cursorUpFromTop = tr
    write(out)
  }
  // Menus render as a modal on the ALTERNATE screen — cleared on every redraw, transcript restored on
  // exit. This is immune to scroll drift (the cause of the stacked box-tops on mobile).
  function enterMenu() { if (!inMenu) { inMenu = true; write(CSI + '?1049h' + CSI + '?25l') } }
  function drawMenu(menuLines) { write(CSI + 'H' + CSI + '2J' + menuLines.join('\r\n')) }
  function exitMenu() { if (inMenu) { inMenu = false; write(CSI + '?25h' + CSI + '?1049l') } }
  return { commit, paint, enterMenu, drawMenu, exitMenu, inMenu: () => inMenu, reset() { firstPaint = true; cursorUpFromTop = 0; pendingCommit = [] } }
}
