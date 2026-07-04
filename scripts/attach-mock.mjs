#!/usr/bin/env node
// scripts/attach-mock.mjs — self-contained integration proof (plan §6.1). Impersonates a sidecar,
// spawns the REAL attach client (rich path, headless via ATTACH_FORCE_RICH), replays a canned session,
// and ASSERTS every stateful round-trip: token, REST auth, permissionReply optionId, setModel,
// pasted-newline prompt, and reconnect-does-not-replay. Zero model tokens. Exit 0 = all pass.
import { WebSocketServer } from 'ws'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, 'attach.mjs')
const TOKEN = 'mock-token-123'
const APIAUTH = 'Basic ' + Buffer.from('user:pass').toString('base64')
const SID = 'ses_mock_0001'

const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  — ' + (detail || ''))) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let restCalls = 0, restAuthOK = false
const history = [
  { info: { role: 'user' }, parts: [{ type: 'text', text: 'earlier question' }] },
  { info: { role: 'assistant' }, parts: [{ type: 'step-start' }, { type: 'text', text: 'earlier answer' }] },
]

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mock-'))
  const rest = http.createServer((req, res) => {
    restCalls++
    if ((req.headers.authorization || '') === APIAUTH) restAuthOK = true
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(history))
  })
  await new Promise((r) => rest.listen(0, '127.0.0.1', r))
  const apiPort = rest.address().port

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((r) => wss.on('listening', r))
  const port = wss.address().port
  fs.writeFileSync(path.join(tmp, `${process.pid}.json`), JSON.stringify({ port, apiPort, token: TOKEN, pid: process.pid, cwd: tmp }))

  const received = []
  let connCount = 0, tokenSeen = null, ws1 = null
  const waitFor = (pred, ms = 4000) => new Promise((resolve, reject) => {
    const hit = () => received.find(pred)
    if (hit()) return resolve(hit())
    const t = setInterval(() => { const f = hit(); if (f) { clearInterval(t); clearTimeout(to); resolve(f) } }, 20)
    const to = setTimeout(() => { clearInterval(t); reject(new Error('timeout')) }, ms)
  })
  wss.on('connection', (ws, req) => {
    connCount++
    try { tokenSeen = new URL(req.url, 'ws://x').searchParams.get('token') } catch {}
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())) } catch {} })
    if (connCount === 1) ws1 = ws
    ws.send(JSON.stringify({ type: 'ready', sessionId: SID, model: 'qwen3-coder-80b', apiPort, apiAuth: APIAUTH,
      commands: [{ name: 'verify', description: 'verify the work' }],
      models: [{ name: 'qwen3-coder-80b', value: 'evo/qwen3-coder-80b' }, { name: 'gpt-oss-120b', value: 'evo/gpt-oss-120b' }] }))
  })

  const client = spawn(process.execPath, [CLIENT], {
    env: { ...process.env, AGENT_OMEGA_ATTACH_DIR: tmp, ATTACH_FORCE_RICH: '1', ATTACH_HISTORY: '20', AGENT_OMEGA_ATTACH_HISTORY: path.join(tmp, 'hist.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  client.stdout.setEncoding('utf8'); client.stdout.on('data', (s) => { out += s })
  client.stderr.setEncoding('utf8'); client.stderr.on('data', (s) => { out += s })
  const toClient = (s) => client.stdin.write(s)
  const plain = () => out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')

  try {
    await sleep(500)
    ok('client connected', connCount >= 1)
    ok('token sent on WS', tokenSeen === TOKEN, 'got ' + tokenSeen)
    ok('REST history fetched once with correct auth', restCalls === 1 && restAuthOK, `calls=${restCalls} auth=${restAuthOK}`)
    ok('header box rendered', /Agent Omega/.test(plain()))
    ok('history replayed (SKIP_PART skipped)', /earlier answer/.test(plain()) && /earlier question/.test(plain()))

    ws1.send(JSON.stringify({ type: 'turn-start' }))
    ws1.send(JSON.stringify({ type: 'update', update: { sessionUpdate: 'assistant', content: { text: 'Looking at the auth test.\n' } } }))
    ws1.send(JSON.stringify({ type: 'update', update: { toolCall: { title: 'Bash(npm test -- auth)' } } }))
    await sleep(250)
    ok('streamed text rendered', /Looking at the auth test/.test(plain()))
    ok('tool call rendered', /Bash\(npm test -- auth\)/.test(plain()))

    ws1.send(JSON.stringify({ type: 'permission', title: 'Write to tests/auth.test.ts', toolCallId: 'tc_1', options: [{ optionId: 'allow_once', name: 'Allow once' }, { optionId: 'deny', name: 'Deny' }] }))
    await sleep(250)
    ok('permission menu rendered', /Permission required/.test(plain()) && /Allow once/.test(plain()))
    toClient('1')
    const pr = await waitFor((m) => m.type === 'permissionReply').catch(() => null)
    ok('permissionReply: correct toolCallId + optionId', pr && pr.toolCallId === 'tc_1' && pr.optionId === 'allow_once', JSON.stringify(pr))

    ws1.send(JSON.stringify({ type: 'update', update: { content: { text: 'Fixed it.' } } }))
    ws1.send(JSON.stringify({ type: 'turn-end' }))
    await sleep(200)

    toClient('/model 2\r')
    const sm = await waitFor((m) => m.type === 'setModel').catch(() => null)
    ok('setModel: /model 2 → correct value', sm && sm.model === 'evo/gpt-oss-120b', JSON.stringify(sm))

    toClient('\x1b[200~multi line\none\x1b[201~\r')
    const pm = await waitFor((m) => m.type === 'prompt').catch(() => null)
    ok('pasted multiline prompt = ONE frame, newline preserved', pm && pm.text === 'multi line\none', JSON.stringify(pm))

    const restBefore = restCalls
    ws1.close()
    await sleep(1800)
    ok('client reconnected after drop', connCount >= 2, 'conns=' + connCount)
    ok('reconnect did NOT re-fetch history (same session)', restCalls === restBefore, `before=${restBefore} after=${restCalls}`)

    for (const c of wss.clients) { try { c.send(JSON.stringify({ type: 'engine-down', message: 'sidecar exited' })) } catch {} }
    await sleep(200)
    ok('engine-down rendered', /engine down/.test(plain()))
  } catch (e) {
    ok('scenario ran without throwing', false, e.message)
  } finally {
    try { client.kill() } catch {}
    try { wss.close() } catch {}
    try { rest.close() } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    const failed = results.filter((r) => !r.pass).length
    console.log(`\n${results.length - failed}/${results.length} integration checks passed`)
    process.exit(failed ? 1 : 0)
  }
}
main().catch((e) => { console.log('MOCK CRASH:', e.stack || e); process.exit(2) })
