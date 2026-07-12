import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_QUALITY_FEATURES,
  TASK_QUALITY_PLUGIN,
  TASK_QUALITY_PROTOCOL,
  assessTaskQualityHealth,
  reconcileTaskQualityConfig,
} from '../../config-template/opencode/task-quality/compat.mjs'

const shipped = [
  './skill-router/index.js',
  TASK_QUALITY_PLUGIN,
  './verify-guard/index.js',
  './iterate-loop/index.js',
]

test('task-quality reconciliation keeps personal model/provider state and inserts only the managed gate', () => {
  const original = {
    model: 'local/my-personal-model',
    provider: { local: { options: { baseURL: 'http://127.0.0.1:8080/v1' } } },
    plugin: ['./skill-router/index.js', './my-personal-plugin.js', './verify-guard/index.js'],
    instructions: ['C:/personal/AGENTS.md'],
  }
  const { config, changed } = reconcileTaskQualityConfig(original, shipped)
  assert.equal(changed, true)
  assert.equal(config.model, original.model)
  assert.deepEqual(config.provider, original.provider)
  assert.deepEqual(config.instructions, original.instructions)
  assert.deepEqual(config.plugin, [
    './skill-router/index.js', TASK_QUALITY_PLUGIN, './my-personal-plugin.js', './verify-guard/index.js', './iterate-loop/index.js',
  ])
})

test('task-quality reconciliation is idempotent and rejects malformed plugin state', () => {
  const first = reconcileTaskQualityConfig({ plugin: shipped }, shipped)
  const second = reconcileTaskQualityConfig(first.config, shipped)
  assert.equal(first.changed, false)
  assert.equal(second.changed, false)
  assert.throws(() => reconcileTaskQualityConfig({ plugin: 'not-an-array' }, shipped), /plugin must be an array/)
})

test('task-quality engine health fails closed for old, incomplete, and valid engine reports', () => {
  assert.equal(assessTaskQualityHealth({}).ok, false)
  assert.equal(assessTaskQualityHealth({ taskQuality: { protocol: 0, features: TASK_QUALITY_FEATURES } }).ok, false)
  assert.equal(assessTaskQualityHealth({ taskQuality: { protocol: 1, features: TASK_QUALITY_FEATURES } }).ok, false)
  assert.equal(assessTaskQualityHealth({ taskQuality: { protocol: TASK_QUALITY_PROTOCOL, features: ['tool-admission'] } }).ok, false)
  const valid = assessTaskQualityHealth({ taskQuality: { protocol: TASK_QUALITY_PROTOCOL, features: TASK_QUALITY_FEATURES, build: { id: 'test' } } })
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.build, { id: 'test' })
})
