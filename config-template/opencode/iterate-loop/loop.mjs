// iterate-loop: the pure decision logic for AgentOmega's verify-and-iterate loop.
//
// The benchmark proved the failure mode: models land in the right place and write
// PLAUSIBLE code built on UNCHECKED assumptions about data shapes / return values,
// then stop. They never run anything to discover they're wrong. This loop forces the
// missing step — write a test, run it, read the failure, fix the ROOT CAUSE, repeat —
// and after MAX_SHOTS failed cycles it escalates the *strategy* (re-read, decompose,
// rethink) with the SAME model. Model-agnostic by design: no routing, no model swap.
//
// Pure logic, no opencode/runtime deps, so it runs identically under Node (tests) and
// opencode's bundled runtime. Wiring lives in index.js.

import { isCodeEditTool, isCodeFile, isVerificationCommand } from '../verify-guard/core.mjs'
import { isFailureResult } from '../verify-guard/failure-evals.mjs'

export const MAX_SHOTS = Number(process.env.ITERATE_MAX_SHOTS || 3)  // failed verify cycles before escalating strategy
export const HARD_CAP = Number(process.env.ITERATE_HARD_CAP || 12)   // total re-prompts before forcing the user rung (no infinite loop)
// Web-search rung: only usable if the optional anon-web component is actually configured (its
// env vars are set). On a default install anon-web isn't present, so the rung is OFF and the
// ladder goes strategy -> user directly — never sending the agent to a dead web bridge.
// ITERATE_WEB_SEARCH (0/1) overrides the auto-detection either way.
// web.py needs BOTH the anon-web path AND its venv python to function, so require both here too —
// otherwise a half-configured install would route the agent to a bridge that then reports "unavailable".
const ANONWEB_PRESENT = Boolean(process.env.AGENT_OMEGA_ANONWEB_VENV && process.env.AGENT_OMEGA_ANONWEB)
export const WEB_SEARCH = process.env.ITERATE_WEB_SEARCH != null && process.env.ITERATE_WEB_SEARCH !== ''
  ? !['0', 'false', 'off'].includes(String(process.env.ITERATE_WEB_SEARCH).toLowerCase())
  : ANONWEB_PRESENT

function argPath(a) { return (a && (a.filePath || a.path || a.file || a.file_path)) || '' }
function argCmd(a) { return (a && (a.command || a.cmd || a.script)) || '' }

export function newState() {
  // tier: escalation rung reached (0 none, 1 strategy, 2 web-search, 3 report-user).
  return { codeChanged: false, lastTest: 'none', shots: 0, prompts: 0, tier: 0, reported: false, rootCause: '' }
}

// Fold one completed tool call into the turn's running state (mutates).
export function observeTool(state, evt) {
  const { tool, args, output } = evt || {}
  const t = String(tool || '').toLowerCase()
  if (isCodeEditTool(t) && isCodeFile(argPath(args))) {
    state.codeChanged = true
    state.lastTest = 'none'          // a new edit invalidates the previous test result
  } else if (t === 'bash' && isVerificationCommand(argCmd(args))) {
    state.lastTest = isFailureResult(output) ? 'fail' : (state.lastTest === 'fail' ? 'fail' : 'pass')   // a passing no-op must not mask a real failure; only an edit (-> 'none') clears a fail
    // verify-guard's classifier (if present) leaves a root-cause summary on the output
    const fc = output && output.metadata && output.metadata.verifyGuardFailure
    state.rootCause = (fc && fc.summary) || ''
  }
  return state
}

const NUDGE = [
  '[iterate-loop] You changed code but have not run a test that proves it works.',
  'Write a SMALL focused test that exercises your change against the EXACT required behavior',
  '(use the requirements/spec for the expected names, return shapes, and values; cover the edge cases it lists),',
  'run it, and read the result. Do not finish until a test you actually ran PASSES.',
].join(' ')

function iterateMsg(rootCause) {
  return [
    '[iterate-loop] Your test did not pass.',
    rootCause ? `Likely cause: ${rootCause}.` : '',
    'Read the expected-vs-actual closely — your code is assuming something about the data shape, names, or',
    'return values that does not match what the test expects. Fix that ROOT CAUSE (not the test), then re-run.',
  ].filter(Boolean).join(' ')
}

const ESCALATE = [
  '[iterate-loop] Three fix attempts have failed — stop patching the same spot.',
  'Change strategy: re-read the requirements AND the relevant code from scratch; write down explicitly what data',
  'shapes, exact names, and return values are expected; decompose the problem into the smallest pieces; and write a',
  'more thorough test BEFORE editing again. Your earlier assumption about how the code or data works is probably',
  'wrong — verify it directly by printing the real values, do not guess.',
].join(' ')

const SEARCH = [
  '[iterate-loop] You have re-strategized and it STILL fails — this is the point to LOOK IT UP, not give up.',
  'Search the web for this exact error / behavior and known fixes using your web bridge',
  '(e.g. `python <your .config/opencode>/web.py search "<the exact error or problem>"`, then `web.py read "<url>"`',
  'on the top authoritative result). Apply the known solution you find, then re-run your test.',
  'Only if searching ALSO fails do you involve the user.',
].join(' ')

// LAST resort — only after iterate + strategy + web search have all failed.
const REPORT_USER = [
  '[iterate-loop] You have iterated, re-strategized, AND searched the web, and it still does not pass.',
  'Now — and only now — involve the user; it is the last move, and you have earned it.',
  'Tell them plainly: what you changed, what you tested, what you found when you searched, and exactly what is',
  'still blocking. Do NOT claim it works.',
].join(' ')

// Decide what to do when the agent goes idle (tries to end its turn). Mutates state.
// Returns { action, text } to re-prompt, or null to let the agent finish.
export function decideIdle(state) {
  if (!state) return null                       // no state -> nothing to decide
  if (!state.codeChanged) return null          // nothing changed -> nothing to verify
  if (state.lastTest === 'pass') return null   // a test ran and passed -> verified, done
  if (state.reported) return null              // already escalated to the user -> let it finish
  if (state.prompts >= HARD_CAP) {             // safety valve: never loop forever
    state.prompts += 1; state.reported = true
    return { action: 'report-user', text: REPORT_USER }
  }
  let action, text
  if (state.lastTest === 'none') {
    action = 'nudge'; text = NUDGE
  } else { // 'fail' — climb the escalation ladder: every MAX_SHOTS failures advances one rung
    state.shots += 1
    if (state.shots >= MAX_SHOTS) {
      state.shots = 0
      state.tier += 1
      if (state.tier === 1) { action = 'escalate'; text = ESCALATE }                // rung 1: change strategy
      else if (state.tier === 2 && WEB_SEARCH) { action = 'search'; text = SEARCH } // rung 2: search the web (anon-web)
      else { action = 'report-user'; text = REPORT_USER; state.reported = true }    // rung 3 (or 2 w/ web off): the user — last resort
    } else {
      action = 'iterate'; text = iterateMsg(state.rootCause)
    }
  }
  state.prompts += 1
  return { action, text }
}
