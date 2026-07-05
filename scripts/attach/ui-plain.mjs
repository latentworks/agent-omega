// scripts/attach/ui-plain.mjs
// Degraded renderer (D19): the ORIGINAL plain scrolling log, used when !isTTY / TERM=dumb /
// ATTACH_PLAIN=1. Sequential printer — no live region, no raw input. Preserves pre-redesign behavior.
const on = !(process.env.NO_COLOR || process.env.TERM === 'dumb')
const A = (n) => (s) => (on ? `\x1b[${n}m${s}\x1b[0m` : String(s))
const dim = A(2), bold = A(1), cyan = A(36), yellow = A(33), red = A(31)

export function createPlainUI({ write }) {
  let atLineStart = true
  const out = (s) => { write(s); atLineStart = s.endsWith('\n') }
  const line = (s = '') => { if (!atLineStart) out('\n'); out(s + '\n') }
  return {
    line, out,
    header: (sid, model) => { line(bold('Agent Omega — terminal attach')); line(dim(`attached to ${sid}  ·  model ${model}`)) },
    rule: (label = '') => line(dim('── ' + label + ' ' + '─'.repeat(Math.max(2, 40 - label.length)))),
    user: (t) => line(cyan('you  ') + t),
    assistant: (t) => { if (atLineStart) out(bold('omega  ')); out(t) },
    tool: (title) => line(dim('  · ' + title)),
    thinking: (t) => line(dim('  ' + t)),
    meta: (t) => line(dim(t)),
    error: (t) => line(red('error: ') + t),
    engineDown: (t) => line(red('engine down: ') + t),
    turnEnd: () => { line(); line(dim('· ready ·')) },
    permission: (title, options) => {
      line(); line(yellow('⚠ permission needed: ') + title)
      options.forEach((o, i) => line(`   [${i + 1}] ${o.name || o.optionId}`))
      out(yellow('choose 1-' + options.length + ' (or /deny): ')); atLineStart = false
    },
    permissionAnswered: (name) => line(dim('  → ' + name)),
    metaReconnect: () => line(dim('· disconnected — retrying (Ctrl-C to quit) ·')),
  }
}
