// scripts/attach/theme.mjs
// Palette, glyphs, color-depth detection, and SGR helpers for the attach TUI. Zero deps.
// Honors NO_COLOR / TERM=dumb (monochrome) and ATTACH_ASCII=1 (glyph fallback). Plan §3.2, D6, D7.

const env = process.env
export const NO_COLOR = ('NO_COLOR' in env) || env.TERM === 'dumb'
export const ASCII = env.ATTACH_ASCII === '1' || env.ATTACH_ASCII === 'true'

// color depth: 3 = truecolor, 2 = 256, 1 = 16, 0 = none
export const depth = (() => {
  if (NO_COLOR) return 0
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 3
  const t = env.TERM || ''
  if (/dumb/.test(t)) return 0
  if (/-256color|-direct/.test(t)) return 2
  if (/^(xterm|screen|vt100|linux|ansi)/.test(t)) return 1
  return 2 // Termius / modern default is xterm-256color
})()

// role -> [truecolor, 256, 16] SGR foreground params
const ROLES = {
  accent: ['38;2;215;119;87', '38;5;173', '33'],
  dim:    ['38;5;245',        '38;5;245', '90'],
  border: ['38;5;240',        '38;5;240', '90'],
  ok:     ['38;2;78;186;101', '38;5;71',  '32'],
  err:    ['38;2;229;72;77',  '38;5;167', '31'],
  warn:   ['38;2;226;192;141','38;5;179', '33'],
  info:   ['38;2;86;182;194', '38;5;80',  '36'],
}
function pick(role) {
  const r = ROLES[role]; if (!r) return ''
  return depth === 3 ? r[0] : depth === 2 ? r[1] : r[2]
}

export function sgr(s, role, { bold = false, italic = false } = {}) {
  if (depth === 0) return String(s)
  const codes = []
  if (bold) codes.push('1')
  if (italic) codes.push('3')
  const c = pick(role); if (c) codes.push(c)
  if (!codes.length) return String(s)
  return `\x1b[${codes.join(';')}m${s}\x1b[0m`
}
export const dim = (s) => sgr(s, 'dim')
export const accent = (s) => sgr(s, 'accent')
export const okc = (s) => sgr(s, 'ok')
export const errc = (s) => sgr(s, 'err')
export const warnc = (s) => sgr(s, 'warn')
export const infoc = (s) => sgr(s, 'info')
export const borderc = (s) => sgr(s, 'border')
export const bold = (s) => (depth === 0 ? String(s) : `\x1b[1m${s}\x1b[0m`)
export const italic = (s) => (depth === 0 ? String(s) : `\x1b[3m${s}\x1b[0m`)

// glyphs: Unicode default, ASCII fallback behind ATTACH_ASCII=1
const U = { bullet: '⏺', elbow: '⎿', pointer: '❯', cross: '✗', tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', rule: '─', sparkle: '✻', spinner: ['·', '✢', '✳', '✶', '✻', '✽'] }
const A = { bullet: '*', elbow: 'L', pointer: '>', cross: 'x', tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', rule: '-', sparkle: '*', spinner: ['-', '\\', '|', '/', '|', '\\'] }
export const glyph = ASCII ? A : U
