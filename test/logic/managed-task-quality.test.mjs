import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncManagedTaskQuality } from '../../managed-task-quality.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const templateFile = (name) => path.join(ROOT, 'config-template', 'opencode', 'task-quality', name)

test('Windows managed task-quality refresh copies only the safety plugin and preserves personal state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-managed-task-quality-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const configRoot = path.join(root, 'config')
  const config = path.join(configRoot, 'opencode')
  fs.mkdirSync(path.join(config, 'skill-router'), { recursive: true })
  fs.mkdirSync(path.join(config, 'council'), { recursive: true })
  fs.mkdirSync(path.join(config, 'memory'), { recursive: true })
  fs.mkdirSync(path.join(config, 'task-quality'), { recursive: true })
  fs.writeFileSync(path.join(config, 'skill-router', 'index.js'), '// Agent Omega marker\n')
  fs.writeFileSync(path.join(config, 'council', 'council.json'), '{"personal":"keep"}\n')
  fs.writeFileSync(path.join(config, 'memory', 'MEMORY.md'), 'personal memory\n')
  fs.writeFileSync(path.join(config, 'task-quality', 'index.js'), '// stale\n')
  const original = { model: 'local/personal', provider: { local: { options: { baseURL: 'http://example.invalid/v1' } } }, plugin: ['./skill-router/index.js', './personal-plugin.js'] }
  fs.writeFileSync(path.join(config, 'opencode.json'), JSON.stringify(original, null, 2) + '\n')

  const result = syncManagedTaskQuality({ packageRoot: ROOT, configRoot })

  assert.deepEqual(result, { status: 'synced', changed: true })
  const updated = JSON.parse(fs.readFileSync(path.join(config, 'opencode.json'), 'utf8'))
  assert.equal(updated.model, original.model)
  assert.deepEqual(updated.provider, original.provider)
  assert.deepEqual(updated.plugin, ['./skill-router/index.js', './task-quality/index.js', './personal-plugin.js'])
  assert.equal(fs.readFileSync(path.join(config, 'council', 'council.json'), 'utf8'), '{"personal":"keep"}\n')
  assert.equal(fs.readFileSync(path.join(config, 'memory', 'MEMORY.md'), 'utf8'), 'personal memory\n')
  for (const name of ['index.js', 'compat.mjs', 'policy.json'])
    assert.equal(fs.readFileSync(path.join(config, 'task-quality', name), 'utf8'), fs.readFileSync(templateFile(name), 'utf8'))
})

test('Windows managed task-quality refresh refuses a foreign config byte-for-byte', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-managed-task-quality-foreign-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const configRoot = path.join(root, 'config')
  const config = path.join(configRoot, 'opencode')
  fs.mkdirSync(config, { recursive: true })
  const foreign = '{"model":"someone-elses-engine","plugin":["./private.js"]}\n'
  fs.writeFileSync(path.join(config, 'opencode.json'), foreign)

  const result = syncManagedTaskQuality({ packageRoot: ROOT, configRoot })

  assert.deepEqual(result, { status: 'foreign' })
  assert.equal(fs.readFileSync(path.join(config, 'opencode.json'), 'utf8'), foreign)
  assert.equal(fs.existsSync(path.join(config, 'task-quality')), false)
})

test('Windows managed task-quality refresh does not mistake a foreign task-quality folder for Agent Omega ownership', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-managed-task-quality-collision-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const configRoot = path.join(root, 'config')
  const config = path.join(configRoot, 'opencode')
  const foreignPlugin = path.join(config, 'task-quality', 'index.js')
  fs.mkdirSync(path.dirname(foreignPlugin), { recursive: true })
  const foreign = '{"model":"someone-elses-engine","plugin":["./task-quality/index.js"]}\n'
  fs.writeFileSync(path.join(config, 'opencode.json'), foreign)
  fs.writeFileSync(foreignPlugin, '// foreign task-quality plugin\n')

  const result = syncManagedTaskQuality({ packageRoot: ROOT, configRoot })

  assert.deepEqual(result, { status: 'foreign' })
  assert.equal(fs.readFileSync(path.join(config, 'opencode.json'), 'utf8'), foreign)
  assert.equal(fs.readFileSync(foreignPlugin, 'utf8'), '// foreign task-quality plugin\n')
})
