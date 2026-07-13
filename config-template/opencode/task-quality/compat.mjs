// Task-quality compatibility contract shared by setup, doctor, and the desktop sidecar.
// This module intentionally contains no lifecycle/reviewer behavior: it only defines the
// fail-closed engine contract and the minimal config reconciliation needed to provision it.

export const TASK_QUALITY_PROTOCOL = 2
export const TASK_QUALITY_PLUGIN = './task-quality/index.js'
export const SKILL_ROUTER_PLUGIN = './skill-router/index.js'
export const TASK_QUALITY_POLICY = 'task-quality/policy.json'
export const TASK_QUALITY_FEATURES = [
  'tool-admission',
  'isolated-review',
  'trusted-origin',
  'lifecycle-cas',
  'plain-review-report',
  'review-address-gate',
  'review-resume',
  'internal-automation',
  'deterministic-terminal-review',
  'terminal-completion-gate',
]

const own = (value) => value && typeof value === 'object' && !Array.isArray(value)

export function reconcileTaskQualityConfig(config, shippedPlugins = []) {
  if (!own(config)) throw new Error('opencode.json must contain an object')
  if ('plugin' in config && !Array.isArray(config.plugin)) throw new Error('opencode.json plugin must be an array')
  if (!shippedPlugins.includes(SKILL_ROUTER_PLUGIN) || !shippedPlugins.includes(TASK_QUALITY_PLUGIN)) {
    throw new Error('shipped config is missing required task-quality plugin registration')
  }

  const current = Array.isArray(config.plugin) ? config.plugin.filter((value) => typeof value === 'string') : []
  const merged = [...current]
  for (const plugin of shippedPlugins) if (!merged.includes(plugin)) merged.push(plugin)

  // The task-quality gate must observe the router handoff before verification/iteration hooks.
  // Preserve every user-added plugin and its relative order; only relocate our managed entry.
  const withoutTaskQuality = merged.filter((plugin) => plugin !== TASK_QUALITY_PLUGIN)
  const routerIndex = withoutTaskQuality.indexOf(SKILL_ROUTER_PLUGIN)
  if (routerIndex < 0) throw new Error('required skill-router plugin is unavailable')
  withoutTaskQuality.splice(routerIndex + 1, 0, TASK_QUALITY_PLUGIN)

  const changed = JSON.stringify(current) !== JSON.stringify(withoutTaskQuality)
  return { config: { ...config, plugin: withoutTaskQuality }, changed }
}

export function assessTaskQualityHealth(payload) {
  const taskQuality = payload && payload.taskQuality
  if (!own(taskQuality)) return { ok: false, reason: 'the engine does not expose task-quality capabilities' }
  if (!Number.isInteger(taskQuality.protocol) || taskQuality.protocol < TASK_QUALITY_PROTOCOL) {
    return { ok: false, reason: `the engine task-quality protocol is ${String(taskQuality.protocol ?? 'missing')} (requires ${TASK_QUALITY_PROTOCOL})` }
  }
  const features = Array.isArray(taskQuality.features) ? taskQuality.features : []
  const missing = TASK_QUALITY_FEATURES.filter((feature) => !features.includes(feature))
  if (missing.length) return { ok: false, reason: 'the engine is missing required capabilities: ' + missing.join(', ') }
  return { ok: true, protocol: taskQuality.protocol, build: own(taskQuality.build) ? taskQuality.build : null }
}

export function incompatibleEngineMessage(reason) {
  return 'Task-quality safety update required: ' + reason + '. Install the engine matching this Agent Omega release, then restart. Task work is blocked until this is fixed.'
}
