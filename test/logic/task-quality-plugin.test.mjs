import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskQualityPlugin } from '../../config-template/opencode/task-quality/index.js'
import { buildRouteHandoff, clearRouteHandoff, digestText, recordRouteHandoff } from '../../config-template/opencode/task-quality/handoff.mjs'

function fakeClient() {
  let state = null
  const reviews = []
  return {
    reviews,
    client: {
      session: {
        taskQuality: {
        async review(input) {
          reviews.push(input)
          return { data: { route: { kind: 'crap', model: { providerID: 'local', modelID: 'model' } }, submission: { kind: input.submission.kind, digest: digestText(input.submission.content) }, review: { status: 'complete', result: { verdict: 'pass', summary: 'checked', findings: [], dispositions: [] } } } }
        },
        },
      },
    },
    internal: {
      async get(sessionID) { assert.equal(sessionID, 'ses-plugin'); return state },
      async update(input) {
          const current = state || { revision: 0, generation: 0, data: null }
          if (input.expectedRevision !== current.revision || input.expectedGeneration !== current.generation) {
            const error = new Error('CAS conflict'); error.status = 409; throw error
          }
          state = { revision: current.revision + 1, generation: input.generation, data: input.data }
          return state
      },
      async review(input) {
        reviews.push(input)
        return { route: { kind: 'crap', model: { providerID: 'local', modelID: 'model' } }, submission: { kind: input.submission.kind, digest: digestText(input.submission.content) }, review: { status: 'complete', result: { verdict: 'pass', summary: 'checked', findings: [], dispositions: [] } } }
      },
    },
    state: () => state,
  }
}

test('plugin takes one router handoff through review, exact external go, and engine admission', async () => {
  const sessionID = 'ses-plugin'
  clearRouteHandoff(sessionID)
  recordRouteHandoff(buildRouteHandoff({
    sessionID,
    messageID: 'msg-task',
    messages: ['Build a robust feature'],
    skillNames: ['brainstorming'],
  }))
  const fake = fakeClient()
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal })

  const system = { system: [] }
  await hooks['experimental.chat.system.transform']({ sessionID }, system)
  assert.match(system.system.join('\n'), /qualifying routed task/)
  assert.equal(fake.state().data.phase, 'planning')

  const premature = { decision: 'allow' }
  await hooks['tool.execute.admission']({ sessionID, tool: 'edit', callID: 'call-before', args: {}, source: 'builtin', capability: 'mutate' }, premature)
  assert.equal(premature.decision, 'deny')

  const checkpoint = await hooks.tool.task_quality_checkpoint.execute({
    repaired_plan: '1. Make the change.\n2. Run the proof.',
    acceptance_criteria: ['The real surface works.', 'The focused proof passes.'],
  }, { sessionID, directory: '.', worktree: '.', metadata() {} })
  assert.match(checkpoint.output, /generation 2/)
  assert.equal(fake.reviews.length, 1)
  assert.equal(fake.reviews[0].submission.kind, 'plan')
  assert.ok(fake.reviews[0].submission.digest)
  assert.deepEqual(fake.reviews[0].reviewers, [{ agent: 'helper2' }, { agent: 'helper1' }])
  assert.equal(fake.state().data.phase, 'awaiting-approval')
  assert.equal(fake.state().data.repairedPlan.digest, digestText('1. Make the change.\n2. Run the proof.'))
  assert.equal(fake.state().data.planReview.route.model, 'local/model')

  await hooks['chat.message.persisted']({ sessionID, messageID: 'msg-internal', origin: 'internal-subagent' }, { parts: [{ type: 'text', text: 'go for it' }] })
  assert.equal(fake.state().data.phase, 'awaiting-approval')
  await hooks['chat.message.persisted']({ sessionID, messageID: 'msg-go', origin: 'external-user' }, { parts: [{ type: 'text', text: 'Ship it.' }] })
  assert.equal(fake.state().data.phase, 'approved')
  assert.equal(fake.state().data.approval.generation, fake.state().generation)

  const admitted = { decision: 'deny' }
  await hooks['tool.execute.admission']({ sessionID, tool: 'edit', callID: 'call-after', args: {}, source: 'builtin', capability: 'mutate' }, admitted)
  assert.equal(admitted.decision, 'allow')

  const reviewCountBeforeMissingReceipt = fake.reviews.length
  const blockedArtifact = await hooks.tool.task_quality_artifact_checkpoint.execute({ artifact: 'This must not invoke a reviewer without evidence.' }, { sessionID, directory: '.', worktree: '.', metadata() {} })
  assert.match(blockedArtifact.output, /receipt is required/)
  assert.equal(fake.reviews.length, reviewCountBeforeMissingReceipt)

  // This is a real plugin hook delivery, not a direct lifecycle helper call.
  // It proves a completed tool output creates only a bounded receipt before an
  // explicit engine-reviewed artifact checkpoint may close the generation.
  await hooks['tool.execute.preexecute']({ sessionID, tool: 'bash', callID: 'call-proof', capability: 'mutate' }, {})
  await hooks['tool.execute.persisted']({ sessionID, tool: 'bash', callID: 'call-proof', completedAt: 50 }, { title: 'ignored', output: 'focused proof passed', metadata: { path: 'C:\\private' } })
  assert.equal(fake.state().data.receipts.length, 1)
  assert.deepEqual(Object.keys(fake.state().data.receipts[0]).sort(), ['callID', 'capturedAt', 'kind', 'outputBytes', 'outputDigest', 'tool'])
  const artifact = await hooks.tool.task_quality_artifact_checkpoint.execute({ artifact: 'Implemented the approved change and observed the focused proof pass.' }, { sessionID, directory: '.', worktree: '.', metadata() {} })
  assert.match(artifact.output, /durably recorded/)
  assert.equal(fake.state().data.phase, 'artifact-reviewed')
  clearRouteHandoff(sessionID)
})

test('checkpoint keeps provider-facing schemas simple but enforces bounded input at execution', async () => {
  const sessionID = 'ses-bounded-input'
  clearRouteHandoff(sessionID)
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: 'msg-task', messages: ['Build a robust feature'], skillNames: ['brainstorming'] }))
  const fake = fakeClient()
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal })
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: [] })

  const empty = await hooks.tool.task_quality_checkpoint.execute({ repaired_plan: 'Plan', acceptance_criteria: [] }, { sessionID, directory: '.', worktree: '.', metadata() {} })
  assert.match(empty.output, /at least one acceptance criterion is required/)
  const oversized = await hooks.tool.task_quality_checkpoint.execute({ repaired_plan: 'x'.repeat(24001), acceptance_criteria: ['Works'] }, { sessionID, directory: '.', worktree: '.', metadata() {} })
  assert.match(oversized.output, /at most 24000 characters/)
  assert.equal(fake.reviews.length, 0)
  clearRouteHandoff(sessionID)
})

test('persisted permission rejection settles only the matching pending execution', async () => {
  const sessionID = 'ses-plugin'
  clearRouteHandoff(sessionID)
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: 'msg-task', messages: ['Build a robust feature'], skillNames: ['brainstorming'] }))
  const fake = fakeClient()
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal })
  await hooks['experimental.chat.system.transform']({ sessionID }, { system: [] })
  await hooks.tool.task_quality_checkpoint.execute({ repaired_plan: '1. Change.', acceptance_criteria: ['Works.'] }, { sessionID, directory: '.', worktree: '.', metadata() {} })
  await hooks['chat.message.persisted']({ sessionID, messageID: 'msg-go', origin: 'external-user' }, { parts: [{ type: 'text', text: 'go for it' }] })
  await hooks['tool.execute.preexecute']({ sessionID, tool: 'edit', callID: 'call-permission', capability: 'mutate' }, {})
  assert.equal(fake.state().data.pendingExecutions.length, 1)
  await hooks['tool.execute.permission_rejected']({ sessionID, tool: 'edit', callID: 'call-permission', rejectedAt: 60 }, {})
  assert.equal(fake.state().data.pendingExecutions.length, 0)
  clearRouteHandoff(sessionID)
})

test('mutation precommit failures reject execution instead of becoming best-effort logs', async () => {
  const fake = fakeClient()
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal })

  await assert.rejects(
    () => hooks['tool.execute.preexecute']({ sessionID: 'ses-plugin', tool: 'edit', callID: 'call-missing', capability: 'mutate' }, {}),
    /no durable task-quality lifecycle exists for mutation precommit/,
  )
})
