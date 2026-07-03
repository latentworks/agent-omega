// commands-list.mjs — the engine behind the /commands slash command.
// Lists every active slash command from the config's command/ directory (plus any extra
// roots passed as argv), with description, source, skill wiring, and warnings for
// duplicates / missing descriptions / broken skill references. Read-only; prints text.
//
// Usage:  node commands-list.mjs [extraRoot1] [extraRoot2] ...
//   The primary root is the directory this script lives in (the opencode config root).
//   Extra roots (e.g. a packaged config template) are scanned for shadowing/duplicates.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWN_ROOT = dirname(fileURLToPath(import.meta.url))
const roots = [OWN_ROOT, ...process.argv.slice(2)].filter((r, i, a) => existsSync(r) && a.indexOf(r) === i)

function parseFrontmatter(raw) {
  const text = raw.replace(/^﻿/, '')   // strip UTF-8 BOM (Windows Notepad prepends it)
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2] }
}

// Which skill does a command body invoke? Match the real phrasings used in this config:
//   "Invoke the 'name' skill"  /  "the \"name\" skill"  /  skill/name  /  skills/name
function skillRefs(body) {
  const refs = new Set()
  for (const re of [/the ['"]([a-z0-9_-]+)['"] skill/gi, /\bskills?\/([a-z0-9_-]+)/gi]) {
    let m; while ((m = re.exec(body)) !== null) refs.add(m[1].toLowerCase())
  }
  return [...refs]
}

const skillExists = (name) => roots.some((r) => existsSync(join(r, 'skill', name, 'SKILL.md')))

const seen = new Map() // command name -> first root that provided it
const rows = []
const warnings = []

for (const root of roots) {
  const dir = join(root, 'command')
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const name = '/' + basename(f, '.md')
    let text = ''
    try { text = readFileSync(join(dir, f), 'utf8') } catch { warnings.push(`${name}: unreadable (${join(dir, f)})`); continue }
    const { meta, body } = parseFrontmatter(text)
    if (seen.has(name)) {
      warnings.push(`${name} exists in both ${seen.get(name)} and ${root}; the first one wins`)
      continue
    }
    seen.set(name, root)
    const refs = skillRefs(body)
    const missing = refs.filter((s) => !skillExists(s))
    for (const s of missing) warnings.push(`${name} references missing skill "${s}"`)
    if (!meta.description) warnings.push(`${name} has no description in its frontmatter`)
    if (!body.trim()) warnings.push(`${name} has an empty body`)
    rows.push({
      name,
      desc: meta.description || '(no description)',
      root,
      skills: refs,
      args: /\$ARGUMENTS/.test(body),
    })
  }
}

if (!rows.length) {
  console.log('No slash commands found. Command roots scanned:\n' + roots.map((r) => '  ' + r).join('\n'))
  process.exit(0)
}

const w = Math.max(...rows.map((r) => r.name.length)) + 2
console.log('Active slash commands:')
for (const r of rows) {
  const extras = []
  if (r.skills.length) extras.push('skill: ' + r.skills.join(', '))
  if (r.args) extras.push('takes arguments')
  console.log('  ' + r.name.padEnd(w) + r.desc + (extras.length ? '   [' + extras.join('; ') + ']' : ''))
}
if (roots.length > 1) {
  console.log('\nSources:')
  for (const root of roots) console.log('  ' + root + (root === OWN_ROOT ? '   (active config)' : '   (extra root)'))
}
if (warnings.length) {
  console.log('\nWarnings:')
  for (const wn of warnings) console.log('  ' + wn)
} else {
  console.log('\nNo wiring problems detected.')
}
