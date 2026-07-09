// engram/extract.mjs — turn a messy local-model reply into structured facts. The parser is
// the point: local models wrap JSON in ```fences```, add prose preambles, emit <think> blocks,
// and drop stray braces — all of which must NOT corrupt the extracted object. callLLM is
// injected so extract() is unit-testable with a fake (no model, no network).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExtractionPrompt, parseExtraction, extract,
} from '../../config-template/opencode/engram/extract.mjs'

test('parseExtraction: a clean JSON object round-trips entities + facts', () => {
  const raw = '{"entities":[{"name":"Deco","type":"router"}],"facts":[{"statement":"S","subject":"a","predicate":"b","object":"c","source":"external"}]}'
  const r = parseExtraction(raw)
  assert.deepEqual(r.entities, [{ name: 'Deco', type: 'router' }])
  assert.equal(r.facts.length, 1)
  assert.equal(r.facts[0].statement, 'S')
  assert.equal(r.facts[0].source, 'external')
  assert.ok(!('error' in r))
})

test('parseExtraction: strips ```json fences``` before parsing', () => {
  const raw = '```json\n{"entities":[],"facts":[{"statement":"fenced"}]}\n```'
  const r = parseExtraction(raw)
  assert.equal(r.facts[0].statement, 'fenced')
  assert.equal(r.facts[0].source, 'chat') // no source → defaults to chat
})

test('parseExtraction: removes <think> reasoning blocks (and any braces inside them)', () => {
  const raw = '<think>let me reason { this is not json }</think>{"entities":[],"facts":[{"statement":"kept"}]}'
  const r = parseExtraction(raw)
  assert.equal(r.facts.length, 1)
  assert.equal(r.facts[0].statement, 'kept')
})

test('parseExtraction: a stray/invalid brace before the real object does not corrupt it', () => {
  const raw = 'Sure! {not json} here it is: {"entities":[],"facts":[{"statement":"ok"}]}'
  const r = parseExtraction(raw)
  assert.equal(r.facts[0].statement, 'ok')
})

test('parseExtraction: empty / whitespace / null → "empty reply"', () => {
  for (const raw of ['', '   ', null, undefined]) {
    const r = parseExtraction(raw)
    assert.equal(r.error, 'empty reply')
    assert.deepEqual(r.facts, [])
  }
})

test('parseExtraction: no parseable object → explicit error', () => {
  assert.equal(parseExtraction('just prose, no braces at all').error, 'no parseable json object found')
  assert.equal(parseExtraction('{ broken and never closed').error, 'no parseable json object found')
})

test('parseExtraction: non-scalar field values are dropped (never stringified to garbage)', () => {
  const raw = '{"facts":[{"statement":"s","subject":"a","predicate":"b","object":{"nested":1}}]}'
  const r = parseExtraction(raw)
  assert.equal(r.facts[0].object, null) // an object value would stringify to "[object Object]" — dropped instead
})

test('parseExtraction: source is only "external" when explicitly tagged, else "chat"', () => {
  const ext = parseExtraction('{"facts":[{"statement":"x","source":"external"}]}')
  assert.equal(ext.facts[0].source, 'external')
  const weird = parseExtraction('{"facts":[{"statement":"x","source":"web"}]}')
  assert.equal(weird.facts[0].source, 'chat') // anything other than "external" → chat
})

test('parseExtraction: blank statements are filtered out', () => {
  const r = parseExtraction('{"facts":[{"statement":"   "},{"statement":"real"}]}')
  assert.equal(r.facts.length, 1)
  assert.equal(r.facts[0].statement, 'real')
})

test('buildExtractionPrompt: caps the chunk at 24000 chars and appends extra', () => {
  const big = 'a'.repeat(24000) + 'ZZZ' // the ZZZ sits past the 24000 slice boundary
  const { system, user } = buildExtractionPrompt(big, { extra: 'FOCUS HERE' })
  assert.match(system, /DURABLE/) // the distillation system prompt
  assert.ok(!user.includes('ZZZ'), 'chunk is sliced at 24000 — trailing content dropped')
  assert.match(user, /FOCUS HERE/)
})

test('extract: empty text short-circuits and never calls the model', async () => {
  let called = false
  const r = await extract('   ', async () => { called = true; return '{}' })
  assert.equal(called, false)
  assert.deepEqual(r, { entities: [], facts: [] })
})

test('extract: a good reply flows through the parser; callLLM receives {system,user}', async () => {
  let seen = null
  const r = await extract('some conversation', async (msg) => {
    seen = msg
    return '{"entities":[],"facts":[{"statement":"distilled"}]}'
  })
  assert.equal(r.facts[0].statement, 'distilled')
  assert.ok(seen && typeof seen.system === 'string' && typeof seen.user === 'string')
})

test('extract: a thrown callLLM is caught and reported, never propagated', async () => {
  const r = await extract('text', async () => { throw new Error('backend down') })
  assert.match(r.error, /^llm call: backend down/)
  assert.deepEqual(r.facts, [])
})
