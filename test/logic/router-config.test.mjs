// Router endpoint selection must work for renamed local providers without ever
// selecting a cloud endpoint. Run each fixture in a child Node process because
// router.mjs reads its XDG config once at module import time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

process.env.ROUTER_COOLDOWN_MS = '20'
// Keep the in-process plugin cases hermetic. Child-process configuration
// fixtures below explicitly remove these overrides before loading router.mjs.
process.env.ROUTER_EXTRACT_URL = 'http://127.0.0.1:9199/v1'
process.env.ROUTER_MODEL = 'test-router'
const ROUTER_URL = pathToFileURL(resolve('config-template/opencode/skill-router/router.mjs')).href
const ROUTER_PLUGIN_URL = pathToFileURL(resolve('config-template/opencode/skill-router/index.js')).href

test('router uses the attested v1 plugin-module shape required for its private engine bridge', async () => {
  const mod = await import(ROUTER_PLUGIN_URL)
  assert.equal(mod.default?.id, 'agent-omega.skill-router')
  assert.equal(typeof mod.default?.server, 'function')
})

test('a native standalone GO opens and settles the exact router ticket before system transform', async () => {
  const mod = await import(ROUTER_PLUGIN_URL)
  const calls = []
  const hooks = await mod.default.server({
    client: { session: { async messages() { return { data: [] } } } },
    experimental_task_router: {
      begin(input) { calls.push(['begin', input]); return { token: 'ticket' } },
      settle(ticket, handoff) { calls.push(['settle', ticket, handoff]) },
    },
  })
  await hooks['chat.message'](
    { sessionID: 'ses-persisted-go', messageID: 'msg-go', origin: 'external-user' },
    { parts: [{ type: 'text', text: 'GO.' }] },
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'begin')
  assert.deepEqual(calls[0][1], { sessionID: 'ses-persisted-go', messageID: 'msg-go', taskKey: calls[1][2].taskKey })
  assert.equal(calls[1][0], 'settle')
  assert.equal(calls[1][2].qualifies, false)
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses-persisted-go' }, { system: [] })
  assert.equal(calls.length, 2)
})

test('a stale nonempty message list cannot replace the current native message ticket', async () => {
  const mod = await import(ROUTER_PLUGIN_URL)
  const calls = []
  const hooks = await mod.default.server({
    client: {
      session: {
        async messages() {
          return { data: [{ info: { role: 'user', id: 'msg-old' }, parts: [{ type: 'text', text: 'NO.' }] }] }
        },
      },
    },
    experimental_task_router: {
      begin(input) { calls.push(['begin', input]); return { token: String(calls.length) } },
      settle(ticket, handoff) { calls.push(['settle', ticket, handoff]) },
    },
  })
  await hooks['chat.message'](
    { sessionID: 'ses-stale-list', messageID: 'msg-new', origin: 'external-user' },
    { parts: [{ type: 'text', text: 'GO.' }] },
  )
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses-stale-list' }, { system: [] })
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1].messageID, 'msg-new')
  assert.equal(calls[1][2].messageID, 'msg-new')
})

test('classifier failure fails the attested ticket, cools down, then recovers on a later request', async () => {
  const mod = await import(ROUTER_PLUGIN_URL)
  const calls = []
  const toasts = []
  const hooks = await mod.default.server({
    client: {
      session: { async messages() { return { data: [] } } },
      tui: { async showToast(input) { toasts.push(input.body.message) } },
    },
    experimental_task_router: {
      begin(input) { calls.push(['begin', input]); return { token: String(calls.length) } },
      settle(ticket, handoff) { calls.push(['settle', ticket, handoff]) },
      fail(ticket) { calls.push(['fail', ticket]) },
    },
  })
  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => { fetches++; throw new Error('ECONNREFUSED') }
  try {
    await hooks['chat.message.persisted'](
      { sessionID: 'ses-router-degraded', messageID: 'msg-one', origin: 'external-user', model: { providerID: 'evo', modelID: 'qwen3-coder-80b' } },
      { parts: [{ type: 'text', text: 'please plan a change' }] },
    )
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses-router-degraded', model: {} }, { system: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(fetches, 1)
    assert.equal(calls.some(([kind]) => kind === 'fail'), true)
    assert.equal(toasts.some((message) => /automatic skill routing is off|temporarily degraded/.test(message)), true)

    await hooks['chat.message.persisted'](
      { sessionID: 'ses-router-cooldown', messageID: 'msg-two', origin: 'external-user', model: { providerID: 'evo', modelID: 'qwen3-coder-80b' } },
      { parts: [{ type: 'text', text: 'please plan a second change' }] },
    )
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses-router-cooldown', model: {} }, { system: [] })
    assert.equal(fetches, 1)
    assert.equal(calls.filter(([kind]) => kind === 'fail').length, 2)

    await new Promise((resolve) => setTimeout(resolve, 30))
    globalThis.fetch = async () => { fetches++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'NONE' } }] }) } }
    await hooks['chat.message.persisted'](
      { sessionID: 'ses-router-recovered', messageID: 'msg-three', origin: 'external-user', model: { providerID: 'evo', modelID: 'qwen3-coder-80b' } },
      { parts: [{ type: 'text', text: 'please plan a third change' }] },
    )
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses-router-recovered', model: {} }, { system: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(fetches, 2)
    assert.equal(calls.some(([kind]) => kind === 'settle'), true)
    assert.equal(toasts.some((message) => /recovered/.test(message)), true)
  } finally { globalThis.fetch = originalFetch }
})

test('internal-subagent persisted messages never create a ticket or classifier call', async () => {
  const mod = await import(ROUTER_PLUGIN_URL)
  const calls = []
  const hooks = await mod.default.server({
    client: { session: { async messages() { return { data: [] } } } },
    experimental_task_router: { begin(input) { calls.push(input); return {} } },
  })
  await hooks['chat.message.persisted'](
    { sessionID: 'ses-internal', messageID: 'msg-internal', origin: 'internal-subagent', model: { providerID: 'evo', modelID: 'qwen3-coder-80b' } },
    { parts: [{ type: 'text', text: 'internal request' }] },
  )
  assert.deepEqual(calls, [])
})

function inspectRouter(config) {
  const root = mkdtempSync(join(tmpdir(), 'agent-omega-router-config-'))
  const cfgDir = join(root, 'opencode')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify(config))
  const env = { ...process.env, XDG_CONFIG_HOME: root }
  delete env.ROUTER_EXTRACT_URL
  delete env.ROUTER_MODEL
  try {
    const script = `import(${JSON.stringify(ROUTER_URL)}).then((m) => process.stdout.write(JSON.stringify({ url: m.EXTRACT_URL, model: m.ROUTER_MODEL })))`
    const out = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    return JSON.parse(out.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

function inspectClassifier(config, model, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-omega-router-classifier-'))
  const cfgDir = join(root, 'opencode')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify(config))
  const childEnv = { ...process.env, XDG_CONFIG_HOME: root, ...env }
  if (!Object.prototype.hasOwnProperty.call(env, 'ROUTER_EXTRACT_URL')) delete childEnv.ROUTER_EXTRACT_URL
  if (!Object.prototype.hasOwnProperty.call(env, 'ROUTER_MODEL')) delete childEnv.ROUTER_MODEL
  try {
    const script = `import(${JSON.stringify(ROUTER_URL)}).then((m) => process.stdout.write(JSON.stringify(m.classifierForModel(${JSON.stringify(model)}))))`
    const out = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env: childEnv, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    return JSON.parse(out.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

function runPluginRoutes(config, steps, { failedURLs = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-omega-router-breaker-'))
  const cfgDir = join(root, 'opencode')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify(config))
  const env = { ...process.env, XDG_CONFIG_HOME: root, ROUTER_COOLDOWN_MS: '60000' }
  delete env.ROUTER_EXTRACT_URL
  delete env.ROUTER_MODEL
  const script = `
    const events = []
    const fetches = []
    const failed = new Set(${JSON.stringify(failedURLs)})
    globalThis.fetch = async (url) => {
      fetches.push(String(url))
      if (failed.has(String(url))) throw new Error('ECONNREFUSED')
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'NONE' } }] }) }
    }
    const mod = await import(${JSON.stringify(ROUTER_PLUGIN_URL)})
    const hooks = await mod.default.server({
      client: { session: { async messages() { return { data: [] } } } },
      experimental_task_router: {
        begin(input) { events.push(['begin', input.sessionID]); return { sessionID: input.sessionID } },
        settle(ticket) { events.push(['settle', ticket.sessionID]) },
        fail(ticket) { events.push(['fail', ticket.sessionID]) },
      },
    })
    for (const step of ${JSON.stringify(steps)}) {
      await hooks['chat.message.persisted'](
        { sessionID: step.sessionID, messageID: step.messageID, origin: 'external-user', model: step.model },
        { parts: [{ type: 'text', text: step.text }] },
      )
      await hooks['experimental.chat.system.transform']({ sessionID: step.sessionID, model: step.model }, { system: [] })
    }
    process.stdout.write(JSON.stringify({ events, fetches }))
  `
  try {
    const out = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    return JSON.parse(out.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('router honors a documented local provider and its selected main model', () => {
  const result = inspectRouter({
    model: 'local/selected',
    provider: { local: { options: { baseURL: 'http://127.0.0.1:8080/v1' }, models: { selected: {}, fallback: {} } } },
  })
  assert.deepEqual(result, { url: 'http://127.0.0.1:8080/v1/chat/completions', model: 'selected' })
})

test('router binds classifier endpoint and model to the engine-attested active local model', () => {
  const lanHost = ['10', '0', '0', '9'].join('.')
  const config = {
    model: 'workstation/lead-model',
    provider: {
      cloud: { options: { baseURL: 'https://api.example.invalid/v1' }, models: { cloud: {} } },
      workstation: { options: { baseURL: `http://${lanHost}:9101/v1` }, models: { 'lead-model': {}, fallback: {} } },
      otherLocal: { options: { baseURL: 'http://127.0.0.1:9102/v1' }, models: { other: {} } },
    },
  }
  const result = inspectClassifier(config, { providerID: 'otherLocal', modelID: 'other' })
  assert.deepEqual(result, { url: 'http://127.0.0.1:9102/v1/chat/completions', model: 'other', source: 'active-local-model' })
})

test('a failed classifier cools only its endpoint/model/provider across sessions', () => {
  const firstURL = 'http://127.0.0.1:9201/v1/chat/completions'
  const secondURL = 'http://127.0.0.1:9202/v1/chat/completions'
  const result = runPluginRoutes(
    {
      model: 'first/model-a',
      provider: {
        first: { options: { baseURL: 'http://127.0.0.1:9201/v1' }, models: { 'model-a': {} } },
        second: { options: { baseURL: 'http://127.0.0.1:9202/v1' }, models: { 'model-b': {} } },
      },
    },
    [
      { sessionID: 'ses-failed-endpoint', messageID: 'msg-one', model: { providerID: 'first', modelID: 'model-a' }, text: 'plan the first change' },
      { sessionID: 'ses-healthy-endpoint', messageID: 'msg-two', model: { providerID: 'second', modelID: 'model-b' }, text: 'plan the second change' },
    ],
    { failedURLs: [firstURL] },
  )
  assert.deepEqual(result.fetches, [firstURL, secondURL])
  assert.equal(result.events.some(([kind, sessionID]) => kind === 'fail' && sessionID === 'ses-failed-endpoint'), true)
  assert.equal(result.events.some(([kind, sessionID]) => kind === 'settle' && sessionID === 'ses-healthy-endpoint'), true)
})

test('an intentionally inert cloud turn does not cool a later local classifier', () => {
  const localURL = 'http://127.0.0.1:9301/v1/chat/completions'
  const result = runPluginRoutes(
    {
      model: 'cloud/main',
      provider: {
        cloud: { options: { baseURL: 'https://api.example.invalid/v1' }, models: { main: {} } },
        localbox: { options: { baseURL: 'http://127.0.0.1:9301/v1' }, models: { worker: {} } },
      },
    },
    [
      { sessionID: 'ses-inert-cloud', messageID: 'msg-cloud', model: { providerID: 'cloud', modelID: 'main' }, text: 'plan the cloud change' },
      { sessionID: 'ses-local-after-cloud', messageID: 'msg-local', model: { providerID: 'localbox', modelID: 'worker' }, text: 'plan the local change' },
    ],
  )
  assert.deepEqual(result.fetches, [localURL])
  assert.equal(result.events.some(([kind, sessionID]) => kind === 'fail' && sessionID === 'ses-inert-cloud'), true)
  assert.equal(result.events.some(([kind, sessionID]) => kind === 'settle' && sessionID === 'ses-local-after-cloud'), true)
})

test('cloud lead remains inert instead of silently selecting an arbitrary private provider', () => {
  const lanHost = ['10', '0', '0', '10'].join('.')
  const result = inspectRouter({
    model: 'cloud/main',
    provider: {
      local: { options: { baseURL: 'https://public.example.invalid/v1' }, models: { leaked: {} } },
      workstation: { options: { baseURL: `http://${lanHost}:9102/v1` }, models: { 'lead-model': {} } },
    },
  })
  assert.deepEqual(result, { url: '', model: '' })
})

test('explicit local override is the only permitted cloud-lead classifier fallback', () => {
  const result = inspectClassifier(
    { model: 'cloud/main', provider: { cloud: { options: { baseURL: 'https://api.example.invalid/v1' }, models: { main: {} } } } },
    { providerID: 'cloud', modelID: 'main' },
    { ROUTER_EXTRACT_URL: 'http://127.0.0.1:9102/v1', ROUTER_MODEL: 'router-model' },
  )
  assert.deepEqual(result, { url: 'http://127.0.0.1:9102/v1/chat/completions', model: 'router-model', source: 'explicit-override' })
})

test('router remains inert when only public endpoints exist', () => {
  const result = inspectRouter({
    model: 'cloud/main',
    provider: { cloud: { options: { baseURL: 'https://api.example.invalid/v1' }, models: { main: {} } } },
  })
  assert.deepEqual(result, { url: '', model: '' })
})
