// task-quality: the durable Slice 1 plan/approval gate. Existing skills still
// own planning and review procedure; this plugin owns only lifecycle state and
// engine admission. There is intentionally no session.idle hook here.
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { tool } from "@opencode-ai/plugin";
import { createLifecycleAdapter, normalizeSnapshot } from "./adapter.mjs";
import { configuredReviewerCandidates } from "./reviewer.mjs";
import { getRouteHandoff, digestText } from "./handoff.mjs";
import {
  admitTaskQualityTool,
  CONTROL_TOOL,
  ARTIFACT_CONTROL_TOOL,
} from "./admission.mjs";
import {
  createLifecycle,
  digestPlan,
  hasCurrentApproval,
  hasArtifactReviewAuthorization,
  hasUnsettledExecution,
  reconstructLifecycle,
  recordArtifactReview,
  recordArtifactReviewDenied,
  recordPendingArtifactReview,
  recordAddressedArtifact,
  recordReviewDelivered,
  recordExecutionPermissionRejected,
  recordExecutionStarted,
  recordReceipt,
  recordRepairedPlan,
  recordPendingPlanReview,
  recordAddressedPlan,
  recordUserDecision,
  revokeApprovalForSubstantiveTurn,
  PENDING_EXECUTION_LIMIT,
} from "./lifecycle.mjs";

const z = tool.schema;
const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "policy.json"), "utf8"));
  } catch {
    return null;
  }
})();
const LOG = process.env.TASK_QUALITY_LOG || join(tmpdir(), "task-quality.log");
const MAX_SUBMISSION_CHARS = 24000;
const MAX_ACCEPTANCE_CRITERIA = 32;
const MAX_CRITERION_CHARS = 2000;
const APPROVAL_REVOCATION_CAS_ATTEMPTS = PENDING_EXECUTION_LIMIT + 2;
function log(message) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function textParts(output) {
  return (output?.parts || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join(" ")
    .trim();
}

function boundedText(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const text = value.trim();
  if (!text) throw new TypeError(`${label} is required`);
  if (text.length > MAX_SUBMISSION_CHARS)
    throw new RangeError(
      `${label} must be at most ${MAX_SUBMISSION_CHARS} characters`,
    );
  return text;
}

function boundedCriteria(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_ACCEPTANCE_CRITERIA
  )
    throw new TypeError("at least one acceptance criterion is required");
  return value.map((item) => {
    if (typeof item !== "string")
      throw new TypeError("acceptance criteria must be text");
    const criterion = item.trim();
    if (!criterion || criterion.length > MAX_CRITERION_CHARS)
      throw new TypeError("acceptance criteria must be non-empty concise text");
    return criterion;
  });
}

function policyIsValid() {
  return (
    POLICY?.schemaVersion === 1 && POLICY?.enforcement?.mode === "fail-closed"
  );
}

async function loadOrCreate(adapter, sessionID, handoff) {
  // A conflicting update is never merged locally. Re-read and retry the small
  // deterministic transition; after two conflicts, leave mutation blocked.
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(sessionID));
    const lifecycle = reconstructLifecycle(snapshot.data, handoff);
    if (lifecycle === snapshot.data) return { snapshot, lifecycle };
    try {
      await adapter.update({
        sessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: lifecycle.generation,
        data: lifecycle,
      });
    } catch (error) {
      if (attempt === 1) throw error;
      continue;
    }
  }
  throw new Error("task-quality lifecycle could not be initialized");
}

async function lifecycleOwner(adapter, engineBridge, sessionID) {
  // A direct TaskTool execution owns a child session. Its mutating tools are
  // still part of the parent task that passed review and received external
  // approval, but generic Session.parentID is public caller input and cannot
  // prove TaskTool provenance. Resolve only the short-lived engine-issued
  // direct-task grant exposed through the loader-attested private bridge.
  const own = normalizeSnapshot(await adapter.get(sessionID));
  if (own.data) return { sessionID, snapshot: own };
  const parentID =
    typeof engineBridge?.directTaskParent === "function"
      ? engineBridge.directTaskParent(sessionID)
      : undefined;
  if (typeof parentID !== "string" || !parentID || parentID === sessionID)
    return { sessionID, snapshot: own };
  return {
    sessionID: parentID,
    snapshot: normalizeSnapshot(await adapter.get(parentID)),
  };
}

async function settlementOwner(adapter, engineBridge, input) {
  const own = normalizeSnapshot(await adapter.get(input.sessionID));
  if (own.data) return { sessionID: input.sessionID, snapshot: own };
  const parentID =
    typeof engineBridge?.takeDirectTaskExecution === "function"
      ? engineBridge.takeDirectTaskExecution(input.sessionID, input.callID)
      : undefined;
  if (typeof parentID !== "string" || !parentID || parentID === input.sessionID)
    return { sessionID: input.sessionID, snapshot: own };
  return {
    sessionID: parentID,
    snapshot: normalizeSnapshot(await adapter.get(parentID)),
  };
}

function taskIdentity(lifecycle) {
  return {
    taskKey: lifecycle?.taskKey,
    taskMessageID: lifecycle?.taskMessageID,
    generation: lifecycle?.generation,
  };
}

function sameTaskIdentity(lifecycle, expected, snapshotGeneration) {
  return (
    !!lifecycle &&
    lifecycle.taskKey === expected.taskKey &&
    lifecycle.taskMessageID === expected.taskMessageID &&
    lifecycle.generation === expected.generation &&
    snapshotGeneration === expected.generation
  );
}

async function recordPlan(
  adapter,
  sessionID,
  expected,
  plan,
  acceptanceCriteria,
  review,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(sessionID));
    if (!snapshot.data)
      throw new Error(
        "No durable qualifying task lifecycle exists. Do not implement; establish the task plan first.",
      );
    if (!sameTaskIdentity(snapshot.data, expected, snapshot.generation)) {
      throw new Error(
        "The routed task changed while the plan review was running. Start a fresh checkpoint for the current task.",
      );
    }
    const current = { snapshot, lifecycle: snapshot.data };
    const next = recordRepairedPlan(current.lifecycle, plan, {
      review,
      acceptanceCriteria,
      reviewedDigest: review?.submission?.digest,
    });
    try {
      const saved = await adapter.update({
        sessionID,
        expectedRevision: current.snapshot.revision,
        expectedGeneration: current.snapshot.generation,
        generation: next.generation,
        data: next,
      });
      return normalizeSnapshot(saved).data || next;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  throw new Error(
    "Task quality could not record the repaired plan due to a concurrent lifecycle update.",
  );
}

async function persistCurrentTransition(adapter, sessionID, expected, transition) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(sessionID));
    if (!snapshot.data) throw new Error("No durable qualifying task lifecycle exists.");
    if (expected && !sameTaskIdentity(snapshot.data, expected, snapshot.generation)) throw new Error("The routed task changed while the review handshake was running. Start a fresh checkpoint for the current task.");
    const next = transition(snapshot.data);
    try {
      const saved = await adapter.update({ sessionID, expectedRevision: snapshot.revision, expectedGeneration: snapshot.generation, generation: next.generation, data: next });
      return normalizeSnapshot(saved).data || next;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  throw new Error("Task quality could not persist the review handshake due to a concurrent lifecycle update.");
}

async function routeHandoff(sessionID, engineBridge) {
  // Production uses the engine-attested bridge. The Map fallback keeps direct
  // plugin tests and legacy inert installs deterministic; it is never an
  // authorization source when the bridge is present.
  if (typeof engineBridge?.awaitRouteDecision === "function")
    return await engineBridge.awaitRouteDecision(sessionID);
  return getRouteHandoff(sessionID);
}

async function recordApproval(adapter, input, output) {
  // `origin` is supplied by the engine from the persisted message, never from
  // client text. Missing/legacy origin remains blocked by recordUserDecision.
  const text = textParts(output);
  // Every bounded pending execution can settle concurrently with this
  // persisted user turn. Re-read through the entire pending bound, plus a
  // small margin, so those finite receipt writers cannot leave stale approval
  // live when routing later returns NONE or fails.
  for (let attempt = 0; attempt < APPROVAL_REVOCATION_CAS_ATTEMPTS; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(input.sessionID));
    if (!snapshot.data) return;
    const revoked = revokeApprovalForSubstantiveTurn(snapshot.data, {
      origin: input.origin,
      messageID: input.messageID,
      text,
    });
    const decision = revoked.ok
      ? null
      : recordUserDecision(snapshot.data, {
          origin: input.origin,
          messageID: input.messageID,
          text,
          expectedGeneration: snapshot.generation,
        });
    const next = revoked.ok ? revoked.lifecycle : decision?.ok ? decision.lifecycle : null;
    if (!next) return;
    try {
      await adapter.update({
        sessionID: input.sessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: next.generation,
        data: next,
      });
      if (revoked.ok) {
        log(
          `revoked stale approval for substantive external turn ${input.sessionID} generation=${next.generation}`,
        );
      } else {
        log(
          `recorded ${next.phase} for ${input.sessionID} generation=${next.generation}`,
        );
      }
      return;
    } catch (error) {
      const isConflict = error?.status === 409 || /CAS conflict/i.test(String(error?.message || ""));
      if (!isConflict || attempt === APPROVAL_REVOCATION_CAS_ATTEMPTS - 1) throw error;
    }
  }
}

function receiptFromToolResult(input, output) {
  // This hook is deliberately non-prompting and side-effect-free apart from
  // its own CAS write. Never retain tool args, raw output, file paths,
  // metadata, attachments, or model text: a later reviewer receives bounded
  // provenance only, not a second hidden builder transcript.
  if (
    !input?.sessionID ||
    !input?.callID ||
    !input?.tool ||
    input.tool === CONTROL_TOOL ||
    input.tool === ARTIFACT_CONTROL_TOOL
  )
    return null;
  const value = typeof output?.output === "string" ? output.output : "";
  const outputBytes = Buffer.byteLength(value, "utf8");
  if (outputBytes > 1_000_000) return null;
  const verification = /(?:test|verify|check|lint|build|audit)/i.test(
    input.tool,
  );
  return {
    callID: String(input.callID),
    tool: String(input.tool),
    kind: verification ? "verification" : "tool",
    ...(input.tool === "task" && typeof input.attestedAgent === "string"
      ? { agent: input.attestedAgent }
      : {}),
    ...(input.tool === "task" && Number.isSafeInteger(input.attestedChildBuiltinReads)
      ? { childBuiltinReads: input.attestedChildBuiltinReads }
      : {}),
    outputDigest: digestText(value),
    outputBytes,
    // Engine-persisted completion time makes a replay idempotent instead of
    // inventing a fresh timestamp for the same call.
    capturedAt: Number.isSafeInteger(input?.completedAt)
      ? input.completedAt
      : 0,
  };
}

async function captureReceipt(
  adapter,
  input,
  output,
  ownerSessionID = input?.sessionID,
) {
  const receipt = receiptFromToolResult(input, output);
  if (!receipt) return;
  // A conflict is not merged in memory. Re-read once; exact duplicate delivery
  // is idempotent, while a changed result for one engine call ID remains blocked.
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(ownerSessionID));
    if (!snapshot.data) return;
    let lifecycle;
    try {
      lifecycle = recordReceipt(snapshot.data, receipt);
    } catch (error) {
      log(`receipt ignored: ${error?.message || error}`);
      return;
    }
    if (lifecycle === snapshot.data) return;
    try {
      await adapter.update({
        sessionID: ownerSessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: lifecycle.generation,
        data: lifecycle,
      });
      return;
    } catch (error) {
      if (attempt === 1)
        log(`receipt capture conflict: ${error?.message || error}`);
    }
  }
}

async function markExecutionStarted(
  adapter,
  input,
  ownerSessionID = input?.sessionID,
) {
  if (
    !input?.sessionID ||
    !input?.callID ||
    !input?.tool ||
    input.capability !== "mutate" ||
    input.tool === CONTROL_TOOL ||
    input.tool === ARTIFACT_CONTROL_TOOL
  )
    return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(ownerSessionID));
    // This write is a prerequisite, not best-effort telemetry. If durable
    // state cannot be read or advanced, the engine must not start a workspace
    // mutation it could not later reconcile after a crash.
    if (!snapshot.data)
      throw new Error(
        "no durable task-quality lifecycle exists for mutation precommit",
      );
    const next = recordExecutionStarted(snapshot.data, {
      callID: String(input.callID),
      tool: String(input.tool),
      startedAt: Number.isSafeInteger(input?.startedAt)
        ? input.startedAt
        : Date.now(),
    });
    if (next === snapshot.data) return;
    try {
      await adapter.update({
        sessionID: ownerSessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: next.generation,
        data: next,
      });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function settlePermissionRejectedExecution(
  adapter,
  input,
  ownerSessionID = input?.sessionID,
) {
  if (!input?.sessionID || !input?.callID || !input?.tool) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(ownerSessionID));
    if (!snapshot.data) return;
    const next = recordExecutionPermissionRejected(snapshot.data, {
      callID: String(input.callID),
      tool: String(input.tool),
    });
    if (next === snapshot.data) return;
    try {
      await adapter.update({
        sessionID: ownerSessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: next.generation,
        data: next,
      });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function recordArtifact(adapter, sessionID, artifact, review) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(sessionID));
    if (!snapshot.data)
      throw new Error(
        "no durable task-quality lifecycle exists for artifact review",
      );
    const next = recordArtifactReview(snapshot.data, artifact, {
      review,
      reviewedDigest: review?.submission?.digest,
    });
    try {
      const saved = await adapter.update({
        sessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: next.generation,
        data: next,
      });
      return normalizeSnapshot(saved).data || next;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  throw new Error(
    "Task quality could not record artifact review due to a concurrent lifecycle update.",
  );
}

async function recordArtifactDenial(adapter, sessionID, artifact, reason) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = normalizeSnapshot(await adapter.get(sessionID));
    if (!snapshot.data) throw new Error("no durable task-quality lifecycle exists for artifact review");
    const next = recordArtifactReviewDenied(snapshot.data, artifact, { reason });
    try {
      const saved = await adapter.update({
        sessionID,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        generation: next.generation,
        data: next,
      });
      return normalizeSnapshot(saved).data || next;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  throw new Error("Task quality could not durably record artifact-review denial due to a concurrent lifecycle update.");
}

// A terminal checkpoint must not depend on a smaller local model choosing the
// control-plane tool correctly. The engine supplies only a fully persisted
// terminal response and its exact parent identity; this hook then uses the
// same isolated HSS/CRAP review and CAS writes as the explicit controls.
function automaticPlanCriteria(lifecycle) {
  const contract = String(lifecycle?.taskContract || "the routed task")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1800);
  return [
    `The plan addresses the routed task without scope drift: ${contract || "the routed task"}.`,
    "The plan identifies concrete implementation steps and a testable verification path.",
    "The plan identifies material unknowns, dependencies, and research needs before implementation.",
  ];
}

async function captureTerminalPlan(adapter, input) {
  const snapshot = normalizeSnapshot(await adapter.get(input.sessionID));
  const lifecycle = snapshot.data;
  if (!lifecycle || hasUnsettledExecution(lifecycle) || lifecycle.revocationPending)
    return false;

  if (
    lifecycle.phase === "planning" &&
    lifecycle.taskMessageID === input.parentMessageID
  ) {
    const plan = boundedText(input.text, "terminal plan");
    const expected = taskIdentity(lifecycle);
    const acceptanceCriteria = automaticPlanCriteria(lifecycle);
    const review = await adapter.review({
      sessionID: input.sessionID,
      contract: lifecycle.taskContract || "",
      acceptanceCriteria,
      submission: {
        kind: "plan",
        content: plan,
        digest: digestPlan(plan),
      },
    });
    if (review.plainReport) {
      await persistCurrentTransition(adapter, input.sessionID, expected, (current) =>
        recordPendingPlanReview(current, plan, {
          review,
          acceptanceCriteria,
          reviewedDigest: review.submission.digest,
        }),
      );
      const delivery = await adapter.resumeWithReview({
        sessionID: input.sessionID,
        reviewID: review.plainReport.reviewID,
      });
      await persistCurrentTransition(adapter, input.sessionID, expected, (current) =>
        recordReviewDelivered(current, delivery),
      );
      return true;
    }
    await recordPlan(adapter, input.sessionID, expected, plan, acceptanceCriteria, review);
    return true;
  }

  if (
    lifecycle.phase === "awaiting-plan-repair" &&
    lifecycle.pendingReview?.kind === "plan" &&
    lifecycle.pendingReview.delivery?.messageID === input.parentMessageID
  ) {
    const plan = boundedText(input.text, "terminal plan");
    const expected = taskIdentity(lifecycle);
    await persistCurrentTransition(adapter, input.sessionID, expected, (current) =>
      recordAddressedPlan(current, plan, {
        acceptanceCriteria: current.acceptanceCriteria,
      }),
    );
    return true;
  }
  return false;
}

async function captureTerminalArtifact(adapter, input) {
  const snapshot = normalizeSnapshot(await adapter.get(input.sessionID));
  const lifecycle = snapshot.data;
  const isPendingRepair =
    lifecycle?.pendingReview?.kind === "artifact" &&
    lifecycle.pendingReview.delivery?.messageID === input.parentMessageID;
  if (isPendingRepair) {
    const artifact = boundedText(input.text, "addressed terminal artifact");
    const expected = taskIdentity(lifecycle);
    await persistCurrentTransition(adapter, input.sessionID, expected, (current) =>
      recordAddressedArtifact(current, artifact),
    );
    return { handled: true };
  }
  if (
    !lifecycle ||
    lifecycle.pendingReview ||
    hasUnsettledExecution(lifecycle) ||
    !Array.isArray(lifecycle.receipts) ||
    lifecycle.receipts.length < 1
  )
    return false;
  const isApprovalTurn =
    lifecycle.phase === "approved" &&
    lifecycle.approval?.messageID === input.parentMessageID;
  const isArtifactFollowup =
    lifecycle.phase === "awaiting-artifact-review" &&
    lifecycle.artifactReviewMessageID === input.parentMessageID;
  if (!isApprovalTurn && !isArtifactFollowup) return false;

  const artifact = boundedText(input.text, "terminal artifact");
  const expected = taskIdentity(lifecycle);
  const review = await adapter.review({
    sessionID: input.sessionID,
    contract: lifecycle.taskContract || "",
    acceptanceCriteria: lifecycle.acceptanceCriteria || [],
    submission: {
      kind: "artifact",
      content: artifact,
      digest: digestPlan(artifact),
    },
  });
  if (review.plainReport) {
    await persistCurrentTransition(adapter, input.sessionID, expected, (current) =>
      recordPendingArtifactReview(current, artifact, {
        review,
        reviewedDigest: review.submission.digest,
      }),
    );
    const delivery = await adapter.resumeWithReview({
      sessionID: input.sessionID,
      reviewID: review.plainReport.reviewID,
    });
    await persistCurrentTransition(adapter, input.sessionID, expected, (current) =>
      recordReviewDelivered(current, delivery),
    );
    return {
      handled: true,
      visibleText:
        "Artifact review feedback was delivered for repair. Complete the repair and record newly settled post-report proof before making a completion claim.",
    };
  }
  await recordArtifact(adapter, input.sessionID, artifact, review);
  return { handled: true };
}

export const TaskQualityPlugin = async ({
  client,
  experimental_task_quality,
}) => {
  const adapter = createLifecycleAdapter(
    client,
    experimental_task_quality,
    configuredReviewerCandidates(POLICY).map(({ agent }) => ({ agent })),
  );
  const active = Boolean(adapter && adapter.canReview && policyIsValid());
  // The engine invokes experimental.text.complete after a text part is
  // streamed but before that part is durably finalized. This response-local
  // latch covers the exact response that receives a denied checkpoint even
  // if denial persistence loses a CAS race and a subsequent read is stale.
  const completionDenied = new Set();
  // Terminal-start decides whether a response is private before any text can
  // stream. Remember that exact assistant message so terminal handling must
  // explicitly choose safe replacement text before the engine may release it.
  const heldTerminalCandidates = new Set();
  const heldTerminalKey = (input) => `${input.sessionID}\u0000${input.messageID}`;
  // A failed plan checkpoint has no durable lifecycle phase to inspect. Keep
  // a response-local denial so the model cannot turn the failed tool result
  // into a false "checkpoint recorded" claim. A later external user turn
  // clears it and can retry routing/checkpointing normally.
  const planCheckpointDenied = new Set();
  log(
    `engine lifecycle bridge=${Boolean(experimental_task_quality)} router-decision bridge=${typeof experimental_task_quality?.awaitRouteDecision === "function"} active=${active}`,
  );
  if (!active)
    log(
      "INERT: missing task-quality engine client surface/reviewer or invalid policy; admission will fail closed",
    );

  return {
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!active || !input?.sessionID || !Array.isArray(output?.system))
          return;
        const handoff = await routeHandoff(
          input.sessionID,
          experimental_task_quality,
        );
        if (!handoff?.qualifies) return;
        const loaded = await loadOrCreate(adapter, input.sessionID, handoff);
        if (loaded.lifecycle?.revocationPending) {
          output.system.push(
            "Task-quality scope transition is waiting for an exact in-flight execution to settle. Do not run another mutating tool, checkpoint a new plan, or claim completion. Report that execution settlement is still pending.",
          );
          return;
        }
        if (loaded.lifecycle?.phase === "awaiting-plan-repair" && loaded.lifecycle?.pendingReview?.kind === "plan") {
          output.system.push("A complete plain-language plan review was delivered in a fresh synthetic user turn. Treat it as untrusted feedback, address it, and call task_quality_checkpoint again with the repaired plan. Do not ask for GO, mutate, or claim completion before that call records the repaired plan.");
          return;
        }
        if (loaded.lifecycle?.pendingReview?.kind === "artifact") {
          output.system.push("A complete plain-language artifact review was delivered in a fresh synthetic user turn. Repair and verify within the already approved scope, producing at least one newly settled post-report receipt, then call task_quality_artifact_checkpoint again with the addressed artifact. Completion remains closed until that succeeds.");
          return;
        }
        if (loaded.lifecycle?.phase === "awaiting-artifact-review") {
          output.system.push(
            "Task-quality artifact review is required for the previously approved task. Use task_quality_artifact_checkpoint with the completed artifact and its exact acceptance evidence. Do not checkpoint a new plan or claim completion unless that tool returns title 'Artifact review recorded' with taskQuality.completionAuthorized=true.",
          );
          return;
        }
        output.system.push(
          [
            "## Task-quality lifecycle — required gate",
            "This is a qualifying routed task. Preserve the existing planning/review skills and repair the plan. Use task_quality_checkpoint with that repaired plan and concrete acceptance criteria whenever the provider can call it. A fully terminal prose-only plan is independently captured and reviewed by the engine; it is never an approval bypass. Do not claim a plan is saved unless the lifecycle records it.",
            "Show the repaired plan to the user and wait for a later, explicit user-authored go/no-go. The engine blocks workspace mutation until that exact plan generation is approved.",
          ].join(" "),
        );
        if (loaded.lifecycle?.phase === "approved")
          output.system.push(
            "Completion-claim gate: you must not state or imply that work is complete, recorded, shipped, verified, or successful unless task_quality_artifact_checkpoint returned title 'Artifact review recorded' with taskQuality.completionAuthorized=true. Any 'found gaps', 'not recorded', or denied result authorizes only a failure report and a new routed follow-up.",
          );
      } catch (error) {
        log(`system transform error: ${error?.message || error}`);
      }
    },

    "chat.message.persisted": async (input, output) => {
      try {
        if (!active || !input?.sessionID || !input?.messageID) return;
        if (input.origin === "external-user") {
          planCheckpointDenied.delete(input.sessionID);
        }
        await recordApproval(adapter, input, output);
      } catch (error) {
        // A CAS conflict or unavailable persistence must never become an
        // approval by implication. Admission remains denied until a later
        // exact external-user approval is durably recorded.
        log(`approval capture error: ${error?.message || error}`);
      }
    },

    "experimental.task_quality.terminal.start": async (input, output) => {
      if (!active || !input?.sessionID || !input?.parentMessageID || !output)
        return;
      try {
        const lifecycle = normalizeSnapshot(await adapter.get(input.sessionID)).data;
        const approvalBound =
          lifecycle?.phase === "approved" &&
          lifecycle.approval?.messageID === input.parentMessageID;
        const artifactReviewBound =
          lifecycle?.phase === "awaiting-artifact-review" &&
          lifecycle.artifactReviewMessageID === input.parentMessageID;
        const artifactRepairBound =
          lifecycle?.pendingReview?.kind === "artifact" &&
          lifecycle.pendingReview.delivery?.messageID === input.parentMessageID;
        if (approvalBound || artifactReviewBound || artifactRepairBound) {
          output.hold = true;
          heldTerminalCandidates.add(heldTerminalKey(input));
        }
      } catch (error) {
        // A state-read failure must not expose an unreviewed completion
        // candidate. The terminal handler supplies a clear fail-closed result.
        completionDenied.add(input.sessionID);
        output.hold = true;
        heldTerminalCandidates.add(heldTerminalKey(input));
        log(`terminal completion hold error: ${error?.message || error}`);
      }
    },

    "experimental.task_quality.terminal": async (input, output) => {
      if (!active || !input?.sessionID || !input?.parentMessageID || !input?.text)
        return;
      const held = heldTerminalCandidates.delete(heldTerminalKey(input));
      try {
        if (await captureTerminalPlan(adapter, input)) {
          planCheckpointDenied.delete(input.sessionID);
          completionDenied.delete(input.sessionID);
          if (held && output && typeof output.text === "string") output.release = true;
          return;
        }
      } catch (error) {
        // Never let an optional reviewer failure crash the completed engine
        // turn. The response is fail-closed by the latch until a new user
        // message reopens planning.
        planCheckpointDenied.add(input.sessionID);
        log(`terminal plan capture error: ${error?.message || error}`);
        return;
      }
      try {
        const result = await captureTerminalArtifact(adapter, input);
        if (result?.handled) {
          completionDenied.delete(input.sessionID);
          if (result.visibleText && output && typeof output.text === "string")
            output.text = result.visibleText;
          if (held && output && typeof output.text === "string") output.release = true;
          return;
        }
        if (held && output && typeof output.text === "string") {
          output.text =
            "Completion is not eligible for artifact review yet because the required execution proof is missing or still unsettled. Complete and settle the required work, then retry the final artifact review.";
          output.release = true;
        }
      } catch (error) {
        completionDenied.add(input.sessionID);
        if (output && typeof output.text === "string")
          output.text =
            "Artifact review could not be recorded, so no completion claim is authorized. Resolve the lifecycle failure before continuing this task.";
        if (held && output && typeof output.text === "string") output.release = true;
        try {
          const artifact = boundedText(input.text, "terminal artifact");
          await recordArtifactDenial(
            adapter,
            input.sessionID,
            artifact,
            error?.message || String(error),
          );
        } catch (denialError) {
          log(`terminal artifact denial persistence error: ${denialError?.message || denialError}`);
        }
        log(`terminal artifact capture error: ${error?.message || error}`);
      }
    },

    "experimental.text.complete": async (input, output) => {
      if (!active || !input?.sessionID || !output || typeof output.text !== "string") return;
      if (planCheckpointDenied.has(input.sessionID)) {
        output.text = "The plan checkpoint was not recorded, so no implementation or approval is authorized. Resolve the routing or lifecycle failure and checkpoint the plan successfully before asking for GO.";
        return;
      }
      let denied = completionDenied.has(input.sessionID);
      let awaiting = false;
      let settling = false;
      let pendingPlan = false;
      let pendingArtifact = false;
      try {
        const lifecycle = normalizeSnapshot(await adapter.get(input.sessionID)).data;
        if (lifecycle?.phase === "artifact-review-failed") denied = true;
        if (lifecycle?.phase === "awaiting-artifact-review") awaiting = true;
        if (lifecycle?.revocationPending) settling = true;
        if (lifecycle?.pendingReview?.kind === "plan") pendingPlan = true;
        if (lifecycle?.pendingReview?.kind === "artifact") pendingArtifact = true;
      } catch (error) {
        // The per-turn latch is enough for an immediately preceding denial;
        // never replace unrelated text merely because a later read failed.
        log(`completion gate state read error: ${error?.message || error}`);
      }
      if (denied) {
        output.text = "Artifact review was denied or found gaps. No completion claim is authorized. This task generation is closed; route a repaired follow-up as a new task.";
        return;
      }
      if (settling) {
        output.text = "An earlier execution is still settling under the durable task-quality lifecycle. No new mutation or completion claim is authorized until its exact receipt or permission rejection is recorded.";
        return;
      }
      if (pendingPlan) {
        output.text = "The plain-language plan review is pending an addressed follow-up checkpoint. No plan, GO, mutation, or completion is authorized yet.";
        return;
      }
      if (pendingArtifact) {
        output.text = "The artifact review report is pending repair and newly settled post-report proof. Work may continue only within the approved scope; no completion claim is authorized yet.";
        return;
      }
      if (awaiting) {
        output.text = "Artifact review is still required for the approved task. No completion claim is authorized until task_quality_artifact_checkpoint records a passing review.";
        return;
      }
      return;
    },

    "tool.execute.admission": async (input, output) => {
      try {
        if (!active) {
          if (input.capability !== "read")
            Object.assign(output, {
              decision: "deny",
              reason:
                "Task quality requires an Agent Omega v2.7.2 engine lifecycle surface before mutating tools may run.",
              policyVersion: "agent-omega/task-quality@1",
            });
          return;
        }
        const owner =
          input.tool === CONTROL_TOOL
            ? null
            : await lifecycleOwner(
                adapter,
                experimental_task_quality,
                input.sessionID,
              );
        const directTaskGrant =
          owner?.sessionID !== input.sessionID &&
          typeof experimental_task_quality?.directTaskGrant === "function"
            ? experimental_task_quality.directTaskGrant(input.sessionID)
            : undefined;
        const directTaskWrapperCallID =
          directTaskGrant &&
          owner &&
          directTaskGrant.parentSessionID === owner.sessionID
            ? directTaskGrant.parentTaskCallID
            : undefined;
        Object.assign(
          output,
          admitTaskQualityTool({
            tool: input.tool,
            source: input.source,
            capability: input.capability,
            trustedControl: input.trustedControl,
            lifecycle: owner?.snapshot?.data || null,
            directTaskWrapperCallID,
          }),
        );
      } catch (error) {
        if (input.capability !== "read") {
          Object.assign(output, {
            decision: "deny",
            reason:
              "Task quality could not read durable lifecycle state; mutation is blocked until the state store is available.",
            policyVersion: "agent-omega/task-quality@1",
          });
        }
        log(`admission error: ${error?.message || error}`);
      }
    },

    "tool.execute.preexecute": async (input) => {
      if (!active) return;
      // Let a failed CAS/read reject tool execution. Swallowing this error
      // would allow an unrecoverable mutation with no durable precommit. The
      // engine invokes this only after policy admission succeeds.
      const owner = await lifecycleOwner(
        adapter,
        experimental_task_quality,
        input.sessionID,
      );
      if (owner.sessionID !== input.sessionID) {
        const boundParent =
          typeof experimental_task_quality?.beginDirectTaskExecution ===
          "function"
            ? experimental_task_quality.beginDirectTaskExecution(
                input.sessionID,
                input.callID,
              )
            : undefined;
        if (boundParent !== owner.sessionID)
          throw new Error(
            "no live engine-issued direct-task execution grant exists for mutation precommit",
          );
      }
      await markExecutionStarted(adapter, input, owner.sessionID);
    },

    "tool.execute.persisted": async (input, output) => {
      try {
        if (!active) return;
        const owner = await settlementOwner(
          adapter,
          experimental_task_quality,
          input,
        );
        await captureReceipt(adapter, input, output, owner.sessionID);
      } catch (error) {
        // Evidence capture cannot authorize anything. A failure leaves the
        // artifact checkpoint closed and never changes the original tool result.
        log(`receipt capture error: ${error?.message || error}`);
      }
    },

    "tool.execute.permission_rejected": async (input) => {
      try {
        if (!active) return;
        const owner = await settlementOwner(
          adapter,
          experimental_task_quality,
          input,
        );
        await settlePermissionRejectedExecution(
          adapter,
          input,
          owner.sessionID,
        );
      } catch (error) {
        // The rejection is already durable. If its recovery settlement cannot
        // be saved, retain the conservative pending record rather than
        // guessing about a side effect.
        log(
          `permission rejection settlement error: ${error?.message || error}`,
        );
      }
    },

    tool: {
      [CONTROL_TOOL]: tool({
        description:
          "Run or address the isolated plan review for the current qualifying task. A plain CRAP report is delivered in a fresh turn; call this tool again with the repaired plan before asking for approval.",
        args: {
          // Some llama.cpp-compatible OpenAI endpoints reject grammars synthesized
          // from JSON Schema cardinality bounds before the model receives a token.
          // Keep the provider-facing contract simple; enforce limits in execute.
          repaired_plan: z
            .string()
            .describe(
              "The complete repaired implementation plan that will be shown to the user for explicit go/no-go.",
            ),
          acceptance_criteria: z
            .array(z.string())
            .describe(
              "Concrete observable conditions the repaired plan must satisfy.",
            ),
        },
        execute: async (args, context) => {
          if (!active)
            return {
              title: "Task-quality blocked",
              output:
                "The installed engine cannot run and persist an isolated task-quality review. Update Agent Omega v2.7.2 before continuing a qualifying change.",
            };
          try {
            const plan = boundedText(args.repaired_plan, "repaired plan");
            const acceptanceCriteria = boundedCriteria(
              args.acceptance_criteria,
            );
            // Read and require durable state before starting the isolated HSS/
            // CRAP call. Otherwise a missing router result wastes a reviewer
            // run and can mislead the model into claiming the plan was saved.
            const lifecycleSnapshot = normalizeSnapshot(
              await adapter.get(context.sessionID),
            );
            const lifecycle = lifecycleSnapshot.data;
            if (!lifecycle)
              throw new Error(
                "No durable qualifying task lifecycle exists. Do not implement; establish the task plan first.",
              );
            const expected = taskIdentity(lifecycle);
            if (
              !sameTaskIdentity(
                lifecycle,
                expected,
                lifecycleSnapshot.generation,
              )
            )
              throw new Error(
                "The durable task lifecycle has an invalid identity. Start a fresh routed task before checkpointing.",
              );
            if (lifecycle.phase === "awaiting-plan-repair" && lifecycle.pendingReview?.kind === "plan") {
              if (!lifecycle.pendingReview.delivery?.messageID) {
                const delivery = await adapter.resumeWithReview({ sessionID: context.sessionID, reviewID: lifecycle.pendingReview.reviewID });
                const recorded = await persistCurrentTransition(adapter, context.sessionID, expected, (current) => recordReviewDelivered(current, delivery));
                planCheckpointDenied.delete(context.sessionID);
                return {
                  title: "Plan review delivered",
                  output: "The pending plain-language review was recovered and durably queued as a fresh user turn. Address it before calling this checkpoint again.",
                  metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, reviewID: delivery.reviewID, reportDigest: delivery.reportDigest, deliveryMessageID: delivery.messageID } },
                };
              }
              const recorded = await persistCurrentTransition(adapter, context.sessionID, expected, (current) => recordAddressedPlan(current, plan, { acceptanceCriteria }));
              planCheckpointDenied.delete(context.sessionID);
              completionDenied.delete(context.sessionID);
              return {
                title: "Repaired plan recorded",
                output: `Repaired plan generation ${recorded.generation} is recorded after the durably delivered review. Show this exact plan to the user and wait for an explicit go/no-go before any implementation tool call.`,
                metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, planDigest: recorded.repairedPlan.digest, reviewID: recorded.addressReceipt.reviewID, reportDigest: recorded.addressReceipt.reportDigest, deliveryMessageID: recorded.addressReceipt.deliveryMessageID } },
              };
            }
            const review = await adapter.review({
              sessionID: context.sessionID,
              contract: lifecycle.taskContract || "",
              acceptanceCriteria,
              submission: {
                kind: "plan",
                content: plan,
                digest: digestPlan(plan),
              },
            });
            if (review.plainReport) {
              await persistCurrentTransition(adapter, context.sessionID, expected, (current) => recordPendingPlanReview(current, plan, { review, acceptanceCriteria, reviewedDigest: review.submission.digest }));
              const delivery = await adapter.resumeWithReview({ sessionID: context.sessionID, reviewID: review.plainReport.reviewID });
              const recorded = await persistCurrentTransition(adapter, context.sessionID, expected, (current) => recordReviewDelivered(current, delivery));
              planCheckpointDenied.delete(context.sessionID);
              return {
                title: "Plan review delivered",
                output: "The complete plain-language review was durably queued as a fresh user turn. No plan, GO, mutation, or completion is authorized until the next checkpoint records the repaired plan.",
                metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, reviewID: review.plainReport.reviewID, reportDigest: review.plainReport.reportDigest, reviewedDigest: review.submission.digest, deliveryMessageID: delivery.messageID } },
              };
            }
            const recorded = await recordPlan(
              adapter,
              context.sessionID,
              expected,
              plan,
              acceptanceCriteria,
              review,
            );
            planCheckpointDenied.delete(context.sessionID);
            // Only a successfully recorded rewrite creates a fresh generation
            // that can safely release a prior response-local artifact denial.
            completionDenied.delete(context.sessionID);
            return {
              title: "Repaired plan recorded",
              output: `Repaired plan generation ${recorded.generation} is recorded. Show this exact plan to the user and wait for an explicit go/no-go before any implementation tool call.`,
              metadata: {
                taskQuality: {
                  phase: recorded.phase,
                  generation: recorded.generation,
                  planDigest: recorded.repairedPlan.digest,
                },
              },
            };
          } catch (error) {
            planCheckpointDenied.add(context.sessionID);
            return {
              title: "Task-quality plan not recorded",
              output: `No implementation is authorized: ${error?.message || error}`,
            };
          }
        },
      }),
      [ARTIFACT_CONTROL_TOOL]: tool({
        description:
          "Record a bounded final artifact review after approved work. This control-plane tool does not edit files or execute commands. It requires sanitized engine-captured execution receipts and permanently closes the current task generation on review success or failure.",
        args: {
          artifact: z
            .string()
            .describe(
              "A concise final work-product report or artifact summary to be independently reviewed.",
            ),
        },
        execute: async (args, context) => {
          if (!active)
            return {
              title: "Task-quality blocked",
              output:
                "The installed engine cannot run and persist an isolated artifact review. Update Agent Omega v2.7.2 before continuing.",
            };
          try {
            const artifact = boundedText(args.artifact, "artifact");
            const lifecycle = normalizeSnapshot(
              await adapter.get(context.sessionID),
            ).data;
            if (
              !hasArtifactReviewAuthorization(lifecycle) ||
              hasUnsettledExecution(lifecycle)
            )
              throw new Error(
                "a current explicit external-user approval with no unresolved execution is required before artifact review",
              );
            if (
              !Array.isArray(lifecycle.receipts) ||
              lifecycle.receipts.length < 1
            )
              throw new Error(
                "at least one sanitized execution or verification receipt is required before artifact review",
              );
            if (lifecycle.pendingReview?.kind === "artifact") {
              const expected = taskIdentity(lifecycle);
              if (!lifecycle.pendingReview.delivery?.messageID) {
                const delivery = await adapter.resumeWithReview({ sessionID: context.sessionID, reviewID: lifecycle.pendingReview.reviewID });
                const recorded = await persistCurrentTransition(adapter, context.sessionID, expected, (current) => recordReviewDelivered(current, delivery));
                completionDenied.delete(context.sessionID);
                return {
                  title: "Artifact review delivered",
                  output: "The pending plain-language artifact review was recovered and durably queued as a fresh user turn. Repair and verify it before calling this checkpoint again.",
                  metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, completionAuthorized: false, reviewID: delivery.reviewID, reportDigest: delivery.reportDigest, deliveryMessageID: delivery.messageID } },
                };
              }
              const recorded = await persistCurrentTransition(adapter, context.sessionID, expected, (current) => recordAddressedArtifact(current, artifact));
              completionDenied.delete(context.sessionID);
              return {
                title: "Artifact review addressed",
                output: "The plain-language artifact report is durably and causally addressed with newly settled post-report proof. This task generation is closed; begin a new routed task before further implementation.",
                metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, artifactDigest: recorded.reviewedArtifact.digest, completionAuthorized: true, reviewID: recorded.addressReceipt.reviewID, reportDigest: recorded.addressReceipt.reportDigest, deliveryMessageID: recorded.addressReceipt.deliveryMessageID } },
              };
            }
            const review = await adapter.review({
              sessionID: context.sessionID,
              contract: lifecycle?.taskContract || "",
              acceptanceCriteria: lifecycle?.acceptanceCriteria || [],
              submission: {
                kind: "artifact",
                content: artifact,
                digest: digestPlan(artifact),
              },
            });
            if (review.plainReport) {
              const expected = taskIdentity(lifecycle);
              await persistCurrentTransition(adapter, context.sessionID, expected, (current) => recordPendingArtifactReview(current, artifact, { review, reviewedDigest: review.submission.digest }));
              const delivery = await adapter.resumeWithReview({ sessionID: context.sessionID, reviewID: review.plainReport.reviewID });
              const recorded = await persistCurrentTransition(adapter, context.sessionID, expected, (current) => recordReviewDelivered(current, delivery));
              completionDenied.delete(context.sessionID);
              return {
                title: "Artifact review delivered",
                output: "The complete plain-language artifact review was durably queued as a fresh user turn. Completion is not authorized until it is repaired, verified, and checkpointed again.",
                metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, completionAuthorized: false, reviewID: review.plainReport.reviewID, reportDigest: review.plainReport.reportDigest, reviewedDigest: review.submission.digest, deliveryMessageID: delivery.messageID, receiptWatermark: recorded.pendingReview.receiptWatermark } },
              };
            }
            const recorded = await recordArtifact(
              adapter,
              context.sessionID,
              artifact,
              review,
            );
            const passed = recorded.phase === "artifact-reviewed";
            if (passed) completionDenied.delete(context.sessionID);
            else completionDenied.add(context.sessionID);
            return {
              title: passed
                ? "Artifact review recorded"
                : "Artifact review found gaps",
              output: passed
                ? "The final artifact review is durably recorded. This task generation is closed; begin a new routed task before further implementation."
                : "The isolated artifact review found gaps or was blocked. This task generation is closed; route a repaired follow-up as a new task before further implementation.",
              metadata: {
                taskQuality: {
                  phase: recorded.phase,
                  generation: recorded.generation,
                  artifactDigest: recorded.reviewedArtifact?.digest || null,
                  completionAuthorized: passed,
                },
              },
            };
          } catch (error) {
            completionDenied.add(context.sessionID);
            try {
              const current = normalizeSnapshot(await adapter.get(context.sessionID)).data;
              if (current?.pendingReview?.kind === "artifact") {
                completionDenied.delete(context.sessionID);
                return { title: "Artifact repair not recorded", output: `No completion claim is authorized; the pending review remains open: ${error?.message || error}`, metadata: { taskQuality: { phase: current.phase, generation: current.generation, completionAuthorized: false, reviewID: current.pendingReview.reviewID, reportDigest: current.pendingReview.reportDigest } } };
              }
            } catch {}
            // A reviewer transport/contract failure is a terminal denial for
            // this approved generation, not a recoverable-looking omission.
            // Persist that denial before returning any model-visible result.
            try {
              const artifact = typeof args?.artifact === "string" ? boundedText(args.artifact, "artifact") : null;
              if (artifact) {
                const denied = await recordArtifactDenial(adapter, context.sessionID, artifact, error?.message || String(error));
                return {
                  title: "Artifact review denied",
                  output: "No completion claim is authorized. The artifact review could not be completed or validated, and this task generation is durably closed; route a repaired follow-up as a new task.",
                  metadata: { taskQuality: { phase: denied.phase, generation: denied.generation, artifactDigest: denied.artifactReviewFailure?.digest || null, completionAuthorized: false } },
                };
              }
            } catch (denialError) {
              log(`artifact denial recording error: ${denialError?.message || denialError}`);
            }
            return {
              title: "Task-quality artifact review not recorded",
              output: `No completion claim is authorized: ${error?.message || error}`,
              metadata: { taskQuality: { completionAuthorized: false } },
            };
          }
        },
      }),
    },
  };
};

// This must use the v1 plugin-module shape rather than the legacy bare
// function export. The engine grants its private lifecycle/review bridge only
// to the loader-attested global config slot, and legacy plugins cannot receive
// that capability.
export default {
  id: "agent-omega.task-quality",
  server: TaskQualityPlugin,
};
