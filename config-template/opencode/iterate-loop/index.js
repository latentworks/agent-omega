// iterate-loop plugin: forces verify-and-iterate, escalates strategy after MAX_SHOTS.
//
// IMPORTANT: this file exports ONLY its default plugin function. opencode treats every
// export of a plugin module as a plugin to load, so all testable logic lives in loop.mjs.
//
// Re-prompts go to a FILE log, never stderr (opencode renders plugin stderr into the user's
// window). Skips subagent sessions. Every hook is wrapped so a bug here can't crash the agent.
//
// Env switches:
//   ITERATE_LOOP_DRYRUN=1   log "WOULD ..." instead of re-prompting
//   ITERATE_MAX_SHOTS=N     failed verify cycles before escalating strategy (default 3)
//   ITERATE_HARD_CAP=N      total re-prompts before giving up (default 12)
//   ITERATE_LOOP_LOG=<path> activity log (default <tmp>/iterate-loop.log)

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newState, observeTool, decideIdle } from './loop.mjs'

const DRYRUN = ['1', 'true'].includes(process.env.ITERATE_LOOP_DRYRUN || '')
const LOG_PATH = process.env.ITERATE_LOOP_LOG || join(tmpdir(), 'iterate-loop.log')
const SKIP_PREFIXES = ['[iterate-loop]', '[verify-guard']   // harness re-prompts, not user tasks ('[verify-guard' also matches '[verify-guard failure-classifier]')

function log(m) {
  try { appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${m}\n`) } catch {}
}

const IterateLoopPlugin = async ({ client }) => {
  log('loaded')
  const sessions = new Map()

  function state(id) {
    let s = sessions.get(id)
    if (!s) { s = newState(); s.primary = undefined; sessions.set(id, s) }
    return s
  }

  async function isPrimary(id, s) {
    if (s.primary !== undefined) return s.primary
    try {
      const r = await client.session.get({ path: { id } })
      s.primary = !r?.data?.parentID
    } catch (e) {
      s.primary = true // fail open: never silently disable on the main session
      log(`session.get failed ${id}: ${e}`)
    }
    return s.primary
  }

  return {
    'tool.execute.after': async (input, output) => {
      try {
        observeTool(state(input.sessionID), { tool: input.tool, args: input.args, output })
      } catch (e) { log(`tool.after error: ${e}`) }
    },

    'chat.message': async (input, output) => {
      try {
        const id = input?.sessionID
        if (!id) return
        const text = (output?.parts || []).filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ')
        if (SKIP_PREFIXES.some((pre) => text.startsWith(pre))) return // our own / sibling re-prompt
        const prev = sessions.get(id)?.primary
        const s = newState(); s.primary = prev; sessions.set(id, s)   // fresh user task -> fresh loop budget
      } catch (e) { log(`chat.message error: ${e}`) }
    },

    event: async (input) => {
      let s
      try {
        const event = input && input.event            // destructure INSIDE try (a null arg must not throw uncaught)
        if (!event || event.type !== 'session.idle') return
        const id = event.properties?.sessionID
        if (!id) return
        s = state(id)
        if (s.busy) return                            // re-entrancy guard: an idle for this session is already in flight
        s.busy = true                                 // set synchronously BEFORE decideIdle mutates — a concurrent idle must not double-fire / skip ladder rungs
        const d = decideIdle(s)
        if (!d) return                                // verified, or nothing changed -> let it finish
        if (!(await isPrimary(id, s))) return         // skip subagent sessions
        if (DRYRUN) { log(`WOULD ${d.action} ${id}`); return }
        await client.session.promptAsync({ path: { id }, body: { parts: [{ type: 'text', text: d.text }] } })
        log(`${d.action} sent ${id} (tier=${s.tier} shots=${s.shots} prompts=${s.prompts})`)
      } catch (e) { log(`event error: ${e}`) }
      finally { if (s) s.busy = false }
    },
  }
}

export default IterateLoopPlugin
