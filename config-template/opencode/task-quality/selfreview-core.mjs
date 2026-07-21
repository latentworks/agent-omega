// selfreview-core.mjs — engine-agnostic ensemble self-review CORE (steps 1-3 of the proven bench mechanism).
//
// PROBLEM (as a system):
//   A single language model that CODES a tricky spec tends to make the SAME small mistake on a trap edge
//   across independent samples (the samples share a systematic blind spot). A naive "vote of N drafts" then
//   agrees on the WRONG answer and ships it confidently — worse than the model's own best single try, because
//   the majority poisons the oracle. This is the "consistent-but-wrong" failure the review/audit levers could
//   not crack: the buggy artifact is internally coherent, so no property check catches it.
//
// THE MECHANISM (why this cracks it):
//   Exploit the gap between how well the model REASONS about a concrete input vs how well it CODES the general
//   case. (1) Generate N independent code drafts AND N ADVERSARIAL test suites in parallel — the adversarial
//   test-writer is the load-bearing lever: it is prompted to enumerate what the rules make INVALID and hunt the
//   corners a lazy implementation silently mishandles, which GUARANTEES the trap edge is probed. (2) On each
//   probe input, tally the drafts' outputs. Strong agreement => trust it (oracle entry). A SPLIT (no strong
//   majority) means the drafts genuinely disagree there — exactly the trap edges — so resolve THAT input by
//   asking the model to REASON it out step by step from the spec (K votes); a strong reasoning majority resolves
//   the oracle entry, otherwise it is carried as an HONEST BOUND (uncertain), never guessed. (3) Score every
//   draft against the resolved oracle and SELECT the best; if the best still disagrees on some resolved inputs,
//   attempt a general REPAIR and keep it only if it agrees more. Ship the selected/repaired draft.
//
// GATE-1 INVARIANT (never worse than raw): the shipped artifact is ALWAYS either one of the model's own drafts
//   or a repair that out-agrees the best draft on the oracle. So in the worst case it equals the model's best
//   single try — it can never ship something worse than the raw model would have. When reasoning ALSO shares the
//   blind spot, splits stay unresolved and degrade to honest BOUND flags rather than confident-wrong.
//
// ISOLATION / PURITY: this module has NO opencode, NO network, NO fs, NO child_process. Every model-facing or
//   code-running operation is a dependency-injected async callback (drafts[].run, resolveByReason, repairDraft).
//   That is what lets it be unit-proven with deterministic fakes AND behavior-proven by routing the real local
//   model through the same code. The plugin wrapper (self-review.mjs) supplies the real callbacks + the env gate.
//
// All values flow as opaque "output-class" STRINGS (e.g. "n:5400", "null", "throw"): the core never inspects a
// real return value, only class-equality, so it is fully task-agnostic.

export const DEFAULT_OPTS = Object.freeze({
  consensusFrac: 0.7, // fraction of loaded drafts that must agree for a STRONG (trusted-without-reasoning) entry
  reasonCap: 8, // max number of SPLIT inputs we spend reasoning votes on (budget guard)
  kreason: 5, // reasoning votes cast per split input
  reasonFrac: 0.8, // fraction of reasoning votes that must agree to RESOLVE a split (else honest BOUND)
  trapCap: 12, // max trap-nominated STRONG-consensus inputs we reason-audit for a shared blind spot (budget guard)
})

// dedupe preserving first-seen order
function dedupe(items) {
  const seen = new Set()
  const out = []
  for (const it of items) {
    if (typeof it !== 'string' || !it) continue
    if (seen.has(it)) continue
    seen.add(it)
    out.push(it)
  }
  return out
}

// most-frequent (class, count) in a tally object; deterministic tiebreak by class string so runs are reproducible
function topOf(tally) {
  const entries = Object.entries(tally)
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return entries[0] // [class, count]
}

/**
 * STEP 1.5 + 2: build the resolved oracle from drafts + probes.
 * @param drafts  Array<{ id, run: (input)=>string|Promise<string> }>  run() returns an output-CLASS string
 * @param probes  string[]  candidate probe inputs (raw; will be de-duped here)
 * @param isTrap  (input)=>boolean  classifies "trap-shaped" inputs (coverage metric + prioritises them under the cap)
 * @param resolveByReason  async (input)=>{ cls, votes }  reasoning resolver for ONE split input; cls is an
 *        output-class string or null/'??' when reasoning could not converge (=> honest BOUND)
 * @param opts  see DEFAULT_OPTS
 * @param onEvent  optional (evt)=>void  progress/telemetry sink (never affects logic)
 */
export async function buildOracle({ drafts, probes, isTrap = () => false, resolveByReason, opts = {}, onEvent = () => {} }) {
  const o = { ...DEFAULT_OPTS, ...opts }
  const loaded = drafts.filter((d) => d && typeof d.run === 'function')
  if (loaded.length < 2) throw new Error(`buildOracle: need >=2 loaded drafts, got ${loaded.length}`)
  let uniq = dedupe(probes)
  const trapCov = uniq.filter((p) => { try { return !!isTrap(p) } catch { return false } }).length
  // probe the trap-shaped inputs FIRST so the reasoning budget (reasonCap) is spent where drafts most likely split
  uniq = uniq.slice().sort((x, y) => (isTrap(y) ? 1 : 0) - (isTrap(x) ? 1 : 0))

  const need = Math.ceil(loaded.length * o.consensusFrac)
  const oracle = []
  let splits = 0
  let reasoned = 0
  let unresolved = 0
  for (const inp of uniq) {
    const tally = {}
    for (const d of loaded) {
      const c = await d.run(inp)
      tally[c] = (tally[c] || 0) + 1
    }
    const [topC, topN] = topOf(tally)
    if (topN >= need) {
      oracle.push({ inp, cls: topC, resolved: true, via: 'consensus' })
      continue
    }
    // genuine disagreement => a candidate trap edge
    splits++
    if (reasoned >= o.reasonCap) {
      oracle.push({ inp, cls: null, resolved: false, via: 'bound-capped', tally })
      unresolved++
      onEvent({ type: 'split_bound_capped', inp, tally })
      continue
    }
    reasoned++
    const { cls: rC, votes } = await resolveByReason(inp)
    const rN = votes && rC != null ? (votes[rC] || 0) : 0
    const rNeed = Math.ceil(o.kreason * o.reasonFrac)
    if (rC != null && rC !== '??' && rN >= rNeed) {
      oracle.push({ inp, cls: rC, resolved: true, via: 'reasoning', tally, votes })
      onEvent({ type: 'split_resolved', inp, tally, cls: rC, rN, kreason: o.kreason })
    } else {
      oracle.push({ inp, cls: null, resolved: false, via: 'bound-unconverged', tally, votes })
      unresolved++
      onEvent({ type: 'split_bound', inp, tally, votes })
    }
  }
  const resolved = oracle.filter((e) => e.resolved)
  return { loaded, oracle, resolved, splits, reasoned, unresolved, trapCov, probeCount: uniq.length }
}

/**
 * STEP 3: score drafts against the resolved oracle, select the best, optionally repair.
 * @param loaded  drafts that loaded (from buildOracle result)
 * @param resolved  resolved oracle entries [{inp, cls}]
 * @param repairDraft  optional async (draftId, failCases:[{inp,cls}]) => { run } | null
 * @param onEvent optional telemetry sink
 */
export async function selectAndRepair({ loaded, resolved, repairDraft = null, onEvent = () => {} }) {
  async function agree(run) {
    let ok = 0
    const fails = []
    for (const e of resolved) {
      const got = await run(e.inp)
      if (got === e.cls) ok++
      else fails.push({ inp: e.inp, cls: e.cls, got })
    }
    return { ok, fails }
  }
  const scored = []
  for (const d of loaded) scored.push({ d, ...(await agree(d.run)) })
  // best by oracle agreement; deterministic tiebreak by draft id
  scored.sort((a, b) => b.ok - a.ok || (String(a.d.id) < String(b.d.id) ? -1 : 1))
  const best = scored[0]
  onEvent({ type: 'select', draftId: best.d.id, ok: best.ok, of: resolved.length })

  let shippedRun = best.d.run
  let shipId = best.d.id
  let shipTag = `select#${best.d.id}`
  let path = 'SELECT'
  let boundFails = best.fails

  if (best.fails.length > 0 && typeof repairDraft === 'function') {
    const repaired = await repairDraft(best.d.id, best.fails.slice(0, 8))
    if (repaired && typeof repaired.run === 'function') {
      const ag = await agree(repaired.run)
      onEvent({ type: 'repair', draftId: best.d.id, ok: ag.ok, was: best.ok, of: resolved.length })
      if (ag.ok > best.ok) {
        shippedRun = repaired.run
        shipTag = `repair#${best.d.id}`
        shipId = `repair#${best.d.id}`
        path = ag.fails.length === 0 ? 'REPAIR-CLEAN' : 'REPAIR-PARTIAL(BOUND)'
        boundFails = ag.fails
      } else {
        path = 'SELECT-BEST(BOUND)'
      }
    } else {
      onEvent({ type: 'repair_loadfail', draftId: best.d.id })
      path = 'SELECT-BEST(BOUND)'
    }
  } else if (best.fails.length > 0) {
    // no repair callback supplied: ship the best draft, carry its disagreements as bounds
    path = 'SELECT-BEST(BOUND)'
  }
  return { scored, best, shippedRun, shipId, shipTag, path, boundFails }
}

/**
 * STEP 2.5 (SHARED-BLIND-SPOT AUDIT): buildOracle trusts STRONG consensus WITHOUT reasoning. That is safe when the
 * drafts DIVERGE on a trap (=> split => reasoned => resolved), but a blind spot UNIFORMLY SHARED by every draft
 * produces a FALSE consensus that no split ever surfaces. Proven live: isValidIPv4 — all 5 drafts accept
 * '256.1.1.1', zero splits, ships the shared bug uncaught (still never-worse, but no better). The pivotal probe
 * (reason-probe-ipv4, 10/10) showed the model's step-by-step REASONING knows these answers though its CODE all got
 * them wrong, AND does NOT wrongly flag correct consensus (0 false alarms on the valid controls). So: take the
 * adversarial nominator's TRAP inputs that landed in STRONG consensus and reason each out from the spec; a CONFIDENT
 * reasoning answer that DISAGREES with the unanimous drafts is a suspected shared blind spot => emit a FINDING.
 *
 * SAFETY (why this keeps Gate-1 exactly): findings do NOT mutate the oracle, the scores, or the ship decision. The
 * core still ships the best real draft / strictly-better repair — strictly never-worse, unchanged proof. A finding
 * is an ADDITIVE advisory handed to the model (via the plugin's existing review channel) to RECONSIDER one input,
 * with full task context and its own verification; acting on it is delegated, gated and reversible. Letting a
 * confident finding drive an oracle-correction + repair is a real never-worse TRADEOFF (reasoning can be wrong) and
 * is deferred to v2 post-dogfood — to be surfaced to Austin, never taken silently.
 *
 * @param oracle  the built oracle entries (from buildOracle) — READ ONLY here
 * @param trapInputs  string[]  inputs a naive impl most likely gets wrong (BLIND nominator; weaker pointer)
 * @param reviewConsensus  optional async (pairs:[{inp,cls}]) => string[]  GROUNDED review of the drafts' unanimous
 *        outputs; returns the inputs whose output violates the spec (stronger pointer — engages evaluative mode)
 * @param resolveByReason  async (input)=>{ cls, votes }  the SAME reasoner used for splits
 * @param opts  see DEFAULT_OPTS (uses kreason, reasonFrac, trapCap)
 */
export async function auditConsensus({ oracle, trapInputs = [], reviewConsensus = null, resolveByReason, opts = {}, onEvent = () => {} }) {
  const o = { ...DEFAULT_OPTS, ...opts }
  const findings = []
  // entries trusted purely by STRONG consensus (never reasoned yet) — the only place a shared blind spot can hide.
  const consensusEntries = oracle.filter((e) => e.resolved && e.via === 'consensus')

  // Candidate inputs to reason-audit come from TWO pointers at a shared blind spot:
  //   (1) trapInputs — the adversarial nominator's BLIND guesses at what a naive impl gets wrong; and
  //   (2) reviewConsensus — a GROUNDED review that reads the drafts' actual UNANIMOUS (input->output) answers and
  //       flags the ones that violate the spec.
  // (2) is the stronger pointer and the reason this function was reshaped: live proof (fs-ipv4-audit-2/3) showed the
  // blind nominator inherits the coder's OWN blind spot — the same model, in generative "list likely-wrong inputs"
  // mode, does not think to name the input it itself gets wrong (ceiling 0: none of 47 nominations were real blind
  // spots, while the drafts DID share 256.x/999.x misses that were never nominated). Reviewing the CONCRETE output
  // instead engages the model's evaluative/reasoning mode, which the pivotal probe (reason-probe-ipv4, 10/10) showed
  // does know the answers the code got wrong. reviewConsensus is injected (task-aware rendering lives in the gen
  // layer); the core still only passes opaque (inp, cls) pairs and receives back input strings, staying task-agnostic.
  const reviewSet = new Set()
  let reviewFlagged = 0
  if (typeof reviewConsensus === 'function' && consensusEntries.length) {
    try {
      const sus = await reviewConsensus(consensusEntries.map((e) => ({ inp: e.inp, cls: e.cls })))
      if (Array.isArray(sus)) for (const s of sus) if (typeof s === 'string') reviewSet.add(s)
      reviewFlagged = reviewSet.size
      onEvent({ type: 'consensus_reviewed', of: consensusEntries.length, flagged: reviewFlagged })
    } catch (err) { onEvent({ type: 'review_error', error: String((err && err.message) || err) }) }
  }
  const trapSet = new Set(dedupe(trapInputs))
  const flagged = new Set([...reviewSet, ...trapSet])
  if (flagged.size === 0 || typeof resolveByReason !== 'function') {
    return { findings, audited: 0, trapConsensus: 0, reviewFlagged }
  }
  // Audit the flagged strong-consensus entries; spend the (capped) reasoning budget on the GROUNDED-review flags
  // first, since blind nominations are the weaker pointer.
  const targets = consensusEntries
    .filter((e) => flagged.has(e.inp))
    .sort((a, b) => (reviewSet.has(b.inp) ? 1 : 0) - (reviewSet.has(a.inp) ? 1 : 0))
  const rNeed = Math.ceil(o.kreason * o.reasonFrac)
  let audited = 0
  for (const e of targets) {
    if (audited >= o.trapCap) { onEvent({ type: 'audit_capped', at: audited, of: targets.length }); break }
    audited++
    const { cls: rC, votes } = await resolveByReason(e.inp)
    const rN = votes && rC != null ? (votes[rC] || 0) : 0
    if (rC != null && rC !== '??' && rN >= rNeed && rC !== e.cls) {
      // confident reasoning disagrees with the unanimous drafts => suspected shared blind spot
      findings.push({ inp: e.inp, consensusCls: e.cls, reasonCls: rC, rN, kreason: o.kreason, votes, pointer: reviewSet.has(e.inp) ? 'review' : 'nominator' })
      onEvent({ type: 'blindspot_finding', inp: e.inp, consensusCls: e.cls, reasonCls: rC, rN })
    } else {
      onEvent({ type: 'audit_confirmed', inp: e.inp, cls: e.cls, reasonCls: rC, rN })
    }
  }
  return { findings, audited, trapConsensus: targets.length, reviewFlagged }
}

/**
 * Full pipeline: buildOracle -> selectAndRepair -> (optional) auditConsensus. Returns the ship decision plus all
 * diagnostics. The caller is responsible for having already GENERATED drafts + probes via the model (injected).
 * Pass cfg.trapInputs (+ cfg.resolveByReason) to enable the shared-blind-spot audit; omit for the base mechanism.
 */
export async function selfReview(cfg) {
  const oracleR = await buildOracle(cfg)
  const shipR = await selectAndRepair({
    loaded: oracleR.loaded,
    resolved: oracleR.resolved,
    repairDraft: cfg.repairDraft || null,
    onEvent: cfg.onEvent || (() => {}),
  })
  let auditR = { findings: [], audited: 0, trapConsensus: 0, reviewFlagged: 0 }
  const auditEnabled =
    ((cfg.trapInputs && cfg.trapInputs.length) || typeof cfg.reviewConsensus === 'function') &&
    typeof cfg.resolveByReason === 'function'
  if (auditEnabled) {
    auditR = await auditConsensus({
      oracle: oracleR.oracle,
      trapInputs: cfg.trapInputs || [],
      reviewConsensus: cfg.reviewConsensus || null,
      resolveByReason: cfg.resolveByReason,
      opts: cfg.opts || {},
      onEvent: cfg.onEvent || (() => {}),
    })
  }
  return {
    ...oracleR,
    ...shipR,
    findings: auditR.findings, // suspected shared blind spots (advisory; ship decision NOT affected)
    audited: auditR.audited,
    trapConsensus: auditR.trapConsensus,
    reviewFlagged: auditR.reviewFlagged,
    boundFlags: oracleR.unresolved, // count of inputs self-review honestly could not certify
    // Gate-1: shipped is always a real draft or a strictly-better repair => never worse than the raw best draft.
    confident: shipR.path === 'SELECT' || shipR.path === 'REPAIR-CLEAN',
  }
}
