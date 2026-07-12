import assert from 'node:assert/strict'
import test from 'node:test'

const sessionID = 'ses_internal_automation_test'

function client() {
  return {
    session: {
      get: async () => ({ data: {} }),
      promptAsync: async () => { throw new Error('public promptAsync must not be used') },
    },
  }
}

test('iterate-loop resumes through the injected internal automation bridge', async () => {
  const sent = []
  const module = await import(`../../config-template/opencode/iterate-loop/index.js?bridge-test=${Date.now()}`)
  const hooks = await module.default({
    client: client(),
    experimental_internal_automation: { continue: async (input) => sent.push(input) },
  })

  await hooks['tool.execute.after']({ sessionID, tool: 'edit', args: { filePath: 'src/example.js' } }, {})
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID } } })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionID, sessionID)
  assert.match(sent[0].text, /^\[iterate-loop\]/)
})

test('verify-guard resumes through the injected internal automation bridge when its opt-in cap is enabled', async () => {
  const prior = process.env.VERIFY_GUARD_VERIFY_CAP
  process.env.VERIFY_GUARD_VERIFY_CAP = '1'
  try {
    const sent = []
    const module = await import(`../../config-template/opencode/verify-guard/index.js?bridge-test=${Date.now()}`)
    const hooks = await module.default({
      client: client(),
      experimental_internal_automation: { continue: async (input) => sent.push(input) },
    })

    await hooks['tool.execute.after']({ sessionID, tool: 'edit', args: { filePath: 'src/example.js' } }, {})
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID } } })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].sessionID, sessionID)
    assert.match(sent[0].text, /^\[verify-guard\]/)
  } finally {
    if (prior === undefined) delete process.env.VERIFY_GUARD_VERIFY_CAP
    else process.env.VERIFY_GUARD_VERIFY_CAP = prior
  }
})
