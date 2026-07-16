// Lever: ARTIFACT-REPAIR LOOP (env-gated, default OFF = byte-identical).
//
// PROBLEM (as a system): both arms of the eval use the same builder model. On a
// solvable task the raw arm sometimes draws correct code while the omega arm draws
// subtly-buggy code — pure sampling, same model. Omega's independent artifact
// reviewer (Lever D, OMEGA_REVIEWER_DIVERSITY) then CORRECTLY catches the bug, but a
// *completed structured* non-pass verdict has no repair path: the adapter's
// first-review conversion that reuses the proven CRAP delivery + repair loop is
// scoped to PLAN submissions only (adapter.mjs), so an artifact non-pass falls to the
// fail-closed throw -> a terminal dead-end. Omega then ships its caught-buggy artifact
// and loses the head-to-head to raw's correct one: the machinery worked (it caught a
// real defect) yet omega is graded worse. The more successfully the independent
// reviewer completes, the more often this happens.
//
// THIS LEVER is the "separate, separately proven" artifact extension the adapter's own
// comment anticipates: when enabled, an artifact first-review non-pass is converted to
// the same bounded plain-language report a plan non-pass already uses, so it travels
// the EXISTING artifact repair path (recordPendingArtifactReview -> resumeWithReview ->
// awaiting-artifact rereview -> bounded rounds -> pass | honest DECLINED at the cap).
// It stays fail-CLOSED (never approves), preserves the independent reviewer's real
// findings + route provenance, keeps the approval generation binding intact so repair
// happens in the already-approved scope, and changes NOTHING when unset.
//
// Isolation: this lever is exactly one import + one condition in adapter.mjs plus this
// module. Reverting it = drop the import and restore the plan-only gate. It does not
// touch lifecycle.mjs (the authorization FSM) or index.js.

// Read once at module load, matching the on/off convention used by the other task-
// quality env toggles (AUTONOMOUS, review-rounds override). Default unset => false =>
// the adapter's artifact non-pass path is byte-identical to today's fail-closed throw.
const ARTIFACT_REPAIR_LOOP = /^(1|true|yes|on)$/i.test(
  String(process.env.OMEGA_ARTIFACT_REPAIR_LOOP || "").trim(),
)

export function artifactRepairLoopEnabled() {
  return ARTIFACT_REPAIR_LOOP
}
