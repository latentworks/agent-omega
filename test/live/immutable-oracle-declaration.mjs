// Lever I turn-on — harness-side oracle declaration for OMEGA_IMMUTABLE_ORACLES.
//
// The immutable-artifact guard (config-template/opencode/task-quality/admission.mjs)
// is a PURE, declaration-driven pre-write block: it denies a mutating write whose
// normalized target basename EXACTLY matches a harness-declared acceptance-oracle
// basename. It deliberately never touches the filesystem and never infers from the
// contract prose (that inference-based design was broken by adversarial review).
//
// Purity has one documented cost: it cannot see through a Windows NTFS 8.3 short
// name. On a volume with 8.3 generation ON, "tests/public.test.mjs" ALSO answers to
// the alias "PUBLIC~1.MJS" — a real, live write path onto the same file (proven by
// round-trip). A pure basename match on the long name alone would miss that alias
// and the oracle could be silently overwritten through it.
//
// The fix lives HERE, in the declaration, where filesystem access legitimately
// exists: when the harness turns the guard on it queries each oracle file's REAL
// 8.3 short name from the OS and declares it alongside the long name. The guard
// stays pure; the exact-match set simply covers both spellings. No guessing of the
// "~1" suffix — we ask the OS for the actual alias the volume assigned.
//
// This module is import-safe (no side effects) so the campaign harness can pull in
// declareImmutableOracles() and set OMEGA_IMMUTABLE_ORACLES on the omega arm.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

// The acceptance oracles the fixtures lay into every task workspace: the hidden
// public grading test and the task contract. Overwriting either fakes a pass or
// rewrites the contract — the exact r5 immutable-oracle breach the guard exists to
// stop. Declared by relative path; only the basename is matched by the guard.
export const CANONICAL_ORACLE_RELPATHS = ['tests/public.test.mjs', 'README.md']

// Ask the OS for a file's real 8.3 short name via the Scripting.FileSystemObject
// COM API (.ShortName), which returns the volume's actually-assigned alias directly
// as a basename — the exact string NTFS resolves for that file, not a guessed "~N".
// The path is handed to PowerShell through an env var so no shell quoting can mangle
// it (the earlier `cmd for %~sI` form was corrupted by Node's argv escaping and
// returned a stray quote). Returns the short BASENAME, or null when there is no
// distinct alias (the name already fits 8.3, or 8.3 generation is off, or we are not
// on Windows / the query failed). Never throws — a missing alias means nothing extra
// to declare, so the guard simply matches on the long name alone.
export function shortNameBasename(absPath) {
  if (process.platform !== 'win32') return null
  try {
    const ps = '$f = New-Object -ComObject Scripting.FileSystemObject; $f.GetFile($env:OMEGA_SN_PATH).ShortName'
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, OMEGA_SN_PATH: absPath },
    }).trim()
    if (!out) return null
    const shortBase = path.win32.basename(out) // FSO already returns a basename; this is just belt-and-braces.
    const longBase = path.win32.basename(absPath)
    // Only meaningful when the short name actually differs from the long name.
    if (!shortBase || shortBase.toLowerCase() === longBase.toLowerCase()) return null
    return shortBase
  } catch {
    return null
  }
}

// Build the OMEGA_IMMUTABLE_ORACLES declaration for a real task workspace: for each
// canonical oracle that EXISTS in the workspace, declare its long basename plus its
// real 8.3 short-name alias (Windows, when distinct). Returns a comma-separated
// declaration string, or '' when no oracle files are present (guard abstains). The
// guard's parseImmutableOracles normalizes/dedupes, so order and case here are free.
export function declareImmutableOracles(workdir, relpaths = CANONICAL_ORACLE_RELPATHS) {
  const basenames = []
  for (const rel of relpaths) {
    const abs = path.join(workdir, rel)
    if (!existsSync(abs)) continue
    basenames.push(path.basename(rel))
    const short = shortNameBasename(abs)
    if (short) basenames.push(short)
  }
  return basenames.join(', ')
}
