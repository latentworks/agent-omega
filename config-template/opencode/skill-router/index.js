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
import { loadSkills, route, buildDirective, classifierForModel, classifierIdentity, isLeadingDirectDecision, lastUserMessageEntries, ROUTER_N, EXTRACT_URL, ROUTER_COOLDOWN_MS } from './router.mjs'
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

const SkillRouterPlugin = async ({ client, experimental_task_router }) => {
  const skills = loadSkills(SKILL_DIR)
  log(`loaded skills=[${Object.keys(skills).join(', ')}] n=${ROUTER_N} dryrun=${DRYRUN} routerBody=${ROUTER_BODY.length}b`)
  log(`engine task-router bridge=${typeof experimental_task_router?.begin === 'function'}`)
  const cache = new Map() // sessionID -> { messageID, directive } : route once per persisted user message

  // A failed classifier must fail its engine-attested ticket immediately. Each
  // resolved endpoint/model/provider owns its own breaker so one cold or dead
  // local model cannot suppress a healthy classifier used by another session.
  const degradedClassifiers = new Map()
  async function notifyInert(err, classifierKey, until = 0) {
    const detail = String((err && err.message) || err)
    // Three distinct states, not two: (a) no endpoint configured; (b) endpoint set but the
    // classifier could not be reached AT ALL (refused / DNS / timeout); (c) the classifier was
    // reached but its reply was unusable (non-2xx, or a 200 with an unparseable body). Only (b) is
    // "unreachable" — routerCall tags the error with `.reachable` so (c) isn't mislabeled as (b).
    let state, msg
    if (err?.code === 'ROUTER_UNCONFIGURED') {
      state = 'unconfigured'
      msg = 'Skill router: no explicit local classifier for this model — automatic skill routing is off for this turn.'
    } else if (err?.code === 'ROUTER_TIMEOUT') {
      state = 'timeout'
      msg = `Skill router: local classifier timed out (${detail}) — routing is temporarily degraded and this task remains fail-closed.`
    } else if (err && err.reachable === true) {
      state = 'bad-response'
      msg = `Skill router: local classifier responded but its reply was unusable (${detail}) — routing is temporarily degraded.`
    } else {
      state = 'unreachable'
      msg = `Skill router: local classifier unreachable (${detail}) — routing is temporarily degraded.`
    }
    const prior = degradedClassifiers.get(classifierKey)
    degradedClassifiers.set(classifierKey, { state, until })
    if (prior?.state === state) return
    log(`ROUTER DEGRADED (${state}): ${msg}`)
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

  async function notifyRecovery(classifierKey) {
    if (!degradedClassifiers.has(classifierKey)) return
    degradedClassifiers.delete(classifierKey)
    const msg = 'Skill router: local classifier recovered — automatic skill routing is on.'
    log(`ROUTER RECOVERED: ${msg}`)
    try {
      if (client?.tui && typeof client.tui.showToast === 'function') await client.tui.showToast({ body: { title: 'Skill router', message: msg, variant: 'success' } })
    } catch (e) { log(`recovery toast failed: ${e}`) }
  }

  function messageText(parts) {
    return (Array.isArray(parts) ? parts : [])
      .filter((part) => part?.type === 'text')
      .map((part) => part.text || '')
      .join(' ')
      .trim()
  }

  // Open the engine ticket synchronously from a user-message hook. The
  // following system transform can now await the exact route even when a fresh
  // session's message-list read is briefly stale. The task identity is
  // deliberately bound to the current message alone; prior turns can still
  // inform classification, but cannot silently widen the approved task.
  function scheduleRoute(sessionID, messageID, taskMessages, routeMessages = taskMessages, source = 'fallback', model) {
    const cached = cache.get(sessionID)
    if (cached?.messageID === messageID) return cached
    const identity = buildRouteHandoff({ sessionID, messageID, messages: taskMessages, skillNames: [] })
    const ticket = experimental_task_router?.begin({ sessionID, messageID, taskKey: identity.taskKey })
    let entry
    if (isLeadingDirectDecision(taskMessages[taskMessages.length - 1])) {
      // Settle an explicit non-qualifying result. Task-quality therefore
      // awaits this exact message instead of a stale router ticket, but
      // retains the durable plan it is approving or declining.
      recordRouteHandoff(identity)
      if (ticket) experimental_task_router?.settle(ticket, identity)
      log(`decision message bypassed classifier ${sessionID} task=${identity.taskKey.slice(0, 12)}`)
      entry = { messageID, injected: true, promise: Promise.resolve(''), source }
    } else {
      entry = {
        messageID,
        injected: false,
        source,
        promise: (async () => {
          let names = []
          const classifier = classifierForModel(model)
          const classifierKey = classifierIdentity(classifier, model)
          try {
            const degraded = degradedClassifiers.get(classifierKey)
            if (degraded?.until > Date.now()) throw Object.assign(new Error('classifier is cooling down after a prior failure'), { code: 'ROUTER_COOLDOWN', reachable: false })
            names = await route({ routerBody: ROUTER_BODY, skills, messages: routeMessages, model, classifier })
          } catch (e) {
            log(`route error ${sessionID}: ${e}`)
            if (ticket) experimental_task_router?.fail(ticket)
            if (e?.code !== 'ROUTER_COOLDOWN') {
              // Unconfigured cloud turns are intentionally inert, not a failed
              // local classifier. Report them without cooling any identity.
              const until = e?.code === 'ROUTER_UNCONFIGURED' ? 0 : Date.now() + ROUTER_COOLDOWN_MS
              notifyInert(e, classifierKey, until) // fully self-guarded; ticket already failed closed
            }
            return ''
          }
          notifyRecovery(classifierKey)
          const handoff = buildRouteHandoff({ sessionID, messageID, messages: taskMessages, skillNames: names })
          recordRouteHandoff(handoff)
          if (ticket) experimental_task_router?.settle(ticket, handoff)
          log(`task-quality handoff ${sessionID} qualifies=${handoff.qualifies} task=${handoff.taskKey.slice(0, 12)}`)
          log(`routed ${sessionID} -> [${names.join(', ') || 'NONE'}]  «${routeMessages[routeMessages.length - 1].slice(0, 60)}»`)
          return buildDirective(names)
        })(),
      }
    }
    cache.set(sessionID, entry)
    return entry
  }

  return {
    // `chat.message` is the stable engine hook and therefore opens the
    // non-authorizing router ticket. A process crash before persistence can
    // leave only an in-memory ticket, which expires shortly and never grants
    // permission or creates an approval record. The durable hook below
    // reinforces this on engines that expose it.
    'chat.message': async (input, output) => {
      if (!input?.sessionID || !input?.messageID || (input.origin && input.origin !== 'external-user')) return
      const text = messageText(output?.parts)
      if (!text) return
      scheduleRoute(input.sessionID, input.messageID, [text], [text], 'message', input.model)
    },

    'chat.message.persisted': async (input, output) => {
      // Only a user-authored persisted turn can define a new task. Internal
      // subagent messages are implementation detail, never routing input.
      if (!input?.sessionID || !input?.messageID || (input.origin && input.origin !== 'external-user')) return
      const text = messageText(output?.parts)
      if (!text) return
      // Create the ticket before any async message-list read. Classification
      // uses the exact durable request now; the system transform has a stable
      // ticket to await even on the first turn of a brand-new session.
      scheduleRoute(input.sessionID, input.messageID, [text], [text], 'persisted', input.model)
    },

    'experimental.chat.system.transform': async (input, output) => {
      try {
        const sessionID = input && input.sessionID
        if (!sessionID || !output || !Array.isArray(output.system) || !ROUTER_BODY) return
        const entries = await recentMessages(sessionID)
        const messages = entries.map((entry) => entry.text)
        const last = entries[entries.length - 1]

        // Cache the in-flight ROUTE PROMISE per (session, query) — set synchronously BEFORE any
        // await, so concurrent hook fires for the same message share ONE model call instead of
        // racing into N (the double-route). Never blocks the turn: a route failure resolves to ''.
        let entry = cache.get(sessionID)
        // A ticket created from either native message hook is authoritative for
        // this turn. The message endpoint can briefly return a nonempty
        // *previous* turn; never let that stale observation replace its task.
        // The list remains a legacy fallback when neither hook supplied a
        // ticket (for compatibility with older engines).
        if (last?.id && (!entry || (entry.source === 'fallback' && entry.messageID !== last.id))) {
          entry = scheduleRoute(sessionID, last.id, [last.text], messages, 'fallback', input?.model)
        }
        if (!entry) return
        const directive = await entry.promise // routerCall has a bounded timeout below the engine ticket deadline

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

// v1 module shape is required: the engine injects the producer-only router
// capability solely into this loader-attested config slot. A legacy bare
// function intentionally receives no private engine capabilities.
export default {
  id: 'agent-omega.skill-router',
  server: SkillRouterPlugin,
}
