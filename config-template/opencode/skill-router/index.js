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
import { loadSkills, route, buildDirective, lastUserMessages, ROUTER_N } from './router.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = process.env.ROUTER_SKILL_DIR || join(HERE, '..', 'skill')
const ROUTER_BODY = (() => {
  try { return readFileSync(join(SKILL_DIR, 'router', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '') } catch { return '' }
})()
const LOG = process.env.ROUTER_LOG || join(tmpdir(), 'skill-router.log')
const DRYRUN = ['1', 'true'].includes(process.env.ROUTER_DRYRUN || '')
function log(m) { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`) } catch {} }

const SkillRouterPlugin = async ({ client }) => {
  const skills = loadSkills(SKILL_DIR)
  log(`loaded skills=[${Object.keys(skills).join(', ')}] n=${ROUTER_N} dryrun=${DRYRUN} routerBody=${ROUTER_BODY.length}b`)
  const cache = new Map() // sessionID -> { query, directive } : route once per user message, not per sub-step

  async function recentMessages(sessionID) {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      return lastUserMessages((res && res.data) || [], ROUTER_N)
    } catch { return [] }
  }

  return {
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const sessionID = input && input.sessionID
        if (!sessionID || !output || !Array.isArray(output.system) || !ROUTER_BODY) return
        const messages = await recentMessages(sessionID)
        if (!messages.length) return
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
                return ''
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
