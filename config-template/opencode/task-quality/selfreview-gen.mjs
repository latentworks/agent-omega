// selfreview-gen.mjs — TASK-AGNOSTIC generation + parsing layer for ensemble self-review.
//
// PROBLEM (as a system): the bench proof hardcoded parseDuration-specific prompts (and even named the trap
// families: ordering / duplicate / leading-zero). The real product never knows the task in advance — it gets an
// arbitrary contract. The proven lever (probe-coverage 2×2) was that the adversarial test-writer's FRAMING —
// "enumerate what the rules make invalid, then build inputs that discriminate a correct impl from a naive one" —
// is what guarantees trap coverage, NOT the task-specific example bullets. So this layer keeps that framing and
// parameterises it by (spec, signature) only; it names NO task-specific traps.
//
// The model call is INJECTED (callModel({system,prompt}) -> {text?|error?}, the exact council tunnel contract),
// so this layer is pure prompt-building + response-parsing and can be driven by council (product) or direct fetch
// (proof) identically. Draft SOURCES are produced here; turning them into runnable voters is the exec runner's job.
//
// outClass here MUST stay byte-identical to the copy embedded in selfreview-exec.mjs RUNNER_SRC — the reasoning
// resolver's class must be comparable to the executed drafts' classes. Change one, change both.

export function outClass(v) {
  if (v === null) return 'null'
  if (v === undefined) return 'undef'
  if (typeof v === 'number') return Number.isFinite(v) ? ('n:' + v) : ('n:' + String(v))
  if (typeof v === 'string') return 's:' + v
  if (typeof v === 'boolean') return 'b:' + v
  try { return 'j:' + JSON.stringify(v) } catch { return 'nonser' }
}

// Parse the model's step-by-step reasoning: take the LAST non-empty line, strip markdown, JSON.parse it, classify.
// Generalised from the proof's number/null-only parser to any JSON return value.
export function parseReasonFinal(text) {
  const lines = String(text || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    let s = lines[i].replace(/^`+|`+$/g, '').replace(/^\*+|\*+$/g, '').trim()
    if (/^null$/i.test(s)) return 'null'
    if (/^undefined$/i.test(s)) return 'undef'
    // try to isolate a trailing JSON scalar/array/object on the line
    const m = s.match(/(-?\d+(?:\.\d+)?|true|false|null|"[^"]*"|\[[\s\S]*\]|\{[\s\S]*\})\s*$/i)
    if (m) { try { return outClass(JSON.parse(m[1])) } catch {} }
    try { return outClass(JSON.parse(s)) } catch {}
  }
  return '??'
}

// Pull a self-contained ES module out of a model response (handles code fences / prose preamble). If the module
// defines fnName but doesn't export it, append an export so the exec runner can import it.
export function extractModule(content, fnName) {
  let c = String(content || '')
  const fence = c.match(/```(?:[a-zA-Z]*)?\s*\n([\s\S]*?)```/)
  if (fence) c = fence[1]
  else {
    const marks = ['/*', '//', 'export ', 'function ', 'const ', 'let ', 'class ']
    let idx = -1
    for (const m of marks) { const i = c.indexOf(m); if (i >= 0 && (idx < 0 || i < idx)) idx = i }
    if (idx > 0) c = c.slice(idx)
  }
  if (fnName && !/export\s/.test(c) && new RegExp(`\\b${fnName}\\b`).test(c)) c += `\nexport { ${fnName} }\n`
  return c
}

// Parse the adversarial test-writer's JSON array of probe inputs. Tolerates the model wrapping each input in an
// object with a common key (e.g. [{"input":"256.1.1.1"},...]) by unwrapping to the scalar input.
export function parseProbeInputs(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const a = JSON.parse(m[0])
    if (!Array.isArray(a)) return []
    return a.map((x) => {
      if (x !== null && typeof x === 'object' && !Array.isArray(x)) {
        for (const k of ['input', 'in', 'value', 'arg', 'args', 's']) if (k in x) return x[k]
      }
      return x
    })
  } catch { return [] }
}

// The proven nudge (task-agnostic): enumerate invalid categories + structural edges BEFORE implementing.
const NUDGE = `Honor the spec's validity boundary exactly. When a task defines what makes input valid, first enumerate — before implementing — every category the rules make invalid (which must return the failure value) and every structural edge they imply: boundaries, ordering, repetition, optional parts, and any stray or extra content anywhere in the input. Then handle each exactly as specified — no stricter, no looser. Silently accepting input the spec says is invalid is as much a defect as rejecting input it says is valid.`

/**
 * Build every prompt the mechanism needs, parameterised ONLY by the task descriptor.
 * taskDesc = { spec, signature, fnName, resultDesc, argHint? }
 */
export function buildPrompts(taskDesc) {
  const { spec, signature, fnName, resultDesc = 'the specified result', argHint } = taskDesc
  const codeOnly = `Respond with ONLY a single self-contained ES module that defines and exports ${signature}. No prose, no markdown code fences, no commentary outside the module.`
  const argLine = argHint || `Each test element is the argument to ${fnName} (use an array element like [a, b] if it takes several arguments).`
  return {
    codeSys: `You are a careful JavaScript engineer. ${codeOnly} Keep the module concise; think through edge cases silently and output only the finished code.\n\n${NUDGE}`,
    codeUser: `Specification:\n${spec}\n\nImplement and export \`${signature}\` exactly per this specification.`,
    testSys: 'You are a ruthless adversarial test engineer. You design inputs that DISTINGUISH a correct implementation from a plausible-but-naive one — you hunt the corners where a lazy implementation silently returns the wrong answer.',
    testUser: `Specification:\n${spec}\n\nDesign a test suite of INPUT VALUES for ${signature} built to CATCH a naive implementation. First enumerate every category the rules make INVALID and every structural edge they imply; then for EACH rule include multiple inputs whose correct answer depends on handling that rule precisely — especially boundaries, ordering, repetition, optional/empty parts, and stray or extra content. Make the correct answers genuinely discriminating between a correct and a naive implementation. ${argLine} Output ONLY a JSON array of inputs; aim for at least 30. No prose, JSON only.`,
    reasonSys: 'You are a careful engineer computing a function result strictly from its specification. Do not use prior knowledge that conflicts with the spec.',
    reasonUser: (input) => `Specification:\n${spec}\n\nCompute \`${fnName}(${JSON.stringify(input)})\` strictly per the spec. Reason step by step through each rule and every relevant edge. On the FINAL line output EXACTLY the return value as JSON (e.g. a number, a string in quotes, an array, or the word null). Nothing else on that final line.`,
    repair: (source, failCases) => {
      const cases = failCases.map((o, k) => `${k + 1}. ${fnName}(${JSON.stringify(o.inp)}) must return ${o.cls === 'null' ? 'null' : o.cls.replace(/^[a-z]+:/, '')} (the impl returned ${o.got === 'null' ? 'null' : o.got.replace(/^[a-z]+:/, '')}).`).join('\n')
      return {
        sys: `You are a careful JavaScript engineer. ${codeOnly}`,
        user: `Specification:\n${spec}\n\nHere is an implementation of ${fnName}:\n\n${source}\n\nIt returns the WRONG result for these cases:\n${cases}\n\nDiagnose the underlying bug and fix the GENERAL logic (do not special-case these inputs). Respond with ONLY the corrected self-contained ES module exporting ${fnName}.`,
      }
    },
  }
}

// ---- thin model-facing helpers (inject callModel) ----

// Generate N draft SOURCES in parallel (honest per-call failure -> that slot is dropped).
export async function generateDraftSources(callModel, taskDesc, n) {
  const p = buildPrompts(taskDesc)
  const results = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const r = await callModel({ system: p.codeSys, prompt: p.codeUser })
    if (!r || r.error || !r.text) return null
    return { id: i, source: extractModule(r.text, taskDesc.fnName) }
  }))
  return results.filter(Boolean)
}

// DIVERSITY LEVER framings — the PROVEN ceiling-raiser (SELF_REVIEW.md "Diversity"). Each pushes a DIFFERENT
// failure-mode focus so independent drafts are unlikely to share the SAME blind spot -> a correct answer more
// often EXISTS in the pool for the selector to find. Task-agnostic (spec knowledge stays with the model); applies
// to any validation/parsing code task. BYTE-IDENTICAL to the framings the bench proved (two hard tasks, roman +
// semver: beats-raw a quarter-to-half of the time, regression cell empty). Do NOT reword without re-measuring.
export const DRAFT_FRAMINGS = [
  'Pay special attention to numeric ranges and BOUNDARY values: the largest and smallest legal values, and the first ILLEGAL value just past each edge. A value one step past any limit must be rejected.',
  'Pay special attention to input FORMAT and structure: leading zeros, empty or missing segments, the wrong number of parts, stray or extra characters, surrounding whitespace, and letter case. Accept only the exact canonical form; reject everything else.',
  'Before writing code, silently enumerate EVERY rule and every INVALID category the specification implies, then implement each rule as its own explicit check. Let no rule go unchecked.',
  'Prefer an approach that validates by RECONSTRUCTING the canonical representation from the parsed value and comparing it back to the input — accept only when the input already equals its one canonical form.',
  'Imagine the inputs a ruthless adversarial tester would use to break a naive implementation — each boundary, each forbidden format, each easy-to-forget invalid case — and make sure your implementation returns the correct answer for every one of them.',
]

// Diverse draft generator (the SHIPPING default via reviewCodeArtifact). Draft 0 uses the PLAIN codeSys —
// IDENTICAL to generateDraftSources' draft 0 — so draft#0 stays drawn from the same single-shot distribution
// as the raw baseline and can never be removed from the selection pool (Gate-1 floor). Drafts 1..n-1 each append
// a distinct framing. Same honest per-call failure -> dropped slot, same {id, source} return shape.
export async function generateDraftSourcesDiverse(callModel, taskDesc, n) {
  const p = buildPrompts(taskDesc)
  const results = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const sys = i === 0 ? p.codeSys : `${p.codeSys}\n\nADDITIONAL FOCUS: ${DRAFT_FRAMINGS[(i - 1) % DRAFT_FRAMINGS.length]}`
    const r = await callModel({ system: sys, prompt: p.codeUser })
    if (!r || r.error || !r.text) return null
    return { id: i, source: extractModule(r.text, taskDesc.fnName) }
  }))
  return results.filter(Boolean)
}

// Generate N adversarial test suites in parallel, union+dedupe the probe inputs.
export async function generateProbes(callModel, taskDesc, n) {
  const p = buildPrompts(taskDesc)
  const suites = await Promise.all(Array.from({ length: n }, async () => {
    const r = await callModel({ system: p.testSys, prompt: p.testUser })
    return r && !r.error && r.text ? r.text : ''
  }))
  const seen = new Set()
  const probes = []
  for (const raw of suites) for (const inp of parseProbeInputs(raw)) {
    const key = JSON.stringify(inp)
    if (!seen.has(key)) { seen.add(key); probes.push(inp) }
  }
  return probes
}

// Nominate the inputs a plausible-but-naive implementation is MOST likely to get wrong — the SHARED-BLIND-SPOT
// hunter. These prioritise the consensus-audit budget in the core: unlike ordinary probes (which catch DIVERGENT
// bugs by making drafts split), these target the bug several independent authors would all repeat the SAME way,
// which yields a false consensus no split surfaces. Task-agnostic: the MODEL supplies the task knowledge; the core
// only ever sees the resulting input strings + output classes. Runs `n` nomination samples and unions them.
export async function generateTraps(callModel, taskDesc, n = 2) {
  const { spec, signature } = taskDesc
  const sys = 'You are a ruthless adversarial test engineer hunting the ONE kind of mistake many independent implementations make the SAME way — a shared blind spot. You name the concrete inputs where a plausible, confident, but subtly-wrong implementation returns the WRONG answer while looking correct.'
  const user = `Specification:\n${spec}\n\nList the input values to ${signature} that a competent-but-naive implementation is MOST likely to get WRONG — the boundary and trap cases where several independent authors would repeat the SAME mistake: off-by-one at a numeric boundary, a range/limit just past the edge, a leading-zero or format rule, an overflow, or an easily-forgotten invalid category. Prefer inputs whose CORRECT answer is subtle and easy to get wrong. Output ONLY a JSON array of such input values; aim for ${n * 8}-${n * 16}. No prose, JSON only.`
  const one = async () => { const r = await callModel({ system: sys, prompt: user }); return r && !r.error && r.text ? r.text : '' }
  const suites = await Promise.all(Array.from({ length: n }, one))
  const seen = new Set()
  const traps = []
  const absorb = (raw) => { for (const inp of parseProbeInputs(raw)) { const key = JSON.stringify(inp); if (!seen.has(key)) { seen.add(key); traps.push(inp) } } }
  for (const raw of suites) absorb(raw)
  // robustness: a transient empty return (e.g. slot starvation under concurrent generation) must not silently
  // disable the whole blind-spot audit — retry once, sequentially, if nothing parsed.
  if (traps.length === 0) absorb(await one())
  return traps
}

// Render an output-CLASS string back to a human-readable value for the grounded review prompt. Inverse-ish of
// outClass: 'b:true'->true, 'n:5400'->5400, 's:abc'->"abc", 'null'->null, 'throw'->(threw an error), etc.
export function classDisplay(cls) {
  if (cls === 'null') return 'null'
  if (cls === 'undef') return 'undefined'
  if (cls === 'throw') return '(threw an error)'
  if (cls === 'timeout') return '(timed out)'
  if (cls === 'load-fail') return '(failed to load)'
  const i = String(cls).indexOf(':')
  if (i < 0) return String(cls)
  const tag = cls.slice(0, i), body = cls.slice(i + 1)
  if (tag === 'n' || tag === 'b' || tag === 'j') return body   // number / boolean / JSON already print as-is
  if (tag === 's') return JSON.stringify(body)                  // quote strings so "" vs whitespace is visible
  return String(cls)
}

// GROUNDED shared-blind-spot pointer (the reshape after fs-ipv4-audit-2/3 proved blind nomination inherits the
// coder's own blind spot). Returns an injected reviewConsensus(pairs) the core calls with the drafts' UNANIMOUS
// (input -> output-class) answers. It renders each pair to a readable "fn(input) returned value" line, shows the
// spec, and asks the model — in reviewer/evaluative mode, the mode the pivotal probe showed KNOWS these answers —
// to flag every input whose returned value violates the spec. Those inputs are then reason-audited AT DEPTH by the
// core (KREASON votes, confident-disagreement-only), so an over-eager flag costs only budget, never a false finding.
// Batched so a large consensus set is a few cheap calls, not one giant prompt.
export function reviewConsensus(callModel, taskDesc, batchSize = 40) {
  const { spec, fnName } = taskDesc
  const sys = 'You are a meticulous code reviewer checking an implementation against its specification. You are shown inputs and the value the implementation returned for each. Using ONLY the specification, identify every case where the returned value is INCORRECT — where a spec-correct implementation would return a different value. Do not assume the implementation is right; a confident-looking wrong answer on a boundary or trap case is exactly what you are hunting.'
  return async function (pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) return []
    const sus = []
    const seen = new Set()
    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize)
      const lines = batch.map((p) => `${fnName}(${JSON.stringify(p.inp)}) returned ${classDisplay(p.cls)}`).join('\n')
      const user = `Specification:\n${spec}\n\nAn implementation of ${fnName} returned these results:\n${lines}\n\nUsing ONLY the spec, list the inputs whose returned value is WRONG — where a correct implementation would return a different value. Output ONLY a JSON array of the offending INPUT values, copied EXACTLY as shown above (the argument inside the parentheses), or [] if every result is correct. No prose, JSON only.`
      const r = await callModel({ system: sys, prompt: user })
      if (r && !r.error && r.text) for (const inp of parseProbeInputs(r.text)) {
        const k = JSON.stringify(inp)
        if (!seen.has(k)) { seen.add(k); sus.push(inp) }
      }
    }
    return sus
  }
}

// Build the core's resolveByReason(input) -> {cls, votes} from KREASON reasoning votes.
export function makeReasoner(callModel, taskDesc, kreason) {
  const p = buildPrompts(taskDesc)
  return async function resolveByReason(input) {
    const tally = {}
    for (let k = 0; k < kreason; k++) {
      const r = await callModel({ system: p.reasonSys, prompt: p.reasonUser(input) })
      const cls = r && !r.error && r.text ? parseReasonFinal(r.text) : '??'
      tally[cls] = (tally[cls] || 0) + 1
    }
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]
    return { cls: top ? top[0] : '??', votes: tally }
  }
}
