// scripts/attach/wrap.mjs
// ANSI-transparent, width-aware measurement + wrapping. THE correctness core: the live-region
// bookkeeping requires that the number of rows painted equals what wrap() produced (plan §3.7, risk 1).
// Zero deps.

// One CSI (\x1b[ ... final) or OSC (\x1b] ... BEL/ST) sequence at the start of a slice.
const ANSI_HEAD = /^(?:\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/
// Global strip (for measure of already-composed strings).
const ANSI_ALL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

// wcwidth: 0 = combining/zero-width, 2 = wide (CJK/emoji), else 1.
export function charWidth(cp) {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (
    (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x200b && cp <= 0x200f) || cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff)
  ) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}

// visible width, ANSI stripped
export function measure(s) {
  let w = 0
  for (const ch of String(s).replace(ANSI_ALL, '')) w += charWidth(ch.codePointAt(0))
  return w
}

// Tokenize into cells: each cell = { ansi (escape codes to emit first), ch (one visible char or ''), w }.
function tokenize(s) {
  const out = []
  let i = 0, pending = ''
  const str = String(s)
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const m = ANSI_HEAD.exec(str.slice(i))
      if (m) { pending += m[0]; i += m[0].length; continue }
    }
    const cp = str.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    out.push({ ansi: pending, ch, w: charWidth(cp) })
    pending = ''
    i += ch.length
  }
  if (pending) out.push({ ansi: pending, ch: '', w: 0 })
  return out
}
const cellsToStr = (cells) => cells.map((c) => c.ansi + c.ch).join('')

// Wrap to `width` visible cols. ANSI-transparent, breaks at spaces, hard-breaks over-long tokens.
// Preserves explicit newlines. Returns an array of line strings (each measure() <= width).
export function wrap(s, width) {
  width = Math.max(1, width | 0)
  const lines = []
  for (const para of String(s).split('\n')) {
    const cells = tokenize(para)
    let line = [], lineW = 0, lastSpace = -1
    for (const c of cells) {
      if (c.w === 0) { line.push(c); continue }        // zero-width rides along
      if (lineW + c.w <= width) {
        line.push(c); lineW += c.w
        if (c.ch === ' ') lastSpace = line.length - 1
      } else if (c.ch === ' ') {                        // break before an overflowing space (drop char, keep its ansi)
        lines.push(cellsToStr(line) + c.ansi); line = []; lineW = 0; lastSpace = -1
      } else if (lastSpace >= 0) {                       // break at last space; carry the word tail down
        const tail = line.slice(lastSpace + 1)
        lines.push(cellsToStr(line.slice(0, lastSpace)) + (line[lastSpace].ansi || ''))
        line = tail; lineW = tail.reduce((a, x) => a + x.w, 0); lastSpace = -1
        if (lineW + c.w <= width) { line.push(c); lineW += c.w }
        else { lines.push(cellsToStr(line)); line = [c]; lineW = c.w }
      } else {                                           // no break point: hard-break
        lines.push(cellsToStr(line)); line = [c]; lineW = c.w; lastSpace = -1
      }
    }
    lines.push(cellsToStr(line))
  }
  return lines
}

// Wrap with a hang indent: line 0 full width, continuation lines get `indent` leading spaces.
export function wrapHang(s, width, indent = 0) {
  const first = wrap(s, width)
  if (first.length <= 1 || indent <= 0) return first
  // Re-wrap to the narrower continuation width so nothing exceeds `width` after indenting.
  const pad = ' '.repeat(indent)
  const all = wrap(s, width - indent)
  return all.map((ln, i) => (i === 0 ? ln : pad + ln))
}

// Truncate to `width` visible cols, preserving ANSI; append ellipsis if it doesn't fit.
export function truncate(s, width, ell = '…') {
  if (measure(s) <= width) return String(s)
  const cells = tokenize(s)
  const budget = Math.max(0, width - measure(ell))
  let out = '', w = 0, hadAnsi = false
  for (const c of cells) {
    if (c.ansi) hadAnsi = true
    if (w + c.w > budget) break
    out += c.ansi + c.ch; w += c.w
  }
  return out + (hadAnsi ? '\x1b[0m' : '') + ell
}
