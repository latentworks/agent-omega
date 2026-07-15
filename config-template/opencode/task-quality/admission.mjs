import { hasCurrentApproval, hasUnsettledExecution, TASK_QUALITY_POLICY_VERSION } from './lifecycle.mjs'

const CONTROL_TOOL = 'task_quality_checkpoint'
const ARTIFACT_CONTROL_TOOL = 'task_quality_artifact_checkpoint'

function hasMatchingDirectTaskWrapperPending(lifecycle, parentTaskCallID) {
  const pending = lifecycle?.pendingExecutions
  return (
    Array.isArray(pending) &&
    pending.length === 1 &&
    pending[0]?.tool === 'task' &&
    pending[0]?.callID === parentTaskCallID
  )
}

// Lever I — immutable-artifact guard (OMEGA_IMMUTABLE_ORACLES, default off).
//
// A deterministic, harness-declared pre-write block. The test harness that owns
// each task knows exactly which files are the acceptance ORACLE — the hidden
// test/spec that grades the run, and the task README/spec that states the
// contract — and passes their basenames explicitly via the environment variable
// OMEGA_IMMUTABLE_ORACLES (comma / semicolon / whitespace separated). A mutating
// write whose target basename EXACTLY matches a declared oracle is denied. This
// converts a silent immutable-oracle breach (overwriting the hidden test file or
// the task README to fake a pass) into a clean, auditable stop.
//
// Why an explicit declared set, not inference from the contract prose: an earlier
// design inferred immutability by parsing the contract text ("modify only src",
// "the tests are read-only") and matching oracle basenames by pattern
// (*.test.*, README*). Independent adversarial review broke that on multiple
// fronts — legitimate source docs matched the patterns and were false-blocked, a
// crafted contract poisoned the authorized set, and the prose regexes were a
// ReDoS surface. The disease was inferring immutability from prose. This design
// removes the parser entirely: the guard protects EXACTLY the basenames the
// harness declares, nothing more. The harness declares only true oracles, so a
// legitimate source-repair write — whose basename is a source basename, never a
// declared oracle — can never be blocked. Can't-make-worse holds by construction,
// independent of path form and independent of contract text.
//
// Why basename, not directory containment: at admission the target path is
// whatever the model emitted — bare "port.mjs", relative "src/port.mjs", or an
// absolute path — and no workspace root is available to this gate, so a
// directory-containment check cannot be performed and would false-block. The
// oracle is identified by basename, invariant across every path form and immune
// to "../" traversal ("src/../tests/public.test.mjs" still has basename
// "public.test.mjs"). Basename normalization also strips a Windows
// alternate-data-stream suffix ("public.test.mjs::$DATA") and trailing dots or
// spaces, so those cannot be used to slip a write past the exact-match set.
//
// Coverage boundary (documented, not silent): this protects EXACTLY the oracle
// basenames the harness declares — no more, no less. It does not infer, and it
// does not attempt to fence every possible non-source file. The engine's own
// assertExternalDirectory already blocks writes OUTSIDE the workspace; this guard
// covers the intra-workspace oracle files that guard does not. When no oracle set
// is declared, or the mutating tool exposes no file path (shell), the guard
// abstains and admission proceeds unchanged.
const MUTATION_PATH_KEYS = ['filePath', 'file_path', 'path']

function extractMutationPath(args) {
  if (!args || typeof args !== 'object') return null
  for (const key of MUTATION_PATH_KEYS) {
    // A hostile args object could expose a throwing accessor for one of these
    // keys; a crash in the gate must never take down the admission path, so read
    // defensively and treat a throwing key as absent.
    let value
    try { value = args[key] } catch { continue }
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

// The final real path segment (basename), canonicalized the way the filesystem
// resolves it so the same oracle matches regardless of how the model spelled the
// path. Handles: either separator (/ or \), "."/".." traversal, a Windows NTFS
// alternate-data-stream suffix (foo::$DATA / foo:stream), and trailing dots or
// spaces (which Windows strips). Lower-cased for a case-insensitive match.
//   "src/../tests/public.test.mjs" -> "public.test.mjs"
//   "README.md::$DATA"             -> "readme.md"
//   "README.md. "                  -> "readme.md"
function normalizeBasename(rawPath) {
  const parts = String(rawPath).replace(/\\/g, '/').split('/')
  let seg = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const s = parts[i].trim()
    if (s && s !== '.' && s !== '..') { seg = s; break }
  }
  const colon = seg.indexOf(':')     // drop any NTFS alternate-data-stream suffix
  if (colon >= 0) seg = seg.slice(0, colon)
  seg = seg.replace(/[.\s]+$/, '')   // drop trailing dots / spaces (Windows strips these)
  return seg.toLowerCase()
}

// Parse a harness-declared oracle list (comma / semicolon / whitespace separated
// basenames, e.g. "public.test.mjs, README.md") into a normalized Set of
// basenames. Directory components are ignored — only the basename matters, to
// mirror normalizeBasename. Returns null for an absent or empty declaration so
// the guard abstains (default off).
export function parseImmutableOracles(raw) {
  if (typeof raw !== 'string') return null
  const set = new Set()
  for (const token of raw.split(/[,;\s]+/)) {
    const b = normalizeBasename(token)
    if (b) set.add(b)
  }
  return set.size ? set : null
}

// Pure, unit-testable core. Denies a mutating write whose target basename EXACTLY
// matches a harness-declared immutable oracle. `oracles` is either a pre-parsed
// Set<string> of normalized basenames or the raw declaration string. Returns:
//   { enforced: false }                                        — guard abstains (no oracle set, or no path)
//   { enforced: true, blocked: false }                         — mutation allowed
//   { enforced: true, blocked: true, targetPath, artifact }    — mutation denied
export function evaluateImmutableGuard(input) {
  const { oracles, args } = input || {}
  const set = oracles instanceof Set ? oracles : parseImmutableOracles(oracles)
  if (!set || set.size === 0) return { enforced: false }
  const targetPath = extractMutationPath(args)
  if (!targetPath) return { enforced: false }
  const basename = normalizeBasename(targetPath)
  if (basename && set.has(basename)) return { enforced: true, blocked: true, targetPath, artifact: basename }
  return { enforced: true, blocked: false }
}

export function admitTaskQualityTool({ tool, source, capability, trustedControl, lifecycle, directTaskWrapperCallID, args, immutableOracles } = {}) {
  // The checkpoint is the narrowly-scoped local control plane that can create
  // the repaired-plan record. It does not touch workspace state or execute a
  // command; every other unknown/plugin/MCP tool remains denied.
  // `trustedControl` is loader-attested by the engine's WeakMap, never supplied
  // by a plugin return object or MCP payload. Keep the complete tuple here so a
  // same-named tool cannot impersonate the checkpoint and open the gate.
  if (
    ((tool === CONTROL_TOOL && trustedControl === CONTROL_TOOL) ||
      (tool === ARTIFACT_CONTROL_TOOL && trustedControl === ARTIFACT_CONTROL_TOOL)) &&
    source === 'plugin' &&
    capability === 'unknown'
  ) {
    return { decision: 'allow', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (capability === 'read') return { decision: 'allow', policyVersion: TASK_QUALITY_POLICY_VERSION }
  if (capability === 'unknown') {
    return { decision: 'deny', reason: 'Task quality blocks unclassified tools until a trusted capability policy explicitly classifies them.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (capability !== 'mutate') {
    return { decision: 'deny', reason: 'Task quality received an invalid tool capability classification.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (!lifecycle) {
    return { decision: 'deny', reason: 'Task quality requires a qualifying routed task and repaired plan before a mutating tool can run.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (!lifecycle.repairedPlan || lifecycle.phase !== 'awaiting-approval' && lifecycle.phase !== 'approved') {
    return { decision: 'deny', reason: 'Task quality requires a repaired plan before mutation. Record the repaired plan and ask the user for an explicit go/no-go.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (!hasCurrentApproval(lifecycle)) {
    return { decision: 'deny', reason: 'Task quality is awaiting an explicit external-user go for the current repaired-plan generation.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  // A direct TaskTool call has its own durable wrapper precommit while its
  // engine-issued child performs the actual workspace action. That private
  // child may proceed through its exact wrapper only; any real unresolved
  // action remains fail-closed. The wrapper call ID is resolved solely from
  // loader-attested engine provenance, never from tool input.
  if (
    hasUnsettledExecution(lifecycle) &&
    !hasMatchingDirectTaskWrapperPending(lifecycle, directTaskWrapperCallID)
  ) {
    return { decision: 'deny', reason: 'Task quality recovered an unresolved execution attempt. Do not continue mutation; inspect the durable tool result and route a repaired follow-up.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  // Lever I — immutable-artifact guard. An otherwise-authorized mutation is still
  // denied if the routed run declares oracle basenames immutable (via
  // OMEGA_IMMUTABLE_ORACLES) and the target basename exactly matches one. Off by
  // default (no declared set → abstains). Can never wedge legitimate source work,
  // whose basename is never a declared oracle.
  if (immutableOracles) {
    const guard = evaluateImmutableGuard({ oracles: immutableOracles, args })
    if (guard.enforced && guard.blocked) {
      return { decision: 'deny', reason: `Task quality immutable-artifact guard: ${guard.artifact} is declared a read-only acceptance oracle (the hidden test/spec or the task README), but this call targets ${guard.targetPath}. That file is the acceptance oracle, not the work product — repair the source, never the oracle. Confine changes to the permitted source files.`, policyVersion: TASK_QUALITY_POLICY_VERSION }
    }
  }
  return { decision: 'allow', policyVersion: TASK_QUALITY_POLICY_VERSION }
}

export { CONTROL_TOOL, ARTIFACT_CONTROL_TOOL }
