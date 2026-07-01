// council/tunnel.mjs — drive one council member as an INDEPENDENT direct AI-SDK call
// (its own "tunnel" to the provider with your vault key), with its own private read-only
// file tools. No opencode session machinery at all — this is what eliminates the
// child-session-tool deadlock and makes the council mode-agnostic (TUI/acp/serve alike).
// Honors the exact callModel(member,{system,prompt}) -> {text?|error?} contract that
// runCouncil (engine.mjs) already expects, so the orchestration is untouched.
import { generateText, stepCountIs } from 'ai'
import { modelFor } from './providers.mjs'
import { createFileTools } from './filetools.mjs'

const MAX_STEPS = 12 // member tool-loop ceiling — enough to read a few files then answer
                     // (the hard 40-call / 1MB file budget in filetools is the real cap)

// Validated once: a non-numeric / 0 / negative COUNCIL_TIMEOUT_MS must NOT silently abort every
// member (AbortSignal.timeout(NaN) throws; 0 aborts instantly) and then get blamed on "bad keys".
export function parseTimeout(raw, fallback = 120000) {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

export function createTunnelRunner(ctx, opts = {}) {
  const timeoutMs = parseTimeout(opts.timeoutMs ?? process.env.COUNCIL_TIMEOUT_MS)
  const scopeDir = ctx.directory || process.cwd()
  const env = opts.env || process.env

  return async function callMember(member, { system, prompt }) {
    try {
      const signals = [AbortSignal.timeout(timeoutMs)]
      if (ctx.abort instanceof AbortSignal) signals.push(ctx.abort) // a non-signal (e.g. an AbortController) would make AbortSignal.any throw and fail every member
      const abortSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
      // Each member gets a FRESH set of read-only file tools (fresh budget). withTools:false
      // (memberAccess: 'none') gives a pure discuss-only member.
      const tools = opts.withTools === false ? undefined : createFileTools({ directory: scopeDir, label: member.label })
      const { text } = await generateText({
        model: modelFor(member.model, env),
        system,
        prompt,
        tools,
        stopWhen: stepCountIs(MAX_STEPS), // REQUIRED in ai v6 — default stepCountIs(1) means no tool loop
        abortSignal,
      })
      const t = (text || '').trim()
      return t ? { text: t } : { error: 'empty reply' }
    } catch (e) {
      return { error: String((e && e.message) || e) } // honest failure (bad key / timeout / provider error)
    }
  }
}
