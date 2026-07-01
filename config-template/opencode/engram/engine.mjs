// engram/engine.mjs — the capture engine + local extractor + config.
//
// IMPORTANT: this lives separately from index.js because OpenCode treats EVERY
// export of a plugin module as a plugin to load — so index.js must export ONLY its
// default plugin function. All the testable, importable pieces live here instead.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { openStore, addEpisode, addFact, upsertEntity } from './store.mjs'
import { extract } from './extract.mjs'
import { selectDropped, buildEpisodeText, projectOf } from './capture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// Fact distillation reuses the LOCAL provider the user already configured (baseURL + model
// from opencode.json, XDG-aware) — the same box you're talking to — so memory works out of
// the box with no extra endpoint to set up. ENGRAM_EXTRACT_URL / ENGRAM_MODEL override.
function readLocalProvider() {
  try {
    const cfgPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const loc = cfg && cfg.provider && cfg.provider.local
    const baseURL = loc && loc.options && typeof loc.options.baseURL === 'string' ? loc.options.baseURL : ''
    const modelId = loc && loc.models && typeof loc.models === 'object' ? (Object.keys(loc.models)[0] || '') : ''
    return { baseURL, modelId }
  } catch { return { baseURL: '', modelId: '' } }
}
const LOCAL = readLocalProvider()

export const DB_PATH = process.env.ENGRAM_DB || join(HERE, 'engram.db')
// The curated, file-based memory index AGENTS.md promises is "loaded each session". It lives
// beside the plugins at <config>/opencode/memory/MEMORY.md; engram injects it every turn.
export const MEMORY_DIR = process.env.ENGRAM_MEMORY_DIR || join(HERE, '..', 'memory')
export function readMemoryIndex() {
  try {
    const txt = readFileSync(join(MEMORY_DIR, 'MEMORY.md'), 'utf8').trim()
    return txt ? txt.slice(0, 4000) : ''
  } catch { return '' }
}
// baseURL is OpenAI-compatible (…/v1); extraction hits …/v1/chat/completions.
export const EXTRACT_URL = process.env.ENGRAM_EXTRACT_URL || (LOCAL.baseURL ? LOCAL.baseURL.replace(/\/+$/, '') + '/chat/completions' : '')
export const ENGRAM_MODEL = process.env.ENGRAM_MODEL || LOCAL.modelId || ''
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

// The configured local model id (or an explicit ENGRAM_MODEL). OpenAI-compatible servers
// like llama.cpp ignore this field and serve their loaded model; Ollama/LM Studio use it.
export async function pickExtractModel() {
  return ENGRAM_MODEL || 'local-model'
}

// Default extractor: a direct call to the configured local provider. Injectable for tests.
export async function extractCall({ system, user }) {
  if (!EXTRACT_URL) throw new Error('no local provider configured (engram extraction inert)')
  const model = await pickExtractModel()
  const r = await fetch(EXTRACT_URL, {
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
export function createEngram({ client, directory, db, callLLM = extractCall } = {}) {
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
