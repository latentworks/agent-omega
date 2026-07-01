// Failure classification + blind-retry detection + eval records.
//
// Pure logic, no side effects (the unified plugin wiring in index.js drives it
// and owns the re-prompt + JSONL logging). Adapted from Codex's parallel draft
// ("verify-guard"); the classifier tag is preserved so its eval records and
// markers stay attributable.

import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const CLASSIFIER_TAG = 'verify-guard'
// Eval records go to the OS temp dir — ABSOLUTE + cross-platform. NEVER a relative or
// Windows path: under `opencode run --dir <repo>` a relative path is created INSIDE the
// repo and gets swept into the user's git diff (that was the verify-guard-logs bug).
export const FAILURE_LOG_DIR = join(tmpdir(), 'verify-guard-evals')

const REDACTED = '[verify-guard-redacted]'

const RULES = [
  {
    category: 'port_in_use',
    pattern: /EADDRINUSE|address already in use|Only one usage of each socket address/i,
    summary: 'A port needed by the command is already in use.',
    advice: 'Do not retry the same command. Find the process using the port or choose a different port first.',
  },
  {
    category: 'missing_dependency',
    pattern: /MODULE_NOT_FOUND|Cannot find module|ModuleNotFoundError|No module named|command not found|is not recognized as/i,
    summary: 'The command failed because a dependency, module, or executable is missing.',
    advice: 'Do not retry blindly. Identify the missing dependency or command and install or route to the expected project runner.',
  },
  {
    category: 'syntax_or_type_error',
    pattern: /SyntaxError|Unexpected token|ParseError|\bTS\d{4}\b|type error|TypeError:/i,
    summary: 'The command failed because code did not parse, typecheck, or execute cleanly.',
    advice: 'Inspect the first syntax/type error and fix that root cause before rerunning broad commands.',
  },
  {
    category: 'test_assertion_failure',
    pattern: /AssertionError|expected .* received|Expected:|Received:|\bFAIL\b|\bFAILED\b|pytest.*failed|toEqual|toBe\(/is,
    summary: 'A test assertion failed.',
    advice: 'Read the expected-versus-actual output and explain why the assertion fails before changing implementation or tests.',
  },
  {
    category: 'permission_or_sandbox',
    pattern: /Permission denied|Access is denied|denied by permission|operation not permitted|\bEPERM\b|\bEACCES\b|sandbox/i,
    summary: 'The command was blocked by permissions or sandboxing.',
    advice: 'Do not bypass the guardrail. Determine whether the action is in scope and ask the user if it is risky or destructive.',
  },
  {
    category: 'network_or_api',
    pattern: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|HTTP\s+(?:401|403|5\d\d)|Unauthorized|Forbidden/i,
    summary: 'The command failed at a network, local server, or API boundary.',
    advice: 'Check whether the service is running, the URL is right, and required auth is present before retrying.',
  },
  {
    category: 'timeout_or_hang',
    pattern: /timed? out|TimeoutError|operation timed out|deadline exceeded/i,
    summary: 'The command timed out or appeared to hang.',
    advice: 'Find the readiness signal or blocking operation. Do not extend timeouts without evidence that the process is healthy.',
  },
]

export function classifyFailure({ tool = 'unknown', args = {}, output = '', title = '', metadata = {} } = {}) {
  const command = extractCommand(args)
  const text = `${title}\n${output}\n${safeStringify(metadata)}`
  const matched = RULES.find((rule) => rule.pattern.test(text))
  const base = matched ?? {
    category: 'unknown_failure',
    summary: 'The command failed, but the failure did not match a known classifier yet.',
    advice: 'Do not retry blindly. Read the failing output and identify the root cause first.',
  }

  return {
    tag: CLASSIFIER_TAG,
    tool,
    command,
    category: base.category,
    summary: base.summary,
    advice: base.advice,
    retryKey: makeRetryKey(tool, command, base.category),
    evidence: truncate(redactSensitive(text), 1200),
  }
}

export function createFailureTracker() {
  const counts = new Map()

  return {
    noteFailure(sessionID, classification) {
      const key = `${sessionID || 'unknown-session'}:${classification.retryKey || classification.category}`
      const repeatCount = (counts.get(key) ?? 0) + 1
      counts.set(key, repeatCount)

      return {
        ...classification,
        repeatCount,
        labels: repeatCount > 1 ? ['unresolved_failure', 'blind_retry'] : ['unresolved_failure'],
        escalation: repeatCount >= 3 ? 'force_debugging_loop' : repeatCount === 2 ? 'require_root_cause' : 'classify_and_continue',
      }
    },
    reset(sessionID) {
      for (const key of [...counts.keys()]) {
        if (key.startsWith(`${sessionID || 'unknown-session'}:`)) counts.delete(key)
      }
    },
  }
}

export function buildBehaviorEvalRecord({ sessionID, event, classification, args = {}, output = '' } = {}) {
  return {
    tag: CLASSIFIER_TAG,
    time: new Date().toISOString(),
    event,
    sessionID,
    tool: classification?.tool,
    command: redactSensitive(classification?.command || extractCommand(args)),
    category: classification?.category,
    labels: classification?.labels ?? [],
    repeatCount: classification?.repeatCount ?? 1,
    escalation: classification?.escalation,
    summary: classification?.summary,
    advice: classification?.advice,
    args: redactObject(args),
    outputTail: truncate(redactSensitive(output), 2000),
  }
}

export function detectDoneWithoutVerification(text = '', { editedFilesCount = 0, sawRuntimeEvidence = false } = {}) {
  if (sawRuntimeEvidence || editedFilesCount < 1) return false
  const claimsDone = /\b(done|fixed|implemented|working|resolved|completed)\b/i.test(text)
  const citesEvidence = /\b(ran|observed|captured|output|exit code|screenshot|curl|http|browser|cli|api|request|response)\b/i.test(text)
  return claimsDone && !citesEvidence
}

export function buildHarnessMessage(classification) {
  const header = `[${CLASSIFIER_TAG} failure-classifier] ${classification.category}: ${classification.summary}`
  if ((classification.repeatCount ?? 1) >= 3) {
    return `${header}\nThis is the third repeated failure. Stop blind retries and enter a debugging loop: state the root-cause hypothesis, identify the smallest confirming check, then run only that check.`
  }
  if ((classification.repeatCount ?? 1) >= 2) {
    return `${header}\nRepeated failure detected. Before retrying, state the root-cause hypothesis and what evidence will confirm it. ${classification.advice}`
  }
  return `${header}\n${classification.advice}`
}

export function isFailureResult(r) {
  const { title = '', output = '', metadata = {} } = r || {}
  const exitCode = extractExitCode(output, metadata)
  if (typeof exitCode === 'number') return exitCode !== 0
  return /\b(error|failed|failure|exception)\b/i.test(`${title}\n${output}`)
}

export function redactSensitive(value) {
  return String(value ?? '')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, REDACTED)
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, `$1${REDACTED}`)
    .replace(/(--?(?:api[-_]?key|token|password|secret)\s+)[^\s"']+/gi, `$1${REDACTED}`)
    .replace(/((?:api[-_]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, `$1${REDACTED}`)
}

function extractCommand(args = {}) {
  if (typeof args.command === 'string') return args.command
  if (Array.isArray(args.command)) return args.command.join(' ')
  if (typeof args.cmd === 'string') return args.cmd
  return ''
}

function extractExitCode(output = '', metadata = {}) {
  for (const key of ['exitCode', 'exit_code', 'code', 'status']) {
    if (Number.isInteger(metadata?.[key])) return metadata[key]
  }
  const match = String(output).match(/exit(?:ed)?(?:\s+with)?(?:\s+code)?[:=]?\s*(-?\d+)/i)
  return match ? Number(match[1]) : undefined
}

function makeRetryKey(tool, command, category) {
  return `${tool}:${category}:${command.replace(/\s+/g, ' ').trim().slice(0, 160)}`
}

function redactObject(value) {
  return JSON.parse(redactSensitive(safeStringify(value)))
}

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '[verify-guard-unstringifiable]'
  }
}

function truncate(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}...` : text
}
