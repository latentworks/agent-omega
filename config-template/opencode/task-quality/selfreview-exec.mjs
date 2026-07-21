// selfreview-exec.mjs — isolated child-process runner for VOTING on model-generated drafts.
//
// PROBLEM (as a system): to vote, self-review must RUN each draft on probe inputs. Running model-generated code
// IN-PROCESS (as the bench proof did) is fine for an offline experiment but unacceptable inside Omega: a draft
// with an infinite loop would hang Omega's process, and an uncaught crash could take it down. We do NOT need the
// unforgeable-correctness sandbox the refuted exec-AUDIT lever needed (that tried to PROVE correctness and could
// be gamed) — here execution only casts VOTES that feed a plurality oracle, and Gate-1 guarantees the shipped
// artifact is never worse than the model's own best draft. So the requirement is containment, not proof:
//   - a hung/runaway draft must be KILLED on a hard timeout and never block the host,
//   - a crashing/malformed draft must degrade to an honest class ('throw' / 'load-fail'), never throw into Omega,
//   - each draft runs in its OWN short-lived child process with its own temp module file.
//
// HARDENING (v1, applied after adversarial review): the child runs UNTRUSTED model-generated code, so it must not
// inherit the sidecar's secrets or run in the live workspace. Each child is spawned with (a) a SECRET-SCRUBBED env
// (all vault keys/tokens removed — a draft cannot read or exfiltrate process.env.*_API_KEY), and (b) cwd locked to
// the throwaway tmpDir (a draft's relative-path fs ops hit scratch, not the user's project). Combined with the hard
// timeout + SIGKILL, this bounds the blast radius to "scratch files a killed child could have written".
// RESIDUAL (staging fork for Austin): this is NOT a full OS sandbox — a draft using ABSOLUTE paths or raw sockets
// can still reach the filesystem/network. Truly bulletproof isolation (--experimental-permission, a restricted
// user, or a container) is a larger decision; the VOTING-only + Gate-1-advisory posture is what makes the cheap
// guardrails an acceptable v1.
//
// Output values flow as the SAME opaque output-class strings the core uses, computed inside the child.

import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Vault-injected secrets (providers.mjs: ANTHROPIC/OPENAI/GOOGLE/MOONSHOT/DEEPSEEK/ZAI *_API_KEY, plus any
// token/secret/credential/session var) must never reach the untrusted child. Blacklist by name pattern so node's
// own startup vars (PATH, SystemRoot, TEMP, ComSpec, …) are preserved on Windows.
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API|AUTH|ANTHROPIC|OPENAI|GOOGLE|MOONSHOT|DEEPSEEK|ZAI|SESSION)/i
function scrubbedEnv(base = process.env) {
  const out = {}
  for (const k of Object.keys(base)) { if (!SECRET_ENV_RE.test(k)) out[k] = base[k] }
  return out
}

// Child runner: import the draft module, apply the exported fn to each input, print output classes as JSON.
// Kept as a string so there is exactly one file to reason about; it has no imports beyond node core.
const RUNNER_SRC = `
function outClass(v){ if(v===null)return 'null'; if(v===undefined)return 'undef'; if(typeof v==='number')return Number.isFinite(v)?('n:'+v):('n:'+String(v)); if(typeof v==='string')return 's:'+v; if(typeof v==='boolean')return 'b:'+v; try{return 'j:'+JSON.stringify(v)}catch{return 'nonser'} }
// CHANNEL ISOLATION (fix: draft-stdout pollution): the untrusted draft shares this process's stdout,
// which is ALSO our result channel. A draft's own console.log / process.stdout.write would prepend to
// the {classes} JSON and make the parent's JSON.parse fail -> a CORRECT draft mis-graded on every input.
// Capture the REAL stdout writer for our result BEFORE the draft loads, then route the draft's stdout and
// console to stderr (parent swallows stderr), so nothing the draft prints can corrupt the vote channel.
const __realOut = process.stdout.write.bind(process.stdout)
const __emit = (obj) => __realOut(JSON.stringify(obj))
process.stdout.write = (chunk, enc, cb) => { try { process.stderr.write(chunk) } catch {} if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb(); return true }
const __toErr = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\\n') } catch {} return true }
console.log = __toErr; console.info = __toErr; console.debug = __toErr; console.warn = __toErr
const [,, modUrl, exportName] = process.argv
let buf=''
process.stdin.on('data', d => buf += d)
process.stdin.on('end', async () => {
  let inputs=[]; try { inputs = JSON.parse(buf) } catch { __emit({error:'bad-input'}); return }
  let fn=null
  try { const m = await import(modUrl); fn = (exportName && m[exportName]) || m.default || m[Object.keys(m)[0]] }
  catch (e) { __emit({error:'import:'+String((e&&e.message)||e)}); return }
  if (typeof fn !== 'function') { __emit({error:'no-export'}); return }
  const classes=[]
  for (const x of inputs) {
    try { const r = Array.isArray(x) ? fn(...x) : fn(x); const rr = (r && typeof r.then === 'function') ? await r : r; classes.push(outClass(rr)) }
    catch { classes.push('throw') }
  }
  __emit({classes})
})
`

const LOAD_FAIL_CLASSES = new Set(['load-fail', 'parse-fail', 'spawn-error', 'no-export'])

export function createExecRunner({ tmpDir, timeoutMs = 5000, exportName = null }) {
  mkdirSync(tmpDir, { recursive: true })
  const runnerPath = `${tmpDir}/_selfreview_runner.mjs`
  writeFileSync(runnerPath, RUNNER_SRC)
  const childEnv = scrubbedEnv() // computed once: no secrets reach any child
  let seq = 0

  // Run ONE draft on ALL inputs in a single child; returns an array of output-class strings aligned to inputs.
  async function execDraft(source, inputs, opts = {}) {
    const id = opts.id != null ? String(opts.id) : String(seq++)
    const exp = opts.exportName ?? exportName ?? ''
    const modPath = `${tmpDir}/draft-${id}.mjs`
    writeFileSync(modPath, source)
    const modUrl = pathToFileURL(modPath).href
    const to = opts.timeoutMs ?? timeoutMs
    return await new Promise((resolve) => {
      let done = false
      const finish = (classes) => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL') } catch {} resolve(classes) }
      // Untrusted child: cwd locked to scratch, secrets scrubbed from env (see header).
      const child = spawn(process.execPath, [runnerPath, modUrl, exp], { stdio: ['pipe', 'pipe', 'pipe'], cwd: tmpDir, env: childEnv })
      const timer = setTimeout(() => finish(inputs.map(() => 'timeout')), to)
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', () => {}) // swallow; failures surface as classes
      child.on('error', () => finish(inputs.map(() => 'spawn-error')))
      child.on('close', () => {
        if (done) return
        let parsed = null
        try { parsed = JSON.parse(out) } catch {}
        if (parsed && Array.isArray(parsed.classes)) finish(parsed.classes)
        else finish(inputs.map(() => (parsed && parsed.error ? 'load-fail' : 'parse-fail')))
      })
      // An async broken-pipe (child killed mid-write) emits 'error' on stdin; with no listener node escalates it to
      // uncaughtException and could take the whole sidecar down. Swallow it — the child's fate is handled above.
      child.stdin.on('error', () => {})
      try { child.stdin.write(JSON.stringify(inputs)); child.stdin.end() } catch {}
    })
  }

  // Remove the whole scratch dir (runner + all draft/repair module files). Idempotent; never throws.
  function cleanup() { try { rmSync(tmpDir, { recursive: true, force: true }) } catch {} }

  return { execDraft, runnerPath, cleanup }
}

// Build a core-compatible draft {id, run, loaded} by precomputing ALL probe outputs in one child run.
// `loaded` is false when the draft never produced a real class (import/parse failure) so the caller can drop it,
// mirroring the proof's `loaded` filter (only genuinely-runnable drafts should vote).
export async function makeExecDraft(runner, id, source, probes, opts = {}) {
  const classes = await runner.execDraft(source, probes, { id, ...opts })
  const map = new Map()
  probes.forEach((p, i) => map.set(JSON.stringify(p), classes[i]))
  const realClasses = classes.filter((c) => !LOAD_FAIL_CLASSES.has(c))
  const loaded = realClasses.length > 0
  return { id, loaded, run: (inp) => map.get(JSON.stringify(inp)) ?? 'unprobed' }
}
