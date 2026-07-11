// skill-router/router.mjs — pure logic + the isolated, context-free router call.
// Importable/testable (fetch is injectable); index.js holds only the OpenCode wiring.
//
// The idea (the design): the model currently driving this turn is its OWN router. On each turn
// we make a SEPARATE, context-free call — just the request + the skill list — asking
// "which skill(s)?". Stripped of conversation momentum, the same model that ignores
// skills mid-flow classifies them cleanly. We then inject "invoke skill X" into the
// turn's system prompt so the skill actually fires.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

// A loopback or private-LAN host: classifier input is user text, so a renamed
// provider must still be local by endpoint, never merely by an inviting name.
function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return false
}
function isLocalBaseURL(baseURL) {
  try { return isLocalHost(new URL(baseURL).hostname) } catch { return false }
}

function readConfig() {
  try {
    const cfgPath = join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'opencode', 'opencode.json')
    return JSON.parse(readFileSync(cfgPath, 'utf8'))
  } catch { return null }
}
const CONFIG = readConfig()

function configuredProvider(providerID) {
  const provider = CONFIG?.provider?.[providerID]
  const baseURL = typeof provider?.options?.baseURL === 'string' ? provider.options.baseURL : ''
  if (!baseURL || !isLocalBaseURL(baseURL)) return null
  return { providerID, baseURL: baseURL.replace(/\/+$/, ''), provider }
}

function modelFromConfig(value) {
  if (typeof value !== 'string') return null
  const slash = value.indexOf('/')
  if (slash < 1 || slash === value.length - 1) return null
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

// Compatibility helper for diagnostics/tests. It deliberately returns only the
// configured lead when that lead is local; it never guesses an arbitrary local
// provider for a cloud lead.
export function readLocalProvider() {
  const active = modelFromConfig(CONFIG?.model)
  const provider = active && configuredProvider(active.providerID)
  return provider ? { baseURL: provider.baseURL, modelId: active.modelID } : { baseURL: '', modelId: '' }
}

const STATIC_LOCAL = readLocalProvider()
const EXPLICIT_URL = process.env.ROUTER_EXTRACT_URL || ''
const EXPLICIT_MODEL = process.env.ROUTER_MODEL || ''
const explicitEndpointIsSafe = !EXPLICIT_URL || isLocalBaseURL(EXPLICIT_URL)
function chatCompletionsURL(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions'
}

// baseURL is OpenAI-compatible (…/v1); the classify call hits …/v1/chat/completions.
// Explicit overrides are the only permitted cloud-lead fallback. Otherwise each
// call resolves against the engine-attested active model, preserving UI model
// switches and preventing a cold/busy unrelated local model from being chosen.
export const EXTRACT_URL = EXPLICIT_URL
  ? (explicitEndpointIsSafe ? chatCompletionsURL(EXPLICIT_URL) : '')
  : (STATIC_LOCAL.baseURL ? chatCompletionsURL(STATIC_LOCAL.baseURL) : '')
export const ROUTER_MODEL = EXPLICIT_MODEL || STATIC_LOCAL.modelId || ''
export const ROUTER_CONFIG_ERROR = EXPLICIT_URL && !explicitEndpointIsSafe
  ? 'ROUTER_EXTRACT_URL must target a loopback or private-LAN endpoint'
  : ''
export const ROUTER_N      = Number(process.env.ROUTER_N || 3)     // how many recent user messages to read
function boundedMs(value, fallback, min, max) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback
}
// Must finish comfortably inside the engine's 25-second attested-router timeout.
export const ROUTER_TIMEOUT_MS = boundedMs(process.env.ROUTER_TIMEOUT_MS, 4000, 50, 20_000)
export const ROUTER_COOLDOWN_MS = boundedMs(process.env.ROUTER_COOLDOWN_MS, 10_000, 0, 300_000)
// Thinking OFF by default — a classify call needs no chain-of-thought (the spec).
const NOTHINK = !['0', 'false', 'off'].includes(String(process.env.ROUTER_NOTHINK ?? '1').toLowerCase())

// name -> description, read from each skill's frontmatter (the router self-registers:
// add a skill and it appears here automatically). The router skill is excluded.
export function loadSkills(skillDir) {
  const out = {}
  let names = []
  try {
    names = readdirSync(skillDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return out }
  for (const name of names) {
    if (name === 'router') continue
    try {
      const txt = readFileSync(join(skillDir, name, 'SKILL.md'), 'utf8')
      const m = txt.match(/^description:\s*(.+)$/m)
      out[name] = (m ? m[1].trim().replace(/^["']|["']$/g, '') : '').slice(0, 220)
    } catch {}
  }
  return out
}

export function buildPrompt(routerBody, skills, messages) {
  const sk = Object.entries(skills || {}).map(([n, d]) => `- ${n}: ${d}`).join('\n')
  const ms = (messages || []).map((m) => `[user] ${m}`).join('\n')
  return String(routerBody || '').replace('{skills}', () => sk).replace('{messages}', () => ms)
}

// Find the valid skill names mentioned anywhere in the model's output, in the order
// they appear. Robust to comma / newline / stray prose. No valid name => [] (= NONE).
export function parseSkills(output, valid) {
  const text = String(output || '').toLowerCase()
  const found = []
  for (const s of Object.keys(valid || {})) {
    const sl = s.toLowerCase()
    const re = new RegExp(`(^|[^a-z0-9-])${sl.replace(/-/g, '\\-')}([^a-z0-9-]|$)`)
    const idx = text.search(re)
    if (idx < 0) continue
    // Skip a match that's negated ("not debugging", "no verify", "skip tdd", and also the
    // SPACED forms "do not use debugging" / "without using verify"). We allow a short run of
    // filler verbs (use/do/to/the/…) between the negation word and the skill name, but the
    // negation must still govern the name — so "don't hesitate to use debugging" (negation not
    // adjacent to a use-verb chain) is NOT suppressed, and a negation in a prior clause
    // ("use tdd, not debugging") only suppresses the name it actually precedes.
    const before = text.slice(Math.max(0, idx - 40), idx + 1)
    const NEG = /\b(?:not|no|never|skip|without|except|avoid|don'?t|doesn'?t|won'?t|isn'?t|can'?t|cannot)\b(?:\s+(?:use|using|used|do|doing|to|the|a|an|any|invoke|invoking|run|running|apply|applying|call|calling|need|want|include|with|your|our))*\s*[^a-z0-9-]*$/
    // Double negative — "do not skip debugging", "never avoid verify", "don't ignore tdd" — is a
    // POSITIVE instruction to USE the skill: the omission verb (skip/avoid/…) is itself what the
    // outer negator negates, not the skill name. Don't suppress in that case. (Scoped to an
    // omission verb governed by an outer negator; "do not use X" stays a plain negation.)
    const DOUBLE_NEG = /\b(?:not|never|no|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|cannot|can'?t|shouldn'?t)\b\s+(?:ever\s+)?(?:skip|avoid|omit|ignore|exclude|neglect|forget|miss|drop|skimp)\b[^a-z0-9-]*$/
    if (NEG.test(before) && !DOUBLE_NEG.test(before)) continue
    found.push([idx, sl])
  }
  found.sort((a, b) => a[0] - b[0])
  return found.map((f) => f[1])
}

// The forceful, just-in-time directive — the thing a local model obeys (a direct order
// now) where it ignored the standing rule. Injected into the turn's system prompt.
export function buildDirective(skillNames) {
  if (!Array.isArray(skillNames) || !skillNames.length) return ''
  const list = skillNames.join(', ')
  const many = skillNames.length > 1
  return [
    '## Skill router — do this FIRST',
    `This request was matched to the following skill${many ? 's' : ''}: ${list}.`,
    `Before anything else — before writing or editing code, before answering — invoke ${many ? 'these skills' : 'this skill'} by name with your skill tool${many ? ', in the order listed,' : ''} and follow ${many ? 'them' : 'it'}.`,
    'This was selected for this exact request: treat it as a required first step, not a suggestion.',
  ].join(' ')
}

// A standalone, unequivocal user decision belongs to the lifecycle already in
// progress; it is not a new request for the classifier. Keep this deliberately
// stricter than task-quality's approval parser. Any added instruction can alter
// scope, so it must be routed as a new task instead of inheriting an old plan's
// approval. Users can approve a plan with a bare GO/Ship it, then make a
// separately routed change request if they want to extend it.
export function isLeadingDirectDecision(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text || text.includes('?')) return false
  return /^(?:go(?:\s+(?:ahead|for\s+(?:it|gold)))?|approve(?:d)?|proceed|ship\s+it|no|don'?t|do\s+not|not\s+yet|hold|stop|wait|decline|reject)[.!…]*$/.test(text)
}

export function classifierForModel(model) {
  if (ROUTER_CONFIG_ERROR) return { url: '', model: '', source: 'invalid-override', error: ROUTER_CONFIG_ERROR }
  if (EXPLICIT_URL) return { url: EXTRACT_URL, model: EXPLICIT_MODEL || '', source: 'explicit-override' }
  const active = model && typeof model.providerID === 'string' && typeof model.modelID === 'string' ? model : modelFromConfig(CONFIG?.model)
  const provider = active && configuredProvider(active.providerID)
  if (!provider) return { url: '', model: '', source: 'cloud-or-unconfigured' }
  return { url: chatCompletionsURL(provider.baseURL), model: active.modelID, source: 'active-local-model' }
}

// Circuit-breaker identity follows the classifier actually selected for this
// turn. The active provider disambiguates renamed providers that may share an
// endpoint/model during migration; explicit overrides intentionally share one
// breaker regardless of the cloud lead that invoked them.
export function classifierIdentity(classifier, activeModel) {
  const target = classifier || {}
  const provider = target.source === 'active-local-model'
    ? String(activeModel?.providerID || target.source)
    : String(target.source || '')
  return JSON.stringify([
    String(target.url || '').trim().toLowerCase(),
    String(target.model || ''),
    provider,
  ])
}

export async function pickModel(classifier) {
  // OpenAI-compatible servers like llama.cpp ignore model; Ollama/LM Studio use it.
  return classifier?.model || ROUTER_MODEL || 'local-model'
}

function routerError(message, code, reachable = false) {
  const err = new Error(message)
  err.code = code
  err.reachable = reachable
  return err
}

export async function routerCall(prompt, fetchImpl = fetch, classifier) {
  const target = classifier || classifierForModel()
  if (!target?.url) throw routerError(target?.error || 'no explicit classifier configured for this cloud/unconfigured model (router inert)', 'ROUTER_UNCONFIGURED')
  const model = await pickModel(target)
  const body = { model, messages: [{ role: 'user', content: prompt }], max_tokens: 40, temperature: 0 }
  if (NOTHINK) body.chat_template_kwargs = { enable_thinking: false }
  // Tag thrown errors with `.reachable` so the inert notice can tell a connection failure (we never
  // got a response) apart from a classifier that answered with an unusable reply (non-2xx, or a 200
  // with a body we can't parse). A malformed reply must NOT be reported as "unreachable".
  let r
  const controller = new AbortController()
  let timer
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(routerError(`classifier timed out after ${ROUTER_TIMEOUT_MS}ms`, 'ROUTER_TIMEOUT'))
      }, ROUTER_TIMEOUT_MS)
    })
    r = await Promise.race([fetchImpl(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }), timeout])
  } catch (e) {
    if (e?.code === 'ROUTER_TIMEOUT') throw e
    if (controller.signal.aborted || e?.name === 'TimeoutError' || e?.name === 'AbortError') throw routerError(`classifier timed out after ${ROUTER_TIMEOUT_MS}ms`, 'ROUTER_TIMEOUT')
    const err = new Error(`connection failed: ${(e && e.message) || e}`)
    err.reachable = false // never reached the server (refused / DNS / timeout)
    err.code = 'ROUTER_UNAVAILABLE'
    throw err
  } finally { if (timer) clearTimeout(timer) }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`)
    err.reachable = true // the server answered — reachable, just an error status
    err.code = 'ROUTER_BAD_RESPONSE'
    throw err
  }
  let j
  try {
    j = await r.json()
  } catch (e) {
    const err = new Error(`malformed response body: ${(e && e.message) || e}`)
    err.reachable = true // 200 but the body was not valid JSON — reachable, reply unusable
    err.code = 'ROUTER_BAD_RESPONSE'
    throw err
  }
  return j.choices?.[0]?.message?.content || ''
}

// messages -> validated skill names. Injectable fetch for tests.
export async function route({ routerBody, skills, messages, model, classifier }, fetchImpl = fetch) {
  const out = await routerCall(buildPrompt(routerBody, skills, messages), fetchImpl, classifier || classifierForModel(model))
  return parseSkills(out, skills)
}

// Pull the last N user-message texts out of an OpenCode messages list.
export function lastUserMessages(msgs, n) {
  return lastUserMessageEntries(msgs, n).map((message) => message.text)
}

// Keep message identity alongside the text for consumers that need to bind a
// routed task to the exact user turn. `lastUserMessages` remains the compact
// text-only compatibility helper above.
export function lastUserMessageEntries(msgs, n) {
  const users = []
  for (const m of msgs || []) {
    const role = m && m.info && m.info.role
    if (role === 'user') {
      const text = (m.parts || []).filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ').trim()
      // harness re-prompts (iterate-loop / verify-guard) arrive as "user" messages — never route on them
      if (text && m.info?.origin !== 'internal-subagent' && !/^\[(iterate-loop|verify-guard)/.test(text)) users.push({ id: m.info?.id || '', text })
    }
  }
  return users.slice(-n)
}
