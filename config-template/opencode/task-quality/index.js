// task-quality: the durable Slice 1 plan/approval gate. Existing skills still
// own planning and review procedure; this plugin owns only lifecycle state and
// engine admission. There is intentionally no session.idle hook here.
import { readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { tool } from '@opencode-ai/plugin'
import { createLifecycleAdapter, normalizeSnapshot } from './adapter.mjs'
import { configuredReviewerCandidates } from './reviewer.mjs'
import { getRouteHandoff, digestText } from './handoff.mjs'
import { admitTaskQualityTool, CONTROL_TOOL, ARTIFACT_CONTROL_TOOL } from './admission.mjs'
import { createLifecycle, digestPlan, hasCurrentApproval, hasUnsettledExecution, reconstructLifecycle, recordArtifactReview, recordExecutionPermissionRejected, recordExecutionStarted, recordReceipt, recordRepairedPlan, recordUserDecision } from './lifecycle.mjs'

const z = tool.schema
const HERE = dirname(fileURLToPath(import.meta.url))
const POLICY = (() => {
  try { return JSON.parse(readFileSync(join(HERE, 'policy.json'), 'utf8')) } catch { return null }
})()
const LOG = process.env.TASK_QUALITY_LOG || join(tmpdir(), 'task-quality.log')
const MAX_SUBMISSION_CHARS = 24000
const MAX_ACCEPTANCE_CRITERIA = 32
const MAX_CRITERION_CHARS = 2000
function log(message) { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`) } catch {} }

function textParts(output) {
  return (output?.parts || []).filter((part) => part?.type === 'text').map((part) => part.text || '').join(' ').trim()
}

function boundedText(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`)
  const text = value.trim()
  if (!text) throw new TypeError(`${label} is required`)
  if (text.length > MAX_SUBMISSION_CHARS) throw new RangeError(`${label} must be at most ${MAX_SUBMISSION_CHARS} characters`)
  return text
}

function boundedCriteria(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACCEPTANCE_CRITERIA) throw new TypeError('at least one acceptance criterion is required')
  return value.map((item) => {
    if (typeof item !== 'string') throw new TypeError('acceptance criteria must be text')
    const criterion = item.trim()
    if (!criterion || criterion.length > MAX_CRITERION_CHARS) throw new TypeError('acceptance criteria must be non-empty concise text')
    return criterion
  })
}

function policyIsValid() {
  return POLICY?.schemaVersion === 1 && POLICY?.enforcement?.mode === 'fail-closed'
}

async function loadOrCreate(adapter, sessionID, handoff) {
  // A conflicting update is never merged locally. Re-read and retry the small
  // deterministic transition; after two conflicts, leave mutation blocked.
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(sessionID))
    const lifecycle = snapshot.data?.taskKey === handoff.taskKey
      ? snapshot.data
      : reconstructLifecycle(snapshot.data, handoff)
    if (lifecycle === snapshot.data) return { snapshot, lifecycle }
    try {
      await adapter.update({
        sessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: lifecycle.generation,
        data: lifecycle,
      })
    } catch (error) {
      if (attempt === 1) throw error
      continue
    }
  }
  throw new Error('task-quality lifecycle could not be initialized')
}

async function recordPlan(adapter, sessionID, plan, acceptanceCriteria, review) {
  const handoff = getRouteHandoff(sessionID)
  if (!handoff?.qualifies) throw new Error('No qualifying skill-router handoff exists for this task. Do not implement; establish the task plan first.')
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await loadOrCreate(adapter, sessionID, handoff)
    const next = recordRepairedPlan(current.lifecycle, plan, { review, acceptanceCriteria, reviewedDigest: review?.submission?.digest })
    try {
      const saved = await adapter.update({
        sessionID,
        expectedRevision: current.snapshot.revision,
        expectedGeneration: current.snapshot.generation,
        generation: next.generation,
        data: next,
      })
      return normalizeSnapshot(saved).data || next
    } catch (error) {
      if (attempt === 1) throw error
    }
  }
  throw new Error('Task quality could not record the repaired plan due to a concurrent lifecycle update.')
}

async function recordApproval(adapter, input, output) {
  // `origin` is supplied by the engine from the persisted message, never from
  // client text. Missing/legacy origin remains blocked by recordUserDecision.
  const snapshot = normalizeSnapshot(await adapter.get(input.sessionID))
  if (!snapshot.data) return
  const decision = recordUserDecision(snapshot.data, {
    origin: input.origin,
    messageID: input.messageID,
    text: textParts(output),
    expectedGeneration: snapshot.generation,
  })
  if (!decision.ok) return
  await adapter.update({
    sessionID: input.sessionID,
    expectedRevision: snapshot.revision,
    expectedGeneration: snapshot.generation,
    generation: decision.lifecycle.generation,
    data: decision.lifecycle,
  })
  log(`recorded ${decision.lifecycle.phase} for ${input.sessionID} generation=${decision.lifecycle.generation}`)
}

function receiptFromToolResult(input, output) {
  // This hook is deliberately non-prompting and side-effect-free apart from
  // its own CAS write. Never retain tool args, raw output, file paths,
  // metadata, attachments, or model text: a later reviewer receives bounded
  // provenance only, not a second hidden builder transcript.
  if (!input?.sessionID || !input?.callID || !input?.tool || input.tool === CONTROL_TOOL || input.tool === ARTIFACT_CONTROL_TOOL) return null
  const value = typeof output?.output === 'string' ? output.output : ''
  const outputBytes = Buffer.byteLength(value, 'utf8')
  if (outputBytes > 1_000_000) return null
  const verification = /(?:test|verify|check|lint|build|audit)/i.test(input.tool)
  return {
    callID: String(input.callID),
    tool: String(input.tool),
    kind: verification ? 'verification' : 'tool',
    outputDigest: digestText(value),
    outputBytes,
    // Engine-persisted completion time makes a replay idempotent instead of
    // inventing a fresh timestamp for the same call.
    capturedAt: Number.isSafeInteger(input?.completedAt) ? input.completedAt : 0,
  }
}

async function captureReceipt(adapter, input, output) {
  const receipt = receiptFromToolResult(input, output)
  if (!receipt) return
  // A conflict is not merged in memory. Re-read once; exact duplicate delivery
  // is idempotent, while a changed result for one engine call ID remains blocked.
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(input.sessionID))
    if (!snapshot.data) return
    let lifecycle
    try { lifecycle = recordReceipt(snapshot.data, receipt) } catch (error) {
      log(`receipt ignored: ${error?.message || error}`)
      return
    }
    if (lifecycle === snapshot.data) return
    try {
      await adapter.update({
        sessionID: input.sessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: lifecycle.generation,
        data: lifecycle,
      })
      return
    } catch (error) {
      if (attempt === 1) log(`receipt capture conflict: ${error?.message || error}`)
    }
  }
}

async function markExecutionStarted(adapter, input) {
  if (!input?.sessionID || !input?.callID || !input?.tool || input.capability !== 'mutate' || input.tool === CONTROL_TOOL || input.tool === ARTIFACT_CONTROL_TOOL) return
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(input.sessionID))
    // This write is a prerequisite, not best-effort telemetry. If durable
    // state cannot be read or advanced, the engine must not start a workspace
    // mutation it could not later reconcile after a crash.
    if (!snapshot.data) throw new Error('no durable task-quality lifecycle exists for mutation precommit')
    const next = recordExecutionStarted(snapshot.data, {
      callID: String(input.callID),
      tool: String(input.tool),
      startedAt: Number.isSafeInteger(input?.startedAt) ? input.startedAt : Date.now(),
    })
    if (next === snapshot.data) return
    try {
      await adapter.update({ sessionID: input.sessionID, expectedRevision: snapshot.revision, expectedGeneration: snapshot.generation, generation: next.generation, data: next })
      return
    } catch (error) {
      if (attempt === 1) throw error
    }
  }
}

async function settlePermissionRejectedExecution(adapter, input) {
  if (!input?.sessionID || !input?.callID || !input?.tool) return
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(input.sessionID))
    if (!snapshot.data) return
    const next = recordExecutionPermissionRejected(snapshot.data, { callID: String(input.callID), tool: String(input.tool) })
    if (next === snapshot.data) return
    try {
      await adapter.update({ sessionID: input.sessionID, expectedRevision: snapshot.revision, expectedGeneration: snapshot.generation, generation: next.generation, data: next })
      return
    } catch (error) {
      if (attempt === 1) throw error
    }
  }
}

async function recordArtifact(adapter, sessionID, artifact, review) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(sessionID))
    if (!snapshot.data) throw new Error('no durable task-quality lifecycle exists for artifact review')
    const next = recordArtifactReview(snapshot.data, artifact, { review, reviewedDigest: review?.submission?.digest })
    try {
      const saved = await adapter.update({
        sessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: next.generation,
        data: next,
      })
      return normalizeSnapshot(saved).data || next
    } catch (error) {
      if (attempt === 1) throw error
    }
  }
  throw new Error('Task quality could not record artifact review due to a concurrent lifecycle update.')
}

export const TaskQualityPlugin = async ({ client, experimental_task_quality }) => {
  const adapter = createLifecycleAdapter(
    client,
    experimental_task_quality,
    configuredReviewerCandidates(POLICY).map(({ agent }) => ({ agent })),
  )
  const active = Boolean(adapter && adapter.canReview && policyIsValid())
  if (!active) log('INERT: missing task-quality engine client surface/reviewer or invalid policy; admission will fail closed')

  return {
    'experimental.chat.system.transform': async (input, output) => {
      try {
        if (!active || !input?.sessionID || !Array.isArray(output?.system)) return
        const handoff = getRouteHandoff(input.sessionID)
        if (!handoff?.qualifies) return
        await loadOrCreate(adapter, input.sessionID, handoff)
        output.system.push([
          '## Task-quality lifecycle — required gate',
          'This is a qualifying routed task. Preserve the existing planning/review skills, repair the plan, then call task_quality_checkpoint with that repaired plan.',
          'Show the repaired plan to the user and wait for a later, explicit user-authored go/no-go. The engine blocks workspace mutation until that exact plan generation is approved.',
        ].join(' '))
      } catch (error) {
        log(`system transform error: ${error?.message || error}`)
      }
    },

    'chat.message.persisted': async (input, output) => {
      try {
        if (!active || !input?.sessionID || !input?.messageID) return
        await recordApproval(adapter, input, output)
      } catch (error) {
        // A CAS conflict or unavailable persistence must never become an
        // approval by implication. Admission remains denied until a later
        // exact external-user approval is durably recorded.
        log(`approval capture error: ${error?.message || error}`)
      }
    },

    'tool.execute.admission': async (input, output) => {
      try {
        if (!active) {
          if (input.capability !== 'read') Object.assign(output, { decision: 'deny', reason: 'Task quality requires an Agent Omega v2.6 engine lifecycle surface before mutating tools may run.', policyVersion: 'agent-omega/task-quality@1' })
          return
        }
        const snapshot = input.tool === CONTROL_TOOL ? null : normalizeSnapshot(await adapter.get(input.sessionID))
        Object.assign(output, admitTaskQualityTool({
          tool: input.tool,
          source: input.source,
          capability: input.capability,
          trustedControl: input.trustedControl,
          lifecycle: snapshot?.data || null,
        }))
      } catch (error) {
        if (input.capability !== 'read') {
          Object.assign(output, { decision: 'deny', reason: 'Task quality could not read durable lifecycle state; mutation is blocked until the state store is available.', policyVersion: 'agent-omega/task-quality@1' })
        }
        log(`admission error: ${error?.message || error}`)
      }
    },

    'tool.execute.preexecute': async (input) => {
      if (!active) return
      // Let a failed CAS/read reject tool execution. Swallowing this error
      // would allow an unrecoverable mutation with no durable precommit. The
      // engine invokes this only after policy admission succeeds.
      await markExecutionStarted(adapter, input)
    },

    'tool.execute.persisted': async (input, output) => {
      try {
        if (!active) return
        await captureReceipt(adapter, input, output)
      } catch (error) {
        // Evidence capture cannot authorize anything. A failure leaves the
        // artifact checkpoint closed and never changes the original tool result.
        log(`receipt capture error: ${error?.message || error}`)
      }
    },

    'tool.execute.permission_rejected': async (input) => {
      try {
        if (!active) return
        await settlePermissionRejectedExecution(adapter, input)
      } catch (error) {
        // The rejection is already durable. If its recovery settlement cannot
        // be saved, retain the conservative pending record rather than
        // guessing about a side effect.
        log(`permission rejection settlement error: ${error?.message || error}`)
      }
    },

    tool: {
      [CONTROL_TOOL]: tool({
        description: 'Record the repaired plan for the current qualifying task. This control-plane tool does not edit files or execute commands. Call only after the required plan review has been repaired, then show the plan and wait for the user to approve it.',
        args: {
          // Some llama.cpp-compatible OpenAI endpoints reject grammars synthesized
          // from JSON Schema cardinality bounds before the model receives a token.
          // Keep the provider-facing contract simple; enforce limits in execute.
          repaired_plan: z.string().describe('The complete repaired implementation plan that will be shown to the user for explicit go/no-go.'),
          acceptance_criteria: z.array(z.string()).describe('Concrete observable conditions the repaired plan must satisfy.'),
        },
        execute: async (args, context) => {
          if (!active) return { title: 'Task-quality blocked', output: 'The installed engine cannot run and persist an isolated task-quality review. Update Agent Omega v2.6 before continuing a qualifying change.' }
          try {
            const plan = boundedText(args.repaired_plan, 'repaired plan')
            const acceptanceCriteria = boundedCriteria(args.acceptance_criteria)
            const review = await adapter.review({
              sessionID: context.sessionID,
              contract: getRouteHandoff(context.sessionID)?.taskText || '',
              acceptanceCriteria,
              submission: { kind: 'plan', content: plan, digest: digestPlan(plan) },
            })
            const lifecycle = await recordPlan(adapter, context.sessionID, plan, acceptanceCriteria, review)
            return {
              title: 'Repaired plan recorded',
              output: `Repaired plan generation ${lifecycle.generation} is recorded. Show this exact plan to the user and wait for an explicit go/no-go before any implementation tool call.`,
              metadata: { taskQuality: { phase: lifecycle.phase, generation: lifecycle.generation, planDigest: lifecycle.repairedPlan.digest } },
            }
          } catch (error) {
            return { title: 'Task-quality plan not recorded', output: `No implementation is authorized: ${error?.message || error}` }
          }
        },
      }),
      [ARTIFACT_CONTROL_TOOL]: tool({
        description: 'Record a bounded final artifact review after approved work. This control-plane tool does not edit files or execute commands. It requires sanitized engine-captured execution receipts and permanently closes the current task generation on review success or failure.',
        args: {
          artifact: z.string().describe('A concise final work-product report or artifact summary to be independently reviewed.'),
        },
        execute: async (args, context) => {
          if (!active) return { title: 'Task-quality blocked', output: 'The installed engine cannot run and persist an isolated artifact review. Update Agent Omega v2.6 before continuing.' }
          try {
            const artifact = boundedText(args.artifact, 'artifact')
            const lifecycle = normalizeSnapshot(await adapter.get(context.sessionID)).data
            if (!hasCurrentApproval(lifecycle) || hasUnsettledExecution(lifecycle)) throw new Error('a current explicit external-user approval with no unresolved execution is required before artifact review')
            if (!Array.isArray(lifecycle.receipts) || lifecycle.receipts.length < 1) throw new Error('at least one sanitized execution or verification receipt is required before artifact review')
            const review = await adapter.review({
              sessionID: context.sessionID,
              contract: lifecycle?.taskContract || '',
              acceptanceCriteria: lifecycle?.acceptanceCriteria || [],
              submission: { kind: 'artifact', content: artifact, digest: digestPlan(artifact) },
            })
            const recorded = await recordArtifact(adapter, context.sessionID, artifact, review)
            const passed = recorded.phase === 'artifact-reviewed'
            return {
              title: passed ? 'Artifact review recorded' : 'Artifact review found gaps',
              output: passed
                ? 'The final artifact review is durably recorded. This task generation is closed; begin a new routed task before further implementation.'
                : 'The isolated artifact review found gaps or was blocked. This task generation is closed; route a repaired follow-up as a new task before further implementation.',
              metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, artifactDigest: recorded.reviewedArtifact?.digest || null } },
            }
          } catch (error) {
            return { title: 'Task-quality artifact review not recorded', output: `No completion claim is authorized: ${error?.message || error}` }
          }
        },
      }),
    },
  }
}

// This must use the v1 plugin-module shape rather than the legacy bare
// function export. The engine grants its private lifecycle/review bridge only
// to the loader-attested global config slot, and legacy plugins cannot receive
// that capability.
export default {
  id: 'agent-omega.task-quality',
  server: TaskQualityPlugin,
}
