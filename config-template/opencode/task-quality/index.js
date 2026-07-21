// task-quality: the durable Slice 1 plan/approval gate. Existing skills still
// own planning and review procedure; this plugin owns only lifecycle state and
// engine admission. Its one idle hook is a bounded recovery for a CRAP report
// that was delivered but answered in prose without post-report proof.
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { tool } from "@opencode-ai/plugin";
import { createLifecycleAdapter, normalizeSnapshot } from "./adapter.mjs";
import { warnOnce, withRouteObservability } from "./observability.mjs";
import { configuredReviewerCandidates } from "./reviewer.mjs";
import { getRouteHandoff, digestText } from "./handoff.mjs";
import {
  admitTaskQualityTool,
  parseImmutableOracles,
  CONTROL_TOOL,
  ARTIFACT_CONTROL_TOOL,
} from "./admission.mjs";
import { reviewCodeArtifact, selfReviewDisabled } from "./selfreview.mjs";
import { deriveFunctionContract, applySwapToFile } from "./selfreview-seam.mjs";
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
  recordArtifactRereview,
  recordReviewDelivered,
  recordExecutionPermissionRejected,
  recordExecutionStarted,
  recordReceipt,
  recordRepairedPlan,
  recordPendingPlanReview,
  recordAddressedPlan,
  recordUserDecision,
  recordAutonomousApproval,
  abandonStaleExecution,
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
// FIX-3 (legible settlement protocol): the bounded (<=1 KB) findings excerpt an
// interception message echoes so the builder can see WHAT to fix, not merely
// that it is blocked.
const INTERCEPTION_CONTEXT_BYTES = 1024;
const APPROVAL_REVOCATION_CAS_ATTEMPTS = PENDING_EXECUTION_LIMIT + 2;
// FIX-2: bounded repair rounds before an honest terminal DECLINED. The
// lifecycle enforces its own default cap; this knob only overrides it within
// a sane range, and anything unset or invalid falls back to that default.
const REVIEW_ROUNDS_CAP_OVERRIDE = (() => {
  const value = Number.parseInt(
    process.env.TASK_QUALITY_REVIEW_ROUNDS_CAP || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 1 && value <= 10
    ? value
    : null;
})();
// Commit C: bounded retry for a transient reviewer-MACHINERY failure on a bound
// re-review (a transport error / timeout / adapter throw — NOT a returned verdict).
// Without it, one flaky reviewer round consumes a repair round against an artifact
// that may be fine. Env OMEGA_REVIEW_MACHINERY_RETRIES, default 0 ⇒ exactly one
// attempt ⇒ byte-identical to prior behavior; clamped to a sane ceiling so a
// hostile value cannot spin the reviewer unbounded.
const MACHINERY_RETRIES = (() => {
  const value = Number.parseInt(process.env.OMEGA_REVIEW_MACHINERY_RETRIES || "0", 10);
  return Number.isSafeInteger(value) && value >= 0 && value <= 5 ? value : 0;
})();
// FIX-3: this is a MATCHER, not display text. Its exact value is a substring of
// the lifecycle's thrown guard error (lifecycle.mjs recordAddressedArtifact), so
// the terminal handler can recognize a missing-post-report-receipt failure and
// preserve the pending review. The builder-facing wording lives in the aligned
// interception messages below; do not extend this string or the match breaks.
const POST_REPORT_RECEIPT_REQUIRED =
  "at least one newly settled post-report execution or verification receipt is required";
const CRAP_ARTIFACT_RECOVERY_PROMPT = [
  "[task-quality CRAP recovery]",
  "The preceding synthetic user message is the C.R.A.P. artifact-review report.",
  "Do not answer it in prose. Stay within the already approved task scope: address each concrete defect it identifies, run at least one relevant verification so a new post-report receipt settles, then call task_quality_artifact_checkpoint again with the updated artifact and exact evidence.",
  "Engine-attested lifecycle facts override stale plan-only or pre-GO wording in the original objective. Do not make a completion claim unless that checkpoint returns title 'Artifact review recorded' with taskQuality.completionAuthorized=true.",
].join(" ");
const CRAP_PARKED_REREVIEW_RECOVERY_PROMPT = [
  "[task-quality re-review recovery]",
  "STATE: this session is parked in the awaiting-artifact-rereview phase - the addressed artifact is durably recorded, but its isolated re-review verdict never persisted, and you cannot self-exit this phase.",
  "NEXT ACTION: do not revise the artifact and do not answer in prose; call task_quality_artifact_checkpoint again with the exact same addressed artifact bytes. No new receipt is needed and the recovery guard rejects any other content, so that byte-exact call is the only thing that re-runs the stalled re-review.",
  "Do not make a completion claim unless that checkpoint returns title 'Artifact review recorded' with taskQuality.completionAuthorized=true.",
].join(" ");
// F3 (iter-2 Road-2 autonomous wiring). Default OFF preserves the interactive
// human-in-the-loop path byte-for-byte: a real person types GO, and a phantom
// precommit stays fail-closed for a human to inspect. It is set ON only by the
// unattended improvement loop, where no human is present to type GO or to clear
// a stale precommit. When ON, two strictly-additive lifecycle edges supply the
// "road back" a human otherwise would (recordAutonomousApproval on a stranded
// approved-plan, abandonStaleExecution on a phantom precommit), and the terminal
// completion hold is widened so a bare "I'm done" narration can never bypass the
// isolated artifact review merely because the autonomously-minted approval
// identity does not match the engine's turn id. It weakens no gate: every
// authorization predicate (mutation, artifact review, completion) is unchanged;
// this only adds edges that move a frozen state to a legitimately-authorized one
// and only ever holds MORE completions, never fewer.
const AUTONOMOUS_MODE = /^(1|true|yes|on)$/i.test(
  String(process.env.TASK_QUALITY_AUTONOMOUS || "").trim(),
);
// Lever I — immutable-artifact guard. The harness declares the acceptance-oracle
// basenames (the hidden test/spec and the task README) via OMEGA_IMMUTABLE_ORACLES
// (comma / semicolon / whitespace separated). When set, an otherwise-authorized
// mutating write whose target basename exactly matches a declared oracle is denied
// at admission. Deterministic, harness-declared (never inferred from prose),
// fail-open. Parsed once here into a normalized Set; null (unset/empty) means the
// guard abstains, so production behavior is byte-identical until explicitly enabled.
const IMMUTABLE_ORACLES = parseImmutableOracles(
  process.env.OMEGA_IMMUTABLE_ORACLES,
);
// FALLBACK-ONLY age floor. The primary phantom signal is now real engine
// liveness (isExecutionLive): the sweep asks the engine whether the subagent
// that owns an unsettled precommit is still running, and defers a live one no
// matter its age. This floor is consulted only when the engine cannot answer
// (an older engine without the capability, or a failed status probe). In that
// degraded case a precommit younger than this may be a live subagent mutation
// still running against the parent lifecycle while the parent session is
// momentarily idle; abandoning it would drop a real execution receipt and
// corrupt the Power-B evidence chain. A genuine phantom never settles, so its
// age only grows and a later idle recovers it. Bias long: wrongly abandoning
// live work is worse than a slow phantom recovery. Tunable via env for r7 lanes.
const STALE_PRECOMMIT_MIN_AGE_MS = (() => {
  const raw = Number(process.env.TASK_QUALITY_STALE_PRECOMMIT_MS);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 300000;
})();
// The synthetic identity stamped on an autonomously-minted approval. It is
// deliberately shaped so it can never collide with an engine message id
// (msg_...), which is what forces autonomous completions down the explicit
// checkpoint path guarded by the widened hold below, rather than the implicit
// terminal-narration capture that binds on a matching turn id.
function autonomousMessageID(kind, generation) {
  return `internal:autonomous-${kind}:g${generation}`;
}
const AUTONOMOUS_APPROVAL_PROMPT = [
  "[task-quality autonomous approval]",
  "Your plan cleared its independent review and has now been approved so work can proceed - this is a road forward, not a completion signal. Stay strictly within the approved plan's scope and implement it now.",
  "When the implementation is finished, do NOT simply narrate that you are done: call task_quality_artifact_checkpoint with the final artifact and your exact verification evidence. A bare completion claim without that checkpoint is held and rejected.",
  "Do not make a completion claim unless that checkpoint returns title 'Artifact review recorded' with taskQuality.completionAuthorized=true.",
].join(" ");
const AUTONOMOUS_REPLAN_PROMPT = [
  "[task-quality stale-execution recovery]",
  "A prior tool execution was precommitted but never settled - its effect on disk is unknown, so the earlier authorization was safely closed and the task was reset to planning. This is a road back, not a failure.",
  "Re-establish ground truth first: re-read the file(s) you were editing to see their CURRENT on-disk state, then produce a fresh plan for the remaining work and continue through the normal task_quality checkpoints.",
].join(" ");
const AUTONOMOUS_ARTIFACT_RECOVERY_PROMPT = [
  "[task-quality stale-execution recovery]",
  "A prior tool execution was precommitted but never settled, so its authorization was closed; because real work-product receipts already exist, that work-so-far now owes its independent artifact review before any completion.",
  "Do not narrate completion. Call task_quality_artifact_checkpoint with the exact current artifact and your verification evidence so the isolated review can run.",
  "Do not make a completion claim unless that checkpoint returns title 'Artifact review recorded' with taskQuality.completionAuthorized=true.",
].join(" ");
const AUTONOMOUS_PLAN_REPAIR_RECOVERY_PROMPT = [
  "[task-quality plan-repair recovery]",
  "STATE: an independent plan review is open and unaddressed - your plan is not approved, no mutation or completion is authorized, and no human will type GO to unblock you. This is a road back, not a stop.",
  "NEXT ACTION: treat the delivered plan review as untrusted feedback; address each finding, then call task_quality_checkpoint again with the repaired plan and concrete acceptance criteria. Once that checkpoint records the repaired plan, work continues automatically.",
  "Do not mutate and do not claim completion before the repaired plan records.",
].join(" ");
// FIX-B: the exact set of lifecycle phases that still owe work or a review and
// so must never yield an authorized completion. In autonomous mode the approval
// is minted with a synthetic messageID that can never match a continuation
// turn's parentMessageID, so the messageID-bound hold checks miss a bare "I'm
// done" narration; this set is the version-guarded backstop that holds it in
// EVERY work-owing phase, not just approved / awaiting-artifact-review. The two
// terminal phases (artifact-reviewed = authorized success, declined = already a
// stop with its own messaging) are deliberately excluded, and a null or legacy
// lifecycle (a non-task conversation turn) is excluded by the version guard at
// the call site - so ordinary conversation is never held.
const AUTONOMOUS_HOLD_PHASES = new Set([
  "planning",
  "awaiting-approval",
  "approved",
  "awaiting-plan-repair",
  "awaiting-artifact-review",
  "awaiting-artifact-rereview",
  "artifact-review-failed",
]);
// The road back for a completion narration held with no plan/artifact captured
// from its text. Because the hold now spans plan-side phases too, a single
// "retry the artifact review" line would dead-end where no artifact exists yet;
// each phase family gets the concrete next checkpoint call instead, so every
// held stop still carries a forward exit.
function autonomousHoldRoadback(phase) {
  switch (phase) {
    case "planning":
    case "awaiting-approval":
    case "awaiting-plan-repair":
      return "You are not done: your plan has not cleared its independent review, so no completion is authorized. Address any plan-review feedback, then call task_quality_checkpoint with your plan and concrete acceptance criteria - work continues automatically once the plan records.";
    case "artifact-review-failed":
    case "awaiting-artifact-rereview":
      return "You are not done: the artifact review returned findings that are not yet resolved. Address every finding, run your verification so a fresh receipt settles, then call task_quality_artifact_checkpoint with the addressed artifact. No completion claim is authorized yet.";
    default:
      // approved / awaiting-artifact-review - work-product owes its review.
      return "Completion is not eligible for artifact review yet because the required execution proof is missing or still unsettled. Complete and settle the required work, then call task_quality_artifact_checkpoint with the final artifact and your verification evidence.";
  }
}
function log(message) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch (error) {
    // FIX-6: surface log-append failures once instead of swallowing silently.
    warnOnce("task-quality.log append", error);
  }
}

// v2 SELF-REVIEW SELECT/SWAP — the "auto-fix, safety-gated" behavior Austin approved. When the finished work is a
// single, unambiguously-identified, self-contained function (deriveFunctionContract; else it no-ops), run the
// PROVEN ensemble self-review on the model's ACTUAL code and, ONLY when a re-derivation provably beats it on a
// reasoning-certified oracle (decideSwap, never-worse by construction + the type-B audit guard), swap the file in
// place (reversible, round-tripped). Everything is fully defensive: it NEVER throws, NEVER blocks completion, and
// on any failure degrades to a no-op with the model's code untouched — so it cannot make the checkpoint worse.
// Returns a small result the caller folds into the checkpoint output for observability. Gated off by
// OMEGA_SELF_REVIEW_DISABLE. Runs only on the fresh artifact review (the moment the model first submits finished
// work), before the summary is graded — the swap improves the code on disk; the artifact review is unchanged.
async function maybeSelfReviewSwap(lifecycle, context) {
  try {
    if (selfReviewDisabled(process.env)) return { ran: false, reason: "disabled" };
    const directory = context?.directory || context?.worktree;
    if (!directory) return { ran: false, reason: "no-directory" };
    // Which file the model actually wrote this task is decided DEFINITIVELY by git (deriveFunctionContract GATE A:
    // git status change-set), not by guessing from the freeform artifact/summary. No git-confirmed change -> no swap
    // (advise-only). So an old/unrelated single-function file that merely shares a task-mentioned name can never be
    // the overwrite target, and we never depend on the artifact being the code (it is only a summary in production).
    const contract = deriveFunctionContract({
      taskContract: lifecycle?.taskContract || "",
      directory,
    });
    if (!contract) return { ran: false, reason: "no-contract" };
    const modelSpec = process.env.OMEGA_SR_MODEL || "evo/qwen3-coder-80b";
    const r = await reviewCodeArtifact({
      ctx: { directory, sessionID: context.sessionID, abort: context.abort },
      task: { spec: contract.spec, fnName: contract.fnName, signature: contract.signature },
      incumbentSource: contract.incumbentSource,
      modelSpec,
      env: process.env,
    });
    if (!r || !r.ran) {
      log(`self-review: not-run (${r?.reason || "unknown"}) fn=${contract.fnName}`);
      return { ran: false, reason: r?.reason || "not-run", fnName: contract.fnName, advisory: r?.advisory || null };
    }
    if (r.swapEligible && r.selectedSource) {
      const applied = applySwapToFile({ file: contract.file, selectedSource: r.selectedSource });
      log(`self-review: SWAP ${applied.applied ? "applied" : "FAILED(" + applied.reason + ")"} fn=${contract.fnName} file=${contract.file} raw=${r.rawScore} winner=${r.winnerScore}/${r.certifiedSize} (${r.swapReason})`);
      return { ran: true, swapped: applied.applied, applyReason: applied.reason, file: contract.file, fnName: contract.fnName, rawScore: r.rawScore, winnerScore: r.winnerScore, certified: r.certifiedSize, swapReason: r.swapReason, advisory: r.advisory };
    }
    log(`self-review: advise-only fn=${contract.fnName} (${r.swapReason})`);
    return { ran: true, swapped: false, fnName: contract.fnName, swapReason: r.swapReason, advisory: r.advisory };
  } catch (error) {
    try { log(`self-review: error ${String((error && error.message) || error)}`); } catch {}
    return { ran: false, reason: "error", error: String((error && error.message) || error) };
  }
}

// Fold a self-review swap result into a human/model-visible note for the checkpoint output (empty when nothing
// notable happened, so the existing output text is unchanged in the common no-op case).
function selfReviewNote(sr) {
  if (!sr || !sr.ran) return "";
  if (sr.swapped) return `\n\nSelf-review improved your \`${sr.fnName}\`: an independent ensemble found a version that was correct on ${sr.winnerScore}/${sr.certified} reasoning-certified inputs where yours was correct on ${sr.rawScore}. That better version has replaced your code in place (never-worse guaranteed: it was swapped only because it strictly beat your code on a certified oracle).`;
  if (sr.advisory) return `\n\nSelf-review (advisory) on \`${sr.fnName}\`: ${sr.advisory}`;
  return "";
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

// FIX-3: a UTF-8 byte-bounded head excerpt of the pending review findings,
// echoed into an interception message so the builder sees WHAT to fix. Never
// splits a multi-byte sequence and never exceeds INTERCEPTION_CONTEXT_BYTES.
function reviewFindingsExcerpt(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  const full = Buffer.from(trimmed, "utf8");
  if (full.length <= INTERCEPTION_CONTEXT_BYTES) return trimmed;
  let end = INTERCEPTION_CONTEXT_BYTES - 16;
  while (end > 0 && (full[end] & 0xc0) === 0x80) end--;
  return `${full.subarray(0, end).toString("utf8")}\n[...]`;
}

// The findings for a state: the open pending review when one exists, else the
// most recent bounded reviewHistory entry. A repairable non-pass round clears
// pendingReview but preserves the findings in history, so this stays truthful
// across the artifact-review-failed phase too.
function interceptionFindings(lifecycle) {
  if (typeof lifecycle?.pendingReview?.report === "string")
    return lifecycle.pendingReview.report;
  const history = Array.isArray(lifecycle?.reviewHistory)
    ? lifecycle.reviewHistory
    : [];
  const last = history.length ? history[history.length - 1] : null;
  return typeof last?.report === "string" ? last.report : "";
}

// FIX-3: the five actionable completion-gate interceptions share one fixed
// three-part shape - (1) STATE: the true lifecycle posture, (2) NEXT ACTION:
// the literal checkpoint tool plus its precondition, (3) REVIEW FINDINGS: a
// bounded excerpt of the pending report. On the third consecutive interception
// in the same phase (noteInterception) the NEXT ACTION collapses to imperative
// numbered steps that name the missing receipt kind outright.
const INTERCEPTIONS = {
  pendingArtifact: {
    phaseName: "approved - artifact-review report open and pending repair",
    meaning:
      "an independent artifact-review report is open and pending repair; completion stays closed until an addressed re-submission re-reviews as pass.",
    action:
      "First make the change that addresses the findings, then run your verification so a NEW post-report execution or verification receipt is captured - re-sending text without a new receipt will be rejected - then call task_quality_artifact_checkpoint with the addressed artifact.",
    steps: [
      "Make the concrete change that addresses each finding listed below.",
      "Run the relevant verification so a new post-report execution or verification receipt settles; re-sending text without a new receipt will be rejected.",
      "Call task_quality_artifact_checkpoint with the addressed artifact and that new receipt.",
    ],
  },
  repairableFailed: {
    phaseName: "artifact-review-failed - approval still valid for repair",
    meaning:
      "the last independent re-review found gaps, and your existing approval still covers repairing them in place.",
    action:
      "Fix the identified gaps within the approved scope, run your verification so a NEW verification receipt settles, then call task_quality_artifact_checkpoint with the repaired artifact.",
    steps: [
      "Fix each gap listed below, staying inside the already approved scope.",
      "Run the relevant verification so a new verification receipt settles.",
      "Call task_quality_artifact_checkpoint with the repaired artifact and that new receipt.",
    ],
  },
  rereviewParked: {
    phaseName: "awaiting-artifact-rereview - parked pending a bound verdict",
    meaning:
      "the addressed artifact is durably recorded but its isolated re-review verdict never persisted; you cannot self-exit this phase and no new receipt is needed - only a byte-exact resubmission re-runs the stalled re-review.",
    action:
      "Call task_quality_artifact_checkpoint again with the exact same addressed artifact bytes; the recovery guard rejects any other content, so do not revise the artifact and do not resend prose.",
    steps: [
      "Do not edit the artifact and do not answer in prose.",
      "Call task_quality_artifact_checkpoint with the exact same addressed artifact bytes you already submitted.",
      "Wait for the re-review verdict; only completionAuthorized=true authorizes a completion claim.",
    ],
  },
  pendingPlan: {
    phaseName: "awaiting-plan-repair - plan review open",
    meaning:
      "a plain-language plan review is open; no plan, GO, mutation, or completion is authorized until the repaired plan is recorded.",
    action: AUTONOMOUS_MODE
      ? "Address the findings and call task_quality_checkpoint with the repaired plan; once that checkpoint records the repaired plan, work resumes automatically."
      : "Address the findings and call task_quality_checkpoint with the repaired plan; that new checkpoint must record the repaired plan before you ask for GO.",
    steps: [
      "Address each plan finding listed below.",
      "Call task_quality_checkpoint with the repaired plan and concrete acceptance criteria.",
      // FIX-C: in the unattended loop no human is present to type GO, so the
      // old "wait for a fresh external GO" step was a dead-end. Re-checkpointing
      // the repaired plan is itself the road forward - Trigger-1 grants it.
      AUTONOMOUS_MODE
        ? "Once that checkpoint records the repaired plan, work resumes automatically - do not wait for a human GO."
        : "Wait for a fresh external GO before any mutation.",
    ],
  },
  awaiting: {
    phaseName: "awaiting-artifact-review - approved task still unreviewed",
    meaning:
      "artifact review is still required for the approved task; it still needs its first independent review, and no completion is authorized until that review passes.",
    action:
      "Call task_quality_artifact_checkpoint with the completed artifact and its exact acceptance evidence, including the settled execution receipts; no completion is authorized until it records a passing review.",
    steps: [
      "Finish the artifact so it satisfies every acceptance criterion.",
      "Run verification so the required execution receipts settle.",
      "Call task_quality_artifact_checkpoint with the artifact and its exact acceptance evidence.",
    ],
  },
};

function interceptionMessage(key, lifecycle, escalated) {
  const spec = INTERCEPTIONS[key];
  if (!spec) return "";
  const excerpt = reviewFindingsExcerpt(interceptionFindings(lifecycle));
  const lines = [`STATE: ${spec.phaseName}. ${spec.meaning}`];
  if (escalated) {
    lines.push(
      "You have been intercepted here repeatedly. Do exactly this, in order:",
    );
    spec.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  } else {
    lines.push(`NEXT ACTION: ${spec.action}`);
  }
  if (excerpt) lines.push(`REVIEW FINDINGS (excerpt): ${excerpt}`);
  return lines.join("\n");
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

// F3: the autonomous-loop road-back driver, invoked only from the idle handler
// under AUTONOMOUS_MODE. It never weakens a gate; it only moves a frozen state
// to a legitimately-authorized posture (identical in shape to the interactive
// counterpart) and prompts the model forward. Returns true when it advanced the
// lifecycle (the caller then returns without running the artifact-recovery path)
// and false when nothing applied. The dedup map bounds re-firing to one
// continuation per durable state, exactly like artifact-CRAP recovery.
const NOTHING_TO_ABANDON = "task-quality:nothing-to-abandon";
async function advanceAutonomousLifecycle({
  adapter,
  sessionID,
  lifecycle,
  internalAutomation,
  dedup,
}) {
  if (!lifecycle || lifecycle.version !== 1) return false;

  // Trigger 0 - an open plan review the model walked away from by going idle
  // instead of re-checkpointing a repaired plan. Without this edge,
  // awaiting-plan-repair is a hard dead-end in the unattended loop: Trigger 1
  // only matches awaiting-approval, Trigger 2 only matches an unsettled
  // execution, and the artifact-recovery fall-through only re-delivers artifact
  // reviews - nothing re-delivers a pending PLAN review, and no human will type
  // GO. Re-deliver it as a road back, mirroring the artifact re-delivery, so
  // every stop keeps a forward exit.
  if (
    lifecycle.phase === "awaiting-plan-repair" &&
    lifecycle.pendingReview?.kind === "plan" &&
    typeof lifecycle.pendingReview.reviewID === "string" &&
    lifecycle.pendingReview.delivery?.messageID
  ) {
    const key = `plan-repair:${lifecycle.pendingReview.reviewID}`;
    if (dedup.get(sessionID) === key) return true;
    if (typeof internalAutomation?.continue !== "function") {
      log(`autonomous plan-repair recovery unavailable for ${sessionID}: internal automation bridge is missing`);
      return true;
    }
    dedup.set(sessionID, key);
    await internalAutomation.continue({ sessionID, text: AUTONOMOUS_PLAN_REPAIR_RECOVERY_PROMPT });
    log(`autonomous plan-repair recovery continuation queued for ${sessionID} (review ${lifecycle.pendingReview.reviewID})`);
    return true;
  }

  // Trigger 1 - a fully-reviewed plan stranded at AWAITING_APPROVAL with no
  // human GO. Mint the autonomous approval (the "road forward") and prompt the
  // model to implement through the explicit checkpoints.
  if (
    lifecycle.phase === "awaiting-approval" &&
    lifecycle.repairedPlan?.generation === lifecycle.generation
  ) {
    const key = `grant:g${lifecycle.generation}`;
    if (dedup.get(sessionID) === key) return true;
    if (typeof internalAutomation?.continue !== "function") {
      log(`autonomous approval unavailable for ${sessionID}: internal automation bridge is missing`);
      return true;
    }
    const messageID = autonomousMessageID("approval", lifecycle.generation);
    const expected = taskIdentity(lifecycle);
    await persistCurrentTransition(adapter, sessionID, expected, (current) => {
      const result = recordAutonomousApproval(current, {
        messageID,
        expectedGeneration: current.generation,
      });
      if (!result.ok) throw new Error(`autonomous approval rejected: ${result.reason}`);
      return result.lifecycle;
    });
    dedup.set(sessionID, key);
    await internalAutomation.continue({ sessionID, text: AUTONOMOUS_APPROVAL_PROMPT });
    log(`autonomous approval granted and continuation queued for ${sessionID} (generation ${lifecycle.generation})`);
    return true;
  }

  // Trigger 2 - a phantom precommit that can never settle on its own (idle means
  // no tool is running, yet a precommit is unsettled). Abandon every stale
  // precommit through the shared fail-closed settlement machinery, then prompt
  // the road back that the resulting phase implies.
  //
  // PRIMARY SIGNAL (engine liveness): ask the engine whether each unsettled
  // precommit belongs to a subagent that is still running. A subagent's child
  // session stays busy for the entire time its tool executes and its receipt is
  // recorded during that turn, before the child ever goes idle - so an unsettled
  // precommit whose child session is idle is a genuine phantom (crashed or killed
  // tool), while a genuinely slow-but-live subagent still reports busy and is
  // deferred no matter how long it has run. This is what makes the sweep abandon
  // ONLY dead work: it no longer times out a legitimately long subagent.
  //
  // FALLBACK (FIX-D age floor): the age gate is consulted only when the engine
  // cannot answer - an older engine without the liveness capability, or a status
  // probe that errored. In that degraded case a precommit younger than the floor
  // is deferred (it may still be live) and only an out-aged one is treated as a
  // phantom, exactly as before. A liveness-aware engine never reaches this path,
  // so it never wrongly abandons a long-running subagent.
  if (hasUnsettledExecution(lifecycle)) {
    const now = Date.now();
    const isAged = (item) =>
      item?.callID &&
      Number.isSafeInteger(item.startedAt) &&
      now - item.startedAt >= STALE_PRECOMMIT_MIN_AGE_MS;
    const pendingNow = (lifecycle.pendingExecutions || []).filter((item) => item?.callID);
    const canProbe = typeof adapter?.isExecutionLive === "function";
    const classify = async (item) => {
      let live = null;
      if (canProbe) {
        try {
          live = await adapter.isExecutionLive({ sessionID, callID: item.callID });
        } catch (error) {
          // Engine present but its status probe failed. Treat as unknown and
          // fall back to the age floor rather than guess "phantom" and risk
          // dropping a live receipt.
          live = null;
          log(
            `autonomous liveness probe failed for ${sessionID} ${item.callID}: ${String(error?.message || error)}`,
          );
        }
      }
      if (live === true) return { item, abandon: false, reason: "engine-live" };
      if (live === false) return { item, abandon: true, reason: "engine-phantom" };
      return { item, abandon: isAged(item), reason: isAged(item) ? "age-fallback" : "age-defer" };
    };
    const classified = await Promise.all(pendingNow.map(classify));
    const stale = classified.filter((entry) => entry.abandon).map((entry) => entry.item);
    if (stale.length === 0) {
      // Nothing is a confirmed phantom yet - either the engine says the subagent
      // is still live, or (engine unavailable) the precommit has not out-aged the
      // floor. Defer to a later idle rather than abandon possibly-live work. Not a
      // stop: the precommit either settles normally or becomes a confirmed phantom
      // that a future idle recovers.
      log(
        `autonomous abandon deferred for ${sessionID}: ${pendingNow.length} precommit(s) still live or not yet phantom (${classified.map((entry) => entry.reason).join(", ") || "none"})`,
      );
      return false;
    }
    const staleCallIDs = stale.map((item) => item.callID);
    const abandonCallIDs = new Set(staleCallIDs);
    const key = `abandon:${staleCallIDs.slice().sort().join(",")}`;
    if (dedup.get(sessionID) === key) return true;
    if (typeof internalAutomation?.continue !== "function") {
      log(`autonomous abandon unavailable for ${sessionID}: internal automation bridge is missing`);
      return true;
    }
    const messageID = autonomousMessageID("abandon", lifecycle.generation);
    const expected = taskIdentity(lifecycle);
    let settled;
    try {
      settled = await persistCurrentTransition(adapter, sessionID, expected, (current) => {
        const pending = Array.isArray(current.pendingExecutions)
          ? current.pendingExecutions
          : [];
        // Re-apply the decision against freshly-read state by exact call ID. A
        // precommit that started after the idle read carries a new call ID that
        // is absent from the confirmed-abandon set, so it can never be swept
        // here; one that settled normally in the meantime is simply gone from
        // pending. This membership filter replaces the age re-check because the
        // confirmed set already encodes the engine-liveness (or age-fallback)
        // phantom decision made against a consistent read above.
        const targetPending = pending.filter(
          (item) => item?.callID && abandonCallIDs.has(item.callID),
        );
        if (targetPending.length === 0) throw new Error(NOTHING_TO_ABANDON);
        let next = current;
        for (const item of targetPending) {
          const result = abandonStaleExecution(next, { callID: item?.callID, messageID });
          if (!result.ok) {
            // Another writer may have settled this exact precommit already;
            // skip it rather than abort the whole abandon transition.
            if (result.reason === "no-matching-stale-execution") continue;
            throw new Error(`autonomous abandon rejected: ${result.reason}`);
          }
          next = result.lifecycle;
        }
        return next;
      });
    } catch (error) {
      // The precommit settled normally between the idle read and this write, so
      // there is nothing stale to recover; let the caller fall through.
      if (String(error?.message || error).includes(NOTHING_TO_ABANDON)) return false;
      throw error;
    }
    dedup.set(sessionID, key);
    const prompt =
      settled?.phase === "awaiting-artifact-review"
        ? AUTONOMOUS_ARTIFACT_RECOVERY_PROMPT
        : AUTONOMOUS_REPLAN_PROMPT;
    await internalAutomation.continue({ sessionID, text: prompt });
    log(`autonomous abandon of [${staleCallIDs.join(", ")}] routed to ${settled?.phase} for ${sessionID}`);
    return true;
  }

  return false;
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

// FIX-2: the addressed artifact is a claim parked in awaiting-artifact-rereview.
// This runs the one exit: a real isolated re-review bound to the exact
// addressed bytes and judged against the preserved original findings. A
// reviewer transport or contract failure is recorded fail-closed as a consumed
// repair round rather than thrown, so the parked state can never silently pass
// or leave the generation dangling on an infrastructure error.
async function runArtifactRereview(adapter, sessionID, expected, lifecycle, artifact) {
  const digest = digestPlan(artifact);
  let review = null;
  let failureReason = null;
  // Commit C: a thrown reviewer-machinery failure (review stays null) is retried up
  // to MACHINERY_RETRIES times before falling closed, so a transient hiccup does not
  // burn a repair round on a possibly-fine artifact. A RETURNED review — any verdict,
  // including non-pass — is a real result and ends the loop immediately (never retried).
  // Still exactly one recordArtifactRereview per call; default 0 retries ⇒ single try.
  for (let attempt = 0; attempt <= MACHINERY_RETRIES && review === null; attempt++) {
    try {
      review = await adapter.review({
        sessionID,
        contract: lifecycle.taskContract || "",
        acceptanceCriteria: lifecycle.acceptanceCriteria || [],
        submission: { kind: "artifact", content: artifact, digest },
        rereview: { reviewID: lifecycle.pendingReview.reviewID },
      });
    } catch (error) {
      failureReason = error?.message || String(error);
    }
  }
  return await persistCurrentTransition(adapter, sessionID, expected, (current) =>
    recordArtifactRereview(current, artifact, {
      ...(review ? { review } : { failureReason }),
      reviewedDigest: digest,
      ...(REVIEW_ROUNDS_CAP_OVERRIDE
        ? { roundsCap: REVIEW_ROUNDS_CAP_OVERRIDE }
        : {}),
    }),
  );
}

function rereviewOutcomeText(recorded) {
  if (recorded.phase === "artifact-reviewed")
    return "The addressed artifact passed an independent re-review against the original findings. This task generation is closed; begin a new routed task before further implementation.";
  if (recorded.phase === "declined")
    return `No completion claim is authorized. The bounded repair rounds are exhausted without a passing re-review and this task is durably declined: ${recorded.reviewDecline?.detail || "the re-review did not pass"}. Report the failure honestly instead of retrying.`;
  return `No completion claim is authorized. The independent re-review did not pass: ${recorded.artifactReviewFailure?.reason || "the re-review found unresolved gaps"}. Repair within the approved scope, record fresh verification evidence, and call task_quality_artifact_checkpoint again.`;
}

function rereviewToolResult(recorded) {
  // The exact pass title is load-bearing: the completion-claim gates authorize
  // a completion only on "Artifact review recorded" + completionAuthorized.
  if (recorded.phase === "artifact-reviewed") {
    return {
      title: "Artifact review recorded",
      output: rereviewOutcomeText(recorded),
      metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, artifactDigest: recorded.reviewedArtifact.digest, completionAuthorized: true, reviewID: recorded.addressReceipt.reviewID, reportDigest: recorded.addressReceipt.reportDigest, deliveryMessageID: recorded.addressReceipt.deliveryMessageID, reviewRounds: recorded.reviewRounds } },
    };
  }
  if (recorded.phase === "declined") {
    return {
      title: "Artifact review declined",
      output: rereviewOutcomeText(recorded),
      metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, completionAuthorized: false, reviewRounds: recorded.reviewRounds, declineReason: recorded.reviewDecline?.reason || null } },
    };
  }
  return {
    title: "Artifact re-review found gaps",
    output: rereviewOutcomeText(recorded),
    metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, completionAuthorized: false, reviewRounds: recorded.reviewRounds } },
  };
}

async function captureTerminalArtifact(adapter, input) {
  const snapshot = normalizeSnapshot(await adapter.get(input.sessionID));
  const lifecycle = snapshot.data;
  if (
    lifecycle?.phase === "awaiting-artifact-rereview" &&
    lifecycle.pendingReview?.kind === "artifact"
  ) {
    // FIX-2: a parked re-review is recovered through the checkpoint tool with
    // the exact addressed artifact; a fresh prose turn must not double-address
    // or stand in for the missing verdict.
    return {
      handled: true,
      visibleText:
        "The addressed artifact is parked awaiting its independent re-review. Call task_quality_artifact_checkpoint again with the exact addressed artifact so the re-review can run. No completion claim is authorized yet.",
    };
  }
  const isPendingRepair =
    lifecycle?.pendingReview?.kind === "artifact" &&
    lifecycle.pendingReview.delivery?.messageID === input.parentMessageID;
  if (isPendingRepair) {
    const artifact = boundedText(input.text, "addressed terminal artifact");
    const expected = taskIdentity(lifecycle);
    const addressed = await persistCurrentTransition(adapter, input.sessionID, expected, (current) =>
      recordAddressedArtifact(current, artifact),
    );
    // FIX-2: addressing the findings is a claim, not a verdict — the builder
    // can never self-terminate the review. Run the real re-review now.
    const recorded = await runArtifactRereview(adapter, input.sessionID, expected, addressed, artifact);
    return { handled: true, visibleText: rereviewOutcomeText(recorded) };
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
  experimental_internal_automation: internalAutomation,
}) => {
  const adapter = withRouteObservability(
    createLifecycleAdapter(
      client,
      experimental_task_quality,
      configuredReviewerCandidates(POLICY).map(({ agent }) => ({ agent })),
    ),
    log,
  );
  const active = Boolean(adapter && adapter.canReview && policyIsValid());
  // The engine invokes experimental.text.complete after a text part is
  // streamed but before that part is durably finalized. This response-local
  // latch covers the exact response that receives a denied checkpoint even
  // if denial persistence loses a CAS race and a subsequent read is stale.
  const completionDenied = new Set();
  // FIX-3: per-session escalation for the actionable completion-gate
  // interceptions. Two blocks in the same phase with no state change means the
  // legible three-part guidance is not landing, so the third block switches to
  // imperative numbered steps. Any phase change / legal progress (a different
  // interception key, a non-actionable posture, or an authorized completion)
  // clears the counter, so it only ever tracks a genuine same-phase stall.
  const interceptionEscalation = new Map();
  const noteInterception = (sessionID, key) => {
    const prior = interceptionEscalation.get(sessionID);
    const count = prior && prior.key === key ? prior.count + 1 : 1;
    interceptionEscalation.set(sessionID, { key, count });
    return count;
  };
  // Terminal-start decides whether a response is private before any text can
  // stream. Remember that exact assistant message so terminal handling must
  // explicitly choose safe replacement text before the engine may release it.
  const heldTerminalCandidates = new Set();
  const heldTerminalKey = (input) => `${input.sessionID}\u0000${input.messageID}`;
  // The engine gives experimental.text.complete no parent linkage, but
  // terminal-start (which precedes text completion for the same assistant
  // message) does. Remember each assistant message's parent so the completion
  // gate can recognize the one response that IS the addressed plan
  // captureTerminalPlan is about to record: rewriting that response would
  // destroy the plan in both the transcript and the durable record.
  const terminalParentByMessage = new Map();
  const rememberTerminalParent = (input) => {
    if (!input?.messageID) return;
    const key = heldTerminalKey(input);
    terminalParentByMessage.delete(key);
    terminalParentByMessage.set(key, input.parentMessageID);
    if (terminalParentByMessage.size > 512)
      terminalParentByMessage.delete(
        terminalParentByMessage.keys().next().value,
      );
  };
  // A failed plan checkpoint has no durable lifecycle phase to inspect. Keep
  // a response-local denial so the model cannot turn the failed tool result
  // into a false "checkpoint recorded" claim. A later external user turn
  // clears it and can retry routing/checkpointing normally.
  const planCheckpointDenied = new Set();
  // One recovery continuation per durable CRAP report. If the engine restarts,
  // the in-memory cap resets and the still-pending durable review can be
  // safely retried; it never authorizes completion on its own.
  const artifactRecoveryContinuation = new Map();
  // F3: one autonomous road-back continuation per durable state (keyed by grant
  // generation or the sorted stale call ids). Same restart semantics as above -
  // the in-memory cap resets on restart and the still-frozen durable state can
  // be safely retried; it never authorizes completion on its own.
  const autonomousContinuation = new Map();
  // Finding-1 carry-forward: a direct-task child carries TWO engine clocks. The
  // admission grant (directTaskParent) proves child->parent provenance but dies
  // 30 minutes after the child is spawned; the execution binding
  // (beginDirectTaskExecution) is minted when a mutating tool STARTS and stays
  // settleable for the 2h settle window. preexecute correctly starts tracking
  // under the still-valid grant, but persisted can fire >30min later for a
  // long-running subagent tool - by then directTaskParent returns undefined and
  // lifecycleOwner resolves the child to ITSELF, so captureReceipt(child) reads
  // a null snapshot, drops the receipt, and the precommit never settles (the
  // stale-precommit sweep then abandons genuinely-completed work). Settlement
  // must therefore ride the binding, not the grant. The engine exposes no
  // non-consuming binding->parent peek, so remember the resolved owner the
  // instant beginDirectTaskExecution admits the execution and read it back at
  // settlement, keeping the receipt path independent of grant expiry while the
  // binding still lives. Consumed on settle; bounded like terminalParentByMessage.
  const directTaskExecutionOwner = new Map();
  const executionOwnerKey = (input) => `${input.sessionID} ${input.callID}`;
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
        if (loaded.lifecycle?.phase === "awaiting-artifact-rereview") {
          // FIX-2: the addressed claim is parked pending its bound verdict.
          output.system.push(
            "An addressed artifact is parked awaiting its independent re-review against the original findings. Call task_quality_artifact_checkpoint again with the exact addressed artifact so the re-review can run. Do not mutate further or claim completion until it returns completionAuthorized=true.",
          );
          return;
        }
        if (loaded.lifecycle?.pendingReview?.kind === "artifact") {
          output.system.push("A complete plain-language artifact review was delivered in a fresh synthetic user turn. Repair and verify within the already approved scope, producing at least one newly settled post-report receipt, then call task_quality_artifact_checkpoint again with the addressed artifact. Completion remains closed until that succeeds.");
          return;
        }
        if (loaded.lifecycle?.phase === "artifact-review-failed" && hasCurrentApproval(loaded.lifecycle)) {
          // FIX-2: a repairable non-pass round keeps the approval binding
          // intact — the builder repairs in place instead of restarting.
          output.system.push(
            "The previous artifact re-review round found gaps and the existing approval remains valid for repair. Fix the identified gaps within the approved scope, record fresh verification evidence, and call task_quality_artifact_checkpoint again with the repaired artifact. Do not claim completion.",
          );
          return;
        }
        if (loaded.lifecycle?.phase === "awaiting-artifact-review") {
          output.system.push(
            "Task-quality artifact review is required for the previously approved task. Use task_quality_artifact_checkpoint with the completed artifact and its exact acceptance evidence. Do not checkpoint a new plan or claim completion unless that tool returns title 'Artifact review recorded' with taskQuality.completionAuthorized=true.",
          );
          return;
        }
        // FIX-A (smoke3 wedge): awaiting-approval and approved previously fell
        // through to the planning-era text below, which told an already-past-
        // planning builder to "repair the plan" and checkpoint again — stale
        // guidance that steered it back into the plan tool.
        if (loaded.lifecycle?.phase === "awaiting-approval") {
          output.system.push(
            AUTONOMOUS_MODE
              ? "The current plan generation is already checkpointed and durably recorded. Do not call task_quality_checkpoint again and do not mutate the workspace yet. In autonomous mode this plan will be approved automatically and you will then be prompted to implement it. Present the recorded plan and do not wait for a human go/no-go; the engine still blocks workspace mutation until that approval is recorded."
              : "The current plan generation is already checkpointed and durably recorded; it now awaits the user's explicit go/no-go. Do not call task_quality_checkpoint again and do not mutate the workspace. Present the recorded plan and wait for a later, explicit user-authored approval; only that approval opens implementation.",
          );
          return;
        }
        if (loaded.lifecycle?.phase === "approved") {
          output.system.push(
            "The recorded plan is approved: implementation is authorized within the approved scope. Do not call task_quality_checkpoint again for this generation. Build and verify against the recorded acceptance criteria, then call task_quality_artifact_checkpoint with the completed artifact and its exact acceptance evidence.",
          );
          output.system.push(
            "Completion-claim gate: you must not state or imply that work is complete, recorded, shipped, verified, or successful unless task_quality_artifact_checkpoint returned title 'Artifact review recorded' with taskQuality.completionAuthorized=true. Any 'found gaps', 'not recorded', or denied result authorizes only a failure report and a new routed follow-up.",
          );
          return;
        }
        output.system.push(
          [
            "## Task-quality lifecycle — required gate",
            "This is a qualifying routed task. Preserve the existing planning/review skills and repair the plan. Use task_quality_checkpoint with that repaired plan and concrete acceptance criteria whenever the provider can call it. A fully terminal prose-only plan is independently captured and reviewed by the engine; it is never an approval bypass. Do not claim a plan is saved unless the lifecycle records it.",
            AUTONOMOUS_MODE
              ? "In autonomous mode the recorded plan will be approved automatically and you will be prompted to implement it; do not wait for a human go/no-go. The engine still blocks workspace mutation until that exact plan generation is approved."
              : "Show the repaired plan to the user and wait for a later, explicit user-authored go/no-go. The engine blocks workspace mutation until that exact plan generation is approved.",
          ].join(" "),
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

    event: async (input) => {
      try {
        if (!active || input?.event?.type !== "session.idle") return;
        const sessionID = input.event.properties?.sessionID;
        if (typeof sessionID !== "string" || !sessionID) return;
        const lifecycle = normalizeSnapshot(await adapter.get(sessionID)).data;
        // F3: in the unattended loop, a stranded approval or a phantom precommit
        // has no human to unblock it. These two additive road-back edges fire on
        // idle (turn ended, no tool running) before the artifact-recovery path,
        // and each moves the state to a legitimately-authorized posture. Default
        // OFF leaves the interactive human path untouched.
        if (AUTONOMOUS_MODE) {
          try {
            const advanced = await advanceAutonomousLifecycle({
              adapter,
              sessionID,
              lifecycle,
              internalAutomation,
              dedup: autonomousContinuation,
            });
            if (advanced) return;
          } catch (error) {
            // A road-back write failing must not become a completion or unblock
            // mutation; the state stays exactly as fail-closed as it was and a
            // later idle retries once the durable state changes.
            log(`autonomous road-back error for ${sessionID}: ${error?.message || error}`);
            return;
          }
        }
        const pending = lifecycle?.pendingReview;
        if (
          pending?.kind !== "artifact" ||
          typeof pending.reviewID !== "string" ||
          !pending.delivery?.messageID
        ) {
          artifactRecoveryContinuation.delete(sessionID);
          return;
        }
        // The parked re-review phase has a different legal exit than an open
        // repair (a byte-exact resubmission of the addressed artifact, not an
        // updated one), so both the prompt and the dedup key are phase-aware:
        // one continuation per review posture, still bounded because posture
        // changes require real durable lifecycle transitions.
        const parked = lifecycle?.phase === "awaiting-artifact-rereview";
        const continuationKey = `${pending.reviewID}:${parked ? "rereview" : "repair"}`;
        if (artifactRecoveryContinuation.get(sessionID) === continuationKey)
          return;
        if (typeof internalAutomation?.continue !== "function") {
          log(`artifact CRAP recovery unavailable for ${sessionID}: engine internal automation bridge is missing`);
          return;
        }
        artifactRecoveryContinuation.set(sessionID, continuationKey);
        try {
          await internalAutomation.continue({
            sessionID,
            text: parked
              ? CRAP_PARKED_REREVIEW_RECOVERY_PROMPT
              : CRAP_ARTIFACT_RECOVERY_PROMPT,
          });
          log(`artifact CRAP recovery continuation queued for ${sessionID}`);
        } catch (error) {
          // The durable review remains pending and the cap remains set. Retrying
          // on every idle event would create an unbounded internal loop; a later
          // lifecycle change is required before another continuation can run.
          throw error;
        }
      } catch (error) {
        log(`artifact CRAP recovery error: ${error?.message || error}`);
      }
    },

    "experimental.task_quality.terminal.start": async (input, output) => {
      if (!active || !input?.sessionID || !input?.parentMessageID || !output)
        return;
      rememberTerminalParent(input);
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
        // Autonomous fail-closed hold. In autonomous mode the approval was
        // minted internally (recordAutonomousApproval) with a synthetic
        // messageID that can never equal the engine's continuation-turn
        // parentMessageID, so the messageID-bound checks above would let a
        // bare "I'm done" narration slip through unheld. FIX-B: hold a
        // completion narration in EVERY work-owing phase (AUTONOMOUS_HOLD_PHASES),
        // not just approved / awaiting-artifact-review - otherwise a bare "done"
        // in planning / awaiting-approval / awaiting-plan-repair / rereview /
        // review-failed also slips through unheld. The version guard means a
        // null or legacy lifecycle (an ordinary non-task conversation turn) is
        // never held. This only ADDS holds; it never removes the power-B teeth.
        const autonomousUnbound =
          AUTONOMOUS_MODE &&
          lifecycle?.version === 1 &&
          AUTONOMOUS_HOLD_PHASES.has(lifecycle.phase);
        if (
          approvalBound ||
          artifactReviewBound ||
          artifactRepairBound ||
          autonomousUnbound
        ) {
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
        // MAJOR-#1 (iter-2 Road-2). FIX-B widened the completion hold to cover
        // the plan-side phases (planning / awaiting-plan-repair). When the
        // isolated PLAN review returns non-pass it THROWS out of
        // captureTerminalPlan (adapter.review), landing here. Every OTHER held
        // exit in this handler releases the held completion with a road back;
        // this one alone used to return unreleased, stranding a held completion
        // in a phase whose only idle re-drive is the plan-repair trigger - the
        // exact stop-and-strand the demote exists to kill. Release it with the
        // phase's road back plus the reviewer's own reason, so the stop still
        // carries a concrete, actionable way forward ("every stop must include a
        // road back"). Gated on AUTONOMOUS_MODE so the interactive path stays
        // byte-identical: there, this catch is only ever reached with held=false
        // (no messageID-bound hold covers the plan-side phases), so this branch
        // never fires and the pre-demote behavior is preserved exactly.
        if (held && AUTONOMOUS_MODE && output && typeof output.text === "string") {
          let heldPhase;
          try {
            heldPhase = normalizeSnapshot(await adapter.get(input.sessionID)).data?.phase;
          } catch {
            heldPhase = undefined;
          }
          output.text = `${autonomousHoldRoadback(heldPhase)} Review detail: ${error?.message || error}`;
          output.release = true;
        }
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
          // FIX-B: the hold now spans plan-side phases, so in autonomous mode
          // the road back must name the checkpoint the CURRENT phase actually
          // owes. Read the phase fresh; a read failure falls back to the generic
          // artifact-review guidance (autonomousHoldRoadback's default), never
          // to no road back. When AUTONOMOUS_MODE is OFF this fall-through can
          // still be reached with held=true (e.g. approvalBound + a terminal
          // narration that is not an artifact), so emit the exact pre-demote
          // string there to keep the interactive path byte-identical.
          if (AUTONOMOUS_MODE) {
            let heldPhase;
            try {
              heldPhase = normalizeSnapshot(await adapter.get(input.sessionID)).data?.phase;
            } catch {
              heldPhase = undefined;
            }
            output.text = autonomousHoldRoadback(heldPhase);
          } else {
            output.text =
              "Completion is not eligible for artifact review yet because the required execution proof is missing or still unsettled. Complete and settle the required work, then retry the final artifact review.";
          }
          output.release = true;
        }
      } catch (error) {
        if (String(error?.message || error).includes(POST_REPORT_RECEIPT_REQUIRED)) {
          // A plain-language CRAP report is meant to be actionable. Preserve
          // its pending lifecycle state when the builder merely narrated a
          // response, then let the bounded idle continuation request real
          // post-report proof. The explicit checkpoint path already has this
          // behavior; terminal capture must not close the generation first.
          completionDenied.delete(input.sessionID);
          if (output && typeof output.text === "string")
            output.text =
              "Artifact review feedback is still pending repair. Run your verification so a NEW post-report execution or verification receipt settles - re-sending text without a new receipt will be rejected - then call task_quality_artifact_checkpoint with the addressed artifact. No completion claim is authorized yet.";
          if (held && output && typeof output.text === "string") output.release = true;
          log(`terminal artifact repair remains pending: ${error?.message || error}`);
          return;
        }
        // Every repair-precondition guard (unresolved execution, missing
        // post-report receipt, byte-identical resubmission without a fresh
        // verification receipt) throws before any lifecycle transition
        // persists, so the pending artifact review survives intact. Mirror
        // the explicit checkpoint path: a still-open pending review is a
        // repairable omission, never grounds for closing the generation.
        try {
          const current = normalizeSnapshot(await adapter.get(input.sessionID)).data;
          if (current?.pendingReview?.kind === "artifact") {
            completionDenied.delete(input.sessionID);
            if (output && typeof output.text === "string")
              output.text = `No completion claim is authorized; the pending artifact review remains open: ${error?.message || error}`;
            if (held && output && typeof output.text === "string") output.release = true;
            log(`terminal artifact repair remains pending: ${error?.message || error}`);
            return;
          }
        } catch (recheckError) {
          log(`terminal artifact pending recheck error: ${recheckError?.message || recheckError}`);
        }
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
      let denied = completionDenied.has(input.sessionID);
      let awaiting = false;
      let settling = false;
      let pendingPlan = false;
      let pendingArtifact = false;
      let repairableFailed = false;
      let rereviewParked = false;
      let roundsExhausted = false;
      // FIX-3: hoisted so the actionable branches below can read the pending
      // review report / reviewHistory that feeds the interception excerpt.
      let lifecycle = null;
      // FIX-C2 (review finding on FIX-C): decided here, applied BEFORE every
      // rewrite branch below - including both denial latches. A latched
      // denial (completionDenied from an artifact mis-call during plan
      // repair, or planCheckpointDenied from a failed plan checkpoint) must
      // not destroy the one response captureTerminalPlan is about to record.
      let addressedPlanResponse = false;
      try {
        lifecycle = normalizeSnapshot(await adapter.get(input.sessionID)).data;
        if (lifecycle?.phase === "artifact-review-failed") {
          // FIX-2: an intact approval binding means a repairable re-review
          // round, not a closed generation — the messages must not conflate
          // the two or the builder restarts work the approval still covers.
          if (hasCurrentApproval(lifecycle)) repairableFailed = true;
          else denied = true;
        }
        if (lifecycle?.phase === "awaiting-artifact-rereview") rereviewParked = true;
        if (lifecycle?.phase === "declined" && lifecycle.reviewDecline) roundsExhausted = true;
        if (lifecycle?.phase === "awaiting-artifact-review") awaiting = true;
        if (lifecycle?.revocationPending) settling = true;
        if (lifecycle?.pendingReview?.kind === "plan") {
          // FIX-C (smoke3 wedge): when this response is part of the message
          // that answers the delivered plan review — its terminal parent
          // (stashed at terminal-start; text.complete itself carries no
          // parent) is the review-delivery message — captureTerminalPlan is
          // about to record that message's text as the addressed plan.
          // Rewriting any of its text parts here would replace the model's
          // actual repaired plan with interception boilerplate in both the
          // transcript and the durable record, and the checkpoint would then
          // approve the boilerplate. Pass every part through untouched.
          const terminalParent = terminalParentByMessage.get(
            heldTerminalKey(input),
          );
          // Mirrors recordAddressedPlan's eligibility guard exactly: capture
          // refuses to record while a revocation is pending or execution is
          // unsettled, so the pass-through must not outrank the rewrites in
          // those states either — otherwise the response streams clean but is
          // never durably recorded.
          addressedPlanResponse =
            lifecycle.phase === "awaiting-plan-repair" &&
            !lifecycle.revocationPending &&
            !hasUnsettledExecution(lifecycle) &&
            Boolean(terminalParent) &&
            terminalParent === lifecycle.pendingReview.delivery?.messageID;
          if (!addressedPlanResponse) pendingPlan = true;
        }
        if (lifecycle?.pendingReview?.kind === "artifact") pendingArtifact = true;
      } catch (error) {
        // The per-turn latch is enough for an immediately preceding denial;
        // never replace unrelated text merely because a later read failed.
        log(`completion gate state read error: ${error?.message || error}`);
      }
      // FIX-C2: the addressed-plan pass-through outranks EVERY rewrite,
      // latched or lifecycle-derived. Fail-closed is preserved: reaching here
      // requires a successful state read plus an exact engine-assigned
      // parent match to the durably recorded review delivery, so a failed
      // read or a non-addressed response still falls through to the latch
      // and cascade branches below unchanged.
      if (addressedPlanResponse) {
        interceptionEscalation.delete(input.sessionID);
        return;
      }
      if (planCheckpointDenied.has(input.sessionID)) {
        interceptionEscalation.delete(input.sessionID);
        // F4 de-contradiction: in autonomous mode there is no human to "ask for
        // GO", so the interactive dead-end wording would strand the agent. The
        // demote reframes it as a road back (fix and re-checkpoint) without
        // weakening any gate — the plan still has to record before work.
        output.text = AUTONOMOUS_MODE
          ? "The plan checkpoint was not recorded, so there is no approved plan to build from yet. This is a road back, not a stop: resolve the routing or lifecycle failure and call the plan checkpoint again. Once it records, work continues automatically."
          : "The plan checkpoint was not recorded, so no implementation or approval is authorized. Resolve the routing or lifecycle failure and checkpoint the plan successfully before asking for GO.";
        return;
      }
      // FIX-3: the five actionable postures below share one legible three-part
      // interception (STATE / NEXT ACTION / REVIEW FINDINGS) and an escalation
      // counter (noteInterception): a third consecutive block in the same phase
      // collapses NEXT ACTION into imperative numbered steps. The three
      // non-actionable postures (roundsExhausted, denied, settling) and the
      // clean pass-through clear the counter so it only tracks a same-phase
      // stall. Branch precedence is preserved exactly.
      if (rereviewParked) {
        output.text = interceptionMessage(
          "rereviewParked",
          lifecycle,
          noteInterception(input.sessionID, "rereviewParked") >= 3,
        );
        return;
      }
      if (repairableFailed) {
        output.text = interceptionMessage(
          "repairableFailed",
          lifecycle,
          noteInterception(input.sessionID, "repairableFailed") >= 3,
        );
        return;
      }
      if (roundsExhausted) {
        interceptionEscalation.delete(input.sessionID);
        output.text = "The bounded artifact repair rounds are exhausted without a passing re-review, and this task is durably declined. No completion claim is authorized; report the failure honestly and escalate to the user.";
        return;
      }
      if (denied) {
        interceptionEscalation.delete(input.sessionID);
        output.text = "Artifact review was denied or found gaps. No completion claim is authorized. This task generation is closed; route a repaired follow-up as a new task.";
        return;
      }
      if (settling) {
        interceptionEscalation.delete(input.sessionID);
        output.text = "An earlier execution is still settling under the durable task-quality lifecycle. No new mutation or completion claim is authorized until its exact receipt or permission rejection is recorded.";
        return;
      }
      if (pendingPlan) {
        output.text = interceptionMessage(
          "pendingPlan",
          lifecycle,
          noteInterception(input.sessionID, "pendingPlan") >= 3,
        );
        return;
      }
      if (pendingArtifact) {
        output.text = interceptionMessage(
          "pendingArtifact",
          lifecycle,
          noteInterception(input.sessionID, "pendingArtifact") >= 3,
        );
        return;
      }
      if (awaiting) {
        output.text = interceptionMessage(
          "awaiting",
          lifecycle,
          noteInterception(input.sessionID, "awaiting") >= 3,
        );
        return;
      }
      interceptionEscalation.delete(input.sessionID);
      return;
    },

    "tool.execute.admission": async (input, output) => {
      try {
        if (!active) {
          if (input.capability !== "read")
            Object.assign(output, {
              decision: "deny",
              reason:
                "Task quality requires the engine matching this Agent Omega release before mutating tools may run.",
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
            args: input.args,
            immutableOracles: IMMUTABLE_ORACLES,
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
        // Grant is valid HERE (begin just succeeded). Remember the parent so
        // settlement survives grant expiry (see directTaskExecutionOwner note).
        directTaskExecutionOwner.set(executionOwnerKey(input), owner.sessionID);
        if (directTaskExecutionOwner.size > 512)
          directTaskExecutionOwner.delete(
            directTaskExecutionOwner.keys().next().value,
          );
      }
      await markExecutionStarted(adapter, input, owner.sessionID);
    },

    "tool.execute.persisted": async (input, output) => {
      try {
        if (!active) return;
        // Settle the mutation precommit WITHOUT depending on the admission grant
        // and WITHOUT consuming the execution binding before the receipt is
        // durably filed. Two failure modes are closed here:
        //  (1) grant expiry - a subagent tool that finishes >30min after the
        //      child spawned no longer has a live directTaskParent grant, so
        //      lifecycleOwner would resolve the child to itself and drop the
        //      receipt. Resolve the owner from the carry-forward stash captured
        //      at preexecute (grant-independent, rides the 2h binding instead).
        //  (2) ordering race - the old consuming resolver deleted the
        //      child->parent liveness binding BEFORE the receipt was written; a
        //      stale-precommit sweep in that window saw no live child, misread
        //      the just-completed subagent as a phantom, and abandoned real
        //      work. File the receipt FIRST, then retire the binding, so any
        //      concurrent sweep in the write window still sees the child live.
        const key = executionOwnerKey(input);
        const stashedOwner = directTaskExecutionOwner.get(key);
        const ownerSessionID =
          typeof stashedOwner === "string" && stashedOwner
            ? stashedOwner
            : (
                await lifecycleOwner(
                  adapter,
                  experimental_task_quality,
                  input.sessionID,
                )
              ).sessionID;
        const ownsBinding =
          ownerSessionID !== input.sessionID &&
          typeof experimental_task_quality?.takeDirectTaskExecution ===
            "function";
        try {
          await captureReceipt(adapter, input, output, ownerSessionID);
        } finally {
          // Retire the one-shot binding and stash entry so a replayed persisted
          // delivery cannot re-settle. Doing this in finally (not only on
          // success) means a captureReceipt error still releases the binding
          // rather than leaving a completed child masquerading as live for the
          // full 2h settle window and masking a later genuine phantom.
          directTaskExecutionOwner.delete(key);
          if (ownsBinding)
            experimental_task_quality.takeDirectTaskExecution(
              input.sessionID,
              input.callID,
            );
        }
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
                "The installed engine cannot run and persist an isolated task-quality review. Install the engine matching this Agent Omega release before continuing a qualifying change.",
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
            // FIX-B (smoke3 wedge): a redundant plan checkpoint after the plan
            // is already recorded (or already approved) previously fell into
            // the reviewer + eligibility path, whose throw latched a denial
            // and told the model "No implementation is authorized" right
            // after its GO — a false rebuff that deadlocked the session.
            // Redirect truthfully instead; no review runs and no latch is set.
            if (lifecycle.phase === "awaiting-approval") {
              planCheckpointDenied.delete(context.sessionID);
              return {
                title: "Plan already recorded",
                output: AUTONOMOUS_MODE
                  ? `Plan generation ${lifecycle.generation} is already durably recorded. Do not call this checkpoint again for this generation. In autonomous mode it will be approved automatically and you will be prompted to implement it — do not wait for a human go/no-go.`
                  : `Plan generation ${lifecycle.generation} is already durably recorded and awaits the user's explicit go/no-go. Do not call this checkpoint again for this generation; present the recorded plan and wait for a user-authored approval.`,
                metadata: { taskQuality: { phase: lifecycle.phase, generation: lifecycle.generation } },
              };
            }
            if (lifecycle.phase === "approved") {
              planCheckpointDenied.delete(context.sessionID);
              return {
                title: "Plan already approved",
                output: `Plan generation ${lifecycle.generation} is approved: implementation is already authorized within the approved scope. Do not checkpoint a plan again; build and verify against the recorded acceptance criteria, then call task_quality_artifact_checkpoint with the completed artifact and its exact acceptance evidence.`,
                metadata: { taskQuality: { phase: lifecycle.phase, generation: lifecycle.generation } },
              };
            }
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
                output: AUTONOMOUS_MODE
                  ? `Repaired plan generation ${recorded.generation} is recorded after the durably delivered review. In autonomous mode it will be approved automatically and you will be prompted to implement it. Do not call an implementation tool until that approval prompt arrives, and do not wait for a human go/no-go.`
                  : `Repaired plan generation ${recorded.generation} is recorded after the durably delivered review. Show this exact plan to the user and wait for an explicit go/no-go before any implementation tool call.`,
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
              output: AUTONOMOUS_MODE
                ? `Repaired plan generation ${recorded.generation} is recorded. In autonomous mode it will be approved automatically and you will be prompted to implement it. Do not call an implementation tool until that approval prompt arrives, and do not wait for a human go/no-go.`
                : `Repaired plan generation ${recorded.generation} is recorded. Show this exact plan to the user and wait for an explicit go/no-go before any implementation tool call.`,
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
              output: AUTONOMOUS_MODE
                ? `The plan could not be recorded, so there is nothing approved to build from yet. Fix the failure and call the plan checkpoint again to continue: ${error?.message || error}`
                : `No implementation is authorized: ${error?.message || error}`,
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
                "The installed engine cannot run and persist an isolated artifact review. Install the engine matching this Agent Omega release before continuing.",
            };
          try {
            const artifact = boundedText(args.artifact, "artifact");
            const lifecycle = normalizeSnapshot(
              await adapter.get(context.sessionID),
            ).data;
            if (
              lifecycle?.phase === "awaiting-artifact-rereview" &&
              lifecycle.pendingReview?.kind === "artifact"
            ) {
              // FIX-2 recovery: the artifact was durably addressed but its
              // re-review verdict never persisted (e.g. a crash between the
              // two transitions). Re-run the re-review idempotently against
              // the exact addressed bytes; different bytes must not slip in
              // under the parked round.
              if (hasUnsettledExecution(lifecycle))
                throw new Error("unresolved execution evidence blocks artifact re-review");
              if (digestPlan(artifact) !== lifecycle.rereview?.addressedDigest)
                throw new Error("re-review recovery requires resubmitting the exact addressed artifact");
              const expected = taskIdentity(lifecycle);
              const recorded = await runArtifactRereview(adapter, context.sessionID, expected, lifecycle, artifact);
              if (recorded.phase === "artifact-reviewed") completionDenied.delete(context.sessionID);
              else completionDenied.add(context.sessionID);
              return rereviewToolResult(recorded);
            }
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
              const addressed = await persistCurrentTransition(adapter, context.sessionID, expected, (current) => recordAddressedArtifact(current, artifact));
              // FIX-2: addressing the findings is a claim, not a verdict. The
              // parked claim closes only through a real bound re-review.
              const recorded = await runArtifactRereview(adapter, context.sessionID, expected, addressed, artifact);
              if (recorded.phase === "artifact-reviewed") completionDenied.delete(context.sessionID);
              else completionDenied.add(context.sessionID);
              return rereviewToolResult(recorded);
            }
            // v2 self-review SELECT/swap on the model's ACTUAL single-function code, BEFORE the artifact is graded.
            // Fully defensive (never throws, never blocks); a no-op with code untouched whenever the task is not a
            // cleanly-identified single function or no certified improvement exists. Improves code on disk; the
            // artifact-review flow below is unchanged.
            const selfReview = await maybeSelfReviewSwap(lifecycle, context);
            const srNote = selfReviewNote(selfReview);
            const srMeta = selfReview && selfReview.ran
              ? { swapped: !!selfReview.swapped, fnName: selfReview.fnName || null, swapReason: selfReview.swapReason || null }
              : null;
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
                output: "The complete plain-language artifact review was durably queued as a fresh user turn. Completion is not authorized until it is repaired, verified, and checkpointed again." + srNote,
                metadata: { taskQuality: { phase: recorded.phase, generation: recorded.generation, completionAuthorized: false, reviewID: review.plainReport.reviewID, reportDigest: review.plainReport.reportDigest, reviewedDigest: review.submission.digest, deliveryMessageID: delivery.messageID, receiptWatermark: recorded.pendingReview.receiptWatermark, selfReview: srMeta } },
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
              output: (passed
                ? "The final artifact review is durably recorded. This task generation is closed; begin a new routed task before further implementation."
                : "The isolated artifact review found gaps or was blocked. This task generation is closed; route a repaired follow-up as a new task before further implementation.") + srNote,
              metadata: {
                taskQuality: {
                  phase: recorded.phase,
                  generation: recorded.generation,
                  artifactDigest: recorded.reviewedArtifact?.digest || null,
                  completionAuthorized: passed,
                  selfReview: srMeta,
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
