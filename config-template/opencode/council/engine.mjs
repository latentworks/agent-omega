// council/engine.mjs — pure turn-taking logic for the council.
//
// NO OpenCode / network here on purpose: this is the orchestration only, so it
// can be unit-tested with a fake model caller. It is a direct port of anon-web's
// council.py — the one thing that changes between anon-web and OpenCode is the
// transport (how a model is actually called), which is injected as `callModel`.
//
// callModel(member, { system, prompt }) -> Promise<{ text?: string, error?: string }>
//   - member: { label, model }  (model is a "provider/model" spec, opaque here)
//   - returns the model's full reply text, or an error (honest failure, never faked)

// The persona each member is given — frames it as a peer in a live, multi-model
// council and tells it who else is at the table.
// Two-prong member persona: (A) you're a council member debating in AgentOmega, and
// (B) you have read-only file-view access, soft-scoped to the project. The hard
// guards (read-only, secret deny-list, caps) are enforced in filetools.mjs — this
// just tells the member how to behave.
export const MEMBER_SYSTEM = (label, others, scopeDir) => {
  const solo = !others || others === 'none'
  const intro = solo
    ? `You are ${label}. You are the SOLE analyst on this shared task — no other council members are present — so give your best complete, standalone analysis. Do not reference, wait on, or defer to other members.`
    : `You are ${label}, one of several distinct AI models seated together in a live council ` +
      `inside Agent Omega, debating one shared task. The other members are: ${others}.\n\n` +
      `Read the discussion so far and add YOUR own distinct contribution: build on what's right, ` +
      `push back on what's weak, and move the work forward. Be substantive and concise — don't ` +
      `merely agree, don't just restate others, and speak in your own voice as ${label}.`
  return intro + `\n\n` +
    `To ground your points in the real code instead of guessing, you have READ-ONLY file-view ` +
    `tools: read, grep, glob, and list. Use them when checking the actual files genuinely ` +
    `sharpens your contribution. Your scope is this project directory by default:\n  ${scopeDir || '(none)'}\n` +
    `You may reach a single clearly-relevant file outside it when the task plainly calls for it, ` +
    `but do NOT go hunting through unrelated, system, or secret files (credentials, keys, env files, ` +
    `private data) — no fishing. These four tools are ALL you have: you cannot write, edit, move, run, ` +
    `or fetch anything, and there is no shell or network — you observe, then reason. Tool output may ` +
    `be truncated; if a tool can't reach something, say so plainly and continue — never fabricate file contents.`
}

// Render the shared task + discussion-so-far into one labeled-transcript message.
// A single user message works across every wire format without per-vendor gymnastics.
export function promptFor(task, transcript) {
  const lines = [`TASK: ${task}`, '', 'DISCUSSION SO FAR:']
  if (!transcript || !transcript.length) lines.push('(nobody has spoken yet — you are first)')
  else for (const t of transcript) lines.push(`[${t.speaker}]: ${t.text}`)
  lines.push('', 'Now add your contribution.')
  return lines.join('\n')
}

// Default turn-taking strategy: everyone speaks once per round, in roster order.
// Pluggable — a future strategy (moderator_pick, parallel-round, …) has the same
// signature and the orchestrator below is unchanged.
export function roundTable(members /*, roundIdx, transcript */) {
  return [...(members || [])]
}

// The orchestrator. Streams progress via onEvent; returns the transcript.
export async function runCouncil(task, members, callModel, opts = {}) {
  const { rounds = 1, strategy = roundTable, onEvent = () => {}, cancel = () => false, extraSystem = '', scopeDir = '' } = opts
  const transcript = []
  const othersFor = (me) =>
    members.filter((m) => m !== me).map((m) => m.label).join(', ') || 'none'

  onEvent({ type: 'council_start', task, members: members.map((m) => m.label), rounds })

  for (let r = 0; r < rounds; r++) {
    if (cancel()) break
    onEvent({ type: 'council_round', round: r + 1, of: rounds })
    // Tunnels are independent (each member is its own direct call), so a round's
    // members run IN PARALLEL — a 5-member round costs ~one member's time, not five.
    // They all see the same prior-rounds transcript (captured before the round); they
    // build on each other across rounds, not within a round.
    const roster = strategy(members, r, transcript)
    const roundPrompt = promptFor(task, transcript)
    const results = await Promise.all(
      roster.map(async (m) => {
        onEvent({ type: 'council_msg_start', speaker: m.label, round: r + 1 })
        try {
          const res = await callModel(m, {
            system: MEMBER_SYSTEM(m.label, othersFor(m), scopeDir) + (extraSystem ? `\n\n${extraSystem}` : ''),
            prompt: roundPrompt,
          })
          return { m, res }
        } catch (e) {
          return { m, res: { error: String((e && e.message) || e) } }
        }
      }),
    )
    for (const { m, res } of results) {
      const text = ((res && res.text) || '').trim()
      if (!text) {
        // honest failure (needs key / error / empty) — surfaced, never faked
        onEvent({ type: 'council_msg_done', speaker: m.label, ok: false, error: (res && res.error) || 'no response', round: r + 1 })
        continue
      }
      transcript.push({ speaker: m.label, text })
      onEvent({ type: 'council_msg_done', speaker: m.label, ok: true, chars: text.length, round: r + 1 })
    }
    if (cancel()) break
  }

  onEvent({ type: 'council_done', turns: transcript.length })
  return transcript
}

// Render a transcript to a readable markdown block (for the tool result / synthesis).
export function renderTranscript(transcript) {
  if (!transcript || !transcript.length) return '(the council produced no responses)'
  return transcript.map((t) => `### ${t.speaker}\n${t.text}`).join('\n\n')
}

// Which configured members never contributed (failed every round) — for honest disclosure,
// so a partial council is never passed off as the full roster.
export function missingMembers(members, transcript) {
  const joined = new Set((transcript || []).map((t) => t && t.speaker))
  return (members || []).filter((m) => m && !joined.has(m.label))
}

// Prompt for a pinned synthesizer model (when synthesizer != "driver").
export function synthPrompt(task, transcript) {
  return [
    'A council of AI models just discussed this task:',
    '',
    `TASK: ${task}`,
    '',
    'Their discussion:',
    '',
    renderTranscript(transcript),
    '',
    'Now decide: did a GENUINE FORK in direction emerge — two real, materially different ' +
      'paths to the goal? If YES, present BOTH paths in plain language as "Path A" and "Path B", ' +
      'each with its one honest DOWNSIDE, and ASK the user to choose before proceeding — never ' +
      'pick for them, never say a path "won\'t work" (you are an enabler, not a gatekeeper), then ' +
      'STOP. If NO real fork, give the single actionable takeaway. Resolve disagreements; never a ' +
      'play-by-play of who said what.',
  ].join('\n')
}
