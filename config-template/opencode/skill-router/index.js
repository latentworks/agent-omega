// skill-router/index.js — the OpenCode wiring for the skill router.
//
// On each turn: read the last N user messages, run the isolated context-free router
// call (router.mjs) to map them to skill(s), and inject a forceful "invoke skill X now"
// directive into the turn's system prompt — so a local model, which skims the standing
// "use your skills" rule, actually fires the right skill at the right moment.
//
// Exports ONLY the default plugin function (OpenCode loads every export of a plugin
// module as a plugin); all importable/testable logic lives in router.mjs.
//
// Env: ROUTER_EXTRACT_URL, ROUTER_MODEL ('' = loaded model, no swap), ROUTER_N (recent msgs),
//      ROUTER_NOTHINK (default 1), ROUTER_DRYRUN=1 (log instead of inject), ROUTER_LOG.

import { readFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { loadSkills, route, buildDirective, lastUserMessageEntries, ROUTER_N, EXTRACT_URL } from './router.mjs'
import { buildRouteHandoff, recordRouteHandoff } from '../task-quality/handoff.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = process.env.ROUTER_SKILL_DIR || join(HERE, '..', 'skill')
// The router prompt lives HERE (skill-router/router-prompt.md), NOT under skill/, so the engine's
// per-skill command discovery does not surface an internal /router command that returns "NONE"
// when a user invokes it (SKL-4). This module is the only consumer of the template.
const ROUTER_BODY = (() => {
  try { return readFileSync(join(HERE, 'router-prompt.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '') } catch { return '' }
})()
const LOG = process.env.ROUTER_LOG || join(tmpdir(), 'skill-router.log')
const DRYRUN = ['1', 'true'].includes(process.env.ROUTER_DRYRUN || '')
function log(m) { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`) } catch {} }

const SkillRouterPlugin = async ({ client }) => {
  const skills = loadSkills(SKILL_DIR)
  log(`loaded skills=[${Object.keys(skills).join(', ')}] n=${ROUTER_N} dryrun=${DRYRUN} routerBody=${ROUTER_BODY.length}b`)
  const cache = new Map() // sessionID -> { query, directive } : route once per user message, not per sub-step

  // The router fails OPEN (a classify failure resolves to '' and never blocks a turn), but that
  // silence hid a whole disabled feature behind a file-log line the user never sees. Surface it
  // ONCE per app run via the SDK's toast channel so a broken/unset classifier is not invisible.
  // (Unset endpoint on a pure-cloud lead is acceptable-by-design — frontier models self-invoke
  // skills — so word that case softly; an endpoint that's set but unreachable is worded as a fault.)
  let inertNotified = false
  async function notifyInert(err) {
    if (inertNotified) return
    inertNotified = true
    const detail = String((err && err.message) || err)
    // Three distinct states, not two: (a) no endpoint configured; (b) endpoint set but the
    // classifier could not be reached AT ALL (refused / DNS / timeout); (c) the classifier was
    // reached but its reply was unusable (non-2xx, or a 200 with an unparseable body). Only (b) is
    // "unreachable" — routerCall tags the error with `.reachable` so (c) isn't mislabeled as (b).
    let state, msg
    if (!EXTRACT_URL) {
      state = 'unconfigured'
      msg = 'Skill router: no local classifier configured — automatic skill routing is off (fine for cloud models, which invoke skills themselves).'
    } else if (err && err.reachable === true) {
      state = 'bad-response'
      msg = `Skill router: local classifier responded but its reply was unusable (${detail}) — automatic skill routing is off this session.`
    } else {
      state = 'unreachable'
      msg = `Skill router: local classifier unreachable (${detail}) — automatic skill routing is off this session.`
    }
    log(`INERT NOTICE (${state}): ${msg}`)
    try {
      if (client && client.tui && typeof client.tui.showToast === 'function') {
        await client.tui.showToast({ body: { title: 'Skill router', message: msg, variant: 'warning' } })
      }
    } catch (e) { log(`toast failed: ${e}`) }
  }

  async function recentMessages(sessionID) {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      return lastUserMessageEntries((res && res.data) || [], ROUTER_N)
    } catch (e) { log(`messages fetch error ${sessionID}: ${e}`); return [] }
  }

  return {
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const sessionID = input && input.sessionID
        if (!sessionID || !output || !Array.isArray(output.system) || !ROUTER_BODY) return
        const entries = await recentMessages(sessionID)
        if (!entries.length) return
        const messages = entries.map((entry) => entry.text)
        const query = messages.join(' || ')

        // Cache the in-flight ROUTE PROMISE per (session, query) — set synchronously BEFORE any
        // await, so concurrent hook fires for the same message share ONE model call instead of
        // racing into N (the double-route). Never blocks the turn: a route failure resolves to ''.
        let entry = cache.get(sessionID)
        if (!entry || entry.query !== query) {
          entry = {
            query,
            injected: false,
            promise: (async () => {
              let names = []
              try {
                names = await route({ routerBody: ROUTER_BODY, skills, messages })
              } catch (e) {
                log(`route error ${sessionID}: ${e}`)
                notifyInert(e) // one-time visible notice; never awaited (fully self-guarded)
                return ''
              }
              const last = entries[entries.length - 1]
              if (last?.id) {
                const handoff = buildRouteHandoff({ sessionID, messageID: last.id, messages, skillNames: names })
                recordRouteHandoff(handoff)
                log(`task-quality handoff ${sessionID} qualifies=${handoff.qualifies} task=${handoff.taskKey.slice(0, 12)}`)
              }
              log(`routed ${sessionID} -> [${names.join(', ') || 'NONE'}]  «${messages[messages.length - 1].slice(0, 60)}»`)
              return buildDirective(names)
            })(),
          }
          cache.set(sessionID, entry)
        }
        const directive = await Promise.race([entry.promise, new Promise((r) => setTimeout(() => r(''), 2500))]) // fail-open: never block a turn >2.5s on a slow/unreachable classifier

        // Inject the "do this FIRST" directive ONCE per turn (the first sub-step), not on every model
        // step — re-ordering "invoke X before anything" at step 20 only confuses a mid-task model.
        if (directive && !entry.injected) {
          entry.injected = true
          if (DRYRUN) log(`WOULD inject -> ${directive.slice(0, 70)}`)
          else output.system.push(directive)
        }
      } catch (e) {
        log(`transform error: ${e}`)
      }
    },
  }
}

export default SkillRouterPlugin
