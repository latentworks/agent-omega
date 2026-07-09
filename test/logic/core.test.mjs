// verify-guard/core.mjs — the classifier that decides whether the agent ACTUALLY
// ran the code (a real verification) vs. merely compiled/parsed/probed it. The whole
// plugin exists to stop "it compiles" being mistaken for "it works", so the crown-jewel
// assertion here is that `node --check` (parse-only) does NOT count as verification.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCodeEditTool, isCodeFile, isWebBridge, isBenignNonZero,
  isVerificationCommand, observeTool, shouldNudge,
} from '../../config-template/opencode/verify-guard/core.mjs'

test('isCodeEditTool: only edit/write/patch/multiedit, case-insensitive', () => {
  for (const t of ['edit', 'write', 'patch', 'multiedit', 'Edit', 'WRITE']) assert.equal(isCodeEditTool(t), true, t)
  for (const t of ['read', 'bash', 'grep', '', null, undefined]) assert.equal(isCodeEditTool(t), false, String(t))
})

test('isCodeFile: source extensions + Dockerfile/Makefile, not prose', () => {
  for (const p of ['a.js', 'b.py', 'c/d.tsx', 'x.rs', 'y.CSS', 'Dockerfile', 'dockerfile.dev', 'Makefile']) assert.equal(isCodeFile(p), true, p)
  for (const p of ['notes.txt', 'README.md', 'data.json', 'photo.png', '', null]) assert.equal(isCodeFile(p), false, String(p))
})

test('isVerificationCommand: EXECUTING the code counts as verification', () => {
  for (const c of [
    'npm test', 'npm run test', 'pytest', 'go test ./...', 'cargo test',
    'node script.mjs', 'python app.py', 'vitest run', 'make test', 'dotnet test',
    './run.sh', 'npm run build && npm test', // exec wins even when a compile pattern also matches
  ]) assert.equal(isVerificationCommand(c), true, c)
})

test('isVerificationCommand: compile/lint/typecheck-only does NOT count', () => {
  for (const c of [
    'tsc', 'eslint .', 'prettier --write .', 'npm run build', 'npm run lint',
    'go build ./...', 'go vet ./...', 'cargo build', 'cargo check', 'dotnet build', 'make',
  ]) assert.equal(isVerificationCommand(c), false, c)
})

test('isVerificationCommand: version/help probes run no real code', () => {
  for (const c of ['node --version', 'node -v', 'pytest --version', 'python3 -m pytest --version', 'npm --help'])
    assert.equal(isVerificationCommand(c), false, c)
})

test('CROWN JEWEL: `node --check` parses but does NOT run — must not count as verification', () => {
  // This is the module's own stated principle (core.mjs:95). If this ever returns true,
  // the whole "prove behavior, not plumbing" guarantee is silently broken.
  for (const c of ['node --check sidecar.mjs', 'node -c x.js', 'python -m py_compile x.py', 'ruby -c app.rb', 'php -l index.php'])
    assert.equal(isVerificationCommand(c), false, c)
})

test('isWebBridge / isVerificationCommand: web.py research is neither a test nor a build', () => {
  assert.equal(isWebBridge('python web.py search "err"'), true)
  assert.equal(isWebBridge('python app.py'), false)
  assert.equal(isVerificationCommand('python web.py read "http://x"'), false) // research, not verification
})

test('isBenignNonZero: grep/diff family exit non-zero as a normal signal', () => {
  for (const c of ['grep foo file', 'rg pattern', 'diff a b', 'cmp a b', 'find . -name x']) assert.equal(isBenignNonZero(c), true, c)
  for (const c of ['npm test', 'node app.js']) assert.equal(isBenignNonZero(c), false, c)
})

test('observeTool: an edit to a code file flags codeChanged; a real test run flags verified', () => {
  const s = { codeChanged: false, verified: false }
  observeTool(s, { tool: 'edit', args: { filePath: 'src/app.js' } })
  assert.equal(s.codeChanged, true)
  assert.equal(s.verified, false)
  observeTool(s, { tool: 'bash', args: { command: 'npm test' } })
  assert.equal(s.verified, true)
})

test('observeTool: editing prose or running node --check does NOT flag change/verified', () => {
  const s = { codeChanged: false, verified: false }
  observeTool(s, { tool: 'edit', args: { filePath: 'README.md' } })
  assert.equal(s.codeChanged, false)
  observeTool(s, { tool: 'write', args: { filePath: 'app.js' } })      // now a real code change
  observeTool(s, { tool: 'bash', args: { command: 'node --check app.js' } }) // parse-only
  assert.equal(s.codeChanged, true)
  assert.equal(s.verified, false, 'node --check must not satisfy the verify gate')
})

test('shouldNudge: nudge only when code changed, unverified, and under the cap', () => {
  assert.equal(shouldNudge({ codeChanged: true, verified: false, nudgeCount: 0, cap: 3 }), true)
  assert.equal(shouldNudge({ codeChanged: true, verified: true, nudgeCount: 0, cap: 3 }), false)  // verified
  assert.equal(shouldNudge({ codeChanged: false, verified: false, nudgeCount: 0, cap: 3 }), false) // nothing changed
  assert.equal(shouldNudge({ codeChanged: true, verified: false, nudgeCount: 3, cap: 3 }), false)  // cap reached
})
