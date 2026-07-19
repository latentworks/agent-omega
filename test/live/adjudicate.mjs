// adjudicate.mjs
//
// Adjudicates an Agent-Omega task-quality wave by EXECUTION (ground truth),
// independently of whatever the harness itself already wrote into
// <runID>.summary.json. This is a deliberately separate re-read of the raw
// per-case evaluation.json files on disk: the whole point is that a fresh,
// independent pass over the ground-truth artifacts can catch a case the
// harness's own summary rollup missed, mis-scored, or went stale on (see the
// "cardinal backfire" cross-check in buildWaveVerdict below). It optionally
// cross-checks a BLIND cloud judge (gpt-5.4) against that same execution
// truth — the judge can be wrong; running the code against the oracle cannot.
//
// Usage:
//   node adjudicate.mjs <runID> [--judge]
//
// Env:
//   AGENT_OMEGA_TEST_OUTPUT_DIR  override the wave-output ROOT (defaults to
//                                 <repo>/.omega-test-runs, same convention as
//                                 test/live/task-quality-campaign.mjs).
//
// Dependencies: none (Node built-ins only). The optional --judge path talks
// to the OpenAI chat completions API over a direct node:https call.

import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url))
const APP_REPO = path.resolve(SCRIPT_ROOT, '../..')
const ROOT = path.resolve(process.env.AGENT_OMEGA_TEST_OUTPUT_DIR || path.join(APP_REPO, '.omega-test-runs'))

// Per-kind primary produced source file, mirroring the fixture layout the
// harness itself writes (test/live/task-quality-campaign.mjs: prepareFixture
// / oracle()). Used only by the optional --judge path to locate "the" file to
// show the blind judge.
export const KIND_PRIMARY_FILE = {
  repair: 'src/port.mjs',
  csvrow: 'src/csvrow.mjs',
  duration: 'src/duration.mjs',
  semver: 'src/semver.mjs',
  evidence: 'src/response.mjs',
}

const JUDGE_MODEL = 'gpt-5.4'
const JUDGE_FILE_CAP_BYTES = 8192

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8'))
}

function capText(text, maxBytes) {
  const buf = Buffer.from(String(text ?? ''), 'utf8')
  if (buf.length <= maxBytes) return buf.toString('utf8')
  return buf.subarray(0, maxBytes).toString('utf8') + `\n... [truncated at ${maxBytes} bytes]`
}

// A case dir belongs to this runID if it matches the harness's own naming
// convention (`auto-<sequence>-<lane>-<kind>-<arm>`, sequence === runID for a
// primary lane or `${runID}-replicate` for the replicate lane) or, loosely,
// any dir literally named `${runID}` or prefixed `${runID}-` (older/other
// harness paths in this ROOT do not use the `auto-` prefix at all). This is a
// heuristic, not a guarantee: a runID that is itself a prefix of another
// runID (e.g. "f6" vs "f6-proof-1") could over-match. Documented, not solved,
// since real runIDs observed in this ROOT do not collide this way.
function belongsToRun(dirName, runID) {
  if (dirName === runID) return true
  if (dirName.startsWith(`auto-${runID}-`)) return true
  if (dirName.startsWith(`${runID}-`)) return true
  return false
}

function loadCasesForRun(runID) {
  const casesRoot = path.join(ROOT, 'cases')
  const cases = []
  const skipped = []
  let dirents = []
  try {
    dirents = fs.readdirSync(casesRoot, { withFileTypes: true })
  } catch (error) {
    throw new Error(`cannot read cases dir ${casesRoot}: ${error.message}`)
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    if (!belongsToRun(dirent.name, runID)) continue
    const caseDir = path.join(casesRoot, dirent.name)
    const evalPath = path.join(caseDir, 'evaluation.json')
    if (!fs.existsSync(evalPath)) {
      skipped.push({ dir: dirent.name, reason: 'no evaluation.json (case incomplete or never produced one)' })
      continue
    }
    let evaluation
    try {
      evaluation = readJson(evalPath)
    } catch (error) {
      skipped.push({ dir: dirent.name, reason: `evaluation.json unreadable: ${error.message}` })
      continue
    }
    cases.push({ dirName: dirent.name, caseDir, evalPath, evaluation })
  }
  return { cases, skipped }
}

// ---------------------------------------------------------------------------
// pairing + execution-grounded verdict (step 3/4 of the spec)
// ---------------------------------------------------------------------------

function pairKey(lane, kind) {
  return `${lane}|${kind}`
}

function groupByLaneKind(cases) {
  const byKey = new Map()
  for (const item of cases) {
    const ev = item.evaluation
    const arm = ev?.arm
    if (arm !== 'omega' && arm !== 'raw') continue // not a recognized arm; excluded, not silently merged
    const key = pairKey(ev.lane, ev.kind)
    const entry = byKey.get(key) || { lane: ev.lane ?? null, kind: ev.kind ?? null, omega: [], raw: [] }
    entry[arm].push(item)
    byKey.set(key, entry)
  }
  return byKey
}

// betterWork lives at evaluation.outcomes.betterWork and is ALREADY computed
// by the harness as hidden.passed && publicTest.passed (test-quality-campaign
// computeOutcomes()) — we read it, we do not recompute it, per spec.
function betterWorkOf(item) {
  return item?.evaluation?.outcomes?.betterWork
}

function sideView(item) {
  if (!item) return null
  const ev = item.evaluation
  return {
    id: ev.id ?? item.dirName,
    betterWork: betterWorkOf(item) ?? null,
    hidden: ev.hidden ?? null,
    publicTest: ev.publicTest ?? null,
    terminalReached: ev.terminalReached ?? null,
  }
}

// Literal spec rule, unchanged:
//   omega_worse  if raw.betterWork===true && omega.betterWork===false
//   omega_better if omega.betterWork===true && raw.betterWork===false
//   equal        otherwise
// dataQuality is an ADDITIVE transparency flag (not a 4th verdict bucket) so a
// harness-failure / null-betterWork pair that literally falls into "equal" by
// the rule above is never silently indistinguishable from a genuine tie.
function executionVerdictFor(omegaItem, rawItem) {
  const o = betterWorkOf(omegaItem)
  const r = betterWorkOf(rawItem)
  let verdict
  if (r === true && o === false) verdict = 'omega_worse'
  else if (o === true && r === false) verdict = 'omega_better'
  else verdict = 'equal'
  const oScored = typeof o === 'boolean'
  const rScored = typeof r === 'boolean'
  const dataQuality = oScored && rScored ? 'both-scored'
    : !oScored && !rScored ? 'both-unscored'
    : !oScored ? 'omega-unscored' : 'raw-unscored'
  return { verdict, dataQuality }
}

function buildPairs(cases) {
  const byKey = groupByLaneKind(cases)
  const pairs = []
  const incomparable = []
  for (const [, entry] of [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const comparable = entry.omega.length === 1 && entry.raw.length === 1
    if (!comparable) {
      const reason = entry.omega.length === 0 && entry.raw.length === 0 ? 'both-arms-missing'
        : entry.omega.length === 0 ? 'omega-arm-missing'
        : entry.raw.length === 0 ? 'raw-arm-missing'
        : entry.omega.length > 1 && entry.raw.length > 1 ? 'duplicate-both-arms'
        : entry.omega.length > 1 ? 'duplicate-omega-arm'
        : 'duplicate-raw-arm'
      incomparable.push({
        lane: entry.lane, kind: entry.kind, reason,
        omegaCount: entry.omega.length, rawCount: entry.raw.length,
      })
      continue
    }
    const omegaItem = entry.omega[0]
    const rawItem = entry.raw[0]
    const { verdict, dataQuality } = executionVerdictFor(omegaItem, rawItem)
    pairs.push({
      lane: entry.lane,
      kind: entry.kind,
      omega: sideView(omegaItem),
      raw: sideView(rawItem),
      executionVerdict: verdict,
      dataQuality,
      _omegaCaseDir: omegaItem.caseDir,
      _rawCaseDir: rawItem.caseDir,
    })
  }
  return { pairs, incomparable }
}

// ---------------------------------------------------------------------------
// wave verdict + cardinal-backfire cross-check against the harness's OWN
// summary.json betterWorkDelta (step 4 of the spec)
// ---------------------------------------------------------------------------

function harnessTargetKind(summary) {
  if (typeof summary?.kind === 'string') return summary.kind
  if (Array.isArray(summary?.fixtures) && summary.fixtures.length === 1) return summary.fixtures[0]
  return null // multi-kind wave or unknown: no single "target", offTarget is not applicable
}

function harnessVerdictFor(summary, lane, kind) {
  const entry = summary?.betterWorkDelta?.pairs?.find((p) => p.lane === lane && p.kind === kind)
  if (!entry) return { label: 'unavailable', raw: entry ?? null }
  if (!entry.comparable) return { label: 'incomparable', raw: entry }
  if (entry.delta === -1) return { label: 'omega_worse', raw: entry }
  if (entry.delta === 1) return { label: 'omega_better', raw: entry }
  if (entry.delta === 0) return { label: 'equal', raw: entry }
  return { label: 'unavailable', raw: entry }
}

function buildWaveVerdict(pairs, summary) {
  const omegaWorse = pairs.filter((p) => p.executionVerdict === 'omega_worse')
  const omegaBetter = pairs.filter((p) => p.executionVerdict === 'omega_better')
  const equal = pairs.filter((p) => p.executionVerdict === 'equal')
  // CARDINAL honesty guard. The literal betterWork rule only fires omega_worse when
  // omega.betterWork===false EXPLICITLY. A pair where raw PASSED but omega produced
  // no pass-score at all (betterWork null/undefined — a crash, deadlock, or empty
  // artifact) is not `false`, so it lands in "equal" and never counts toward
  // omegaWorseCount. For "never ship worse than raw" that omega-failed-where-raw-
  // succeeded case is the single most important worse-case, so we surface it: it does
  // NOT get force-relabelled omega_worse (null can be a benign harness glitch and
  // false-flagging would erode the gate's precision), but it DOES taint a blanket
  // zeroWorse=true and demands a human look before the gate is trusted.
  const dataQualityWarnings = pairs
    .filter((p) => p.raw?.betterWork === true && p.omega?.betterWork !== true && p.executionVerdict !== 'omega_worse')
    .map((p) => ({
      lane: p.lane,
      kind: p.kind,
      omegaBetterWork: p.omega?.betterWork ?? null,
      dataQuality: p.dataQuality,
      note: 'omega produced no pass-score while raw passed — potential worse-case not captured by the literal betterWork rule; inspect before trusting zeroWorse',
    }))
  const targetKind = harnessTargetKind(summary)
  const backfire = omegaWorse.map((p) => {
    const harness = harnessVerdictFor(summary, p.lane, p.kind)
    return {
      lane: p.lane,
      kind: p.kind,
      executionVerdict: p.executionVerdict,
      harnessVerdict: harness.label,
      // true only when the harness's OWN summary positively said something
      // other than omega_worse for this exact pair — i.e. a fresh execution
      // re-read caught a worse-case the harness's own rollup did not flag.
      harnessDisagrees: harness.label !== 'omega_worse',
      offTarget: targetKind === null ? null : p.kind !== targetKind,
    }
  })
  return {
    zeroWorse: omegaWorse.length === 0,
    // zeroWorse is only trustworthy as a clean pass when there are ALSO no
    // omega-unscored-while-raw-passed pairs quietly folded into "equal".
    zeroWorseTrustworthy: omegaWorse.length === 0 && dataQualityWarnings.length === 0,
    omegaWorseCount: omegaWorse.length,
    omegaBetterCount: omegaBetter.length,
    equalCount: equal.length,
    dataQualityWarnings,
    backfire,
    comparablePairs: pairs.length,
    incomparablePairs: undefined, // filled by caller (needs the incomparable list length)
    targetKind,
  }
}

// ---------------------------------------------------------------------------
// optional blind cloud-judge cross-check (step 5 of the spec)
// ---------------------------------------------------------------------------

function fetchOpenAIKey() {
  const secretsScript = 'C:\\Users\\aingl\\.claude-secrets\\secrets.ps1'
  const out = execFileSync('powershell', ['-NoProfile', '-File', secretsScript, 'get', 'OPENAI_API'], { encoding: 'utf8' })
  const key = out.trim()
  if (!key) throw new Error('vault returned an empty OPENAI_API key')
  return key
}

export function listWorkspaceSourceFiles(workspaceDir) {
  const out = []
  const visit = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) out.push(path.relative(workspaceDir, full).replace(/\\/g, '/'))
    }
  }
  visit(workspaceDir)
  return out
}

// Returns { source, content } — the primary produced code file for `kind` if
// it exists, else a capped concatenation of every non-node_modules source
// file in the workspace (per spec fallback for an ambiguous case).
export function readWorkspaceArtifact(caseDir, kind) {
  const workspaceDir = path.join(caseDir, 'workspace')
  const primaryRel = KIND_PRIMARY_FILE[kind]
  const primaryPath = primaryRel ? path.join(workspaceDir, primaryRel) : null
  if (primaryPath && fs.existsSync(primaryPath)) {
    return { source: primaryRel, content: capText(fs.readFileSync(primaryPath, 'utf8'), JUDGE_FILE_CAP_BYTES) }
  }
  const files = listWorkspaceSourceFiles(workspaceDir).slice(0, 40) // hard cap on file count too
  const parts = files.map((rel) => {
    let text
    try {
      text = fs.readFileSync(path.join(workspaceDir, rel), 'utf8')
    } catch (error) {
      text = `[unreadable: ${error.message}]`
    }
    return `// ---- ${rel} ----\n${capText(text, JUDGE_FILE_CAP_BYTES)}`
  })
  return { source: 'concatenated-workspace-sources', content: parts.join('\n\n') || '[workspace had no readable source files]' }
}

export function readTaskSpec(rawCaseDir, omegaCaseDir) {
  for (const caseDir of [rawCaseDir, omegaCaseDir]) {
    const readmePath = path.join(caseDir, 'workspace', 'README.md')
    if (fs.existsSync(readmePath)) {
      try {
        return capText(fs.readFileSync(readmePath, 'utf8'), JUDGE_FILE_CAP_BYTES)
      } catch {
        // try the other side
      }
    }
  }
  return '(no README.md task spec found in either workspace)'
}

export function buildJudgeMessages({ taskSpec, lane, kind, labelA, labelB }) {
  const system = 'You are a strict code-quality judge. You will be shown a task specification and two anonymized candidate '
    + 'implementations, labeled A and B only. Judge ONLY correctness and robustness against the specification — not style, '
    + 'naming, or comments. Respond with a first line of exactly "VERDICT: A", "VERDICT: B", or "VERDICT: EQUIVALENT", '
    + 'followed by a brief rationale.'
  const user = `Task specification (lane=${lane}, kind=${kind}):\n${taskSpec}\n\n`
    + `Candidate A (source: ${labelA.source}):\n\`\`\`\n${labelA.content}\n\`\`\`\n\n`
    + `Candidate B (source: ${labelB.source}):\n\`\`\`\n${labelB.content}\n\`\`\`\n\n`
    + 'Which candidate better satisfies the specification, correctness and robustness only? If truly equivalent, say so.'
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function parseJudgeVerdict(text) {
  const match = /^\s*VERDICT:\s*(A|B|EQUIVALENT)\b/i.exec(text ?? '')
  return match ? match[1].toUpperCase() : null
}

function callOpenAI(apiKey, messages) {
  const payload = JSON.stringify({ model: JUDGE_MODEL, messages, temperature: 0 })
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 120_000,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          reject(new Error(`OpenAI API returned HTTP ${res.statusCode}: ${body.slice(0, 500)}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(new Error(`OpenAI API returned unparseable JSON: ${error.message}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('OpenAI API request timed out')))
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function judgePair(apiKey, pair) {
  const taskSpec = readTaskSpec(pair._rawCaseDir, pair._omegaCaseDir)
  const omegaArtifact = readWorkspaceArtifact(pair._omegaCaseDir, pair.kind)
  const rawArtifact = readWorkspaceArtifact(pair._rawCaseDir, pair.kind)
  const omegaIsA = crypto.randomInt(0, 2) === 1
  const labelA = omegaIsA ? omegaArtifact : rawArtifact
  const labelB = omegaIsA ? rawArtifact : omegaArtifact
  const messages = buildJudgeMessages({ taskSpec, lane: pair.lane, kind: pair.kind, labelA, labelB })
  const response = await callOpenAI(apiKey, messages)
  const text = response?.choices?.[0]?.message?.content ?? ''
  const rawVerdict = parseJudgeVerdict(text)
  const pick = rawVerdict === 'A' ? (omegaIsA ? 'omega' : 'raw')
    : rawVerdict === 'B' ? (omegaIsA ? 'raw' : 'omega')
    : rawVerdict === 'EQUIVALENT' ? 'equivalent'
    : 'unparseable'
  const judgeAgreesWithExecution = (pick === 'omega' && pair.executionVerdict === 'omega_better')
    || (pick === 'raw' && pair.executionVerdict === 'omega_worse')
    || (pick === 'equivalent' && pair.executionVerdict === 'equal')
  return {
    pick,
    rationale: text.trim(),
    judgeAgreesWithExecution,
    executionOverridesJudge: !judgeAgreesWithExecution,
  }
}

async function runJudge(pairs) {
  const apiKey = fetchOpenAIKey()
  const overrides = []
  let judged = 0
  let agreed = 0
  for (const pair of pairs) {
    try {
      pair.judge = await judgePair(apiKey, pair)
      judged += 1
      if (pair.judge.judgeAgreesWithExecution) agreed += 1
      else overrides.push({ lane: pair.lane, kind: pair.kind, judgePick: pair.judge.pick, executionVerdict: pair.executionVerdict })
    } catch (error) {
      pair.judge = { error: String(error?.message || error) }
    }
  }
  return { agreementRate: judged > 0 ? agreed / judged : null, judged, overrides }
}

// ---------------------------------------------------------------------------
// console output
// ---------------------------------------------------------------------------

function printTable(pairs, incomparable, judgeEnabled) {
  const rows = pairs.map((p) => {
    const row = {
      lane: p.lane, kind: p.kind,
      'omega.betterWork': p.omega.betterWork, 'raw.betterWork': p.raw.betterWork,
      verdict: p.executionVerdict, dataQuality: p.dataQuality,
    }
    if (judgeEnabled) {
      row.judgePick = p.judge?.pick ?? p.judge?.error ?? '(none)'
      row.judgeAgrees = p.judge?.judgeAgreesWithExecution ?? null
    }
    return row
  })
  for (const inc of incomparable) {
    rows.push({
      lane: inc.lane, kind: inc.kind,
      'omega.betterWork': `(${inc.omegaCount})`, 'raw.betterWork': `(${inc.rawCount})`,
      verdict: 'INCOMPARABLE', dataQuality: inc.reason,
      ...(judgeEnabled ? { judgePick: '-', judgeAgrees: null } : {}),
    })
  }
  if (rows.length === 0) {
    console.log('(no pairs or incomparable rows found for this runID)')
    return
  }
  console.table(rows)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const runID = process.argv[2]
  const judgeEnabled = process.argv.includes('--judge')
  if (!runID || runID.startsWith('--')) {
    console.error('Usage: node adjudicate.mjs <runID> [--judge]')
    process.exit(1)
  }

  const summaryPath = path.join(ROOT, `${runID}.summary.json`)
  if (!fs.existsSync(summaryPath)) {
    console.error(`Cannot adjudicate ${runID}: ${summaryPath} does not exist (wave not finished, or wrong runID).`)
    process.exit(1)
  }
  const summary = readJson(summaryPath)

  const { cases, skipped } = loadCasesForRun(runID)
  if (skipped.length > 0) {
    for (const s of skipped) console.error(`[adjudicate] skipping cases/${s.dir}: ${s.reason}`)
  }
  if (cases.length === 0) {
    console.error(`[adjudicate] no case dirs with evaluation.json matched runID ${runID} under ${path.join(ROOT, 'cases')}`)
  }

  const { pairs, incomparable } = buildPairs(cases)

  let judgeSummary
  if (judgeEnabled) {
    if (pairs.length === 0) {
      console.error('[adjudicate] --judge requested but there are no comparable pairs; skipping judge calls.')
    } else {
      judgeSummary = await runJudge(pairs)
    }
  }

  const waveVerdict = buildWaveVerdict(pairs, summary)
  waveVerdict.incomparablePairs = incomparable.length

  const output = {
    runID,
    pairs: pairs.map(({ _omegaCaseDir, _rawCaseDir, ...rest }) => rest),
    incomparable, // additive: per-item detail behind waveVerdict.incomparablePairs' count
    waveVerdict,
    ...(judgeSummary ? { judgeSummary } : {}),
  }

  printTable(pairs, incomparable, judgeEnabled)
  console.log(
    `WAVE VERDICT: zeroWorse=${waveVerdict.zeroWorse} trustworthy=${waveVerdict.zeroWorseTrustworthy} `
    + `| comparable=${waveVerdict.comparablePairs} `
    + `incomparable=${waveVerdict.incomparablePairs} | omega_worse=${waveVerdict.omegaWorseCount} `
    + `omega_better=${waveVerdict.omegaBetterCount} equal=${waveVerdict.equalCount}`
    + (waveVerdict.dataQualityWarnings.length > 0 ? ` | ⚠ DATA-QUALITY WARNINGS: ${JSON.stringify(waveVerdict.dataQualityWarnings)}` : '')
    + (waveVerdict.backfire.length > 0 ? ` | BACKFIRE: ${JSON.stringify(waveVerdict.backfire)}` : ''),
  )

  const outPath = path.join(ROOT, `adjudicate-${runID}.json`)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n')
  console.log(`Wrote ${outPath}`)
}

// Guarded the same way test/live/task-quality-campaign.mjs guards its own
// CLI entry: running `node adjudicate.mjs ...` executes main(), but another
// script may `import` this module (e.g. to dry-run the pure judge helpers
// below with no network I/O) without triggering a real CLI invocation.
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().catch((error) => {
    console.error(`[adjudicate] fatal: ${error?.stack || error}`)
    process.exit(1)
  })
}
