// selfreview-seam.mjs — the PRODUCTION bridge between the engine checkpoint and the proven self-review mechanism.
//
// THE PROBLEM (as a system): the mechanism is function-level — it needs a { spec, fnName, signature } contract and
// the model's ACTUAL code (the incumbent) to grade. But the engine's lifecycle only carries FREEFORM task text
// (taskContract = handoff.taskText) and a workspace directory. It never hands us "the function the model just
// wrote". We must DERIVE that, and the derivation is safety-critical: pointing the swap at the WRONG file would let
// it overwrite unrelated code — a Gate-1 violation far worse than doing nothing.
//
// THE DEFENSE (two hard gates, else skip) — after two prior wrong-file/destruction strikes we STOP GUESSING which
// file the model wrote and stop overwriting files that aren't safe to overwrite:
//   GATE A (WHICH file — definitive): ask GIT what actually changed in the working tree this task
//     (git status --porcelain --untracked-files=all). Only a git-confirmed changed file may be a target. If git is
//     unavailable / not a repo / the change-set is empty -> we cannot prove any file was touched -> advise-only.
//   GATE B (SAFE to whole-file overwrite): the file must be a PURE single-function module — exactly ONE swappable
//     exported function that is ALSO the file's sole export of any kind (no co-exported const/class/second-fn/
//     re-export/TS-decl to destroy) and NO bare side-effect import a rewrite would drop.
//   Plus: EXACTLY ONE such (file, function) pair across the change-set, and the function name appears in the task text.
// Zero or multiple matches -> return null -> the seam runs advise-only (code untouched, never-worse trivially).
// The incumbent must additionally LOAD in the exec harness (enforced downstream in reviewCodeArtifact); a function
// with unresolvable imports/helpers is not self-contained -> incumbentLoaded=false -> advise-only. So the swap can
// only ever engage on a git-confirmed, self-contained, uniquely-identified pure-function module — rare by design but
// provably safe. Everything here is pure fs + git-read + string work so it is unit-provable on real fixtures/repos.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { execFileSync } from 'node:child_process'

const SRC_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'])
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.cache', 'vendor', '.opencode'])

// Canonical path key for cross-referencing (case-insensitive + slash-normalized on Windows so a git-reported
// forward-slash path matches a Node backslash path and a drive-letter case difference never causes a miss).
const normPath = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))

// Shallow-ish bounded walk. Returns absolute paths of source files, newest-mtime first, capped.
export function listSourceFiles(directory, { maxDepth = 3, maxFiles = 250, maxBytes = 64 * 1024, sinceMs = 0 } = {}) {
  const out = []
  const root = directory
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= maxFiles) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1); continue }
      if (!e.isFile()) continue
      if (!SRC_EXT.has(path.extname(e.name))) continue
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.size > maxBytes) continue
      if (sinceMs && st.mtimeMs < sinceMs) continue
      out.push({ file: full, mtimeMs: st.mtimeMs })
    }
  }
  try { if (fs.statSync(root).isDirectory()) walk(root, 0) } catch { return [] }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.map((x) => x.file)
}

// Find EXPORTED function-like declarations in a module's source. Returns [{ name, args }]. Deliberately covers the
// common ESM/CJS export shapes; a name we can't get args for still counts as an exported function (args '').
export function findExportedFunctions(source) {
  const src = String(source || '')
  const found = new Map() // name -> args (first-seen wins)
  const add = (name, args) => { if (name && !found.has(name)) found.set(name, (args || '').trim()) }
  let m
  // export function NAME(args) / export async function NAME(args)
  const reFn = /\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g
  while ((m = reFn.exec(src))) add(m[1], m[2])
  // export const/let/var NAME = (args) => / = async (args) => / = function(args)
  const reArrow = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\*?\s*)?\(([^)]*)\)\s*(?:=>|\{)/g
  while ((m = reArrow.exec(src))) add(m[1], m[2])
  // export { NAME, NAME2 as X } — resolve each to a local function/arrow decl for its args
  const reBrace = /\bexport\s*\{([^}]*)\}/g
  while ((m = reBrace.exec(src))) {
    for (const part of m[1].split(',')) {
      const local = part.trim().split(/\s+as\s+/)[0].trim()
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue
      // only count it as a FUNCTION export if there's a local function/arrow binding
      const dre = new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s*${local}\\s*\\(([^)]*)\\)|\\b(?:const|let|var)\\s+${local}\\s*=\\s*(?:async\\s+)?(?:function\\s*\\*?\\s*)?\\(([^)]*)\\)\\s*(?:=>|\\{)`)
      const dm = src.match(dre)
      if (dm) add(local, dm[1] ?? dm[2] ?? '')
    }
  }
  // export default function NAME(args) (named default)
  const reDef = /\bexport\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g
  while ((m = reDef.exec(src))) add(m[1], m[2])
  // CJS: module.exports.NAME = function(args) / exports.NAME = (args) =>
  const reCjs = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\*?\s*)?\(([^)]*)\)\s*(?:=>|\{)?/g
  while ((m = reCjs.exec(src))) add(m[1], m[2])
  return [...found.entries()].map(([name, args]) => ({ name, args }))
}

// Find EVERY exported symbol name of ANY kind (function, const/let/var, class, default, re-export braces, CJS) —
// NOT just function-shaped ones. This is the safety counterpart to findExportedFunctions: applySwapToFile overwrites
// the WHOLE file, so "safe to overwrite" requires the file's SOLE export to be the one function. A const/class/second
// export co-located with it would be silently destroyed. findExportedFunctions is deliberately narrow (it only
// recognizes the shapes we can swap) and therefore UNDERCOUNTS real exports; this function is deliberately broad and
// only needs the NAME, never the args, so it catches named function expressions, anonymous defaults, and classes that
// the narrow matcher misses. Returns a de-duplicated array of exported names ('default' for an anonymous default,
// 'module.exports' for a whole-object CJS assignment).
export function findAllExports(source) {
  const src = String(source || '')
  const names = new Set()
  let m
  const reFn = /\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g
  while ((m = reFn.exec(src))) names.add(m[1])
  const reVar = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
  while ((m = reVar.exec(src))) names.add(m[1])
  const reClass = /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g
  while ((m = reClass.exec(src))) names.add(m[1])
  // export default [async] [function*/class] [NAME]  -> the name if present, else 'default' (anonymous)
  const reDef = /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+)?([A-Za-z_$][\w$]*)?/g
  while ((m = reDef.exec(src))) names.add(m[1] || 'default')
  // export * from '...'  /  export * as ns from '...'  -> a whole-namespace re-export a whole-file overwrite loses
  const reStar = /\bexport\s+\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\b/g
  while ((m = reStar.exec(src))) names.add(m[1] ? `*as:${m[1]}` : '*')
  // TS declaration exports (type/interface/enum/namespace/module) — runtime-erased but still file-level exports a
  // sibling `.ts` imports; their presence means the file is NOT a pure single-function module -> must skip.
  const reTs = /\bexport\s+(?:declare\s+)?(?:const\s+enum|type|interface|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/g
  while ((m = reTs.exec(src))) names.add(m[1])
  // export { A, B as C, X as "str" } -> the EXPORTED name (after `as`, else the local) — what siblings import
  const reBrace = /\bexport\s*\{([^}]*)\}/g
  while ((m = reBrace.exec(src))) {
    for (const part of m[1].split(',')) {
      const seg = part.trim(); if (!seg) continue
      const asParts = seg.split(/\s+as\s+/)
      const exported = (asParts[1] || asParts[0]).trim()
      if (/^[A-Za-z_$][\w$]*$/.test(exported)) names.add(exported)
      else if (exported === 'default') names.add('default')
      else if (/^["'].+["']$/.test(exported)) names.add(exported) // string-named export
    }
  }
  const reCjs = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g
  while ((m = reCjs.exec(src))) names.add(m[1])
  if (/\bmodule\.exports\s*=(?!=)/.test(src)) names.add('module.exports')
  // A destructuring export (`export const { A, B } = ...` / `export const [X] = ...`) binds names the per-statement
  // regexes above cannot enumerate. Emit a sentinel so the count reflects "an export we can't decompose is present"
  // -> the sole-export gate fails -> skip. (hasComplexVarExport is the load-bearing check; this is a second catch.)
  if (/\bexport\s+(?:const|let|var)\s*[{[]/.test(src)) names.add('<pattern-export>')
  return [...names]
}

// THE FAIL-SAFE EXPORT-SURFACE GUARD (root-cause fix after export-counting was broken 3x). A single ESM statement can
// bind MANY names — `export const A = ..., B = ...` (multi-declarator) or `export const { A, B } = ...`
// (destructuring). The per-syntax regexes in findAllExports/findExportedFunctions capture only the FIRST name, so a
// co-export rides in invisibly and the whole-file overwrite destroys it (a Gate-1 violation, CONFIRMED by two
// reviewers). Enumerating every syntax is a losing game; instead we DETECT COMPLEXITY and refuse. This depth-aware
// scanner returns true if ANY `export const/let/var` declaration is destructuring OR binds more than one declarator.
// It errs toward OVER-detecting (a comma inside a string/comment at column-0 depth counts) which only causes an extra
// advise-only skip — never a miss. Any true here => deriveFunctionContract skips (safe). This inverts the failure
// direction from "miss an export -> destroy it" to "unsure -> don't touch".
export function hasComplexVarExport(source) {
  const src = String(source || '')
  const re = /\bexport\s+(?:const|let|var)\s+/g
  let m
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length
    if (src[i] === '{' || src[i] === '[') return true // destructuring binding pattern
    let depth = 0
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth-- }
      else if (depth === 0) {
        if (ch === ',') return true          // a second declarator at top level => multi-binding export
        if (ch === ';') break                // statement end
        if (ch === '\n') {                    // newline: a leading comma on the next line continues the declarator list
          let j = i + 1
          while (j < src.length && /\s/.test(src[j])) j++
          if (src[j] === ',') return true
          break                               // otherwise the statement ends here
        }
      }
    }
  }
  return false
}

// A side-effect-only import runs code for effect, not for a binding, so a whole-file overwrite would silently drop it.
// Covers static bare imports (`import './telemetry.js'`, `import "dotenv/config";`, no-space `import"./x"`) AND a
// top-level dynamic side-effect import (`import('./register.js')`). Its presence disqualifies the file from swap.
export function hasSideEffectImport(source) {
  const src = String(source || '')
  if (/(^|\n)\s*import\s*['"][^'"]+['"]\s*;?\s*(?=\n|$)/.test(src)) return true      // static bare (opt. no space)
  if (/(^|\n)\s*import\s*\(\s*['"][^'"]+['"]\s*\)\s*;?\s*(?=\n|$)/.test(src)) return true // top-level dynamic
  return false
}

// DEFINITIVE task tie: the set of files git reports as CHANGED in `directory`'s working tree (modified + untracked),
// as absolute normalized path keys. This is what the model actually wrote/edited this task — not a heuristic. Returns
// null when a change-set cannot be established (git missing, not a repo, timeout, error): the caller must then treat
// EVERY file as unconfirmed and refuse to swap (advise-only). Read-only (`git status`), arg-vector exec (no shell,
// no injection), short timeout, fully contained.
export function changedFilesGit(directory, { gitTimeoutMs = 4000 } = {}) {
  let out
  try {
    out = execFileSync('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=all'],
      { timeout: gitTimeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch { return null }
  const set = new Set()
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.length < 4) continue
    const xy = line.slice(0, 2) // porcelain v1 status codes: "XY <path>"
    let p = line.slice(3)
    // ' -> ' is a rename/copy separator ONLY on an R/C status line. Splitting it on any path that merely CONTAINS
    // ' -> ' (legal on POSIX filesystems) would truncate to the wrong file -> wrong-file swap. Gate it on status.
    if (xy.includes('R') || xy.includes('C')) {
      const arrow = p.indexOf(' -> ')
      if (arrow >= 0) p = p.slice(arrow + 4)
    }
    p = p.trim()
    if (p.startsWith('"') && p.endsWith('"')) { try { p = JSON.parse(p) } catch {} } // git quotes special-char paths
    if (!p) continue
    set.add(normPath(path.resolve(directory, p)))
  }
  return set
}

// word-boundary presence of a function name in the (freeform) task text
function nameInProse(name, prose) {
  try { return new RegExp(`(?:^|[^\\w$])${name}(?:[^\\w$]|$)`).test(String(prose || '')) } catch { return false }
}

/**
 * Derive the single, unambiguous function contract for this task, or null to skip (advise-only).
 *   taskContract : freeform task text (lifecycle.taskContract)
 *   directory    : workspace root (context.directory / context.worktree)
 *   sinceMs      : optional mtime watermark; only files modified at/after it are considered (secondary tie)
 *   opts         : listSourceFiles bounds + { gitTimeoutMs } for changedFilesGit
 * Returns { spec, fnName, signature, incumbentSource, file } | null.
 *
 * WHY THIS SHAPE (root-cause of two prior wrong-file/destruction strikes): the earlier heuristics tried to GUESS which
 * file the model wrote from mtimes / name-in-prose / artifact-content overlap. Every guess was breakable — an old
 * untouched utility that shares a name, a shared license/import run that fakes the artifact tie. So we stop guessing on
 * BOTH axes with two hard, positively-characterized gates:
 *
 *   GATE A — WHICH file (definitive, not heuristic): ask GIT what changed in the working tree this task
 *     (changedFilesGit). A candidate file must be in that set. If git is unavailable / not a repo / the change-set is
 *     empty -> we cannot prove any file was touched this task -> return null (advise-only). No git, no swap.
 *   GATE B — SAFE to whole-file overwrite: the file must be a PURE single-function module —
 *     (1) exactly ONE swappable exported function (findExportedFunctions), (2) that function is the file's SOLE export
 *     of ANY kind (findAllExports: no co-exported const/class/second-fn/re-export/TS-decl to destroy),
 *     (2b) NO multi-declarator or destructuring export the regexes can't enumerate (hasComplexVarExport — fail-safe
 *     so a `export const A=..,B=..` co-binding can never ride in invisibly and get destroyed), and
 *     (3) NO bare/dynamic side-effect import (hasSideEffectImport) that a whole-file rewrite would silently drop.
 *   Plus the prose cross-check (the function name appears in the task text) as a cheap sanity tie.
 *
 * Then EXACTLY ONE such (file, function) pair may exist across the change-set; any ambiguity -> skip. The swap thus
 * only ever engages on a git-confirmed, self-contained, uniquely-identified pure-function module — rare by design, but
 * provably safe. Everything else falls to advise-only, which is the always-on value and is trivially never-worse.
 */
export function deriveFunctionContract({ taskContract, directory, sinceMs = 0, opts = {} }) {
  if (!taskContract || typeof taskContract !== 'string' || !taskContract.trim()) return null
  if (!directory || typeof directory !== 'string') return null
  // GATE A: git is the definitive task change-set. No git / not-a-repo / empty -> cannot prove any file was touched.
  const changed = changedFilesGit(directory, opts)
  if (!changed || changed.size === 0) return null
  const files = listSourceFiles(directory, { ...opts, sinceMs })
  const candidates = [] // { file, name, args, source }
  for (const file of files) {
    // GATE A cont.: only files git confirms the model changed this task are eligible targets
    if (!changed.has(normPath(file))) continue
    let source
    try { source = fs.readFileSync(file, 'utf8') } catch { continue }
    const exps = findExportedFunctions(source)
    // GATE B(1): require the file to expose a SINGLE swappable exported function (private helpers may exist unexported)
    if (exps.length !== 1) continue
    const { name, args } = exps[0]
    // GATE B(2): that function must be the file's SOLE export of ANY kind — else overwriting destroys co-exports
    const allExports = findAllExports(source)
    if (allExports.length !== 1 || allExports[0] !== name) continue
    // GATE B(2b): fail-safe against multi-declarator / destructuring exports the regexes can't enumerate (a single
    // `export const A=.., B=..` statement binds names findAllExports misses) -> any such complexity => skip
    if (hasComplexVarExport(source)) continue
    // GATE B(3): a whole-file rewrite would silently drop any bare/dynamic side-effect import -> disqualify
    if (hasSideEffectImport(source)) continue
    // prose cross-check: this function belongs to THIS task
    if (!nameInProse(name, taskContract)) continue
    candidates.push({ file, name, args, source })
  }
  // require EXACTLY ONE (file, function) pair across the change-set; any ambiguity -> skip
  if (candidates.length !== 1) return null
  const { file, name, args, source } = candidates[0]
  const signature = `${name}(${(args || '').trim()})`
  return {
    spec: taskContract,
    fnName: name,
    signature,
    incumbentSource: source,
    file,
  }
}

/**
 * Apply a swap to disk: write selectedSource, then round-trip (read back + byte-assert). On write/round-trip
 * FAILURE the original bytes are restored, so a failed swap never leaves the file worse than it started. A
 * SUCCESSFUL swap intentionally PERSISTS the new source (that is the whole point) — the returned `backup` is the
 * pre-swap text for the caller's audit trail, not an auto-undo. selectedSource's FUNCTIONAL correctness was already
 * certified upstream (it won the exec oracle) and the TARGET file was tied to this task's work upstream
 * (deriveFunctionContract gates 2+4); this function only guarantees write integrity. Returns { applied, reason, backup }.
 */
export function applySwapToFile({ file, selectedSource }) {
  if (!file || typeof selectedSource !== 'string' || !selectedSource.trim()) return { applied: false, reason: 'bad-args' }
  let backup
  try { backup = fs.readFileSync(file, 'utf8') } catch (e) { return { applied: false, reason: 'read-fail:' + (e && e.message) } }
  try {
    fs.writeFileSync(file, selectedSource, 'utf8')
    const readBack = fs.readFileSync(file, 'utf8') // round-trip: write -> read -> assert
    if (readBack !== selectedSource) {
      fs.writeFileSync(file, backup, 'utf8') // restore on mismatch
      return { applied: false, reason: 'roundtrip-mismatch', backup }
    }
    return { applied: true, reason: 'ok', backup }
  } catch (e) {
    try { fs.writeFileSync(file, backup, 'utf8') } catch {} // best-effort restore
    return { applied: false, reason: 'write-fail:' + (e && e.message), backup }
  }
}

// convenience for tests / callers that want to actually execute the written file
export async function importFresh(file) {
  const href = url.pathToFileURL(file).href + `?t=${Date.now()}${Math.random().toString(36).slice(2)}`
  return import(href)
}
