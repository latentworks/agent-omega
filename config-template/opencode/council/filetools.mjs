// council/filetools.mjs — read-only, privacy-hardened file-view sandbox for council
// members. Members get ONLY these four tools (read/grep/glob/list): by ABSENCE they
// cannot write, edit, run, fetch, or shell. Soft-scoped to the project dir, HARD
// read-only, with a hard deny-list for secrets/keys/credentials that holds even when a
// member reaches outside the project, plus traversal/symlink/UNC/8.3/ADS hardening and
// per-member size+call caps. Pure node fs — zero opencode contention (this is what
// kills the deadlock). Refusals are plain strings; we never throw into the SDK loop and
// never return denied content or a real absolute path.
import { tool, jsonSchema } from 'ai'
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || ''
const norm = (p) => (String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') || '/')
const isUnder = (p, base) => p === base || p.startsWith(base.replace(/\/+$/, '') + '/')

// ---- deny-list (data; compared lowercased + forward-slashed) ----
const DENY_PREFIXES = [
  norm(HOME + '/.agent-omega'), norm(HOME + '/.ssh'), norm(HOME + '/.aws'),
  norm(HOME + '/.gnupg'), norm(HOME + '/.azure'), norm(HOME + '/.kube'), norm(HOME + '/.docker'),
  norm(HOME + '/.config/gh'), norm(HOME + '/.config/gcloud'), norm(HOME + '/.claude/.credentials'),
  norm(HOME + '/appdata/roaming/microsoft/credentials'), norm(HOME + '/appdata/local/microsoft/credentials'),
  norm(HOME + '/appdata/local/google/chrome/user data'), norm(HOME + '/appdata/roaming/mozilla/firefox/profiles'),
  // F2: Windows credential stores the original list missed (readable with no prereq).
  norm(HOME + '/appdata/local/microsoft/edge/user data'), norm(HOME + '/appdata/roaming/github cli'),
  norm(HOME + '/appdata/roaming/gcloud'), norm(HOME + '/.local/share/opencode'), norm(HOME + '/.npm'),
  'c:/windows/system32/config',
]
const DENY_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.agent-omega'])
const DENY_LEAF = [
  /^\.env(\..+)?$/, /\.env$/, /\.pem$/, /\.ppk$/, /\.pfx$/, /\.p12$/, /\.jks$/, /\.keystore$/, /\.kdbx$/, /\.key$/,
  /\.gpg$/, /\.asc$/, /(^|[._-])key$/, /^id_(rsa|dsa|ecdsa|ed25519)$/, /^\.netrc$/, /^\.pgpass$/, /^secring/,
  /^\.gitconfig$/, /^\.git-credentials$/, /^\.npmrc$/,  // F2
]
const DENY_SUBSTR_HARD = ['private-key', 'private_key', 'privatekey', 'client-secret', 'client_secret', 'service-account', 'service_account', 'id_ed25519', 'id_rsa', '.agent-omega']
const DENY_SUBSTR_SOFT = ['secret', 'token', 'password', 'passwd', 'credential', 'apikey', 'api-key', 'api_key', 'vault']

class Refusal extends Error {}

function denyHard(p) {
  for (const pre of DENY_PREFIXES) if (p === pre || p.startsWith(pre + '/')) return true
  const segs = p.split('/')
  for (const seg of segs) if (DENY_DIR_SEGMENTS.has(seg)) return true
  const leaf = segs[segs.length - 1] || ''
  for (const re of DENY_LEAF) if (re.test(leaf)) return true
  for (const sub of DENY_SUBSTR_HARD) if (p.includes(sub)) return true
  return false
}
const denySoftOutside = (p, inProject) => !inProject && DENY_SUBSTR_SOFT.some((s) => p.includes(s))

// raw-reject -> resolve -> deny(logical) -> realpath -> deny(real) -> kind -> tag inProject.
export function resolveSafe(input, scopeDir, { kind = 'any' } = {}) {
  const raw = String(input == null ? '' : input)
  if (!raw || raw.includes('\0')) throw new Refusal('denied: invalid path')
  if (/^(\\\\|\/\/)/.test(raw)) throw new Refusal('denied: UNC paths not allowed')
  if (/^~/.test(raw)) throw new Refusal('denied: home-relative (~) not allowed')
  if (/~\d/.test(raw)) throw new Refusal('denied: short (8.3) names not allowed')
  if (/^[a-zA-Z]:(?![\\/])/.test(raw)) throw new Refusal('denied: drive-relative paths not allowed')
  const afterDrive = /^[a-zA-Z]:[\\/]/.test(raw) ? raw.slice(2) : raw
  if (afterDrive.includes(':')) throw new Refusal('denied: alternate data streams not allowed')

  const scope = norm(scopeDir)
  const logical = path.resolve(scopeDir, raw)
  const logNorm = norm(logical)
  const logIn = isUnder(logNorm, scope)
  if (denyHard(logNorm) || denySoftOutside(logNorm, logIn)) throw new Refusal('denied: sensitive path')

  let real
  try { real = fs.realpathSync.native(logical) } catch { throw new Refusal('not found') }
  const realNorm = norm(real)
  const realIn = isUnder(realNorm, scope)
  if (denyHard(realNorm) || denySoftOutside(realNorm, realIn)) throw new Refusal('denied: sensitive path')

  let st
  try { st = fs.lstatSync(real) } catch { throw new Refusal('not found') }
  // F1: a hard link is a 2nd directory entry for the same inode — realpath returns the
  // link's own innocent name, so the deny-list can't see the target. A multi-linked file
  // inside a read sandbox is suspicious; refuse it (the real secret stays at nlink>1).
  if (st.isFile() && st.nlink > 1) throw new Refusal('denied: sensitive path')
  if (kind === 'file' && !st.isFile()) throw new Refusal('not a file')
  if (kind === 'dir' && !st.isDirectory()) throw new Refusal('not a directory')
  return { real, logical, inProject: realIn, stat: st }
}

// Per-member cumulative budget across all four tools.
function makeBudget() {
  const b = { bytes: 0, calls: 0 }
  return {
    call() { if (++b.calls > 40) throw new Refusal('view budget exhausted (40-call limit)') },
    add(n) { b.bytes += n; if (b.bytes > 1024 * 1024) throw new Refusal('view budget exhausted (1MB limit)') },
  }
}

// Safe directory walker for glob/grep: skips denied dirs, never follows symlinks, capped.
function* walk(root, deadline, maxDepth = 12, maxDirs = 5000) {
  let dirs = 0
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length) {
    if (Date.now() > deadline) return
    const { dir, depth } = stack.pop()
    if (depth > maxDepth) continue
    if (++dirs > maxDirs) return
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const full = path.join(dir, e.name)
      if (denyHard(norm(full))) continue
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) stack.push({ dir: full, depth: depth + 1 })
      else if (e.isFile()) { try { if (fs.lstatSync(full).nlink > 1) continue } catch { continue } yield full }   // F1: skip hardlinks in walk
    }
  }
}

function globToRe(pat) {
  let re = ''
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]
    if (c === '*') { if (pat[i + 1] === '*') { re += '.*'; i++; if (pat[i + 1] === '/') i++ } else re += '[^/]*' }
    else if (c === '?') re += '[^/]'
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$', 'i')
}

// Heuristic ReDoS guard (F3/F4): a JS RegExp can't be preempted mid-match, and a
// catastrophic pattern blows up even on a short line — so reject obviously dangerous
// patterns up front: too many quantifiers, or a quantified group/class immediately
// followed by another quantifier (the (a+)+ / (.*)* class). Not exhaustive (RE2 would
// be), but it blocks the demonstrated DoS while allowing normal search patterns.
function looksCatastrophic(p) {
  const s = String(p)
  const quants = (s.match(/[*+]|\{\d+,?\d*\}/g) || []).length
  if (quants > 10) return true
  if (/(\+|\*|\})\s*[)\]]\s*\??\s*(\+|\*|\{)/.test(s)) return true
  return false
}

const refuse = (e, fallback) => (e instanceof Refusal ? e.message : fallback)

// createFileTools(ctx) -> { read, grep, glob, list }: the four AI-SDK read-only tools,
// sharing one per-member budget, all scoped to ctx.directory.
export function createFileTools(ctx) {
  const scopeDir = ctx.directory || process.cwd()
  const budget = makeBudget()

  const read = tool({
    description: 'Read a UTF-8 text file (READ-ONLY). Path is relative to the project by default. Large files are truncated.',
    inputSchema: jsonSchema({ type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'file path (relative to the project, or absolute)' }, start_line: { type: 'number' }, max_lines: { type: 'number' } }, required: ['path'] }),
    execute: async ({ path: p, start_line, max_lines }) => {
      try {
        budget.call()
        const { real } = resolveSafe(p, scopeDir, { kind: 'file' })
        const MAXB = 256 * 1024
        const buf = Buffer.alloc(MAXB)
        const fd = fs.openSync(real, 'r')
        let n
        try { n = fs.readSync(fd, buf, 0, MAXB, 0) } finally { fs.closeSync(fd) }   // never leak the fd if readSync throws
        budget.add(n)
        const text = buf.slice(0, n).toString('utf8')
        const allLines = text.split('\n')
        const start = Math.max(0, (start_line | 0) ? (start_line | 0) - 1 : 0)
        const maxL = Math.min(5000, (max_lines | 0) || 5000)
        const slice = allLines.slice(start, start + maxL).map((l) => (l.length > 2000 ? l.slice(0, 2000) + '…' : l))
        let out = slice.join('\n')
        if (n >= MAXB) out += '\n…[truncated at 256KB]'
        else if (allLines.length > start + maxL) out += `\n…[${allLines.length - (start + maxL)} more lines]`
        return out || '(empty file)'
      } catch (e) { return refuse(e, 'error: could not read file') }
    },
  })

  const list = tool({
    description: 'List a directory (READ-ONLY). Sensitive children are omitted.',
    inputSchema: jsonSchema({ type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'directory path (default: project root)' } } }),
    execute: async ({ path: p }) => {
      try {
        budget.call()
        const { real, inProject } = resolveSafe(p || '.', scopeDir, { kind: 'dir' })
        if (!inProject) return 'denied: search/list is limited to the project directory'
        const ents = fs.readdirSync(real, { withFileTypes: true })
        const out = []
        for (const e of ents) {
          if (out.length >= 1000) { out.push('…[more]'); break }
          if (denyHard(norm(path.join(real, e.name)))) continue
          out.push((e.isDirectory() ? '[dir]  ' : '[file] ') + e.name)
        }
        return out.length ? out.join('\n') : '(empty directory)'
      } catch (e) { return refuse(e, 'error: could not list directory') }
    },
  })

  const glob = tool({
    description: 'Find files by glob pattern (e.g. **/*.ts) under the project (READ-ONLY).',
    inputSchema: jsonSchema({ type: 'object', additionalProperties: false, properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'search root (default: project root)' } }, required: ['pattern'] }),
    execute: async ({ pattern, path: p }) => {
      try {
        budget.call()
        if (String(pattern).length > 128) return 'denied: pattern too long'   // F4: glob had NO pattern cap
        if (looksCatastrophic(pattern)) return 'denied: pattern too complex'
        const { real, inProject } = resolveSafe(p || '.', scopeDir, { kind: 'dir' })
        if (!inProject) return 'denied: search/list is limited to the project directory'
        const re = globToRe(String(pattern))
        const deadline = Date.now() + 5000
        const out = []; let seen = 0
        for (const f of walk(real, deadline)) {
          if ((seen++ & 511) === 0 && Date.now() > deadline) break            // F4: deadline around the match
          const rel = path.relative(real, f).replace(/\\/g, '/')
          if (rel.length > 1024) continue                                      // F4: skip oversize subjects
          if (re.test(rel) || re.test(path.basename(f))) { out.push(rel); if (out.length >= 200) { out.push('…[more]'); break } }
        }
        return out.length ? out.join('\n') : '(no matches)'
      } catch (e) { return refuse(e, 'error: glob failed') }
    },
  })

  const grep = tool({
    description: 'Search file contents for a regex under the project (READ-ONLY). Returns file:line: text.',
    inputSchema: jsonSchema({ type: 'object', additionalProperties: false, properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'search root (default: project root)' } }, required: ['pattern'] }),
    execute: async ({ pattern, path: p }) => {
      try {
        budget.call()
        if (String(pattern).length > 128) return 'denied: pattern too long'   // F3: tighter cap vs ReDoS
        if (looksCatastrophic(pattern)) return 'denied: pattern too complex'
        let re; try { re = new RegExp(String(pattern), 'i') } catch { return 'error: bad regex' }
        const { real, inProject } = resolveSafe(p || '.', scopeDir, { kind: 'dir' })
        if (!inProject) return 'denied: search/list is limited to the project directory'
        const deadline = Date.now() + 5000
        const out = []; let files = 0, bytes = 0
        outer: for (const f of walk(real, deadline)) {
          if (++files > 2000 || Date.now() > deadline) break
          let content
          try { if (fs.statSync(f).size > 1024 * 1024) continue; content = fs.readFileSync(f, 'utf8') } catch { continue }
          const rel = path.relative(real, f).replace(/\\/g, '/')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if ((i & 1023) === 0 && Date.now() > deadline) break outer   // F3: deadline INSIDE the line loop
            const subj = lines[i]
            if (subj.length > 4096) continue                              // F3: skip oversize lines (ReDoS subject)
            if (re.test(subj)) {
              const ln = subj.length > 300 ? subj.slice(0, 300) + '…' : subj
              const entry = `${rel}:${i + 1}: ${ln}`
              out.push(entry); bytes += entry.length
              if (out.length >= 100) { out.push('…[more matches]'); break outer }
              if (bytes > 64 * 1024) { out.push('…[truncated]'); break outer }
            }
          }
        }
        return out.length ? out.join('\n') : '(no matches)'
      } catch (e) { return refuse(e, 'error: grep failed') }
    },
  })

  return { read, grep, glob, list }
}
