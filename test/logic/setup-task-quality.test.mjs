import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SETUP = path.join(ROOT, 'setup.mjs')

function isolatedEnv(root) {
  const home = path.join(root, 'home')
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    AGENT_OMEGA_ENGINE: path.join(root, 'missing-engine'),
  }
}

function runSetup(env) {
  return spawnSync(process.execPath, [SETUP, '--non-interactive'], { cwd: ROOT, env, encoding: 'utf8' })
}

test('setup upgrade preserves personal config/council/memory while reconciling task-quality', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-task-quality-setup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = isolatedEnv(root), cfg = path.join(env.XDG_CONFIG_HOME, 'opencode')
  fs.mkdirSync(path.join(cfg, 'skill-router'), { recursive: true })
  fs.writeFileSync(path.join(cfg, 'skill-router', 'index.js'), '// Agent Omega marker\n')
  fs.mkdirSync(path.join(cfg, 'council'), { recursive: true })
  fs.mkdirSync(path.join(cfg, 'memory'), { recursive: true })
  const original = {
    model: 'local/my-personal-model',
    provider: { local: { options: { baseURL: 'http://127.0.0.1:12345/v1' } } },
    plugin: ['./skill-router/index.js', './personal-plugin.js', './verify-guard/index.js'],
    instructions: ['C:/personal/AGENTS.md'],
  }
  fs.writeFileSync(path.join(cfg, 'opencode.json'), JSON.stringify(original, null, 2))
  fs.writeFileSync(path.join(cfg, 'council', 'council.json'), '{"personal":"keep"}')
  fs.writeFileSync(path.join(cfg, 'memory', 'MEMORY.md'), 'personal memory')

  const result = runSetup(env)
  assert.equal(result.status, 0, result.stderr)
  const installed = JSON.parse(fs.readFileSync(path.join(cfg, 'opencode.json'), 'utf8'))
  assert.equal(installed.model, original.model)
  assert.deepEqual(installed.provider, original.provider)
  assert.deepEqual(installed.instructions, ['{env:AGENT_OMEGA_AGENTS}', ...original.instructions])
  assert.deepEqual(installed.plugin, [
    './skill-router/index.js', './task-quality/index.js', './personal-plugin.js', './verify-guard/index.js', './iterate-loop/index.js', './council/index.js', './engram/index.js', './setup/index.js',
  ])
  assert.equal(fs.readFileSync(path.join(cfg, 'council', 'council.json'), 'utf8'), '{"personal":"keep"}')
  assert.equal(fs.readFileSync(path.join(cfg, 'memory', 'MEMORY.md'), 'utf8'), 'personal memory')
  assert.equal(fs.existsSync(path.join(cfg, 'task-quality', 'policy.json')), true)
  assert.equal(fs.existsSync(path.join(cfg, 'task-quality', 'compat.mjs')), true)
})

test('setup refuses a foreign OpenCode config without changing it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-task-quality-foreign-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = isolatedEnv(root), cfg = path.join(env.XDG_CONFIG_HOME, 'opencode')
  fs.mkdirSync(cfg, { recursive: true })
  const foreign = '{"model":"someone-elses-engine","plugin":["./private.js"]}\n'
  fs.writeFileSync(path.join(cfg, 'opencode.json'), foreign)
  const result = runSetup(env)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /NOT an Agent Omega install/i)
  assert.equal(fs.readFileSync(path.join(cfg, 'opencode.json'), 'utf8'), foreign)
})
