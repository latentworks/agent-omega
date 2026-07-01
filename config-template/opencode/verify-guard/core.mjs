// Pure decision logic for the verify-guard plugin.
// No opencode/runtime dependencies, so it runs identically under Node (tests)
// and opencode's bundled runtime. The plugin wiring lives in index.js.

const CODE_EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit'])

const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'm', 'mm',
  'sh', 'bash', 'zsh', 'ps1', 'psm1',
  'sql', 'lua', 'dart', 'ex', 'exs', 'erl', 'clj', 'pl', 'r',
  'vue', 'svelte', 'astro',
  'css', 'scss', 'sass', 'less', 'html', 'htm', // renderable UI — a change you should look at
])

// Commands that indicate the agent actually ran/tested/built something, rather
// than just inspecting the tree. Deliberately broad: a missed match only costs
// one extra nudge, while a false match would suppress a needed one.
const VERIFY_PATTERNS = [
  /\bpytest\b/, /\bunittest\b/, /\bnose2?\b/,
  /\bjest\b/, /\bvitest\b/, /\bmocha\b/, /\bjasmine\b/, /\bplaywright\b/, /\bcypress\b/,
  /\bphpunit\b/, /\brspec\b/, /\bminitest\b/,
  /\bgo\s+(test|run|build)\b/,
  /\bcargo\s+(test|run|build|check)\b/,
  /\b(npm|yarn|pnpm|bun)\s+(run\s+)?(test|build|lint|typecheck|tsc|start|dev|check)\b/,
  /\bnpm\s+test\b/,
  /\bdotnet\s+(test|run|build)\b/,
  /\b(gradle|gradlew|mvn|maven)\b/,
  /\bctest\b/, /\bcmake\b/, /\bninja\b/, /\bmake\b/,
  /\btsc\b/, /\beslint\b/,
  /\b(pio|platformio)\s+(run|test)\b/,
  /\b(python3?|node|deno|ruby|php|perl|rscript)\s+\S/i,
  /\b(deno|bun)\s+(run|test)\b/,
  /\b(invoke-pester|pester)\b/i,
  /(^|\s)\.\/\S+/,    // ./run.sh, ./a.out
  /(^|\s)\.\\\S+/,    // .\run.ps1 (Windows)
]

export function isCodeEditTool(tool) {
  return CODE_EDIT_TOOLS.has(String(tool || '').toLowerCase())
}

export function isCodeFile(path) {
  const p = String(path || '').toLowerCase()
  const name = p.split(/[/\\]/).pop() || ''
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name === 'makefile') return true
  const m = p.match(/\.([a-z0-9]+)$/)
  return m ? CODE_EXTENSIONS.has(m[1]) : false
}

// The web gateway (web.py search/read) is a RESEARCH tool, not a build/test of the code.
// Its output (low-trust results, a partial "unreachable") must NOT read as a verification run
// or as a command failure — otherwise the failure classifier nags about a search that worked.
export function isWebBridge(command) {
  return /\bweb\.py\b/.test(String(command || ''))
}

// Commands that exit non-zero as a NORMAL signal (no match / differs / false), NOT a real failure —
// so the classifier must not flag a `grep` that found nothing as a failed command.
export function isBenignNonZero(command) {
  return /^\s*\S*\b(grep|egrep|fgrep|rg|ag|diff|cmp|test|find)\b/i.test(String(command || ''))
}

export function isVerificationCommand(command) {
  const c = String(command || '')
  if (isWebBridge(c)) return false
  // A bare version/help probe runs no real code — it must NOT count as having verified anything.
  if (/^\s*\S*\b(python3?|node|deno|bun|ruby|php|perl|rscript|go|cargo|npm|pnpm|yarn|dotnet|tsc)\b\s+(-v|-V|--version|version|--help|-h|help)\s*$/i.test(c)) return false
  return VERIFY_PATTERNS.some((re) => re.test(c))
}

function argPath(args) {
  if (!args || typeof args !== 'object') return ''
  return args.filePath || args.path || args.file || args.file_path || ''
}

function argCommand(args) {
  if (!args || typeof args !== 'object') return ''
  return args.command || args.cmd || args.script || ''
}

// Fold a single completed tool call into the turn's running state (mutates).
export function observeTool(state, evt) {
  const { tool, args } = evt || {}
  if (isCodeEditTool(tool) && isCodeFile(argPath(args))) {
    state.codeChanged = true
  } else if (String(tool || '').toLowerCase() === 'bash' && isVerificationCommand(argCommand(args))) {
    state.verified = true
  }
  return state
}

export function shouldNudge({ codeChanged, verified, nudgeCount, cap }) {
  return Boolean(codeChanged) && !verified && (nudgeCount || 0) < (cap || 0)
}
