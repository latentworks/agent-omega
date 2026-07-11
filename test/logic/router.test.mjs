// skill-router/router.mjs — the context-free "which skill(s)?" classifier. Pure string
// logic (parseSkills negation handling is the crown jewel) plus the isolated router call
// with an INJECTED fetch, so we prove the reachable/unreachable error tagging with no network.
//
// EXTRACT_URL is read from env at import time; routerCall throws "inert" without it. Set it
// BEFORE importing so the call path is live, then import dynamically. Hermetic vs. ambient env.
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.ROUTER_EXTRACT_URL = 'http://127.0.0.1:9/chat/completions' // truthy → router not inert
process.env.ROUTER_MODEL = 'test-model'
process.env.ROUTER_TIMEOUT_MS = '25'
const {
  buildPrompt, parseSkills, buildDirective, pickModel,
  routerCall, route, classifierIdentity, lastUserMessages, lastUserMessageEntries, isLeadingDirectDecision, EXTRACT_URL, ROUTER_MODEL, ROUTER_TIMEOUT_MS,
} = await import('../../config-template/opencode/skill-router/router.mjs')

const VALID = { debugging: 'debug things', verify: 'verify things', tdd: 'test first' }

test('env override makes the router live and picks the configured model', async () => {
  assert.equal(EXTRACT_URL, 'http://127.0.0.1:9/chat/completions')
  assert.equal(ROUTER_MODEL, 'test-model')
  assert.equal(await pickModel(), 'test-model')
  assert.equal(ROUTER_TIMEOUT_MS, 50)
})

test('parseSkills: finds valid names in order of appearance, ignores prose/unknowns', () => {
  assert.deepEqual(parseSkills('use the debugging skill', VALID), ['debugging'])
  assert.deepEqual(parseSkills('first tdd, then debugging', VALID), ['tdd', 'debugging'])
  assert.deepEqual(parseSkills('none of these apply', VALID), [])
  assert.deepEqual(parseSkills('use frobnicate', VALID), []) // unknown name
  assert.deepEqual(parseSkills('', VALID), [])
})

test('parseSkills: a whole-word boundary is required (no substring false-match)', () => {
  // "verifying" contains "verify" but the trailing "ing" fails the [^a-z0-9-] boundary.
  assert.deepEqual(parseSkills('I am verifying the output', VALID), [])
  assert.deepEqual(parseSkills('debuggingx tddy', VALID), []) // both glued to a letter → no match
})

test('parseSkills: a plain negation suppresses the skill it governs', () => {
  assert.deepEqual(parseSkills('not debugging', VALID), [])
  assert.deepEqual(parseSkills('do not use debugging', VALID), [])
  assert.deepEqual(parseSkills('skip tdd', VALID), [])
  assert.deepEqual(parseSkills('without using verify', VALID), [])
  // negation only kills the name it precedes, not an earlier positive one
  assert.deepEqual(parseSkills('use tdd, not debugging', VALID), ['tdd'])
})

test('parseSkills: a double negative is a POSITIVE instruction to use the skill', () => {
  assert.deepEqual(parseSkills('do not skip debugging', VALID), ['debugging'])
  assert.deepEqual(parseSkills('never avoid verify', VALID), ['verify'])
  assert.deepEqual(parseSkills("don't ignore tdd", VALID), ['tdd'])
})

test('parseSkills: a negation word not governing the name does NOT suppress it', () => {
  // "don't hesitate to use debugging" — "hesitate" breaks the negation→verb chain.
  assert.deepEqual(parseSkills("don't hesitate to use debugging", VALID), ['debugging'])
})

test('buildPrompt: fills {skills} and {messages}, and is $-safe in the replacement', () => {
  const body = 'SK:\n{skills}\nMSG:\n{messages}'
  const out = buildPrompt(body, { a: 'costs $5 for $1' }, ['hello $world'])
  assert.match(out, /SK:\n- a: costs \$5 for \$1/) // literal $ preserved (no $1 backref expansion)
  assert.match(out, /MSG:\n\[user\] hello \$world/)
})

test('buildDirective: empty → "", one vs many skills phrase differently', () => {
  assert.equal(buildDirective([]), '')
  assert.equal(buildDirective(null), '')
  const one = buildDirective(['debugging'])
  assert.match(one, /debugging/)
  assert.match(one, /required first step/)
  const many = buildDirective(['tdd', 'debugging'])
  assert.match(many, /tdd, debugging/)
  assert.match(many, /in the order listed/)
})

test('leading direct decisions bypass classification without treating plan discussion as approval', () => {
  assert.equal(isLeadingDirectDecision('GO.'), true)
  assert.equal(isLeadingDirectDecision('Ship it'), true)
  assert.equal(isLeadingDirectDecision('No.'), true)
  assert.equal(isLeadingDirectDecision("Let's go over the plan before deciding."), false)
  assert.equal(isLeadingDirectDecision('Go add OAuth login too.'), false)
  assert.equal(isLeadingDirectDecision('GO. Execute it now.'), false)
  assert.equal(isLeadingDirectDecision('Should we proceed?'), false)
})

test('classifier identity is endpoint, model, and resolved provider specific', () => {
  const classifier = { url: 'HTTP://127.0.0.1:9101/v1/chat/completions', model: 'model-a', source: 'active-local-model' }
  assert.notEqual(
    classifierIdentity(classifier, { providerID: 'box-a', modelID: 'model-a' }),
    classifierIdentity(classifier, { providerID: 'box-b', modelID: 'model-a' }),
  )
  assert.notEqual(
    classifierIdentity(classifier, { providerID: 'box-a', modelID: 'model-a' }),
    classifierIdentity({ ...classifier, model: 'model-b' }, { providerID: 'box-a', modelID: 'model-b' }),
  )
})

test('lastUserMessages: keeps last N user texts, skips harness re-prompts', () => {
  const mk = (role, text, id = text) => ({ info: { role, id }, parts: [{ type: 'text', text }] })
  const msgs = [
    mk('user', 'first request'),
    mk('assistant', 'reply'),
    mk('user', '[iterate-loop] keep going'),   // harness re-prompt → skipped
    mk('user', '[verify-guard] run the tests'), // harness re-prompt → skipped
    { info: { role: 'user', id: 'internal', origin: 'internal-subagent' }, parts: [{ type: 'text', text: 'internal request' }] },
    mk('user', 'second request'),
    mk('user', 'third request'),
  ]
  assert.deepEqual(lastUserMessages(msgs, 2), ['second request', 'third request'])
  assert.deepEqual(lastUserMessages(msgs, 10), ['first request', 'second request', 'third request'])
  assert.deepEqual(lastUserMessageEntries(msgs, 1), [{ id: 'third request', text: 'third request' }])
})

// ---- routerCall / route with an injected fake fetch (no network) ----
const okFetch = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })

test('route: a good classify reply parses to skill names (injected fetch)', async () => {
  const skills = await route({ routerBody: '{skills}\n{messages}', skills: VALID, messages: ['x'] }, okFetch('use debugging'))
  assert.deepEqual(skills, ['debugging'])
})

test('routerCall: a non-2xx status throws reachable=true (server answered, bad status)', async () => {
  const badStatus = async () => ({ ok: false, status: 500 })
  await assert.rejects(() => routerCall('p', badStatus), (e) => { assert.equal(e.reachable, true); return /HTTP 500/.test(e.message) })
})

test('routerCall: a thrown fetch (connection refused) throws reachable=false', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED') }
  await assert.rejects(() => routerCall('p', boom), (e) => { assert.equal(e.reachable, false); return /connection failed/.test(e.message) })
})

test('routerCall: a fetch that never resolves fails within the bounded classifier budget', async () => {
  const never = () => new Promise(() => {})
  await assert.rejects(() => routerCall('p', never), (e) => { assert.equal(e.code, 'ROUTER_TIMEOUT'); assert.equal(e.reachable, false); return /timed out/.test(e.message) })
})

test('routerCall: a 200 with an unparseable body throws reachable=true (reply unusable)', async () => {
  const badBody = async () => ({ ok: true, json: async () => { throw new Error('not json') } })
  await assert.rejects(() => routerCall('p', badBody), (e) => { assert.equal(e.reachable, true); return /malformed response body/.test(e.message) })
})

test('routerCall: a 200 with empty choices returns "" (no throw)', async () => {
  const empty = async () => ({ ok: true, json: async () => ({}) })
  assert.equal(await routerCall('p', empty), '')
})
