// Narrow Windows adoption bridge. A released desktop bundle owns the safety
// plugin it relies on, but never overwrites a person's providers, council,
// memory, or other OpenCode configuration.
import fs from 'node:fs'
import path from 'node:path'
import {
  reconcileTaskQualityConfig,
  SKILL_ROUTER_PLUGIN,
  TASK_QUALITY_PLUGIN,
} from './config-template/opencode/task-quality/compat.mjs'

const RUNTIME_JUNK = new Set(['task-quality.db', 'task-quality.log'])

const exists = (target) => fs.existsSync(target)

function isAgentOmegaConfig(configDir) {
  return (
    exists(path.join(configDir, 'skill-router', 'index.js')) ||
    exists(path.join(configDir, 'council', 'index.js'))
  )
}

function copyManagedTree(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (target) => !RUNTIME_JUNK.has(path.basename(target)),
  })
}

export function syncManagedTaskQuality({ packageRoot, configRoot }) {
  const configDir = path.join(configRoot, 'opencode')
  if (!exists(configDir)) return { status: 'missing' }
  if (!isAgentOmegaConfig(configDir)) return { status: 'foreign' }

  const source = path.join(packageRoot, 'config-template', 'opencode', 'task-quality')
  for (const name of ['index.js', 'compat.mjs', 'policy.json']) {
    if (!exists(path.join(source, name))) throw new Error('packaged task-quality files are incomplete')
  }

  const configPath = path.join(configDir, 'opencode.json')
  if (!exists(configPath)) throw new Error('Agent Omega configuration is missing opencode.json')
  const original = fs.readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(original)
  const reconciled = reconcileTaskQualityConfig(parsed, [SKILL_ROUTER_PLUGIN, TASK_QUALITY_PLUGIN])

  copyManagedTree(source, path.join(configDir, 'task-quality'))
  if (reconciled.changed)
    fs.writeFileSync(configPath, JSON.stringify(reconciled.config, null, 2) + '\n')

  return {
    status: 'synced',
    changed: reconciled.changed,
  }
}
