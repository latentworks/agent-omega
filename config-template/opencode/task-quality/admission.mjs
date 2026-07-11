import { hasCurrentApproval, hasUnsettledExecution, TASK_QUALITY_POLICY_VERSION } from './lifecycle.mjs'

const CONTROL_TOOL = 'task_quality_checkpoint'
const ARTIFACT_CONTROL_TOOL = 'task_quality_artifact_checkpoint'

function hasMatchingDirectTaskWrapperPending(lifecycle, parentTaskCallID) {
  const pending = lifecycle?.pendingExecutions
  return (
    Array.isArray(pending) &&
    pending.length === 1 &&
    pending[0]?.tool === 'task' &&
    pending[0]?.callID === parentTaskCallID
  )
}

export function admitTaskQualityTool({ tool, source, capability, trustedControl, lifecycle, directTaskWrapperCallID } = {}) {
  // The checkpoint is the narrowly-scoped local control plane that can create
  // the repaired-plan record. It does not touch workspace state or execute a
  // command; every other unknown/plugin/MCP tool remains denied.
  // `trustedControl` is loader-attested by the engine's WeakMap, never supplied
  // by a plugin return object or MCP payload. Keep the complete tuple here so a
  // same-named tool cannot impersonate the checkpoint and open the gate.
  if (
    ((tool === CONTROL_TOOL && trustedControl === CONTROL_TOOL) ||
      (tool === ARTIFACT_CONTROL_TOOL && trustedControl === ARTIFACT_CONTROL_TOOL)) &&
    source === 'plugin' &&
    capability === 'unknown'
  ) {
    return { decision: 'allow', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (capability === 'read') return { decision: 'allow', policyVersion: TASK_QUALITY_POLICY_VERSION }
  if (capability === 'unknown') {
    return { decision: 'deny', reason: 'Task quality blocks unclassified tools until a trusted capability policy explicitly classifies them.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (capability !== 'mutate') {
    return { decision: 'deny', reason: 'Task quality received an invalid tool capability classification.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (!lifecycle) {
    return { decision: 'deny', reason: 'Task quality requires a qualifying routed task and repaired plan before a mutating tool can run.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (!lifecycle.repairedPlan || lifecycle.phase !== 'awaiting-approval' && lifecycle.phase !== 'approved') {
    return { decision: 'deny', reason: 'Task quality requires a repaired plan before mutation. Record the repaired plan and ask the user for an explicit go/no-go.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  if (!hasCurrentApproval(lifecycle)) {
    return { decision: 'deny', reason: 'Task quality is awaiting an explicit external-user go for the current repaired-plan generation.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  // A direct TaskTool call has its own durable wrapper precommit while its
  // engine-issued child performs the actual workspace action. That private
  // child may proceed through its exact wrapper only; any real unresolved
  // action remains fail-closed. The wrapper call ID is resolved solely from
  // loader-attested engine provenance, never from tool input.
  if (
    hasUnsettledExecution(lifecycle) &&
    !hasMatchingDirectTaskWrapperPending(lifecycle, directTaskWrapperCallID)
  ) {
    return { decision: 'deny', reason: 'Task quality recovered an unresolved execution attempt. Do not continue mutation; inspect the durable tool result and route a repaired follow-up.', policyVersion: TASK_QUALITY_POLICY_VERSION }
  }
  return { decision: 'allow', policyVersion: TASK_QUALITY_POLICY_VERSION }
}

export { CONTROL_TOOL, ARTIFACT_CONTROL_TOOL }
