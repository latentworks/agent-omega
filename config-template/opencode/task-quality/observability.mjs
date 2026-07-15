// FIX-6 observability: a once-per-process stderr warning used to replace bare
// catches that previously swallowed diagnostics silently (e.g. task-quality.log
// append failures). Surfacing the first failure keeps the next audit from
// needing forensic reconstruction, while suppressing the rest avoids spamming a
// long-running process. Emitting a diagnostic must never be fatal, so the write
// itself is guarded — that terminal guard is the sink of last resort, not a
// silent swallow of the original error (which has already been surfaced once).
export function createWarnOnce(write = (text) => process.stderr.write(text)) {
  let emitted = false
  return function warnOnce(scope, error) {
    if (emitted) return false
    emitted = true
    try {
      const detail = error && error.message ? error.message : String(error)
      write(`[task-quality] ${scope} failed (further diagnostics suppressed for this process): ${detail}\n`)
    } catch {
      // Nowhere left to report to; stay non-fatal.
    }
    return true
  }
}

// Process-wide singleton for the plugin's own diagnostics.
export const warnOnce = createWarnOnce()

// Lever O — review-route observability (pure diagnostics, changes no decision).
//
// The engine's review handler decides HOW a review ran and returns that on
// route: kind ("subagent" = a different-model clean-room review actually
// completed; "crap" = same-model self-review), plus — critically — a `reason`
// string when kind is "crap" that distinguishes WHY the clean-room path was not
// taken (HSS never requested by the loader-attested plugin vs. no eligible
// helper completed the bounded review), and `attempts`/`health`. The lifecycle
// layer bakes route down to {kind, model, agent} before persisting, dropping
// reason/attempts/health — so no durable case artifact records why same-model
// review fired, which is the single most important signal for improving review
// quality. summarizeReviewRoute captures the full route defensively (a hostile
// or partial value must never throw here); withRouteObservability records it to
// the injected log at the one place the unmodified engine value is available:
// the adapter's review() return. It reads only; it never alters the returned
// value, any decision, or any durable state.
export function summarizeReviewRoute(route) {
  if (!route || typeof route !== 'object') return null
  const model =
    typeof route.model === 'string'
      ? route.model
      : route.model && route.model.providerID && route.model.modelID
        ? `${route.model.providerID}/${route.model.modelID}`
        : null
  const attempts = Array.isArray(route.attempts)
    ? route.attempts
        .map((a) => (a && typeof a === 'object' ? `${a.agent ?? '?'}:${a.reason ?? a.status ?? '?'}` : String(a)))
        .filter(Boolean)
    : null
  return {
    kind: route.kind ?? null,
    model,
    ...(route.agent ? { agent: String(route.agent) } : {}),
    ...(route.health ? { health: String(route.health) } : {}),
    ...(typeof route.reason === 'string' ? { reason: route.reason } : {}),
    ...(attempts && attempts.length ? { attempts } : {}),
  }
}

// Wrap a lifecycle adapter so every review() return logs its full engine route
// via the injected `log(message)` writer. Returns the base unchanged if it is
// null (old engine) or exposes no review(), preserving the exact active/inactive
// behavior. The wrapped review() returns precisely `await base.review(input)`;
// the log is a swallowed side-effect that can never throw out (warnOnce absorbs
// any failure), so it is provably inert to every downstream decision and to the
// value the caller receives.
export function withRouteObservability(base, log) {
  if (!base || typeof base.review !== 'function') return base
  const emit = typeof log === 'function' ? log : () => {}
  // Forward ALL arguments (not just the first) so the wrapper stays behavior-
  // identical even if a future caller passes review() a second argument; the
  // logged summary is read off the returned route, never off the input.
  const review = async (...args) => {
    const result = await base.review(...args)
    try {
      const summary = summarizeReviewRoute(result && result.route)
      if (summary) emit(`review route ${JSON.stringify(summary)}`)
    } catch (error) {
      warnOnce('review-route observability', error)
    }
    return result
  }
  return Object.freeze({ ...base, review })
}
