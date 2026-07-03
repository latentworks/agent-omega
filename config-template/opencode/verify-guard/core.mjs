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

// EXECUTING commands: the agent actually RAN the code — a test suite or the program itself —
// and could observe real behavior. Only these count as verification (see the verify skill:
// "run the real thing and observe the real output").
const EXEC_PATTERNS = [
  /\bpytest\b/, /\bunittest\b/, /\bnose2?\b/,
  /\bjest\b/, /\bvitest\b/, /\bmocha\b/, /\bjasmine\b/, /\bplaywright\b/, /\bcypress\b/,
  /\bphpunit\b/, /\brspec\b/, /\bminitest\b/,
  /\bgo\s+(test|run)\b/,
  /\bcargo\s+(test|run)\b/,
  /\bswift\s+(test|run)\b/,                         // Apple-native: `swift test` / `swift run` actually run
  /\bxcodebuild\b[^&;|]*\s(test|run)(\s|$)/,        // `xcodebuild test` runs the test bundle
  /\bxcrun\s+(simctl|xctest)\b/,                    // driving the simulator / xctest runner
  /\b(npm|yarn|pnpm|bun)\s+(run\s+)?(test|start|dev|serve|preview)\b/,
  /\bnpm\s+test\b/,
  /\bdotnet\s+(test|run)\b/,
  // build tool invoking a TEST target — the target must be its own space-delimited arg, so a
  // lint goal like `mvn checkstyle:check` (":check", no leading space) does NOT count, while
  // `make test`, `make check`, `mvn verify`, `gradle test`, `gradle check` do.
  /\b(make|cmake|gradle|gradlew|mvn|maven)\b[^&;|]*\s(test|check|verify|integration-test|integrationTest|run|itest)(\s|$)/,
  /\bctest\b/,
  /\b(pio|platformio)\s+(run|test)\b/,
  /\b(python3?|node|deno|ruby|php|perl|rscript)\s+\S/i,
  /\b(deno|bun)\s+(run|test)\b/,
  /\b(invoke-pester|pester)\b/i,
  // running a local executable — only when ./x is the COMMAND (start or after a shell separator),
  // NOT a path ARGUMENT like `go build ./...` or `eslint ./src` (those are compile-only).
  /(^|&&|;|\||\bthen\b)\s*\.\/\S+/,    // ./run.sh, ./a.out
  /(^|&&|;|\||\bthen\b)\s*\.\\\S+/,    // .\run.ps1 (Windows)
]

// COMPILE-ONLY commands: they prove the code builds/type-checks/lints — NOT that it behaves.
// The whole point of this tool is to stop "it compiles" being mistaken for "it works", so a
// turn whose only "verification" is one of these does NOT count as verified.
const COMPILE_ONLY_PATTERNS = [
  /\b(npm|yarn|pnpm|bun)\s+(run\s+)?(build|lint|typecheck|type-check|check|compile|format)\b/,
  /\btsc\b/, /\beslint\b/, /\bprettier\b/, /\bruff\b/, /\bmypy\b/, /\bflake8\b/,
  /\bgo\s+build\b/, /\bgo\s+vet\b/,
  /\bcargo\s+(build|check|clippy|fmt)\b/,
  /\bswift\s+build\b/, /\bxcodebuild\s+build\b/,   // Apple-native: building is NOT running
  /\bdotnet\s+build\b/,
  /\b(cmake|ninja)\b/,
  /\b(make|gradle|gradlew|mvn|maven)\b/,   // bare build tools (an explicit test target is caught by EXEC_PATTERNS first)
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

// True only if the command actually EXECUTED the code (ran tests or the program). A
// compile/lint/typecheck-only command returns false — building is not behaving. An exec match
// wins even when a compile pattern also matches (e.g. `npm run build && npm test`).
export function isVerificationCommand(command) {
  const c = String(command || '')
  if (isWebBridge(c)) return false
  // A bare version/help probe runs no real code — it must NOT count as having verified anything.
  if (/^\s*\S*\b(python3?|node|deno|bun|ruby|php|perl|rscript|go|cargo|npm|pnpm|yarn|dotnet|tsc)\b\s+(-v|-V|--version|version|--help|-h|help)\s*$/i.test(c)) return false
  // Compile-only syntax checks that would otherwise trip an EXEC pattern (`node <arg>`, etc.):
  // `node --check` only parses, it does not RUN — so it must NOT count as a verification run.
  if (/\bnode\s+(--check|-c)\b/.test(c) || /\bpython3?\s+-m\s+py_compile\b/.test(c) || /\bruby\s+-c\b/.test(c) || /\bphp\s+-l\b/.test(c)) return false
  if (EXEC_PATTERNS.some((re) => re.test(c))) return true
  if (COMPILE_ONLY_PATTERNS.some((re) => re.test(c))) return false
  return false
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
