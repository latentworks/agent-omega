// skill-router/router.mjs — pure logic + the isolated, context-free router call.
// Importable/testable (fetch is injectable); index.js holds only the OpenCode wiring.
//
// The idea (Austin's design): the model that's loaded is its OWN router. On each turn
// we make a SEPARATE, context-free call — just the request + the skill list — asking
// "which skill(s)?". Stripped of conversation momentum, the same model that ignores
// skills mid-flow classifies them cleanly. We then inject "invoke skill X" into the
// turn's system prompt so the skill actually fires.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const EVO_URL      = process.env.ROUTER_EVO_URL || ''
export const ROUTER_MODEL = process.env.ROUTER_MODEL || ''        // '' => use the loaded model (no swap)
export const ROUTER_N     = Number(process.env.ROUTER_N || 3)     // how many recent user messages to read
const RUNNING_URL   = (() => { try { return new URL('/running', EVO_URL).href } catch { return '' } })()
const FALLBACK_MODEL = process.env.ROUTER_FALLBACK || 'qwen3-coder-30b'
// Thinking OFF by default — a classify call needs no chain-of-thought (Austin's spec).
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
  return String(routerBody || '').replace('{skills}', sk).replace('{messages}', ms)
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
    if (idx >= 0) found.push([idx, sl])
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

export async function pickModel(fetchImpl = fetch) {
  if (ROUTER_MODEL) return ROUTER_MODEL
  try {
    const r = await fetchImpl(RUNNING_URL, { signal: AbortSignal.timeout(6000) })
    if (r.ok) {
      const j = await r.json()
      const list = (j && j.running) || []
      const ready = list.find((m) => m && m.state === 'ready') || list[0]
      if (ready && ready.model) return ready.model
    }
  } catch {}
  return FALLBACK_MODEL
}

export async function routerCall(prompt, fetchImpl = fetch) {
  const model = await pickModel(fetchImpl)
  const body = { model, messages: [{ role: 'user', content: prompt }], max_tokens: 40, temperature: 0 }
  if (NOTHINK) body.chat_template_kwargs = { enable_thinking: false }
  const r = await fetchImpl(EVO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json()
  return j.choices?.[0]?.message?.content || ''
}

// messages -> validated skill names. Injectable fetch for tests.
export async function route({ routerBody, skills, messages }, fetchImpl = fetch) {
  const out = await routerCall(buildPrompt(routerBody, skills, messages), fetchImpl)
  return parseSkills(out, skills)
}

// Pull the last N user-message texts out of an OpenCode messages list.
export function lastUserMessages(msgs, n) {
  const users = []
  for (const m of msgs || []) {
    const role = m && m.info && m.info.role
    if (role === 'user') {
      const text = (m.parts || []).filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ').trim()
      // harness re-prompts (iterate-loop / verify-guard) arrive as "user" messages — never route on them
      if (text && !/^\[(iterate-loop|verify-guard)/.test(text)) users.push(text)
    }
  }
  return users.slice(-n)
}
