// engram/engine.mjs — the capture engine + EVO extractor + config.
//
// IMPORTANT: this lives separately from index.js because OpenCode treats EVERY
// export of a plugin module as a plugin to load — so index.js must export ONLY its
// default plugin function. All the testable, importable pieces live here instead.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openStore, addEpisode, addFact, upsertEntity } from './store.mjs'
import { extract } from './extract.mjs'
import { selectDropped, buildEpisodeText, projectOf } from './capture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

export const DB_PATH = process.env.ENGRAM_DB || join(HERE, 'engram.db')
export const EVO_URL = process.env.ENGRAM_EVO_URL || ''
// Explicit extractor override — people shipping this will set their own. Empty (the
// default) means: use whatever model is ALREADY LOADED on the box, so writing a memory
// never evicts the model you're talking to. The llama-swap /running endpoint tells us.
export const ENGRAM_MODEL = process.env.ENGRAM_MODEL || ''
const RUNNING_URL = (() => { try { return new URL('/running', EVO_URL).href } catch { return '' } })()
const FALLBACK_MODEL = 'gpt-oss-120b'
export const TAIL_KEEP = Number(process.env.ENGRAM_TAIL_KEEP || 4)
const EXTRACT_TIMEOUT = Number(process.env.ENGRAM_EXTRACT_TIMEOUT || 180000)

// Logs go to a FILE, not stderr — OpenCode renders plugin stderr into the user's
// window, and the user shouldn't see engram's internal chatter. Opt in to on-screen
// logs with ENGRAM_DEBUG=1.
const LOG_FILE = process.env.ENGRAM_LOG || join(tmpdir(), 'engram.log')
const LOG_TO_STDERR = ['1', 'true'].includes(process.env.ENGRAM_DEBUG || '')
export function log(m) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${m}\n`) } catch {}
  if (LOG_TO_STDERR) { try { process.stderr.write(`[engram] ${m}\n`) } catch {} }
}

// Choose the extractor: explicit override, else whatever llama-swap currently has
// loaded (so there's no model swap), else a sane fallback.
export async function pickExtractModel() {
  if (ENGRAM_MODEL) return ENGRAM_MODEL
  try {
    const r = await fetch(RUNNING_URL, { signal: AbortSignal.timeout(8000) })
    if (r.ok) {
      const j = await r.json()
      const list = (j && j.running) || []
      const ready = list.find((m) => m && m.state === 'ready') || list[0]
      if (ready && ready.model) return ready.model
    }
  } catch {}
  return FALLBACK_MODEL
}

// Default extractor: a direct call to the local box using the currently-loaded model.
// Injectable for tests.
export async function evoExtractCall({ system, user }) {
  const model = await pickExtractModel()
  const r = await fetch(EVO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 1500,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(EXTRACT_TIMEOUT),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json()
  return j.choices?.[0]?.message?.content || ''
}

// The capture engine. Pure orchestration over an injected client + extractor, so
// an integration test can drive the real capture path without a live OpenCode server.
export function createEngram({ client, directory, db, callLLM = evoExtractCall } = {}) {
  const store = db || openStore(DB_PATH)
  const watermark = new Map() // sessionID -> messages already captured

  async function captureAtCompaction(sessionID, dir) {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const msgs = (res && res.data) || []
      const { slice, end } = selectDropped(msgs, watermark.get(sessionID) || 0, TAIL_KEEP)
      if (!slice.length) return null
      const content = buildEpisodeText(slice)
      watermark.set(sessionID, end)
      if (content.length < 40) return null
      const project = projectOf(dir || directory)
      const ep = addEpisode(store, { sessionId: sessionID, project, content, capturedAt: Date.now() })
      log(`captured episode ${ep} (${content.length} chars) from ${sessionID}`)
      // BACKGROUND extraction — deliberately not awaited so compaction is never blocked.
      const done = extract(content, callLLM)
        .then((ex) => {
          if (ex.error) { log(`extract failed ep ${ep}: ${ex.error}`); return { added: 0 } }
          const now = Date.now()
          for (const e of ex.entities) upsertEntity(store, { name: e.name, type: e.type, project, t: now })
          let added = 0
          for (const f of ex.facts) {
            const r = addFact(store, { ...f, project, sourceEpisode: ep, createdAt: now })
            if (r && !r.duplicate) added++
          }
          log(`ep ${ep}: stored ${added} new facts of ${ex.facts.length}`)
          return { added, extracted: ex.facts.length }
        })
        .catch((e) => { log(`extract error ep ${ep}: ${e}`); return { added: 0 } })
      return { episode: ep, content, extraction: done }
    } catch (e) {
      log(`capture error: ${e}`)
      return null
    }
  }

  return { store, watermark, captureAtCompaction }
}
