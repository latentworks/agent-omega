// engram/capture.mjs — pure helpers for turning an OpenCode message list into a
// capturable "episode" at compaction time. No OpenCode/network → unit-testable.
//
// A session's messages look like { info: {role,...}, parts: [{type,text,...}] }.
// At compaction OpenCode keeps a recent tail verbatim and summarizes the rest, so
// we capture everything from our per-session watermark up to (length - tailKeep) —
// i.e. exactly the slice about to be dropped — and never re-capture what we already did.

export function textOfMessage(msg) {
  const parts = (msg && msg.parts) || []
  return parts
    .filter((p) => p && p.type === 'text' && p.text)
    .map((p) => String(p.text))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function roleOfMessage(msg) {
  return (msg && msg.info && msg.info.role) || 'unknown'
}

// Which messages are about to fall off, given how many we've already captured.
export function selectDropped(messages, watermark = 0, tailKeep = 4) {
  const msgs = Array.isArray(messages) ? messages : []
  const end = Math.max(0, msgs.length - tailKeep)
  if (end <= watermark) return { slice: [], end: watermark }
  return { slice: msgs.slice(watermark, end), end }
}

// Render a slice of messages into one episode text block (skips empty/tiny turns).
export function buildEpisodeText(messages) {
  return (messages || [])
    .map((m) => `[${roleOfMessage(m)}] ${textOfMessage(m)}`)
    .filter((s) => s.length > 8)
    .join('\n\n')
    .trim()
}

// Tag memory by project = the working directory's leaf name (one shared brain,
// but each fact knows where it came from). 'global' when there's no directory.
export function projectOf(directory) {
  if (!directory) return 'global'
  const parts = String(directory).replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || 'global'
}
