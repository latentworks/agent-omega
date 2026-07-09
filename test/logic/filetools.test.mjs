// council/filetools.mjs — the read-only, privacy-hardened file-view sandbox given to council
// members. The guarantee under test is DUAL: (1) the four tools genuinely read real files
// (behavior, not plumbing — a real temp dir with real content, round-tripped through execute),
// and (2) resolveSafe refuses every documented escape (traversal/UNC/8.3/ADS/hardlink) and every
// secret path (.env leaf, .ssh segment) against the REAL filesystem, not a mock.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSafe, createFileTools } from '../../config-template/opencode/council/filetools.mjs'

// A real sandbox on the real fs. realpath the root so isUnder() comparisons hold even if the
// OS temp dir is itself a symlink (e.g. macОS /tmp). Deterministic fixed name — no randomness.
let SCOPE = ''
const ROOT = path.join(os.tmpdir(), 'ao-ftools-test')

before(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
  SCOPE = fs.realpathSync.native(ROOT)
  fs.writeFileSync(path.join(SCOPE, 'hello.txt'), 'line1\nline2\nline3')
  fs.writeFileSync(path.join(SCOPE, 'needle.txt'), 'nothing here\nfind the needle here\nmore text')
  fs.writeFileSync(path.join(SCOPE, '.env'), 'SECRET=xyz') // a secret that must never be readable
  fs.mkdirSync(path.join(SCOPE, 'sub'), { recursive: true })
  // a hard link: two directory entries for one inode → nlink 2 on both (the F1 escape)
  fs.writeFileSync(path.join(SCOPE, 'linktarget.txt'), 'linked content')
  fs.linkSync(path.join(SCOPE, 'linktarget.txt'), path.join(SCOPE, 'linkalias.txt'))
})
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch {} })

// ---- resolveSafe: every documented escape is refused (it THROWS a Refusal) ----
test('resolveSafe: rejects null bytes, UNC, home-relative, 8.3, drive-relative, and ADS', () => {
  assert.throws(() => resolveSafe('a\0b', SCOPE), /invalid path/)
  assert.throws(() => resolveSafe('\\\\server\\share', SCOPE), /UNC/)
  assert.throws(() => resolveSafe('//server/share', SCOPE), /UNC/)
  assert.throws(() => resolveSafe('~/secrets', SCOPE), /home-relative/)
  assert.throws(() => resolveSafe('PROGRA~1', SCOPE), /short \(8\.3\)/)
  assert.throws(() => resolveSafe('C:relative', SCOPE), /drive-relative/)
  assert.throws(() => resolveSafe('file.txt:stream', SCOPE), /alternate data streams/)
})

test('resolveSafe: not-found and wrong-kind are distinct refusals', () => {
  assert.throws(() => resolveSafe('ghost.txt', SCOPE, { kind: 'file' }), /not found/)
  assert.throws(() => resolveSafe('sub', SCOPE, { kind: 'file' }), /not a file/)
})

test('resolveSafe: a good file inside the project resolves and is tagged inProject', () => {
  const r = resolveSafe('hello.txt', SCOPE, { kind: 'file' })
  assert.equal(r.inProject, true)
  assert.equal(path.basename(r.real), 'hello.txt')
})

test('resolveSafe: a .env leaf is denied even though it really exists in the project', () => {
  assert.throws(() => resolveSafe('.env', SCOPE, { kind: 'file' }), /sensitive path/)
})

test('resolveSafe: a path with a .ssh segment is denied (deny-list beats existence)', () => {
  // denyHard runs on the logical path before realpath, so the target need not exist.
  assert.throws(() => resolveSafe('sub/.ssh/id_rsa', SCOPE), /sensitive path/)
})

test('resolveSafe: a hard-linked file (nlink > 1) is refused — the F1 escape', () => {
  assert.throws(() => resolveSafe('linktarget.txt', SCOPE, { kind: 'file' }), /sensitive path/)
})

// ---- createFileTools: the four tools genuinely read real content ----
test('read: returns the real file content, and slices by start_line/max_lines', async () => {
  const { read } = createFileTools({ directory: SCOPE })
  assert.equal(await read.execute({ path: 'hello.txt' }), 'line1\nline2\nline3')
  // start at line 2, take 1 line → "line2", plus the module's honest "more lines" notice (line3 remains)
  assert.equal(await read.execute({ path: 'hello.txt', start_line: 2, max_lines: 1 }), 'line2\n…[1 more lines]')
})

test('read: a denied path returns the refusal STRING (never throws into the SDK loop)', async () => {
  const { read } = createFileTools({ directory: SCOPE })
  const out = await read.execute({ path: '.env' })
  assert.equal(out, 'denied: sensitive path')
  assert.ok(!out.includes('SECRET'), 'the secret content never leaks')
})

test('list: shows project children but omits denied ones (.env)', async () => {
  const { list } = createFileTools({ directory: SCOPE })
  const out = await list.execute({ path: '.' })
  assert.match(out, /\[file\] hello\.txt/)
  assert.match(out, /\[dir\]  sub/)
  assert.ok(!out.includes('.env'), 'a sensitive child is omitted from the listing')
})

test('glob: finds matching files and skips hard-linked ones (F1 in the walker)', async () => {
  const { glob } = createFileTools({ directory: SCOPE })
  const out = await glob.execute({ pattern: '*.txt' })
  assert.match(out, /hello\.txt/)
  assert.match(out, /needle\.txt/)
  assert.ok(!out.includes('linktarget.txt'), 'the hard-linked file is skipped by the walker')
})

test('grep: returns file:line: text for a real content match', async () => {
  const { grep } = createFileTools({ directory: SCOPE })
  const out = await grep.execute({ pattern: 'needle' })
  assert.match(out, /needle\.txt:2: .*needle/)
})

test('grep: a catastrophic (ReDoS) pattern is refused up front', async () => {
  const { grep } = createFileTools({ directory: SCOPE })
  const out = await grep.execute({ pattern: '(a+)+$' })
  assert.equal(out, 'denied: pattern too complex')
})
