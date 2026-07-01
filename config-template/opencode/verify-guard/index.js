// verify-guard: a turn-end guardrail for OpenCode.
//
// Two local-model failure modes are caught at the moment the agent tries to
// hand a turn back:
//   1. Changed code but ran nothing to confirm it works  -> nudge to verify.
//   2. A command failed and the agent retried blindly / walked away -> classify
//      the failure, inject root-cause advice in-place, and escalate on repeats.
//
// At most one re-prompt per idle (a pending failure outranks the verify nudge),
// each capped per task and reset on a new user message. Safe by design: it only
// re-prompts the agent, never runs commands itself; it skips subagent sessions;
// every hook is wrapped so a bug here can never crash the agent.
//
// The failure classifier is merged from Codex's parallel "verify-guard" draft;
// its tag is preserved so eval records stay attributable.
//
// Env switches:
//   VERIFY_GUARD_DRYRUN=1     log "would ..." instead of actually re-prompting
//   VERIFY_GUARD_VERBOSE=1    log every idle decision
//   VERIFY_GUARD_LOG=<path>   activity log (default: <tmp>/verify-guard.log)
//   VERIFY_GUARD_EVAL_DIR=<d> where JSONL failure-eval records go (default: <tmp>/verify-guard-evals)

import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observeTool, shouldNudge, isWebBridge, isBenignNonZero } from './core.mjs'
import {
  CLASSIFIER_TAG,
  FAILURE_LOG_DIR,
  buildBehaviorEvalRecord,
  buildHarnessMessage,
  classifyFailure,
  createFailureTracker,
  isFailureResult,
} from './failure-evals.mjs'

const VERIFY_CAP = Number(process.env.VERIFY_GUARD_VERIFY_CAP ?? 0) // 0: iterate-loop now owns verify-driving; keep verify-guard's failure classifier only
const FAILURE_CAP = Number(process.env.VERIFY_GUARD_FAILURE_CAP ?? 0) // 0: iterate-loop OWNS idle re-prompting (kills the double-nudge + the mutual reset). verify-guard stays the inline classifier iterate-loop reads via metadata.verifyGuardFailure.
const DRYRUN = ['1', 'true'].includes(process.env.VERIFY_GUARD_DRYRUN || '')
const VERBOSE = DRYRUN || ['1', 'true'].includes(process.env.VERIFY_GUARD_VERBOSE || '')
const LOG_PATH = process.env.VERIFY_GUARD_LOG || join(tmpdir(), 'verify-guard.log')
const EVAL_DIR = process.env.VERIFY_GUARD_EVAL_DIR || FAILURE_LOG_DIR

const VERIFY_MARKER = '[verify-guard]'
const FAILURE_MARKER = `[${CLASSIFIER_TAG} failure-classifier]`
const NUDGE_TEXT = [
  VERIFY_MARKER,
  'You changed code this turn but I did not see you run anything to confirm it works.',
  'Before telling the user it is done: run the real thing at its true surface (the test, the command, the actual request) and show the output.',
  'If you genuinely cannot run it here, say so plainly and state exactly what you did and did not check.',
  'Do not claim it works just because the change looks right.',
].join(' ')

function log(msg) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

function logEval(record) {
  try {
    mkdirSync(EVAL_DIR, { recursive: true })
    appendFileSync(join(EVAL_DIR, `${CLASSIFIER_TAG}-behavior-evals.jsonl`), `${JSON.stringify(record)}\n`)
  } catch (e) {
    log(`eval-log error: ${e}`)
  }
}

const VerifyGuardPlugin = async ({ client }) => {
  log(`loaded (dryrun=${DRYRUN}, verifyCap=${VERIFY_CAP}, failureCap=${FAILURE_CAP})`)
  const sessions = new Map()
  const tracker = createFailureTracker()

  function state(id) {
    let s = sessions.get(id)
    if (!s) {
      s = { codeChanged: false, verified: false, nudgeCount: 0, failurePromptCount: 0, pendingFailure: null, primary: undefined }
      sessions.set(id, s)
    }
    return s
  }

  async function isPrimary(id, s) {
    if (s.primary !== undefined) return s.primary
    try {
      const res = await client.session.get({ path: { id } })
      s.primary = !res?.data?.parentID
    } catch (e) {
      s.primary = true // fail open: never silently disable the guard on the main session
      log(`session.get failed for ${id}: ${e}`)
    }
    return s.primary
  }

  return {
    'tool.execute.after': async (input, output) => {
      try {
        const s = state(input.sessionID)
        observeTool(s, { tool: input.tool, args: input.args })

        // Failure classification is scoped to bash: command exit codes are the
        // real signal, and this avoids misreading a file that merely contains
        // the word "error" as a failed command.
        const bashCmd = (input.args && (input.args.command || input.args.cmd || input.args.script)) || ''
        if (output && String(input.tool || '').toLowerCase() === 'bash' && isFailureResult(output) && !isWebBridge(bashCmd) && !isBenignNonZero(bashCmd)) {
          const classification = tracker.noteFailure(
            input.sessionID,
            classifyFailure({ tool: input.tool, args: input.args, title: output.title, output: output.output, metadata: output.metadata }),
          )
          s.pendingFailure = classification
          output.output = `${output.output || ''}\n\n${buildHarnessMessage(classification)}`.trim()
          output.metadata = { ...(output.metadata ?? {}), verifyGuardFailure: classification }
          logEval(buildBehaviorEvalRecord({ sessionID: input.sessionID, event: 'tool_failure', classification, args: input.args, output: output.output }))
        }
      } catch (e) {
        log(`tool.execute.after error: ${e}`)
      }
    },

    'chat.message': async (input, output) => {
      try {
        const text = (output?.parts || [])
          .filter((p) => p && p.type === 'text')
          .map((p) => p.text || '')
          .join(' ')
        if (text.startsWith(VERIFY_MARKER) || text.startsWith(FAILURE_MARKER) || text.startsWith('[iterate-loop]')) return // our own / sibling re-prompt, not a fresh user task
        const id = input?.sessionID
        if (!id) return
        const s = state(id)
        s.codeChanged = false
        s.verified = false
        s.nudgeCount = 0
        s.failurePromptCount = 0
        s.pendingFailure = null
        tracker.reset(id) // a fresh user task gets a fresh budget
      } catch (e) {
        log(`chat.message error: ${e}`)
      }
    },

    event: async ({ event }) => {
      try {
        if (!event || event.type !== 'session.idle') return
        const id = event.properties?.sessionID
        if (!id) return
        const s = state(id)

        let kind = null
        let text = null
        if (s.pendingFailure && s.failurePromptCount < FAILURE_CAP) {
          kind = 'failure'
          text = `${buildHarnessMessage(s.pendingFailure)}\n\nDo not claim the task is done until this failure is resolved or explicitly reported as blocked.`
        } else if (shouldNudge({ ...s, cap: VERIFY_CAP })) {
          kind = 'verify'
          text = NUDGE_TEXT
        }

        if (VERBOSE) {
          log(`idle ${id} changed=${s.codeChanged} verified=${s.verified} nudges=${s.nudgeCount} failPrompts=${s.failurePromptCount} pending=${!!s.pendingFailure} -> ${kind || 'none'}`)
        }

        if (text && (await isPrimary(id, s))) {
          if (kind === 'failure') {
            s.failurePromptCount += 1
            s.pendingFailure = null
          } else {
            s.nudgeCount += 1
          }
          if (DRYRUN) {
            log(`WOULD ${kind.toUpperCase()} ${id}`)
          } else {
            await client.session.promptAsync({ path: { id }, body: { parts: [{ type: 'text', text }] } })
            log(`${kind} prompt sent ${id}`)
          }
        }

        s.codeChanged = false
        s.verified = false
      } catch (e) {
        log(`event error: ${e}`)
      }
    },
  }
}

export default VerifyGuardPlugin
