// task-quality/reviewer.mjs — managed HSS candidate policy only.
//
// The engine owns HSS health, leases, and clean-room execution. This attested
// config module merely provides the ordered, explicit candidate allow-list;
// it must never manufacture endpoint, quota, or busy health from config.

export const DEFAULT_REVIEWER_CANDIDATES = Object.freeze([
  Object.freeze({ agent: 'helper2' }),
  Object.freeze({ agent: 'helper1' }),
])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validAgentName(value) {
  return nonEmpty(value) && /^[A-Za-z0-9_.-]{1,96}$/.test(value)
}

export function configuredReviewerCandidates(policy = {}) {
  // An explicit empty list is an opt-out. Omission receives the shipped order.
  const raw = Array.isArray(policy.reviewers) ? policy.reviewers : DEFAULT_REVIEWER_CANDIDATES
  const seen = new Set()
  return raw
    .filter((candidate) => candidate && candidate.enabled !== false && validAgentName(candidate.agent) && !seen.has(candidate.agent) && seen.add(candidate.agent))
    .map((candidate) => ({ agent: candidate.agent }))
}
