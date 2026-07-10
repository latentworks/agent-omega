// Thin client adapter for the fork's durable task-quality endpoints. Keeping
// this boundary explicit makes the plugin fail closed on an old engine instead
// of quietly falling back to an in-memory authorization map.
export function createLifecycleAdapter(_client, internal, reviewers = []) {
  // Lifecycle writes are deliberately an in-process, engine-attested bridge.
  // A public HTTP/SDK caller may request a review, but can never forge a
  // lifecycle record or an approval.
  if (!internal || typeof internal.get !== 'function' || typeof internal.update !== 'function' || typeof internal.review !== 'function') return null
  return Object.freeze({
    canReview: true,
    async get(sessionID) {
      return await internal.get(sessionID)
    },
    async update(input) {
      return await internal.update(input)
    },
    async review(input) {
      // HSS candidate order crosses only the loader-attested in-process
      // bridge. Ordinary SDK callers cannot select or probe helpers.
      const response = await internal.review({ ...input, reviewers })
      const payload = response?.data ?? response
      // The engine owns the route, active-model affinity, workspace, immutable
      // receipts, and review execution. Accept only its completed envelope;
      // caller-shaped review objects must never authorize a plan checkpoint.
      if (!payload || payload.review?.status !== 'complete' || !payload.route || !payload.submission || !payload.review.result) {
        throw new Error('the engine returned an incomplete isolated review result')
      }
      if (
        payload.submission.kind !== input?.submission?.kind ||
        typeof payload.submission.digest !== 'string' ||
        !payload.submission.digest ||
        payload.submission.digest !== input?.submission?.digest
      ) {
        throw new Error('the engine review result does not bind to the canonical submitted artifact digest')
      }
      return { route: payload.route, submission: payload.submission, result: payload.review.result }
    },
  })
}

export function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object') return { revision: 0, generation: 0, data: null }
  return {
    revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
    generation: Number.isSafeInteger(value.generation) ? value.generation : 0,
    data: value.data && typeof value.data === 'object' ? value.data : null,
  }
}
