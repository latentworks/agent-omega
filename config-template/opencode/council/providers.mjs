// council/providers.mjs — map a "provider/model" spec + vault env key to an AI-SDK
// LanguageModel, so council members are driven DIRECTLY (no opencode session).
// This is the "tunnel": each member talks straight to its provider with your key.
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// providerID -> { key: <env var>, make(apiKey) -> provider }. Keys match what the
// sidecar injects from the DPAPI vault (see agent-omega/sidecar.mjs vaultEnv).
const SPECS = {
  anthropic: { key: 'ANTHROPIC_API_KEY', make: (k) => createAnthropic({ apiKey: k }) },
  openai: { key: 'OPENAI_API_KEY', make: (k) => createOpenAI({ apiKey: k }) },
  google: { key: 'GOOGLE_GENERATIVE_AI_API_KEY', make: (k) => createGoogleGenerativeAI({ apiKey: k }) },
  deepseek: { key: 'DEEPSEEK_API_KEY', make: (k) => createOpenAICompatible({ name: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: k }) },
  moonshotai: { key: 'MOONSHOT_API_KEY', make: (k) => createOpenAICompatible({ name: 'moonshotai', baseURL: 'https://api.moonshot.ai/v1', apiKey: k }) },
  zai: { key: 'ZAI_API_KEY', make: (k) => createOpenAICompatible({ name: 'zai', baseURL: 'https://api.z.ai/api/paas/v4', apiKey: k }) },
}

// Local OpenAI-compatible endpoints (llama-server / llama-swap) — pulled from the SAME
// opencode.json the main session uses, so a council of LOCAL models works and follows
// whatever endpoints the user configured. No API key required, no duplicated IPs.
function loadLocalSpecs() {
  const out = {}
  try {
    // XDG-aware, like the engine + sidecar — so an isolated instance reads ITS OWN opencode.json
    // (not the shared ~/.config one). Keeps the "same opencode.json the main session uses" promise true.
    const cfgPath = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode', 'opencode.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    for (const [id, p] of Object.entries(cfg.provider || {})) {
      if (SPECS[id]) continue // a cloud provider is already defined above
      const baseURL = p && p.options && p.options.baseURL
      if (!baseURL) continue
      out[id] = { local: true, baseURL, make: (k) => createOpenAICompatible({ name: id, baseURL, apiKey: k || 'local' }) }
    }
  } catch (e) { console.error('council: failed to load local providers from opencode.json —', (e && e.message) || e) }
  return out
}
const LOCAL_SPECS = loadLocalSpecs()

const _cache = {}

// "anthropic/claude-opus-4-8" -> LanguageModel. Throws on unknown provider or
// missing key — the caller (tunnel.mjs) turns that into an honest {error}, never faked.
export function modelFor(spec, env = process.env) {
  const s = String(spec)
  const i = s.indexOf('/')
  if (i < 0) throw new Error(`council: bad model spec "${spec}" (need provider/model)`)
  const providerID = s.slice(0, i)
  const modelID = s.slice(i + 1)
  if (!modelID) throw new Error(`council: bad model spec "${spec}" (empty model id)`)
  const def = SPECS[providerID] || LOCAL_SPECS[providerID]
  if (!def) throw new Error(`council: unknown provider "${providerID}" (cloud: ${Object.keys(SPECS).join(', ')}; local: ${Object.keys(LOCAL_SPECS).join(', ') || 'none configured in opencode.json'})`)
  const apiKey = def.local ? undefined : env[def.key]
  if (!def.local && !apiKey) throw new Error(`council: missing ${def.key} for ${providerID}`)
  const provider = (_cache[`${providerID}\0${apiKey || 'local'}`] ||= def.make(apiKey)) // key on the API key too — a rotated/per-call key must not be silently dropped
  return provider(modelID)
}

export function knownProviders() {
  return Object.keys(SPECS).concat(Object.keys(LOCAL_SPECS))
}
