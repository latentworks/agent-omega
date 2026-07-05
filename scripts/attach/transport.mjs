// scripts/attach/transport.mjs
// WebSocket transport + REST history. Send helpers map to the EXACT existing WS shapes (no protocol
// change). Reconnect backoff per D12: 1s→2s→4s→5s cap, infinite. Uses only `ws`.
// send() RETURNS success so the controller can flag silent data loss during a reconnect.
import { WebSocket } from 'ws'

export function createTransport(d, { onFrame, onOpen, onClose, onError } = {}) {
  let ws = null, quitting = false, backoff = 1000, retryTimer = null
  function connect() {
    const url = `ws://127.0.0.1:${d.port}` + (d.token ? `?token=${encodeURIComponent(d.token)}` : '')
    ws = new WebSocket(url)
    ws.on('open', () => { backoff = 1000; onOpen && onOpen() })
    ws.on('message', (data) => { let m; try { m = JSON.parse(data.toString()) } catch { return } onFrame && onFrame(m) })
    ws.on('error', (e) => onError && onError(e))
    ws.on('close', () => {
      if (quitting) return
      const wait = backoff
      onClose && onClose(wait)
      backoff = Math.min(backoff * 2, 5000)
      retryTimer = setTimeout(connect, wait)
    })
  }
  function send(obj) { try { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true } } catch {} return false }
  return {
    connect,
    close() { quitting = true; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null } try { ws && ws.close() } catch {} },
    isOpen: () => !!ws && ws.readyState === WebSocket.OPEN,
    prompt: (text) => send({ type: 'prompt', text }),
    command: (name, args) => send({ type: 'command', name, args }),
    permissionReply: (toolCallId, optionId) => send({ type: 'permissionReply', toolCallId, optionId }),
    setModel: (model) => send({ type: 'setModel', model }),
    abort: () => send({ type: 'abort' }),
    newSession: () => send({ type: 'new' }),
  }
}

export async function fetchHistory(apiPort, sessionId, apiAuth, historyN) {
  const r = await fetch(`http://127.0.0.1:${apiPort}/session/${sessionId}/message`, apiAuth ? { headers: { Authorization: apiAuth } } : undefined)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const j = await r.json()
  const msgs = Array.isArray(j) ? j : (j.data || j.messages || [])
  return msgs.slice(-historyN)
}
