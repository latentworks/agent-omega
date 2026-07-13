import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Test-only, one-model transport broker. It deliberately serializes every
// upstream request so title/reviewer/builder traffic cannot overlap on a local
// lane, and it advances only after the previous response ended cleanly.
export async function startSettledThinkingShim(lane, thinking, {
  settlementTimeoutMs = 22 * 60 * 1000,
  idleStreamTimeoutMs = 90_000,
  downstreamDrainTimeoutMs = 30_000,
  capturePath = null,
  caseId = null,
} = {}) {
  const target = new URL(lane.baseURL)
  const receipts = []
  const sockets = new Set()
  const queue = []
  const waiters = []
  let active = null
  let sequence = 0
  let activityVersion = 0
  let halted = null
  let currentTurnCorrelation = null
  let resolveHalt
  const haltedSignal = new Promise((resolve) => { resolveHalt = resolve })
  const captureFd = capturePath ? (() => {
    fs.mkdirSync(path.dirname(capturePath), { recursive: true })
    return fs.openSync(capturePath, 'a')
  })() : null

  const appendCapture = (event) => {
    if (captureFd === null) return
    const line = JSON.stringify({
      recordedAt: new Date().toISOString(),
      monotonicNs: process.hrtime.bigint().toString(),
      caseId,
      ...event,
    }) + '\n'
    fs.writeSync(captureFd, line, null, 'utf8')
    fs.fsyncSync(captureFd)
  }
  const safeHeaders = (headers) => Object.fromEntries(Object.entries(headers || {}).filter(([name]) => {
    const lower = name.toLowerCase()
    return !['authorization', 'proxy-authorization', 'cookie', 'set-cookie'].includes(lower) &&
      !/(?:^|[-_])(?:api[-_]?key|auth|token|secret|credential|session)(?:$|[-_])/.test(lower)
  }))

  const notify = () => { while (waiters.length) waiters.shift()() }
  const halt = (reason, job) => {
    if (halted) return
    const failure = typeof reason === 'string' ? { failureClass: 'transport-failure', message: reason } : reason
    halted = Object.assign(new Error(failure.message), failure)
    if (job?.receipt) Object.assign(job.receipt, { settled: false, failure: failure.message, ...failure, endedAt: Date.now() })
    appendCapture({ type: 'lane-halted', providerRequestId: job?.providerRequestId || null, ...failure })
    resolveHalt({ ...failure, providerRequestId: job?.providerRequestId || null })
    while (queue.length) {
      const queued = queue.shift()
      if (!queued.response.headersSent) queued.response.writeHead(503, { 'content-type': 'application/json' })
      queued.response.end(JSON.stringify({ error: `transport broker halted: ${failure.message}`, failureClass: failure.failureClass }))
    }
    activityVersion++
    notify()
  }

  const pump = () => {
    if (active || halted || queue.length === 0) return
    const job = queue.shift()
    active = job
    activityVersion++
    if (job.receipt) Object.assign(job.receipt, { sequence: job.sequence, startedAt: Date.now() })
    appendCapture({
      type: 'provider-started',
      providerRequestId: job.providerRequestId,
      sequence: job.sequence,
      startedAt: new Date().toISOString(),
      correlation: job.correlation,
    })

    const headers = { ...job.headers, host: target.host }
    delete headers['content-length']
    headers['content-length'] = String(job.body.length)
    let finished = false
    let incoming = null
    let downstreamOpen = !job.response.destroyed
    let sseBuffer = ''
    let upstream
    let idleWatchdog = null
    let drainWatchdog = null
    let lastByteAt = null
    let lastTokenAt = null
    let downstreamClosedAt = null
    let bytesReceived = 0
    let totalChunks = 0
    let keepaliveCount = 0
    let generationFrameCount = 0
    let reportedTokenCount = 0
    let sawDone = false

    const clearIdleWatchdog = () => {
      if (idleWatchdog) clearTimeout(idleWatchdog)
      idleWatchdog = null
    }
    const tokenCount = () => Math.max(generationFrameCount, reportedTokenCount)
    const progressFields = () => ({
      lastTokenAt,
      tokenCount: tokenCount(),
      totalChunks,
      keepaliveCount,
      bytesReceived,
      lastByteAt,
    })
    const armIdleWatchdog = () => {
      clearIdleWatchdog()
      if (sawDone || !idleStreamTimeoutMs) return
      idleWatchdog = setTimeout(() => {
        if (finished || sawDone) return
        const failure = {
          failureClass: 'stream-stall',
          message: `upstream SSE request ${job.sequence} delivered no token-bearing frame for ${idleStreamTimeoutMs}ms`,
          idleStreamTimeoutMs,
          ...progressFields(),
        }
        appendCapture({ type: 'stream-stall', providerRequestId: job.providerRequestId, sequence: job.sequence, ...failure })
        finish(false, failure)
        incoming?.destroy()
        upstream?.destroy()
      }, idleStreamTimeoutMs)
    }

    const clearDrainWatchdog = () => {
      if (drainWatchdog) clearTimeout(drainWatchdog)
      drainWatchdog = null
    }
    const armDrainWatchdog = () => {
      if (drainWatchdog || finished || sawDone || downstreamOpen || !downstreamDrainTimeoutMs) return
      drainWatchdog = setTimeout(() => {
        if (finished || sawDone || downstreamOpen) return
        const failure = {
          failureClass: 'zombie-drain-kill',
          message: `upstream request ${job.sequence} did not reach [DONE] within ${downstreamDrainTimeoutMs}ms after downstream close`,
          downstreamDrainTimeoutMs,
          downstreamClosedAt,
          ...progressFields(),
        }
        appendCapture({ type: 'zombie-drain-kill', providerRequestId: job.providerRequestId, sequence: job.sequence, ...failure })
        finish(false, failure, { haltLane: false, deferPump: true })
        incoming?.destroy()
        upstream?.destroy()
        pump()
      }, downstreamDrainTimeoutMs)
    }

    const noteGenerationProgress = (receivedAt) => {
      generationFrameCount++
      lastTokenAt = receivedAt
      armIdleWatchdog()
    }

    function settleDoneAfterDownstreamGone() {
      if (downstreamOpen || !sawDone || finished) return false
      finish(true, null, { deferPump: true })
      incoming?.destroy()
      upstream?.destroy()
      pump()
      return true
    }

    const deltaAdvancesGeneration = (parsed) => Array.isArray(parsed?.choices) && parsed.choices.some((choice) => {
      const delta = choice?.delta
      if (!delta || typeof delta !== 'object') return false
      if (typeof delta.content === 'string' && delta.content.length > 0) return true
      if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) return true
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true
      if (delta.function_call && typeof delta.function_call === 'object' && Object.keys(delta.function_call).length > 0) return true
      return false
    })

    const processSseFrame = (rawFrame, receivedAt) => {
      const lines = rawFrame.replace(/\r\n/g, '\n').split('\n')
      if (lines.length === 0 || lines.every((line) => line === '')) {
        keepaliveCount++
        return
      }
      if (lines.every((line) => line === '' || line.startsWith(':'))) {
        keepaliveCount++
        return
      }
      const dataLines = lines.filter((line) => line.startsWith('data:'))
      if (dataLines.length === 0) return
      const data = dataLines.map((line) => line.slice(5).replace(/^ /, '')).join('\n')
      if (!data) {
        keepaliveCount++
        return
      }
      if (data.trim() === '[DONE]') {
        sawDone = true
        clearIdleWatchdog()
        clearDrainWatchdog()
        settleDoneAfterDownstreamGone()
        return
      }
      try {
        const parsed = JSON.parse(data)
        const predicted = Number(parsed?.timings?.predicted_n ?? parsed?.timings_per_token?.predicted_n)
        if (Number.isFinite(predicted) && predicted >= 0) reportedTokenCount = Math.max(reportedTokenCount, predicted)
        if (deltaAdvancesGeneration(parsed)) noteGenerationProgress(receivedAt)
      } catch {
        // Malformed or provider-specific frames are captured verbatim, but do
        // not prove generation progress and therefore cannot reset liveness.
      }
    }

    const processSseChunk = (chunk, receivedAt) => {
      sseBuffer += chunk.toString('utf8')
      for (;;) {
        const lfBoundary = sseBuffer.indexOf('\n\n')
        const crlfBoundary = sseBuffer.indexOf('\r\n\r\n')
        const boundary = lfBoundary < 0
          ? crlfBoundary
          : crlfBoundary < 0 ? lfBoundary : Math.min(lfBoundary, crlfBoundary)
        if (boundary < 0) break
        const delimiterLength = boundary === crlfBoundary ? 4 : 2
        const frame = sseBuffer.slice(0, boundary)
        sseBuffer = sseBuffer.slice(boundary + delimiterLength)
        processSseFrame(frame, receivedAt)
      }
      if (sseBuffer.length > 1024 * 1024) sseBuffer = sseBuffer.slice(-1024 * 1024)
    }

    const finish = (clean, reason = null, { haltLane = true, deferPump = false } = {}) => {
      if (finished) return
      finished = true
      clearTimeout(watchdog)
      clearIdleWatchdog()
      clearDrainWatchdog()
      const failure = reason && typeof reason === 'object'
        ? reason
        : reason ? { failureClass: 'transport-failure', message: reason } : null
      if (job.receipt) Object.assign(job.receipt, {
        endedAt: Date.now(),
        settled: clean,
        ...progressFields(),
        ...(failure ? { failure: failure.message, ...failure } : {}),
      })
      appendCapture({
        type: clean ? 'provider-settled' : 'provider-failed',
        providerRequestId: job.providerRequestId,
        sequence: job.sequence,
        settled: clean,
        ...progressFields(),
        ...(failure || {}),
      })
      if (!clean && downstreamOpen && !job.response.destroyed) job.response.destroy(halted || undefined)
      active = null
      activityVersion++
      if (!clean && haltLane) halt(failure || {
        failureClass: 'transport-failure',
        message: `upstream request ${job.sequence} ended without a clean response`,
      }, job)
      notify()
      if (!deferPump) pump()
    }

    const watchdog = setTimeout(() => {
      if (finished) return
      const reason = {
        failureClass: 'total-turn-timeout',
        message: `upstream request ${job.sequence} did not settle within ${settlementTimeoutMs}ms`,
        settlementTimeoutMs,
        lastByteAt,
        bytesReceived,
      }
      finish(false, reason)
      incoming?.destroy()
      upstream?.destroy()
    }, settlementTimeoutMs)

    job.response.once('close', () => {
      downstreamOpen = false
      downstreamClosedAt = new Date().toISOString()
      // Continue consuming briefly so a terminal [DONE] can settle cleanly,
      // but never let a dead stream retain the single-model FIFO indefinitely.
      incoming?.resume()
      if (!settleDoneAfterDownstreamGone()) armDrainWatchdog()
    })

    upstream = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      agent: false,
      method: job.method,
      path: (job.url || '/').startsWith(target.pathname.replace(/\/$/, '') + '/')
        ? job.url
        : `${target.pathname.replace(/\/$/, '')}${(job.url || '/').startsWith('/') ? job.url : `/${job.url || ''}`}`,
      headers,
    }, (response) => {
      incoming = response
      const isSse = /text\/event-stream/i.test(String(response.headers['content-type'] || ''))
      appendCapture({
        type: 'provider-response-head',
        providerRequestId: job.providerRequestId,
        sequence: job.sequence,
        statusCode: response.statusCode || null,
        headers: safeHeaders(response.headers),
        isSse,
      })
      if (isSse) armIdleWatchdog()
      if (!downstreamOpen) armDrainWatchdog()
      if (downstreamOpen && !job.response.headersSent) job.response.writeHead(response.statusCode || 502, response.headers)
      response.on('data', (chunk) => {
        totalChunks++
        bytesReceived += chunk.length
        lastByteAt = new Date().toISOString()
        appendCapture({
          type: isSse ? 'provider-sse-chunk' : 'provider-response-chunk',
          providerRequestId: job.providerRequestId,
          sequence: job.sequence,
          receivedAt: lastByteAt,
          byteLength: chunk.length,
          chunkBase64: chunk.toString('base64'),
        })
        if (isSse) processSseChunk(chunk, lastByteAt)
        if (downstreamOpen && !job.response.destroyed) job.response.write(chunk)
      })
      response.once('end', () => {
        if (downstreamOpen && !job.response.destroyed) job.response.end()
        const clean = !isSse || sawDone
        finish(clean, clean ? null : `upstream SSE request ${job.sequence} ended without [DONE]`)
      })
      response.once('aborted', () => finish(false, `upstream request ${job.sequence} aborted`))
      response.once('error', (error) => finish(false, `upstream request ${job.sequence} failed: ${error.message}`))
    })
    upstream.once('error', (error) => {
      if (downstreamOpen && !job.response.headersSent) job.response.writeHead(502, { 'content-type': 'application/json' })
      if (downstreamOpen && !job.response.destroyed) job.response.end(JSON.stringify({ error: `transport broker upstream failure: ${error.message}` }))
      finish(false, `upstream request ${job.sequence} failed: ${error.message}`)
    })
    upstream.end(job.body)
  }

  const drainClean = async ({ quietMs = 500 } = {}) => {
    for (;;) {
      if (halted) throw halted
      if (active || queue.length) {
        await new Promise((resolve) => waiters.push(resolve))
        continue
      }
      // Internal automation is accepted asynchronously after the outer ACP
      // turn. Require a quiet generation before declaring the lane drained.
      const version = activityVersion
      await pause(quietMs)
      if (halted) throw halted
      if (!active && queue.length === 0 && activityVersion === version) return
    }
  }

  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const original = Buffer.concat(chunks)
      let body = original
      let receipt = null
      if (request.method === 'POST' && /\/chat\/completions(?:\?|$)/.test(request.url || '')) {
        try {
          const parsed = JSON.parse(original.toString('utf8'))
          const engineRequestedNoThinking = parsed.chat_template_kwargs?.enable_thinking === false
          const titleGeneration = Array.isArray(parsed.messages) && parsed.messages.some((message) =>
            message?.role === 'user' && typeof message.content === 'string' &&
            message.content.startsWith('Generate a title for this conversation:\n'))
          const enableThinking = parsed.stream === true && !engineRequestedNoThinking && !titleGeneration ? thinking : false
          parsed.chat_template_kwargs = { ...(parsed.chat_template_kwargs || {}), enable_thinking: enableThinking }
          parsed.timings_per_token = true
          body = Buffer.from(JSON.stringify(parsed))
          receipt = {
            model: parsed.model || null,
            stream: parsed.stream === true,
            role: parsed.stream !== true ? 'router-or-nonstream' : engineRequestedNoThinking ? 'crap-review' : titleGeneration ? 'title-generation' : 'builder',
            enableThinking: parsed.chat_template_kwargs.enable_thinking,
            timingsPerToken: parsed.timings_per_token,
            engineRequestedNoThinking,
            titleGeneration,
          }
          receipts.push(receipt)
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'thinking shim could not parse model request' }))
          return
        }
      }
      const requestSequence = ++sequence
      const providerRequestId = `${caseId || 'case'}-${requestSequence}-${crypto.randomUUID()}`
      const correlation = currentTurnCorrelation ? { ...currentTurnCorrelation } : null
      appendCapture({
        type: 'provider-request',
        providerRequestId,
        sequence: requestSequence,
        admittedAt: new Date().toISOString(),
        method: request.method,
        url: request.url,
        headers: safeHeaders(request.headers),
        bodyByteLength: body.length,
        bodyUtf8: body.toString('utf8'),
        correlation,
      })
      queue.push({
        sequence: requestSequence,
        providerRequestId,
        correlation,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        response,
        receipt,
      })
      activityVersion++
      pump()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('settled thinking shim did not bind a TCP port')

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    receipts,
    capturePath,
    record: appendCapture,
    setTurnCorrelation: (correlation) => { currentTurnCorrelation = correlation ? { ...correlation } : null },
    waitForHalt: () => haltedSignal,
    drainClean,
    get halted() { return halted?.message || null },
    close: async () => {
      let drainError = null
      try { await drainClean() } catch (error) { drainError = error }
      await new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
      if (captureFd !== null) fs.closeSync(captureFd)
      if (drainError) throw drainError
    },
  }
}
