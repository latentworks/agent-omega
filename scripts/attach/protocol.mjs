// scripts/attach/protocol.mjs
// Raw WS frames -> typed render events. Update-shape sniffing preserved VERBATIM (plan §5.2).
// D20: ALL wire text is sanitized against terminal injection AND against row-count wormholes
// (CR resets the cursor; tabs render up to 8 cols; emoji VS16 renders 2-wide but measures 0).

const DEBUG = ['1', 'true'].includes(process.env.ATTACH_DEBUG || '')
const THOUGHTS = !['1', 'true'].includes(process.env.ATTACH_NO_THOUGHTS || '')   // show thinking traces by DEFAULT (hide with ATTACH_NO_THOUGHTS=1)

// Strip ESC/CSI/OSC + C0 controls. Class \x0b-\x1f also removes CR (0x0d). Keeps \n (0x0a).
const STRIP = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g
export function sanitize(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/️/g, '').replace(STRIP, '')
}
const sanitizeList = (arr) => (Array.isArray(arr) ? arr.map((o) => (o && typeof o === 'object'
  ? { ...o, name: o.name != null ? sanitize(String(o.name)) : o.name, value: o.value != null ? sanitize(String(o.value)) : o.value, description: o.description != null ? sanitize(String(o.description)) : o.description }
  : o)) : arr)

const SKIP_PART = new Set(['step-start', 'step-finish', 'step', 'snapshot', 'patch'])
export function textOfParts(parts) {
  const t = []
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue
    if (SKIP_PART.has(p.type)) continue
    if (typeof p.text === 'string' && p.text.trim()) t.push(sanitize(p.text))
    else if (p.type && p.type !== 'text') t.push(`[${p.type}${p.tool || p.name ? ':' + (p.tool || p.name) : ''}]`)
  }
  return t.join('')
}
export function roleOf(m) { return (m && m.info && m.info.role) || (m && m.role) || '?' }

export function normalize(m) {
  if (!m || typeof m !== 'object') return null
  switch (m.type) {
    case 'ready': return { kind: 'ready', sessionId: sanitize(m.sessionId || ''), model: sanitize(m.model || ''), apiPort: m.apiPort, apiAuth: m.apiAuth, commands: Array.isArray(m.commands) ? sanitizeList(m.commands) : null, models: Array.isArray(m.models) ? sanitizeList(m.models) : null }
    case 'commands': return { kind: 'commands', commands: Array.isArray(m.commands) ? sanitizeList(m.commands) : [] }
    case 'update': return normalizeUpdate(m.update)
    case 'permission': return { kind: 'permission', title: sanitize(m.title || m.kind || '(action)'), options: (m.options || []).map((o) => ({ optionId: o.optionId, name: sanitize(o.name || o.optionId) })), toolCallId: m.toolCallId }
    case 'turn-start': return { kind: 'turn-start' }
    case 'turn-end': return { kind: 'turn-end' }
    case 'error': return { kind: 'error', message: sanitize(m.message || '') }
    case 'engine-down': return { kind: 'engine-down', message: sanitize(m.message || '') }
    case 'model': return { kind: 'model', model: sanitize(m.model || '') }
    case 'agent': return { kind: 'agent', agent: sanitize(m.agent || '') }
    case 'effort': return { kind: 'effort', effort: sanitize(m.effort || '') }
    case 'replay-start': return { kind: 'replay-start' }
    case 'replay-end': return { kind: 'replay-end' }
    default: return DEBUG ? { kind: 'raw', text: sanitize(JSON.stringify(m)).slice(0, 300) } : null
  }
}
function updateText(u) {
  return (u.content && typeof u.content.text === 'string' && u.content.text)
    || (typeof u.text === 'string' && u.text)
    || (u.delta && u.delta.text) || ''
}
function normalizeUpdate(u) {
  if (!u || typeof u !== 'object') return null
  if (DEBUG) return { kind: 'raw', text: sanitize(JSON.stringify(u)).slice(0, 300) }   // original dumped every update
  const kind = u.sessionUpdate || u.type || ''
  if (/thought/i.test(kind)) return THOUGHTS ? { kind: 'thinking', text: sanitize(updateText(u)) } : null
  const title = (u.toolCall && u.toolCall.title) || u.title
  if (title) return { kind: 'tool', title: sanitize(String(title)) }
  const text = updateText(u)
  if (text) return { kind: 'text', text: sanitize(text) }
  return null
}
