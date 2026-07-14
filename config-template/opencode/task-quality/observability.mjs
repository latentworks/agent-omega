// FIX-6 observability: a once-per-process stderr warning used to replace bare
// catches that previously swallowed diagnostics silently (e.g. task-quality.log
// append failures). Surfacing the first failure keeps the next audit from
// needing forensic reconstruction, while suppressing the rest avoids spamming a
// long-running process. Emitting a diagnostic must never be fatal, so the write
// itself is guarded — that terminal guard is the sink of last resort, not a
// silent swallow of the original error (which has already been surfaced once).
export function createWarnOnce(write = (text) => process.stderr.write(text)) {
  let emitted = false
  return function warnOnce(scope, error) {
    if (emitted) return false
    emitted = true
    try {
      const detail = error && error.message ? error.message : String(error)
      write(`[task-quality] ${scope} failed (further diagnostics suppressed for this process): ${detail}\n`)
    } catch {
      // Nowhere left to report to; stay non-fatal.
    }
    return true
  }
}

// Process-wide singleton for the plugin's own diagnostics.
export const warnOnce = createWarnOnce()
