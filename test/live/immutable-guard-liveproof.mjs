// #19 — Lever I live turn-on proof. Run explicitly:  node test/live/immutable-guard-liveproof.mjs
//
// Proves, end to end, that turning the immutable-artifact guard on is real:
//   A. declareImmutableOracles() against a REAL workspace emits the long oracle
//      basenames PLUS the volume's real 8.3 short alias, and never the source file.
//   B. Setting OMEGA_IMMUTABLE_ORACLES in the process env flips the guard on inside
//      a freshly-loaded, REAL index.js plugin instance: an oracle overwrite (long
//      form AND 8.3 alias) is DENIED by the guard; a legitimate source write is
//      allowed; with the var unset the guard abstains and every write is allowed.
//      Each arm runs in its own child process so index.js's module-load env read is
//      genuinely exercised (not mocked).
//   C. On the live NTFS volume, a write to the 8.3 alias truly lands on the oracle
//      file — the concrete bypass surface the declaration closes.
//
// This is the real shipping plugin (config-template/opencode/task-quality/index.js),
// its real module-load env read, its real tool.execute.admission hook, and its real
// admitTaskQualityTool decision. Only the engine's durable-state bridge is stubbed —
// to hand the hook a genuine APPROVED lifecycle built by the real record* functions —
// because durable persistence is the engine's, not the guard logic under test.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { declareImmutableOracles, shortNameBasename } from './immutable-oracle-declaration.mjs'
import { buildRouteHandoff } from '../../config-template/opencode/task-quality/handoff.mjs'
import { createLifecycle, digestPlan, recordRepairedPlan, recordUserDecision } from '../../config-template/opencode/task-quality/lifecycle.mjs'
// index.js reads process.env.OMEGA_IMMUTABLE_ORACLES at module load — this static
// import binds it from THIS process's env, which is exactly what each child probe
// (spawned with the var set or unset) is here to exercise.
import { TaskQualityPlugin } from '../../config-template/opencode/task-quality/index.js'

const SELF = fileURLToPath(import.meta.url)

// A genuine APPROVED lifecycle, built by the real lifecycle state machine (same
// path the engine drives): route handoff -> reviewed repaired plan -> external-user
// go. admitTaskQualityTool only reaches the immutable guard once a mutation is
// otherwise authorized, so the guard's effect is observable only past this gate.
function buildApprovedLifecycle() {
  const handoff = buildRouteHandoff({ sessionID: 'ses-guard', messageID: 'msg-task', messages: ['Repair src/port.mjs'], skillNames: ['debugging'], routedAt: 1 })
  const planText = 'Plan'
  const passReview = { route: { kind: 'crap', model: 'local/model' }, submission: { kind: 'plan', digest: digestPlan(planText) }, result: { verdict: 'pass', summary: 'No supported gaps.', findings: [], dispositions: [] } }
  const repaired = recordRepairedPlan(createLifecycle(handoff), planText, { review: passReview, reviewedDigest: passReview.submission.digest, acceptanceCriteria: ['Repair parsePort'] })
  return recordUserDecision(repaired, { origin: 'external-user', messageID: 'msg-go', text: 'go for it', expectedGeneration: repaired.generation }).lifecycle
}

// PROBE: run in a child process whose env was set (or not) by the orchestrator, so
// index.js's IMMUTABLE_ORACLES is parsed from THIS process's env. Drives the real
// admission hook against the paths passed on argv and prints its decisions.
async function runProbe(paths) {
  const approved = buildApprovedLifecycle()
  const internal = {
    get: async () => ({ data: approved, revision: 1, generation: approved.generation }),
    update: async () => ({}),
    review: async () => { throw new Error('review path is unused by the admission probe') },
  }
  const hooks = await TaskQualityPlugin({ client: {}, experimental_task_quality: internal })
  const admit = async (filePath) => {
    const output = {}
    await hooks['tool.execute.admission']({ tool: 'write', source: 'engine', capability: 'mutate', sessionID: 'ses-guard', args: { filePath } }, output)
    return output.decision || 'allow'
  }
  const [srcP, longP, shortP] = paths
  const result = {
    env: process.env.OMEGA_IMMUTABLE_ORACLES || null,
    src: await admit(srcP),
    oracleLong: await admit(longP),
    oracle83: shortP ? await admit(shortP) : 'n/a',
  }
  process.stdout.write('PROBE_RESULT ' + JSON.stringify(result) + '\n')
}

async function runOrchestrator() {
  const failures = []
  const ok = (cond, label) => { console.log((cond ? '  PASS' : '  FAIL') + ' — ' + label); if (!cond) failures.push(label) }

  // ---- Part A: the turn-on declaration against a real workspace ----
  const ws = mkdtempSync(path.join(os.tmpdir(), 'lever-i-ws-'))
  mkdirSync(path.join(ws, 'tests'), { recursive: true })
  mkdirSync(path.join(ws, 'src'), { recursive: true })
  writeFileSync(path.join(ws, 'tests', 'public.test.mjs'), 'ORACLE: the hidden grading test\n')
  writeFileSync(path.join(ws, 'README.md'), 'Task contract\n')
  writeFileSync(path.join(ws, 'src', 'port.mjs'), 'export function parsePort() {}\n')

  const decl = declareImmutableOracles(ws)
  const declSet = new Set(decl.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  const realShort = shortNameBasename(path.join(ws, 'tests', 'public.test.mjs'))
  console.log('Part A — turn-on declaration for a real workspace:')
  console.log('  OMEGA_IMMUTABLE_ORACLES = ' + JSON.stringify(decl))
  console.log('  queried 8.3 short name  = ' + JSON.stringify(realShort))
  ok(declSet.has('public.test.mjs'), 'declares the long oracle basename public.test.mjs')
  ok(declSet.has('readme.md'), 'declares the README oracle basename README.md')
  ok(realShort ? declSet.has(realShort.toLowerCase()) : true, 'declares the real 8.3 alias ' + (realShort || '(none on this volume)'))
  ok(!declSet.has('port.mjs'), 'does NOT declare the source file port.mjs (guard can never false-block source)')

  // ---- Part B: env flips the REAL plugin guard, fresh module load per child ----
  console.log('Part B — env flips the REAL index.js plugin guard (fresh module load per child process):')
  const testPaths = ['src/port.mjs', 'tests/public.test.mjs', realShort ? 'tests/' + realShort : '']
  const probe = (envOn) => {
    const env = { ...process.env }
    if (envOn) env.OMEGA_IMMUTABLE_ORACLES = decl
    else delete env.OMEGA_IMMUTABLE_ORACLES
    const out = execFileSync(process.execPath, [SELF, '--probe', ...testPaths], { env, encoding: 'utf8', windowsHide: true })
    const line = out.split(/\r?\n/).find((l) => l.startsWith('PROBE_RESULT '))
    if (!line) throw new Error('probe produced no PROBE_RESULT line; output:\n' + out)
    return JSON.parse(line.slice('PROBE_RESULT '.length))
  }
  const on = probe(true)
  const off = probe(false)
  console.log('  guard ON  (' + JSON.stringify(on.env) + '): ' + JSON.stringify({ src: on.src, oracleLong: on.oracleLong, oracle83: on.oracle83 }))
  console.log('  guard OFF (unset)         : ' + JSON.stringify({ src: off.src, oracleLong: off.oracleLong, oracle83: off.oracle83 }))
  ok(on.src === 'allow', 'ON: legitimate source write src/port.mjs is ALLOWED')
  ok(on.oracleLong === 'deny', 'ON: oracle overwrite tests/public.test.mjs is DENIED by the guard')
  ok(realShort ? on.oracle83 === 'deny' : true, 'ON: oracle overwrite via 8.3 alias tests/' + (realShort || '(n/a)') + ' is DENIED by the guard')
  ok(off.src === 'allow' && off.oracleLong === 'allow' && (off.oracle83 === 'allow' || off.oracle83 === 'n/a'), 'OFF (unset): guard abstains — every write allowed (byte-identical to production default)')

  // ---- Part C: live NTFS proof that the 8.3 alias is a real write path ----
  console.log('Part C — live NTFS: a write to the 8.3 alias lands on the oracle file:')
  const oraclePath = path.join(ws, 'tests', 'public.test.mjs')
  const before = readFileSync(oraclePath, 'utf8')
  if (process.platform === 'win32' && realShort) {
    // Write through the 8.3 alias with the SAME fs API the engine's write tool uses —
    // NTFS resolves PUBLIC~1.MJS to the very same inode as public.test.mjs.
    writeFileSync(path.join(ws, 'tests', realShort), 'OVERWRITTEN-VIA-8.3\n')
    const after = readFileSync(oraclePath, 'utf8')
    ok(before !== after && /OVERWRITTEN-VIA-8.3/.test(after), 'a write to ' + realShort + ' changed public.test.mjs (same file — the concrete bypass the declaration closes)')
  } else {
    console.log('  SKIP — not Windows or no 8.3 alias on this volume (bypass surface absent here)')
  }

  rmSync(ws, { recursive: true, force: true })

  console.log('')
  if (failures.length) { console.log('RESULT: FAIL (' + failures.length + ' check(s) failed)'); process.exitCode = 1; return }
  console.log('RESULT: PASS — Lever I turn-on wired, env→plugin guard flip proven on the real module, live 8.3 bypass closed')
}

if (process.argv.includes('--probe')) {
  const paths = process.argv.slice(process.argv.indexOf('--probe') + 1)
  runProbe(paths)
} else {
  runOrchestrator()
}
