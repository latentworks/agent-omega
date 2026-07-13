import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startSettledThinkingShim } from '../live/settled-provider-shim.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const listen = async (handler) => {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  return { server, baseURL: `http://127.0.0.1:${address.port}/v1` }
}
const close = (server) => new Promise((resolve) => server.close(resolve))
const body = JSON.stringify({ model: 'test', stream: false, messages: [] })
const request = (url) => new Promise((resolve, reject) => {
  const req = http.request(`${url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
    response.resume()
    response.once('end', () => resolve(response.statusCode))
  })
  req.once('error', reject)
  req.end(body)
})
const streamRequest = (url) => new Promise((resolve, reject) => {
  const req = http.request(`${url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.once('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    response.once('aborted', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), aborted: true }))
  })
  req.once('error', reject)
  req.end(JSON.stringify({ model: 'test', stream: true, messages: [] }))
})

test('downstream disconnect still waits for the natural upstream end', async (t) => {
  let completed = false
  const upstream = await listen((req, res) => {
    req.resume()
    setTimeout(() => { completed = true; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }, 150)
  })
  const shim = await startSettledThinkingShim(upstream, false, { settlementTimeoutMs: 1000 })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  const req = http.request(`${shim.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } })
  req.on('error', () => {})
  req.end(body)
  await pause(25)
  req.destroy()
  await shim.drainClean({ quietMs: 10 })
  assert.equal(completed, true)
  assert.equal(shim.receipts[0].settled, true)
})

test('simultaneous requests are FIFO with only one active upstream', async (t) => {
  let active = 0
  let maxActive = 0
  let nextID = 0
  const order = []
  const upstream = await listen((req, res) => {
    const id = ++nextID
    order.push(`start-${id}`)
    active++
    maxActive = Math.max(maxActive, active)
    req.resume()
    setTimeout(() => { active--; order.push(`end-${id}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }, 75)
  })
  const shim = await startSettledThinkingShim(upstream, false, { settlementTimeoutMs: 1000 })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  assert.deepEqual(await Promise.all([request(shim.baseURL), request(shim.baseURL)]), [200, 200])
  await shim.drainClean({ quietMs: 10 })
  assert.equal(maxActive, 1)
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2'])
  assert.deepEqual(shim.receipts.map((item) => item.sequence), [1, 2])
})

test('drain requires a quiet generation and catches late internal traffic', async (t) => {
  let completed = false
  const upstream = await listen((req, res) => {
    req.resume()
    setTimeout(() => { completed = true; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }, 80)
  })
  const shim = await startSettledThinkingShim(upstream, false, { settlementTimeoutMs: 1000 })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  const draining = shim.drainClean({ quietMs: 100 })
  await pause(20)
  const late = request(shim.baseURL)
  await draining
  await late
  assert.equal(completed, true)
})

test('an upstream settlement timeout halts the lane and refuses queued work', async (t) => {
  let started = 0
  const upstream = await listen((req, res) => {
    started++
    req.resume()
    if (started > 1) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }
  })
  const shim = await startSettledThinkingShim(upstream, false, { settlementTimeoutMs: 100 })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  const first = request(shim.baseURL).catch(() => null)
  const second = request(shim.baseURL)
  await assert.rejects(shim.drainClean({ quietMs: 10 }), /did not settle/)
  assert.equal(await second, 503)
  await first
  assert.equal(started, 1)
  assert.match(shim.halted, /did not settle/)
  assert.equal(shim.receipts[0].settled, false)
})

test('keepalive-only SSE fires the token-liveness watchdog', async (t) => {
  const capturePath = path.join(os.tmpdir(), `omega-keepalive-capture-${process.pid}-${Date.now()}.ndjson`)
  let upstreamCloseCount = 0
  const upstream = await listen((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let heartbeat = 0
    const timer = setInterval(() => res.write(++heartbeat % 2 ? ':\n\n' : 'data:\n\n'), 15)
    res.once('close', () => { upstreamCloseCount++; clearInterval(timer) })
  })
  const shim = await startSettledThinkingShim(upstream, false, {
    settlementTimeoutMs: 1000,
    idleStreamTimeoutMs: 70,
    capturePath,
    caseId: 'keepalive-only',
  })
  t.after(async () => {
    await shim.close().catch(() => {})
    await close(upstream.server)
    fs.rmSync(capturePath, { force: true })
  })
  await streamRequest(shim.baseURL).catch(() => null)
  await assert.rejects(shim.drainClean({ quietMs: 10 }), (error) => error.failureClass === 'stream-stall')
  assert.equal(shim.receipts[0].failureClass, 'stream-stall')
  assert.equal(shim.receipts[0].tokenCount, 0)
  assert.ok(shim.receipts[0].keepaliveCount >= 3)
  const records = fs.readFileSync(capturePath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(records.filter((record) => record.type === 'stream-stall').length, 1)
  assert.equal(records.filter((record) => record.type === 'provider-failed').length, 1)
  assert.equal(records.filter((record) => record.type === 'lane-halted').length, 1)
  assert.equal(upstreamCloseCount, 1)
})

test('mid-stream generation silence triggers stream-stall despite timing-only frames', async (t) => {
  const upstream = await listen((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
    const timer = setInterval(() => res.write('data: {"timings":{"predicted_n":1}}\n\n'), 15)
    res.once('close', () => clearInterval(timer))
  })
  const shim = await startSettledThinkingShim(upstream, false, { settlementTimeoutMs: 1000, idleStreamTimeoutMs: 75 })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  await streamRequest(shim.baseURL).catch(() => null)
  await assert.rejects(shim.drainClean({ quietMs: 10 }), (error) => error.failureClass === 'stream-stall')
  assert.equal(shim.receipts[0].failureClass, 'stream-stall')
  assert.match(shim.receipts[0].lastTokenAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(shim.receipts[0].tokenCount, 1)
  assert.ok(shim.receipts[0].bytesReceived > 0)
})

test('slow but real SSE progress below the token deadline stays alive', async (t) => {
  const upstream = await listen((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let count = 0
    const timer = setInterval(() => {
      count++
      res.write(`data: {"choices":[{"delta":{"content":"${count}"}}]}\n\n`)
      if (count === 3) {
        clearInterval(timer)
        res.end('data: [DONE]\n\n')
      }
    }, 40)
  })
  const shim = await startSettledThinkingShim(upstream, false, { settlementTimeoutMs: 1000, idleStreamTimeoutMs: 70 })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  const result = await streamRequest(shim.baseURL)
  assert.equal(result.statusCode, 200)
  await shim.drainClean({ quietMs: 10 })
  assert.equal(shim.halted, null)
  assert.equal(shim.receipts[0].settled, true)
})

test('reasoning and tool-call deltas both count as generation progress', async (t) => {
  const upstream = await listen((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    setTimeout(() => res.write('data: {"choices":[{"delta":{"reasoning_content":"inspect"}}]}\r\n\r\n'), 35)
    setTimeout(() => res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\r\n\r\n'), 70)
    setTimeout(() => res.end('data: [DONE]\r\n\r\n'), 105)
  })
  const shim = await startSettledThinkingShim(upstream, false, { settlementTimeoutMs: 1000, idleStreamTimeoutMs: 60 })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  const result = await streamRequest(shim.baseURL)
  assert.equal(result.statusCode, 200)
  await shim.drainClean({ quietMs: 10 })
  assert.equal(shim.receipts[0].settled, true)
  assert.equal(shim.receipts[0].tokenCount, 2)
})

test('silence after DONE does not trigger the idle watchdog', async (t) => {
  const upstream = await listen((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: [DONE]\n\n')
    setTimeout(() => res.end(), 150)
  })
  const shim = await startSettledThinkingShim(upstream, false, { settlementTimeoutMs: 1000, idleStreamTimeoutMs: 50 })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  const result = await streamRequest(shim.baseURL)
  assert.equal(result.statusCode, 200)
  await shim.drainClean({ quietMs: 10 })
  assert.equal(shim.halted, null)
  assert.equal(shim.receipts[0].settled, true)
})

test('abandoned downstream has a hard drain grace even while real tokens continue', async (t) => {
  let started = 0
  const upstream = await listen((req, res) => {
    started++
    req.resume()
    if (started === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
      const timer = setInterval(() => res.write('data: {"choices":[{"delta":{"content":"still-running"}}]}\n\n'), 10)
      res.once('close', () => clearInterval(timer))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const shim = await startSettledThinkingShim(upstream, false, {
    settlementTimeoutMs: 1000,
    idleStreamTimeoutMs: 500,
    downstreamDrainTimeoutMs: 60,
  })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  let firstResponse
  const firstHead = new Promise((resolve, reject) => {
    const req = http.request(`${shim.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      firstResponse = response
      response.once('data', () => resolve())
    })
    req.once('error', reject)
    req.end(JSON.stringify({ model: 'test', stream: true, messages: [] }))
  })
  await firstHead
  firstResponse.destroy()
  const secondStatus = await request(shim.baseURL)
  await shim.drainClean({ quietMs: 10 })
  assert.equal(secondStatus, 200)
  assert.equal(started, 2)
  assert.equal(shim.receipts[0].failureClass, 'zombie-drain-kill')
  assert.equal(shim.receipts[0].settled, false)
  assert.equal(shim.receipts[1].settled, true)
  assert.equal(shim.halted, null)
})

test('abandoned downstream accepts DONE without HTTP end inside the drain grace window as clean and advances FIFO', async (t) => {
  let started = 0
  const upstream = await listen((req, res) => {
    started++
    req.resume()
    if (started > 1) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
    setTimeout(() => res.write('data: [DONE]\n\n'), 40)
  })
  const shim = await startSettledThinkingShim(upstream, false, {
    settlementTimeoutMs: 1000,
    idleStreamTimeoutMs: 500,
    downstreamDrainTimeoutMs: 80,
  })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  let firstResponse
  const firstHead = new Promise((resolve, reject) => {
    const req = http.request(`${shim.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      firstResponse = response
      response.once('data', () => resolve())
    })
    req.once('error', reject)
    req.end(JSON.stringify({ model: 'test', stream: true, messages: [] }))
  })
  await firstHead
  firstResponse.destroy()
  const secondStatus = await request(shim.baseURL)
  await shim.drainClean({ quietMs: 10 })
  assert.equal(secondStatus, 200)
  assert.equal(started, 2)
  assert.equal(shim.receipts[0].settled, true)
  assert.equal(shim.receipts[0].failureClass, undefined)
  assert.equal(shim.receipts[1].settled, true)
  assert.equal(shim.halted, null)
})

test('DONE before downstream close still settles cleanly and advances FIFO', async (t) => {
  let started = 0
  const upstream = await listen((req, res) => {
    started++
    req.resume()
    if (started > 1) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
    setTimeout(() => res.write('data: [DONE]\n\n'), 20)
  })
  const shim = await startSettledThinkingShim(upstream, false, {
    settlementTimeoutMs: 1000,
    idleStreamTimeoutMs: 500,
    downstreamDrainTimeoutMs: 80,
  })
  t.after(async () => { await shim.close().catch(() => {}); await close(upstream.server) })
  let firstResponse
  const doneReceived = new Promise((resolve, reject) => {
    const req = http.request(`${shim.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      firstResponse = response
      let received = ''
      response.on('data', (chunk) => {
        received += chunk.toString('utf8')
        if (received.includes('data: [DONE]')) resolve()
      })
    })
    req.once('error', reject)
    req.end(JSON.stringify({ model: 'test', stream: true, messages: [] }))
  })
  await doneReceived
  firstResponse.destroy()
  const secondStatus = await request(shim.baseURL)
  await shim.drainClean({ quietMs: 10 })
  assert.equal(secondStatus, 200)
  assert.equal(started, 2)
  assert.equal(shim.receipts[0].settled, true)
  assert.equal(shim.receipts[1].settled, true)
  assert.equal(shim.halted, null)
})

test('provider capture persists the full forwarded body and every response chunk without authorization', async (t) => {
  const capturePath = path.join(os.tmpdir(), `omega-provider-capture-${process.pid}-${Date.now()}.ndjson`)
  const upstream = await listen((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'captured', 'set-cookie': 'session=response-secret' })
    res.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  const shim = await startSettledThinkingShim(upstream, false, {
    settlementTimeoutMs: 1000,
    idleStreamTimeoutMs: 200,
    capturePath,
    caseId: 'capture-test',
  })
  t.after(async () => {
    await shim.close().catch(() => {})
    await close(upstream.server)
    fs.rmSync(capturePath, { force: true })
  })
  shim.setTurnCorrelation({ harnessTurnCorrelationId: 'turn-correlation' })
  const forwarded = JSON.stringify({ model: 'test-model', stream: true, max_tokens: 17, messages: [{ role: 'user', content: 'full body' }] })
  const result = await new Promise((resolve, reject) => {
    const req = http.request(`${shim.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer must-not-persist',
        cookie: 'session=request-secret',
        'x-auth-token': 'must-not-persist-either',
        'x-openai-api-key': 'must-not-persist-api-key',
      },
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    req.once('error', reject)
    req.end(forwarded)
  })
  assert.equal(result, 200)
  await shim.drainClean({ quietMs: 10 })
  const records = fs.readFileSync(capturePath, 'utf8').trim().split('\n').map(JSON.parse)
  const requestRecord = records.find((record) => record.type === 'provider-request')
  assert.equal(JSON.parse(requestRecord.bodyUtf8).max_tokens, 17)
  assert.equal(JSON.parse(requestRecord.bodyUtf8).chat_template_kwargs.enable_thinking, false)
  assert.equal(JSON.parse(requestRecord.bodyUtf8).timings_per_token, true)
  assert.equal(requestRecord.headers.authorization, undefined)
  assert.equal(requestRecord.headers.cookie, undefined)
  assert.equal(requestRecord.headers['x-auth-token'], undefined)
  assert.equal(requestRecord.headers['x-openai-api-key'], undefined)
  assert.equal(records.find((record) => record.type === 'provider-response-head').headers['set-cookie'], undefined)
  assert.equal(requestRecord.correlation.harnessTurnCorrelationId, 'turn-correlation')
  assert.equal(records.filter((record) => record.type === 'provider-sse-chunk').length, 2)
  assert.equal(records.filter((record) => record.type === 'provider-settled').length, 1)
  assert.equal(fs.readFileSync(capturePath, 'utf8').endsWith('\n'), true)
})
