// task-quality/selfreview.mjs — ALWAYS-ON ensemble self-review for CODE tasks.
//
// WHAT THIS IS (Agent Omega's Gate-1 "never worse than raw" feature):
//   When the local worker model produces a function-level code artifact, an INDEPENDENT
//   ensemble of N blind re-derivations of the same spec is generated, each executed in a
//   CONTAINED child process (see selfreview-exec.mjs: secret-scrubbed env, cwd locked to a throwaway
//   scratch dir, hard SIGKILL timeout — containment for a voting-only run, NOT a full OS sandbox;
//   the residual absolute-path/socket reach is a documented staging fork), and their input->output
//   behavior is voted. Strong consensus is a
//   trusted oracle; splits are resolved by the model's own step-by-step reasoning or, when that
//   is inconclusive, carried as an honest BOUND ("could not certify"). A grounded-consensus
//   review then reads the ensemble's UNANIMOUS answers and flags outputs that violate the spec —
//   catching a blind spot that every draft SHARES (the one failure the vote alone cannot see).
//
// DEFAULT-ON (a FIRST — every prior lever defaults OFF): the ONLY way to disable is the explicit
//   OMEGA_SELF_REVIEW_DISABLE=1 hatch. Rationale: this is what Omega is supposed to do out of the
//   gate, so the safe path is unconditional and only the escape hatch is gated.
//
// GATE-1 IN v1 IS BY CONSTRUCTION: this module NEVER mutates the shipped code and NEVER overrides
//   the ship decision. Its entire output is `advisory` (a plain-English signal) + honest bound
//   flags. Because the committed code is left exactly as the model wrote it, "never worse than
//   raw" holds unconditionally here — the ensemble can only ADD a signal, never subtract quality.
//   (The bench proofs that the ensemble's SELECT output is itself never-worse are the evidence
//   base for a possible v2 SELECT/replace mode — deferred; Austin's call.)
//
// SCOPE (honest): the mechanism is FUNCTION-LEVEL — it needs a `{ spec, fnName, signature }`
//   contract so it can generate N implementations of ONE function and compare their I/O. It does
//   NOT apply to arbitrary multi-file feature/refactor work. Callers that cannot express the task
//   as a function contract MUST skip it; this module returns `{ ran:false, reason:'no-contract' }`
//   rather than degrade. The Omega eval workload (csvrow, semver, parseDuration, isValidIPv4, ...)
//   and self-checking one's own utility functions ARE function-level, which is the target.
//
// Ships as PLUGIN (uncompiled, no engine rebuild). Reuses the council tunnel for generation and
// the exec sandbox for voting — no new provider plumbing, no key model (judges with the SAME
// local worker model that produced the code).

import os from 'node:os'
import path from 'node:path'
import { createTunnelRunner } from '../council/tunnel.mjs'
import {
  generateDraftSourcesDiverse, generateProbes, generateTraps,
  buildPrompts, extractModule, classDisplay,
  reviewConsensus, makeReasoner,
} from './selfreview-gen.mjs'
import { createExecRunner, makeExecDraft } from './selfreview-exec.mjs'
import { selfReview } from './selfreview-core.mjs'

// Default-ON. Only an explicit truthy disable flag turns it off.
export function selfReviewDisabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.OMEGA_SELF_REVIEW_DISABLE || '').trim())
}

const numEnv = (env, k, d) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : d }

// The draft id under which the model's ACTUAL workspace code is graded. A string so it can never collide with
// the numeric ids (0..n-1) of the re-derived drafts. The swap gate ships a re-derivation only when it strictly
// out-scores THIS entry on a certified oracle — so `raw` is the never-worse floor, exactly like the bench's draft#0.
const INCUMBENT_ID = 'raw'

// A usable function contract is the precondition for running at all. All three parts are required:
// `spec` (what to build), `fnName` (which export to vote on), and `signature` (so the draft prompt
// tells the model the exact arg shape — without it the prompt says "defines and exports undefined"
// and drafts vote on mismatched arities, silently producing garbage classes).
function hasFunctionContract(task) {
  return !!task && typeof task.spec === 'string' && task.spec.trim().length > 0 &&
    typeof task.fnName === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(task.fnName || '') &&
    typeof task.signature === 'string' && task.signature.trim().length > 0
}

// ---- v2 SWAP GATE (pure, deterministic, independently tested) --------------------------------------------
// The single decision that preserves Gate-1 (never worse than the model's ACTUAL code) while allowing an
// improvement. Given the core's finished review `r`, whether the incumbent was graded, the id->source map, and
// env, it returns whether to SWAP the model's code for a re-derived draft — and, if so, which source.
//
// A swap is emitted ONLY when ALL hold (checked in order; swapReason names the FIRST blocker):
//   • swap not disabled (OMEGA_SR_SWAP_DISABLE)
//   • the model's actual code was graded as a draft (the never-worse FLOOR exists)
//   • the winner rode a fully-CERTIFIED oracle: r.path==='SELECT' (zero fails across ALL resolved entries).
//     BOUND / REPAIR-* are never certified enough to overwrite the model.
//   • the winner is a DIFFERENT draft than the incumbent (something real to swap in)
//   • the CONSENSUS-resolved oracle is large enough to trust (OMEGA_SR_SWAP_MIN, default 5)
//   • the incumbent is docked ONLY on CONSENSUS flip-points — never on a reasoning-resolved split
//   • the winner STRICTLY out-scores the incumbent on the consensus oracle (ties => keep the model's code)
//   • no consensus flip-point was audit-flagged (type-B guard); the winner's source is present (defensive)
//
// WHY CONSENSUS-ONLY (the Gate-1 fix): the core resolves a split-vote input in TWO ways — strong ensemble
// CONSENSUS (trustworthy), or, when the drafts split, the model's step-by-step REASONING (fallible; the core itself
// says "reasoning can be wrong"). Both land in r.resolved. Counting a REASONING-resolved entry as certified truth
// would let a confidently-WRONG tie-break dock the incumbent on the very input where the incumbent was uniquely
// RIGHT — shipping worse-than-incumbent. And the type-B audit only ever inspects CONSENSUS entries, so it is
// structurally blind to that case. So the swap trusts consensus ONLY: reasoning entries can never count toward the
// evidence size, and if the incumbent's disagreement is on a reasoning-resolved input we ABSTAIN. Because
// path==='SELECT' means the winner already agrees every resolved entry (consensus AND reasoning), requiring the
// incumbent's fails to be consensus-only makes winner and incumbent EQUAL on every reasoning entry — so whether the
// reasoning was right or wrong, never-worse holds there by construction, and the measured improvement is purely on
// high-confidence consensus inputs.
export function decideSwap({ r, incumbentLoaded, srcById, env = process.env }) {
  const resolved = (r && r.resolved) || []
  // consensus is the only trustworthy certification base; reasoning-resolved splits are fallible + audit-unguarded
  const reasoningInputs = new Set(resolved.filter((e) => e && e.via !== 'consensus').map((e) => JSON.stringify(e.inp)))
  const consensusCount = resolved.filter((e) => e && e.via === 'consensus').length
  const SWAP_MIN = numEnv(env, 'OMEGA_SR_SWAP_MIN', 5)
  const swapOff = /^(1|true|yes|on)$/i.test(String(env.OMEGA_SR_SWAP_DISABLE || '').trim())
  const incEntry = incumbentLoaded ? ((r && r.scored) || []).find((s) => s && s.d && s.d.id === INCUMBENT_ID) : null
  const incFails = (incEntry && incEntry.fails) || []
  // scores reported on the CONSENSUS oracle (the swap's actual evidence base): winner passes all of it under SELECT.
  const certifiedSize = consensusCount
  const rawScore = incEntry ? consensusCount - incFails.filter((f) => !reasoningInputs.has(JSON.stringify(f.inp))).length : null
  const winnerScore = incEntry ? consensusCount : (r && r.best ? r.best.ok : null)
  const out = { swapEligible: false, selectedSource: null, selectedId: null, rawScore, winnerScore, certifiedSize, swapReason: '' }
  if (swapOff) { out.swapReason = 'swap-disabled'; return out }
  if (!incumbentLoaded || incEntry == null) { out.swapReason = 'no-incumbent-floor'; return out }
  if (!r || r.path !== 'SELECT') { out.swapReason = `oracle-uncertified(${r && r.path})`; return out }
  if (r.shipId === INCUMBENT_ID) { out.swapReason = 'incumbent-is-best'; return out }
  if (certifiedSize < SWAP_MIN) { out.swapReason = `oracle-too-small(consensus ${certifiedSize}<${SWAP_MIN})`; return out }
  // REASONING-SPLIT GUARD (the Gate-1 fix): if ANY incumbent flip-point is a reasoning-resolved entry, the incumbent
  // may actually be RIGHT there and the fallible tie-break WRONG — abstain rather than ship a possible regression.
  const reasonFail = incFails.find((f) => reasoningInputs.has(JSON.stringify(f.inp)))
  if (reasonFail) { out.swapReason = `incumbent-fails-on-reasoning-split(${JSON.stringify(reasonFail.inp)})`; return out }
  // after the guard, all incumbent fails are consensus entries => the improvement is measured purely on consensus.
  if (!(winnerScore > rawScore)) { out.swapReason = `no-improvement(consensus ${rawScore}/${consensusCount})`; return out }
  // TYPE-B GUARD (zero extra model calls). A swap only changes behavior on the inputs where the incumbent
  // disagrees with the certified oracle — i.e. incFails (all consensus now). If the core's shared-blind-spot AUDIT
  // independently flagged ANY of those flip-point inputs as a suspected FALSE consensus (its step-by-step reasoning
  // disagreed with the unanimous ensemble there), then the winner's "improvement" on that input is exactly what our
  // own audit distrusts. Withhold the swap and keep the model's code. This is a BEST-EFFORT reduction of the residual
  // consensus blind-spot (model uniquely right, ensemble uniformly wrong): it only fires when the audit independently
  // NOMINATED that exact flip-point. A uniformly-shared false consensus the audit never nominates can still ship — an
  // ACCEPTED, documented tradeoff (see selfreview-core auditConsensus), not a closed hole. Uses signal the core already computed.
  const flipInputs = new Set(incFails.map((f) => JSON.stringify(f.inp)))
  const auditHit = ((r.findings) || []).find((f) => flipInputs.has(JSON.stringify(f.inp)))
  if (auditHit) { out.swapReason = `audit-flagged-flippoint(${JSON.stringify(auditHit.inp)})`; return out }
  if (!srcById || !srcById.has(r.shipId)) { out.swapReason = 'winner-source-missing'; return out }
  out.swapEligible = true
  out.selectedId = r.shipId
  out.selectedSource = srcById.get(r.shipId)
  out.swapReason = `swap:draft#${r.shipId} beats raw ${winnerScore}>${rawScore} on ${certifiedSize} consensus-certified inputs`
  return out
}

// ANALYSIS + CONFIDENCE-GATED SELECT (v2). Runs the proven diverse-gen+exec+core+audit stack on the LOCAL
// worker model. Returns BOTH an advisory signal AND — when the model's actual code is supplied as
// `incumbentSource` — a swap decision the seam can act on.
//
// GATE-1 (never worse than the model's actual code) IS PRESERVED BY THE SWAP CONDITION, not by refusing to
// swap. The model's real code is graded as one draft in the pool (the never-worse FLOOR). A swap is emitted
// ONLY when a DIFFERENT draft (a) fully satisfies a reasoning-certified oracle (path===SELECT, zero fails) AND
// (b) strictly out-scores the incumbent on that oracle — i.e. the incumbent provably disagrees with a certified
// consensus that the winner fully satisfies. When the incumbent drives the consensus, or the oracle is
// uncertified/split/too small, no swap is emitted and the model's code is kept (v1 advise-only behavior). This
// is the same construction the bench proved never-worse (roman+semver, 0 regressions), tightened by the extra
// "beat the incumbent" requirement. When `incumbentSource` is absent (seam could not extract the model's real
// function) the never-worse floor cannot be established, so swapEligible is always false — advise-only.
//
//   ctx            : { directory, sessionID?, abort? } — the workspace + optional abort signal (tunnel scope)
//   task           : { spec, fnName, signature?, resultDesc?, argHint? } — the function contract
//   modelSpec      : "provider/model" of the local worker (e.g. "evo/qwen3-coder-80b") — judges own work
//   incumbentSource: string? — the model's ACTUAL function source from the workspace; graded as the never-worse
//                    floor. Omit to run advise-only (no swap possible).
export async function reviewCodeArtifact({ ctx, task, modelSpec, incumbentSource = null, env = process.env, opts = {}, onEvent = () => {} }) {
  if (selfReviewDisabled(env)) return { ran: false, reason: 'disabled', findings: [], advisory: null, swapEligible: false }
  if (!hasFunctionContract(task)) return { ran: false, reason: 'no-contract', findings: [], advisory: null, swapEligible: false }
  if (!modelSpec || typeof modelSpec !== 'string') return { ran: false, reason: 'no-model-spec', findings: [], advisory: null, swapEligible: false }

  const NCODE = numEnv(env, 'OMEGA_SR_NCODE', 5)
  const NTEST = numEnv(env, 'OMEGA_SR_NTEST', 4)
  const NTRAP = numEnv(env, 'OMEGA_SR_NTRAP', 2)
  const KREASON = numEnv(env, 'OMEGA_SR_KREASON', 5)
  const FN = task.fnName

  // TUNNEL: N INDEPENDENT direct calls to the SAME local worker model (withTools:false = pure
  // generate-only, so drafts re-derive from spec instead of peeking at the workspace). Honest
  // failure ({error}) on empty/timeout is already treated as a lost draft by the mechanism.
  const callMember = createTunnelRunner(ctx || {}, { withTools: false, env })
  const member = { model: modelSpec, label: 'self-review' }
  const callModel = ({ system, prompt }) => callMember(member, { system, prompt })

  // STEP 1: blind drafts + adversarial probes + trap nominations — ALL model calls, wrapped together so
  // any generation failure (drafts, probes, OR traps) degrades to an honest not-run instead of throwing
  // out of the plugin. (Traps were previously outside the try — an unhandled traps rejection escaped.)
  let draftSources, probes, trapInputs = []
  try {
    const [ds, probes0] = await Promise.all([
      generateDraftSourcesDiverse(callModel, task, NCODE),
      generateProbes(callModel, task, NTEST),
    ])
    draftSources = ds
    const traps = await generateTraps(callModel, task, NTRAP)
    trapInputs = traps.filter((t) => typeof t === 'string')
    probes = probes0.slice()
    const seen = new Set(probes.map((p) => JSON.stringify(p)))
    for (const t of traps) { const k = JSON.stringify(t); if (!seen.has(k)) { seen.add(k); probes.push(t) } }
  } catch (e) {
    return { ran: false, reason: 'generation-error', error: String((e && e.message) || e), findings: [], advisory: null }
  }
  if (draftSources.length < 2 || probes.length < 2) {
    return { ran: false, reason: 'insufficient-generation', draftCount: draftSources.length, probeCount: probes.length, findings: [], advisory: null }
  }

  // STEP 1.5 onward runs the exec sandbox + core. UNIQUE scratch dir per invocation (pid+session+nonce)
  // so two reviews sharing a session never overwrite each other's draft files, and the finally-block
  // ALWAYS removes the dir — no scratch leak even on an exec/review error or an early return.
  const tmpDir = path.join(
    os.tmpdir(),
    `omega-selfreview-${process.pid}-${(ctx && ctx.sessionID) || 'x'}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  )
  let runner = null
  try {
    // Exec-containment setup does host filesystem I/O (mkdir + write the runner) that can throw
    // (ENOSPC/EACCES) — contain it so a disk problem degrades to not-run rather than escaping the plugin.
    let drafts, srcById
    let incumbentLoaded = false
    try {
      runner = createExecRunner({ tmpDir, timeoutMs: numEnv(env, 'OMEGA_SR_EXEC_MS', 5000), exportName: FN })
      srcById = new Map(draftSources.map((d) => [d.id, d.source]))
      const execDrafts = await Promise.all(draftSources.map((d) => makeExecDraft(runner, d.id, d.source, probes, { exportName: FN })))
      drafts = execDrafts.filter((d) => d.loaded)
      // Grade the model's ACTUAL code as one more draft (the never-worse FLOOR). It votes in the consensus
      // exactly like a re-derivation, and its oracle score is the bar a swap must strictly clear. If it fails to
      // load in the voting harness (e.g. it isn't a self-contained single function) we cannot certify a
      // never-worse swap against it -> incumbentLoaded stays false -> advise-only, code kept untouched.
      if (typeof incumbentSource === 'string' && incumbentSource.trim()) {
        srcById.set(INCUMBENT_ID, incumbentSource)
        const inc = await makeExecDraft(runner, INCUMBENT_ID, incumbentSource, probes, { exportName: FN })
        if (inc.loaded) { drafts.push(inc); incumbentLoaded = true }
      }
    } catch (e) {
      return { ran: false, reason: 'exec-setup-error', error: String((e && e.message) || e), findings: [], advisory: null, swapEligible: false }
    }
    if (drafts.length < 2) return { ran: false, reason: 'insufficient-loaded-drafts', loaded: drafts.length, findings: [], advisory: null, swapEligible: false }

    async function repairDraft(bestId, failCases) {
      const { sys, user } = buildPrompts(task).repair(srcById.get(bestId), failCases)
      const r = await callModel({ system: sys, prompt: user })
      if (!r || r.error || !r.text) return null
      const d = await makeExecDraft(runner, `repair-${bestId}`, extractModule(r.text, FN), probes, { exportName: FN })
      return d.loaded ? { run: d.run } : null
    }

    // STEP 2-3-2.5: drive the core WITH the grounded-review audit enabled (PRIMARY pointer) and the
    // blind trap-nominator as SECONDARY. Findings are advisory only.
    const events = []
    let r
    try {
      r = await selfReview({
        drafts, probes, trapInputs,
        reviewConsensus: reviewConsensus(callModel, task),
        resolveByReason: makeReasoner(callModel, task, KREASON),
        repairDraft,
        opts: { consensusFrac: 0.7, reasonCap: 8, kreason: KREASON, reasonFrac: 0.8, trapCap: numEnv(env, 'OMEGA_SR_TRAPCAP', 12), ...(opts || {}) },
        onEvent: (e) => { events.push(e); try { onEvent(e) } catch {} },
      })
    } catch (e) {
      return { ran: false, reason: 'review-error', error: String((e && e.message) || e), findings: [], advisory: null, swapEligible: false }
    }

    // GATE (honesty): an empty oracle means the vote verified NOTHING — e.g. numeric/array/multi-arg inputs
    // the core's string-keyed dedupe drops, leaving no consensus entries. Report as not-run instead of a
    // misleading confident:true with consensusSize:0. This marks the v1 string-argument scope boundary,
    // not a certification. (Generalizing dedupe to non-strings is deferred — it needs the proven core re-proved.)
    if (!r.oracle || r.oracle.length === 0) {
      return { ran: false, reason: 'no-verifiable-consensus', findings: [], advisory: null, swapEligible: false }
    }

    // ---- v2 CONFIDENCE-GATED SWAP DECISION (all safety lives in the pure, independently-tested decideSwap) ----
    const sw = decideSwap({ r, incumbentLoaded, srcById, env })
    onEvent({ type: 'swap_decision', swapEligible: sw.swapEligible, selectedId: sw.selectedId, rawScore: sw.rawScore, winnerScore: sw.winnerScore, certified: sw.certifiedSize, path: r.path, reason: sw.swapReason })

    const advisory = buildAdvisory(r, FN)
    return {
      ran: true,
      reason: 'ok',
      findings: r.findings,
      boundFlags: r.boundFlags,
      shipPath: r.path,          // SELECT | REPAIR-CLEAN | BOUND — the ensemble's own ship path (informational)
      confident: r.confident,
      consensusSize: r.oracle.length,
      certifiedSize: sw.certifiedSize, // # of reasoning-certified oracle entries (the swap evidence base)
      splits: r.splits,
      reviewFlagged: r.reviewFlagged,
      advisory,                  // plain-English signal for the seam (null when nothing to say)
      oracle: r.oracle,          // [{inp, cls, resolved, via}] — the ensemble's per-input answers (informational)
      // ---- v2 swap decision (seam acts on this; all safety already applied) ----
      swapEligible: sw.swapEligible, // true => the seam MAY overwrite the model's code with selectedSource
      selectedSource: sw.selectedSource, // winning draft's full module source (null unless swapEligible)
      selectedId: sw.selectedId,     // winning draft id (null unless swapEligible)
      rawScore: sw.rawScore,         // incumbent agreements on certified oracle (null if not graded)
      winnerScore: sw.winnerScore,   // winner agreements on certified oracle
      swapReason: sw.swapReason,     // why swap fired / was withheld (observability)
      events,
    }
  } finally {
    if (runner) runner.cleanup()
  }
}

// v1 advisory: strictly additive plain-English signal. Never mutates code. Frames each finding as a
// DISAGREEMENT worth a spec re-check — NOT a verdict. (Neither side is authoritative: the ensemble's
// unanimous answer could be a shared blind spot, or the step-by-step reasoning could itself be wrong.
// The signal's value is surfacing that the two disagree, so a human decides which matches the spec.)
function buildAdvisory(r, FN) {
  const lines = []
  if (r.findings && r.findings.length) {
    lines.push(`Self-review (advisory): on ${r.findings.length} input(s), an independent ensemble of ${FN} implementations agreed on one answer while the model's own step-by-step reasoning reached a DIFFERENT answer. Either could be wrong — this flags a disagreement to reconcile against the spec, not a verdict:`)
    for (const f of r.findings) {
      lines.push(`  • input ${JSON.stringify(f.inp)}: ensemble → ${classDisplay(f.consensusCls)}; reasoning → ${classDisplay(f.reasonCls)}. Confirm which matches the spec.`)
    }
  }
  if (r.boundFlags) {
    lines.push(`Self-review could not certify ${r.boundFlags} input(s) (the ensemble split and reasoning was inconclusive) — treat those cases as unverified.`)
  }
  return lines.length ? lines.join('\n') : null
}
