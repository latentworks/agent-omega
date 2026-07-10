// Process-local router handoff only. Durable lifecycle authority belongs to the
// engine's session task-quality record, never this cache.
import { createHash } from 'node:crypto'

const handoffs = new Map()
const QUALIFYING_SKILLS = new Set([
  'brainstorming',
  'code-review',
  'debugging',
  'orchestration',
  'tdd',
  'verify',
  'writing-plans',
])

export function digestText(value) {
  return createHash('sha256').update(String(value).replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

// This is deliberately a deterministic interpretation of the router's single
// model result, not a second task classifier. A router miss leaves no handoff;
// mutation admission then fails closed rather than guessing.
export function buildRouteHandoff({ sessionID, messageID, messages, skillNames, routedAt = Date.now() } = {}) {
  if (typeof sessionID !== 'string' || !sessionID) throw new TypeError('sessionID is required')
  if (typeof messageID !== 'string' || !messageID) throw new TypeError('messageID is required')
  const skills = Object.freeze([...new Set((Array.isArray(skillNames) ? skillNames : []).filter((item) => typeof item === 'string' && item))])
  const taskText = (Array.isArray(messages) ? messages : []).map((item) => String(item || '').trim()).filter(Boolean).join('\n')
  const qualifyingSkills = skills.filter((skill) => QUALIFYING_SKILLS.has(skill))
  const qualifies = qualifyingSkills.length > 0
  return Object.freeze({
    version: 1,
    sessionID,
    messageID,
    taskKey: digestText(`${messageID}\0${taskText}`),
    taskText,
    skills,
    qualifies,
    qualificationReason: qualifies ? `skill-router:${qualifyingSkills.join(',')}` : 'skill-router:non-qualifying',
    routedAt,
  })
}

export function recordRouteHandoff(handoff) {
  if (!handoff || typeof handoff.sessionID !== 'string') throw new TypeError('valid router handoff is required')
  // Do not erase an active qualifying handoff because a later non-task turn
  // (for example a plain approval) routes to NONE.
  if (handoff.qualifies) handoffs.set(handoff.sessionID, handoff)
  return handoff
}

export function getRouteHandoff(sessionID) {
  return handoffs.get(sessionID)
}

export function clearRouteHandoff(sessionID) {
  handoffs.delete(sessionID)
}
