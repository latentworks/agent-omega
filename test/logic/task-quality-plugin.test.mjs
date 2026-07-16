import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TaskQualityPlugin } from "../../config-template/opencode/task-quality/index.js";
import {
  buildRouteHandoff,
  clearRouteHandoff,
  digestText,
  recordRouteHandoff,
} from "../../config-template/opencode/task-quality/handoff.mjs";
import { recordReceipt } from "../../config-template/opencode/task-quality/lifecycle.mjs";

function fakeClient() {
  const states = new Map();
  const directTaskParents = new Map();
  const directTaskExecutions = new Map();
  let lastState = null;
  let beforeUpdate = null;
  let reviewHandler = null;
  const reviews = [];
  const continuations = [];
  const deliveries = [];
  const deliveryByReview = new Map();
  let failResumeAfterDelivery = false;
  let failNextContinuation = false;
  return {
    reviews,
    client: {
      session: {
        taskQuality: {
          async review(input) {
            reviews.push(input);
            return {
              data: {
                route: {
                  kind: "crap",
                  model: { providerID: "local", modelID: "model" },
                },
                submission: {
                  kind: input.submission.kind,
                  digest: digestText(input.submission.content),
                },
                review: {
                  status: "complete",
                  result: {
                    verdict: "pass",
                    summary: "checked",
                    findings: [],
                    dispositions: [],
                  },
                },
              },
            };
          },
        },
      },
    },
    internal: {
      async get(sessionID) {
        return states.get(sessionID) || null;
      },
      async update(input) {
        if (beforeUpdate) {
          const callback = beforeUpdate;
          beforeUpdate = null;
          await callback({
            input,
            current: states.get(input.sessionID) || null,
            set(next) {
              lastState = next;
              states.set(input.sessionID, next);
            },
          });
        }
        const current = states.get(input.sessionID) || {
          revision: 0,
          generation: 0,
          data: null,
        };
        if (
          input.expectedRevision !== current.revision ||
          input.expectedGeneration !== current.generation
        ) {
          const error = new Error("CAS conflict");
          error.status = 409;
          throw error;
        }
        lastState = {
          revision: current.revision + 1,
          generation: input.generation,
          data: input.data,
        };
        states.set(input.sessionID, lastState);
        return lastState;
      },
      async review(input) {
        reviews.push(input);
        if (reviewHandler) return await reviewHandler(input);
        return {
          route: {
            kind: "crap",
            model: { providerID: "local", modelID: "model" },
          },
          submission: {
            kind: input.submission.kind,
            digest: digestText(input.submission.content),
          },
          review: {
            status: "complete",
            // A current engine binds a re-review verdict to the exact
            // requested review identity; the adapter fails closed without it.
            ...(input.rereview
              ? { rereview: { reviewID: input.rereview.reviewID } }
              : {}),
            result: {
              verdict: "pass",
              summary: "checked",
              findings: [],
              dispositions: [],
            },
          },
        };
      },
      async resumeWithReview(input) {
        const current = states.get(input.sessionID);
        const reportDigest = current?.data?.pendingReview?.reportDigest;
        let receipt = deliveryByReview.get(input.reviewID);
        if (!receipt) {
          receipt = { ...input, reportDigest, messageID: `msg-review-${deliveryByReview.size + 1}` };
          deliveryByReview.set(input.reviewID, receipt);
          deliveries.push(input);
        }
        if (failResumeAfterDelivery) {
          failResumeAfterDelivery = false;
          throw new Error("delivery response lost after durable write");
        }
        return receipt;
      },
      directTaskParent(sessionID) {
        return directTaskParents.get(sessionID)?.parentSessionID;
      },
      directTaskGrant(sessionID) {
        return directTaskParents.get(sessionID);
      },
      beginDirectTaskExecution(sessionID, callID) {
        const grant = directTaskParents.get(sessionID);
        if (grant)
          directTaskExecutions.set(`${sessionID}:${callID}`, grant.parentSessionID);
        return grant?.parentSessionID;
      },
      takeDirectTaskExecution(sessionID, callID) {
        const key = `${sessionID}:${callID}`;
        const parentID = directTaskExecutions.get(key);
        directTaskExecutions.delete(key);
        return parentID;
      },
    },
    automation: {
      async continue(input) {
        continuations.push(input);
        if (failNextContinuation) {
          failNextContinuation = false;
          throw new Error("internal continuation unavailable");
        }
      },
    },
    state: (sessionID) =>
      sessionID ? states.get(sessionID) || null : lastState,
    grantDirectTaskChild: (childID, parentID, parentTaskCallID = "parent-task") =>
      directTaskParents.set(childID, { parentSessionID: parentID, parentTaskCallID }),
    beforeNextUpdate: (callback) => {
      beforeUpdate = callback;
    },
    setReview: (callback) => {
      reviewHandler = callback;
    },
    failNextResumeAfterDelivery: () => {
      failResumeAfterDelivery = true;
    },
    failNextContinuation: () => {
      failNextContinuation = true;
    },
    deliveries,
    continuations,
  };
}

test("plugin takes one router handoff through review, exact external go, and engine admission", async () => {
  const sessionID = "ses-plugin";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(
    buildRouteHandoff({
      sessionID,
      messageID: "msg-task",
      messages: ["Build a robust feature"],
      skillNames: ["brainstorming"],
    }),
  );
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });

  const system = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, system);
  assert.match(system.system.join("\n"), /qualifying routed task/);
  assert.equal(fake.state().data.phase, "planning");

  const premature = { decision: "allow" };
  await hooks["tool.execute.admission"](
    {
      sessionID,
      tool: "edit",
      callID: "call-before",
      args: {},
      source: "builtin",
      capability: "mutate",
    },
    premature,
  );
  assert.equal(premature.decision, "deny");

  const checkpoint = await hooks.tool.task_quality_checkpoint.execute(
    {
      repaired_plan: "1. Make the change.\n2. Run the proof.",
      acceptance_criteria: [
        "The real surface works.",
        "The focused proof passes.",
      ],
    },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.match(checkpoint.output, /generation 2/);
  assert.equal(fake.reviews.length, 1);
  assert.equal(fake.reviews[0].submission.kind, "plan");
  assert.ok(fake.reviews[0].submission.digest);
  assert.deepEqual(fake.reviews[0].reviewers, [
    { agent: "helper2" },
    { agent: "helper1" },
  ]);
  assert.equal(fake.state().data.phase, "awaiting-approval");
  assert.equal(
    fake.state().data.repairedPlan.digest,
    digestText("1. Make the change.\n2. Run the proof."),
  );
  assert.equal(fake.state().data.planReview.route.model, "local/model");

  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-internal", origin: "internal-subagent" },
    { parts: [{ type: "text", text: "go for it" }] },
  );
  assert.equal(fake.state().data.phase, "awaiting-approval");
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "Ship it." }] },
  );
  assert.equal(fake.state().data.phase, "approved");
  assert.equal(fake.state().data.approval.generation, fake.state().generation);

  const admitted = { decision: "deny" };
  await hooks["tool.execute.admission"](
    {
      sessionID,
      tool: "edit",
      callID: "call-after",
      args: {},
      source: "builtin",
      capability: "mutate",
    },
    admitted,
  );
  assert.equal(admitted.decision, "allow");

  const reviewCountBeforeMissingReceipt = fake.reviews.length;
  const blockedArtifact =
    await hooks.tool.task_quality_artifact_checkpoint.execute(
      { artifact: "This must not invoke a reviewer without evidence." },
      { sessionID, directory: ".", worktree: ".", metadata() {} },
    );
  assert.match(blockedArtifact.output, /receipt is required/);
  assert.equal(fake.reviews.length, reviewCountBeforeMissingReceipt);

  // This is a real plugin hook delivery, not a direct lifecycle helper call.
  // It proves a completed tool output creates only a bounded receipt before an
  // explicit engine-reviewed artifact checkpoint may close the generation.
  await hooks["tool.execute.preexecute"](
    { sessionID, tool: "bash", callID: "call-proof", capability: "mutate" },
    {},
  );
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-proof", completedAt: 50 },
    {
      title: "ignored",
      output: "focused proof passed",
      metadata: { path: "C:\\private" },
    },
  );
  assert.equal(fake.state().data.receipts.length, 1);
  assert.deepEqual(Object.keys(fake.state().data.receipts[0]).sort(), [
    "callID",
    "capturedAt",
    "kind",
    "outputBytes",
    "outputDigest",
    "tool",
  ]);
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-artifact-follow-up", origin: "external-user" },
    { parts: [{ type: "text", text: "Run the final artifact review now without further workspace changes." }] },
  );
  assert.equal(fake.state().data.phase, "awaiting-artifact-review");
  const artifact = await hooks.tool.task_quality_artifact_checkpoint.execute(
    {
      artifact:
        "Implemented the approved change and observed the focused proof pass.",
    },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.match(artifact.output, /durably recorded/);
  assert.equal(fake.state().data.phase, "artifact-reviewed");
  clearRouteHandoff(sessionID);
});

test("checkpoint admission remains available without a lifecycle owner or direct-task grant", async () => {
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  const admission = { decision: "deny" };
  await hooks["tool.execute.admission"](
    {
      sessionID: "ses-control",
      tool: "task_quality_checkpoint",
      callID: "call-control",
      source: "plugin",
      capability: "unknown",
      trustedControl: "task_quality_checkpoint",
    },
    admission,
  );
  assert.equal(admission.decision, "allow");
});

test("persisted artifact follow-up survives qualifying router transform and blocks premature completion", async () => {
  const sessionID = "ses-artifact-follow-up-order";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change it.\n2. Prove it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "bash", callID: "call-proof", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-proof", completedAt: 50 },
    { output: "focused proof passed" },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-artifact", origin: "external-user" },
    { parts: [{ type: "text", text: "Run final artifact review now." }] },
  );
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-artifact", messages: ["Run final artifact review now."], skillNames: ["verification"] }));
  const transformed = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, transformed);
  assert.equal(fake.state().data.phase, "awaiting-artifact-review");
  assert.equal(fake.state().data.artifactReviewMessageID, "msg-artifact");
  assert.match(transformed.system.join("\n"), /artifact review is required/i);
  assert.doesNotMatch(transformed.system.join("\n"), /checkpoint with that repaired plan/i);
  const premature = { text: "Everything is complete and verified." };
  await hooks["experimental.text.complete"]({ sessionID, messageID: "msg-assistant", partID: "part-final" }, premature);
  assert.match(premature.text, /artifact review is still required/i);
  assert.doesNotMatch(premature.text, /everything is complete/i);
  clearRouteHandoff(sessionID);
});

test("a prose-only CRAP repair stays pending, receives one corrective continuation, and still needs a new receipt", async () => {
  const sessionID = "ses-crap-artifact-recovery";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
    experimental_internal_automation: fake.automation,
  });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change it.\n2. Prove it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "bash", callID: "call-initial-proof", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-initial-proof", completedAt: 50 },
    { output: "initial proof passed" },
  );
  const report = "Re-run the relevant verification after reviewing this artifact.";
  fake.setReview(async (input) => {
    if (input.rereview) {
      return {
        route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
        submission: { kind: input.submission.kind, digest: input.submission.digest },
        review: {
          status: "complete",
          rereview: { reviewID: input.rereview.reviewID },
          result: { verdict: "pass", summary: "findings addressed", findings: [], dispositions: [] },
        },
      };
    }
    return {
      route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
      submission: { kind: input.submission.kind, digest: input.submission.digest },
      review: {
        status: "complete",
        report,
        reportDigest: digestText(report),
        reviewID: "review-crap-artifact-recovery",
        completedAt: 60,
        toolCalls: 0,
      },
    };
  });
  const delivered = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: "Implemented the approved change and observed the initial proof pass." },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(delivered.title, "Artifact review delivered");
  const pending = fake.state(sessionID).data.pendingReview;
  assert.equal(pending.kind, "artifact");
  assert.ok(pending.delivery?.messageID);

  const terminalStart = {};
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-crap-reply", parentMessageID: pending.delivery.messageID },
    terminalStart,
  );
  assert.equal(terminalStart.hold, true);
  const terminal = { text: "I understand the report and will handle it." };
  await hooks["experimental.task_quality.terminal"](
    { sessionID, messageID: "msg-crap-reply", parentMessageID: pending.delivery.messageID, text: terminal.text },
    terminal,
  );
  assert.equal(fake.state(sessionID).data.phase, "approved");
  assert.equal(fake.state(sessionID).data.pendingReview.reviewID, "review-crap-artifact-recovery");
  assert.match(terminal.text, /still pending/i);

  const completedText = { text: "Everything is complete and verified." };
  await hooks["experimental.text.complete"]({ sessionID, messageID: "msg-crap-reply", partID: "part-final" }, completedText);
  assert.match(completedText.text, /pending repair/i);
  assert.doesNotMatch(completedText.text, /Everything is complete/i);

  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  assert.equal(fake.continuations.length, 1);
  assert.equal(fake.continuations[0].sessionID, sessionID);
  assert.match(fake.continuations[0].text, /Do not answer it in prose/i);

  await hooks["tool.execute.preexecute"]({ sessionID, tool: "bash", callID: "call-post-report-proof", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-post-report-proof", completedAt: 70 },
    { output: "post-report proof passed" },
  );
  const addressed = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: "Implemented the approved change and observed the post-report proof pass." },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(addressed.title, "Artifact review recorded");
  assert.equal(addressed.metadata.taskQuality.completionAuthorized, true);
  assert.equal(fake.reviews.at(-1).rereview?.reviewID, "review-crap-artifact-recovery");
  assert.equal(fake.state(sessionID).data.phase, "artifact-reviewed");
  assert.equal(fake.state(sessionID).data.addressReceipt.postReportReceiptCount, 1);
  assert.equal(fake.state(sessionID).data.reviewedArtifact.rereviewed, true);
  assert.equal(fake.state(sessionID).data.reviewRounds, 1);
  clearRouteHandoff(sessionID);
});

test("a failed CRAP recovery continuation stays capped and leaves the review pending", async () => {
  const sessionID = "ses-crap-recovery-fails-closed";
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
    experimental_internal_automation: fake.automation,
  });
  await fake.internal.update({
    sessionID,
    expectedRevision: 0,
    expectedGeneration: 0,
    generation: 1,
    data: {
      phase: "approved",
      pendingReview: {
        kind: "artifact",
        reviewID: "review-crap-recovery-fails-closed",
        delivery: { messageID: "msg-crap-recovery-report" },
      },
    },
  });
  fake.failNextContinuation();

  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

  assert.equal(fake.continuations.length, 1);
  assert.equal(fake.state(sessionID).data.phase, "approved");
  assert.equal(fake.state(sessionID).data.pendingReview.reviewID, "review-crap-recovery-fails-closed");
  assert.equal(fake.state(sessionID).data.addressReceipt, undefined);
});

test("a byte-identical terminal resubmission during pending repair preserves the review instead of closing the generation", async () => {
  const sessionID = "ses-terminal-byte-identical-repair";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
    experimental_internal_automation: fake.automation,
  });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change it.\n2. Prove it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "bash", callID: "call-initial-proof", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-initial-proof", completedAt: 50 },
    { output: "initial proof passed" },
  );
  const report = "Re-run the relevant verification after reviewing this artifact.";
  fake.setReview(async (input) => {
    if (input.rereview) {
      return {
        route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
        submission: { kind: input.submission.kind, digest: input.submission.digest },
        review: {
          status: "complete",
          rereview: { reviewID: input.rereview.reviewID },
          result: { verdict: "pass", summary: "findings addressed", findings: [], dispositions: [] },
        },
      };
    }
    return {
      route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
      submission: { kind: input.submission.kind, digest: input.submission.digest },
      review: {
        status: "complete",
        report,
        reportDigest: digestText(report),
        reviewID: "review-byte-identical-repair",
        completedAt: 60,
        toolCalls: 0,
      },
    };
  });
  const artifactText = "Implemented the approved change and observed the initial proof pass.";
  const delivered = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: artifactText },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(delivered.title, "Artifact review delivered");
  const pending = fake.state(sessionID).data.pendingReview;
  assert.equal(pending.kind, "artifact");

  // A post-report receipt from a non-verification tool passes the receipt
  // gate, so the byte-identical guard is the one that throws.
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "edit", callID: "call-post-report-edit", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "edit", callID: "call-post-report-edit", completedAt: 70 },
    { output: "edited the artifact source" },
  );
  const generationBefore = fake.state(sessionID).generation;
  const terminalStart = {};
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-identical-reply", parentMessageID: pending.delivery.messageID },
    terminalStart,
  );
  assert.equal(terminalStart.hold, true);
  const terminal = { text: artifactText };
  await hooks["experimental.task_quality.terminal"](
    { sessionID, messageID: "msg-identical-reply", parentMessageID: pending.delivery.messageID, text: artifactText },
    terminal,
  );
  assert.equal(fake.state(sessionID).data.phase, "approved");
  assert.equal(fake.state(sessionID).data.pendingReview.reviewID, "review-byte-identical-repair");
  assert.equal(fake.state(sessionID).data.artifactReviewFailure ?? null, null);
  assert.equal(fake.state(sessionID).generation, generationBefore);
  assert.match(terminal.text, /pending artifact review remains open/i);
  assert.match(terminal.text, /byte-identical/i);
  assert.doesNotMatch(terminal.text, /could not be recorded/i);
  const completedText = { text: "Everything is complete and verified." };
  await hooks["experimental.text.complete"]({ sessionID, messageID: "msg-identical-reply", partID: "part-final" }, completedText);
  assert.match(completedText.text, /pending repair/i);
  assert.doesNotMatch(completedText.text, /artifact review was denied/i);

  // The preserved state must remain genuinely repairable: with a fresh
  // verification receipt the same bytes settle through the re-review.
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "test", callID: "call-post-report-verify", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "test", callID: "call-post-report-verify", completedAt: 80 },
    { output: "verification passed against the unchanged artifact" },
  );
  const retryStart = {};
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-identical-retry", parentMessageID: pending.delivery.messageID },
    retryStart,
  );
  const retry = { text: artifactText };
  await hooks["experimental.task_quality.terminal"](
    { sessionID, messageID: "msg-identical-retry", parentMessageID: pending.delivery.messageID, text: artifactText },
    retry,
  );
  assert.equal(fake.state(sessionID).data.phase, "artifact-reviewed");
  assert.equal(fake.reviews.at(-1).rereview?.reviewID, "review-byte-identical-repair");
  assert.equal(fake.state(sessionID).data.reviewedArtifact.rereviewed, true);
  assert.equal(fake.state(sessionID).data.reviewRounds, 1);
  clearRouteHandoff(sessionID);
});

test("idle recovery in the parked re-review phase issues the byte-exact resubmission prompt", async () => {
  const sessionID = "ses-parked-rereview-recovery";
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
    experimental_internal_automation: fake.automation,
  });
  await fake.internal.update({
    sessionID,
    expectedRevision: 0,
    expectedGeneration: 0,
    generation: 1,
    data: {
      phase: "approved",
      pendingReview: {
        kind: "artifact",
        reviewID: "review-parked-recovery",
        delivery: { messageID: "msg-parked-report" },
      },
    },
  });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  assert.equal(fake.continuations.length, 1);
  assert.match(fake.continuations[0].text, /Do not answer it in prose/i);

  // The same pending review parking for its re-review is a new posture: the
  // prompt must switch to the truthful byte-exact instruction and fire once.
  await fake.internal.update({
    sessionID,
    expectedRevision: 1,
    expectedGeneration: 1,
    generation: 1,
    data: {
      phase: "awaiting-artifact-rereview",
      pendingReview: {
        kind: "artifact",
        reviewID: "review-parked-recovery",
        delivery: { messageID: "msg-parked-report" },
      },
      rereview: { addressedDigest: "digest-addressed" },
    },
  });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
  assert.equal(fake.continuations.length, 2);
  assert.match(fake.continuations[1].text, /awaiting-artifact-rereview/);
  assert.match(fake.continuations[1].text, /exact same addressed artifact bytes/i);
  assert.doesNotMatch(fake.continuations[1].text, /updated artifact/i);
});

test("scope transition survives router order while an execution settles and never revives mutation", async () => {
  const sessionID = "ses-pending-scope-order";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change it.\n2. Prove it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "write", callID: "call-write", capability: "mutate" }, {});
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-next", origin: "external-user" },
    { parts: [{ type: "text", text: "Now handle a different task." }] },
  );
  assert.equal(fake.state().data.revocationPending.messageID, "msg-next");
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-next", messages: ["Now handle a different task."], skillNames: ["debugging"] }));
  const transformed = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, transformed);
  assert.equal(fake.state().data.pendingExecutions.length, 1);
  assert.match(transformed.system.join("\n"), /waiting for an exact in-flight execution to settle/i);
  const admission = {};
  await hooks["tool.execute.admission"]({ sessionID, tool: "edit", callID: "call-new", capability: "mutate" }, admission);
  assert.equal(admission.decision, "deny");
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "write", callID: "call-write", completedAt: 51 },
    { output: "original call settled" },
  );
  assert.equal(fake.state().data.pendingExecutions.length, 0);
  assert.equal(fake.state().data.revocationPending, null);
  assert.equal(fake.state().data.phase, "awaiting-artifact-review");
  const afterSettlement = {};
  await hooks["tool.execute.admission"]({ sessionID, tool: "edit", callID: "call-after", capability: "mutate" }, afterSettlement);
  assert.equal(afterSettlement.decision, "deny");
  clearRouteHandoff(sessionID);
});

test("receipt-winning CAS race retries substantive revocation even when routing returns NONE", async () => {
  const sessionID = "ses-receipt-wins-revocation";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change it.\n2. Prove it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "write", callID: "call-write", capability: "mutate" }, {});
  fake.beforeNextUpdate(({ current, set }) => {
    const settled = recordReceipt(current.data, {
      callID: "call-write",
      tool: "write",
      kind: "tool",
      outputDigest: digestText("original call settled"),
      outputBytes: Buffer.byteLength("original call settled", "utf8"),
      capturedAt: 51,
    });
    set({ revision: current.revision + 1, generation: settled.generation, data: settled });
  });
  clearRouteHandoff(sessionID);
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-next", origin: "external-user" },
    { parts: [{ type: "text", text: "Now handle a different task." }] },
  );
  assert.equal(fake.state().data.phase, "awaiting-artifact-review");
  assert.equal(fake.state().data.artifactReviewMessageID, "msg-next");
  assert.equal(fake.state().data.pendingExecutions.length, 0);
  const admission = {};
  await hooks["tool.execute.admission"]({ sessionID, tool: "edit", callID: "call-new", capability: "mutate" }, admission);
  assert.equal(admission.decision, "deny");
  clearRouteHandoff(sessionID);
});

test("multiple receipt-winning CAS races cannot exhaust substantive revocation", async () => {
  const sessionID = "ses-multiple-receipts-win-revocation";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change it.\n2. Prove it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "write", callID: "call-write-a", capability: "mutate" }, {});
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "write", callID: "call-write-b", capability: "mutate" }, {});

  const settleBeforeUpdate = (callID, output, capturedAt, next) => ({ current, set }) => {
    const settled = recordReceipt(current.data, {
      callID,
      tool: "write",
      kind: "tool",
      outputDigest: digestText(output),
      outputBytes: Buffer.byteLength(output, "utf8"),
      capturedAt,
    });
    set({ revision: current.revision + 1, generation: settled.generation, data: settled });
    if (next) fake.beforeNextUpdate(next);
  };
  const settleB = settleBeforeUpdate("call-write-b", "second call settled", 52);
  fake.beforeNextUpdate(settleBeforeUpdate("call-write-a", "first call settled", 51, settleB));
  clearRouteHandoff(sessionID);
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-next", origin: "external-user" },
    { parts: [{ type: "text", text: "Now handle a different task." }] },
  );

  assert.equal(fake.state().data.phase, "awaiting-artifact-review");
  assert.equal(fake.state().data.artifactReviewMessageID, "msg-next");
  assert.equal(fake.state().data.pendingExecutions.length, 0);
  assert.equal(fake.state().data.receipts.length, 2);
  const admission = {};
  await hooks["tool.execute.admission"]({ sessionID, tool: "edit", callID: "call-new", capability: "mutate" }, admission);
  assert.equal(admission.decision, "deny");
  clearRouteHandoff(sessionID);
});

test("an incomplete engine artifact review is durably denied and cannot be narrated as recorded success", async () => {
  const sessionID = "ses-artifact-denial";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change it.\n2. Prove it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go for it" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "bash", callID: "call-proof", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-proof", completedAt: 50 },
    { output: "focused proof passed" },
  );
  fake.internal.review = async (input) => ({
    route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
    submission: { kind: input.submission.kind, digest: digestText(input.submission.content) },
    review: { status: "invalid_result", reason: "required structured final result was absent" },
  });
  const artifact = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: "Implemented the approved change and observed the focused proof pass." },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(artifact.title, "Artifact review denied");
  assert.match(artifact.output, /No completion claim is authorized/);
  assert.equal(artifact.metadata.taskQuality.completionAuthorized, false);
  assert.equal(fake.state().data.phase, "artifact-review-failed");
  assert.equal(fake.state().data.reviewedArtifact, null);
  assert.ok(fake.state().data.artifactReviewFailure?.digest);
  const completedText = { text: "Everything passed and the artifact review was recorded successfully." };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-assistant", partID: "part-final" },
    completedText,
  );
  assert.match(completedText.text, /artifact review was denied/i);
  assert.doesNotMatch(completedText.text, /recorded successfully/);
  clearRouteHandoff(sessionID);
});

test("checkpoint keeps provider-facing schemas simple but enforces bounded input at execution", async () => {
  const sessionID = "ses-bounded-input";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(
    buildRouteHandoff({
      sessionID,
      messageID: "msg-task",
      messages: ["Build a robust feature"],
      skillNames: ["brainstorming"],
    }),
  );
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  await hooks["experimental.chat.system.transform"](
    { sessionID },
    { system: [] },
  );

  const empty = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "Plan", acceptance_criteria: [] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.match(empty.output, /at least one acceptance criterion is required/);
  const oversized = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "x".repeat(24001), acceptance_criteria: ["Works"] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.match(oversized.output, /at most 24000 characters/);
  assert.equal(fake.reviews.length, 0);
  clearRouteHandoff(sessionID);
});

test("checkpoint fails before HSS when durable lifecycle is absent", async () => {
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  const result = await hooks.tool.task_quality_checkpoint.execute(
    {
      repaired_plan: "1. Do not review an unauthorized task.",
      acceptance_criteria: ["No reviewer is called."],
    },
    { sessionID: "ses-missing", directory: ".", worktree: ".", metadata() {} },
  );
  assert.match(result.output, /No durable qualifying task lifecycle exists/);
  assert.equal(fake.reviews.length, 0);
  const completedText = {
    text: "The checkpoint was recorded and the plan is ready for GO.",
  };
  await hooks["experimental.text.complete"](
    {
      sessionID: "ses-missing",
      messageID: "msg-assistant",
      partID: "part-final",
    },
    completedText,
  );
  assert.match(completedText.text, /plan checkpoint was not recorded/i);
  assert.doesNotMatch(completedText.text, /checkpoint was recorded/i);
  await hooks["chat.message.persisted"](
    { sessionID: "ses-missing", messageID: "msg-unknown-origin" },
    { parts: [{ type: "text", text: "Retry the plan." }] },
  );
  const unknownOriginText = { text: "The checkpoint was recorded." };
  await hooks["experimental.text.complete"](
    {
      sessionID: "ses-missing",
      messageID: "msg-unknown-origin-assistant",
      partID: "part-unknown-origin-final",
    },
    unknownOriginText,
  );
  assert.match(unknownOriginText.text, /plan checkpoint was not recorded/i);
  await hooks["chat.message.persisted"](
    {
      sessionID: "ses-missing",
      messageID: "msg-retry",
      origin: "external-user",
    },
    { parts: [{ type: "text", text: "Retry the plan." }] },
  );
  const retryText = { text: "I can retry the routing and checkpoint now." };
  await hooks["experimental.text.complete"](
    {
      sessionID: "ses-missing",
      messageID: "msg-retry-assistant",
      partID: "part-retry-final",
    },
    retryText,
  );
  assert.equal(retryText.text, "I can retry the routing and checkpoint now.");
});

test("checkpoint refuses to write an old plan after a new routed task replaces the lifecycle during HSS", async () => {
  const sessionID = "ses-plan-race";
  const first = buildRouteHandoff({
    sessionID,
    messageID: "msg-first",
    messages: ["Build the first feature"],
    skillNames: ["brainstorming"],
  });
  const second = buildRouteHandoff({
    sessionID,
    messageID: "msg-second",
    messages: ["Build a different feature"],
    skillNames: ["brainstorming"],
  });
  clearRouteHandoff(sessionID);
  recordRouteHandoff(first);
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  await hooks["experimental.chat.system.transform"](
    { sessionID },
    { system: [] },
  );
  const realReview = fake.internal.review;
  fake.internal.review = async (input) => {
    recordRouteHandoff(second);
    await hooks["experimental.chat.system.transform"](
      { sessionID },
      { system: [] },
    );
    return realReview(input);
  };

  const result = await hooks.tool.task_quality_checkpoint.execute(
    {
      repaired_plan: "1. Implement the first feature.",
      acceptance_criteria: ["The first feature works."],
    },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );

  assert.match(
    result.output,
    /routed task changed while the plan review was running/,
  );
  assert.equal(fake.state().data.taskMessageID, "msg-second");
  assert.equal(fake.state().data.phase, "planning");
  assert.equal(fake.state().data.repairedPlan, null);
  clearRouteHandoff(sessionID);
});

test("system transform waits for an attested delayed router decision before creating lifecycle", async () => {
  const sessionID = "ses-delayed-router";
  const handoff = buildRouteHandoff({
    sessionID,
    messageID: "msg-delayed",
    messages: ["Build a robust feature"],
    skillNames: ["brainstorming"],
  });
  let resolve;
  const decision = new Promise((done) => {
    resolve = done;
  });
  const fake = fakeClient();
  fake.internal.awaitRouteDecision = async (requested) => {
    assert.equal(requested, sessionID);
    return await decision;
  };
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  const system = { system: [] };
  const transforming = hooks["experimental.chat.system.transform"](
    { sessionID },
    system,
  );
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(fake.state(), null);
  resolve(handoff);
  await transforming;
  assert.equal(fake.state().data.phase, "planning");
  assert.match(system.system.join("\n"), /qualifying routed task/);
});

test("a standalone decision preserves approval, while a substantive follow-up routes into a fresh lifecycle", async () => {
  const sessionID = "ses-approved-decision";
  const task = buildRouteHandoff({
    sessionID,
    messageID: "msg-task",
    messages: ["Build a robust feature"],
    skillNames: ["brainstorming"],
  });
  const decision = buildRouteHandoff({
    sessionID,
    messageID: "msg-go",
    messages: ["GO."],
    skillNames: [],
  });
  const followUp = buildRouteHandoff({
    sessionID,
    messageID: "msg-oauth",
    messages: ["Go add OAuth login too."],
    skillNames: ["brainstorming"],
  });
  let next = task;
  const fake = fakeClient();
  fake.internal.awaitRouteDecision = async () => next;
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  await hooks["experimental.chat.system.transform"](
    { sessionID },
    { system: [] },
  );
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change.", acceptance_criteria: ["Works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "GO." }] },
  );
  assert.equal(fake.state().data.phase, "approved");
  const approvedIdentity = {
    taskKey: fake.state().data.taskKey,
    generation: fake.state().generation,
  };

  next = decision;
  await hooks["experimental.chat.system.transform"](
    { sessionID },
    { system: [] },
  );
  assert.equal(fake.state().data.phase, "approved");
  assert.equal(fake.state().data.taskKey, approvedIdentity.taskKey);
  assert.equal(fake.state().generation, approvedIdentity.generation);

  next = followUp;
  await hooks["experimental.chat.system.transform"](
    { sessionID },
    { system: [] },
  );
  assert.equal(fake.state().data.phase, "planning");
  assert.equal(fake.state().data.taskMessageID, "msg-oauth");
  assert.notEqual(fake.state().data.taskKey, approvedIdentity.taskKey);
});

test("a scope-changing go cannot approve an existing plan while the router ticket is unavailable", async () => {
  const sessionID = "ses-router-failure-approval";
  const task = buildRouteHandoff({
    sessionID,
    messageID: "msg-task",
    messages: ["Build the first feature"],
    skillNames: ["brainstorming"],
  });
  clearRouteHandoff(sessionID);
  recordRouteHandoff(task);
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    {
      repaired_plan: "1. Build the first feature.",
      acceptance_criteria: ["The first feature works."],
    },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(fake.state().data.phase, "awaiting-approval");

  // This is the router failure/cooldown shape: no replacement handoff reaches
  // the lifecycle, so the old plan must not be approved by a new scoped ask.
  fake.internal.awaitRouteDecision = async () => null;
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-scope-change", origin: "external-user" },
    { parts: [{ type: "text", text: "Go ahead and also delete B." }] },
  );
  assert.equal(fake.state().data.phase, "awaiting-approval");
  assert.equal(fake.state().data.approval, null);
  clearRouteHandoff(sessionID);
});

test("a new substantive task revokes approved work when routing returns NONE or fails", async () => {
  for (const routerOutcome of ["none", "failure"]) {
    const sessionID = `ses-approved-${routerOutcome}`;
    const task = buildRouteHandoff({
      sessionID,
      messageID: "msg-task-a",
      messages: ["Build task A"],
      skillNames: ["brainstorming"],
    });
    const fake = fakeClient();
    fake.internal.awaitRouteDecision = async () => task;
    const hooks = await TaskQualityPlugin({
      client: fake.client,
      experimental_task_quality: fake.internal,
    });
    await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
    await hooks.tool.task_quality_checkpoint.execute(
      { repaired_plan: "1. Build task A.", acceptance_criteria: ["Task A works."] },
      { sessionID, directory: ".", worktree: ".", metadata() {} },
    );
    await hooks["chat.message.persisted"](
      { sessionID, messageID: "msg-go-a", origin: "external-user" },
      { parts: [{ type: "text", text: "GO" }] },
    );
    assert.equal(fake.state().data.phase, "approved");

    const none = buildRouteHandoff({
      sessionID,
      messageID: "msg-task-b",
      messages: ["Build unrelated task B"],
      skillNames: [],
    });
    fake.internal.awaitRouteDecision =
      routerOutcome === "none"
        ? async () => none
        : async () => {
            throw new Error("classifier unavailable");
          };
    await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
    await hooks["chat.message.persisted"](
      { sessionID, messageID: "msg-task-b", origin: "external-user" },
      { parts: [{ type: "text", text: "Build unrelated task B" }] },
    );

    assert.equal(fake.state().data.phase, "planning");
    assert.equal(fake.state().data.repairedPlan, null);
    assert.equal(fake.state().data.approval, null);
    const admission = {};
    await hooks["tool.execute.admission"](
      { sessionID, tool: "bash", source: "builtin", capability: "mutate" },
      admission,
    );
    assert.equal(admission.decision, "deny");
  }
});

test("artifact denial latch dominates stale approved reads until a new plan is durably recorded", async () => {
  const sessionID = "ses-stale-artifact-denial";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({
    sessionID,
    messageID: "msg-task",
    messages: ["Build it"],
    skillNames: ["brainstorming"],
  }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change it.\n2. Prove it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go for it" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "bash", callID: "call-proof", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-proof", completedAt: 50 },
    { output: "focused proof passed" },
  );
  fake.internal.review = async (input) => ({
    route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
    submission: { kind: input.submission.kind, digest: digestText(input.submission.content) },
    review: { status: "invalid_result", reason: "required structured final result was absent" },
  });
  const update = fake.internal.update;
  fake.internal.update = async (input) => {
    if (input.data?.phase === "artifact-review-failed") throw new Error("denial persistence unavailable");
    return await update(input);
  };

  const artifact = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: "Implemented the approved change and observed the focused proof pass." },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(artifact.title, "Task-quality artifact review not recorded");
  // Both denial CAS attempts failed, so this is deliberately a stale durable
  // approval; the response-local denial latch must still suppress completion.
  assert.equal(fake.state().data.phase, "approved");
  const deniedText = { text: "Everything passed and the artifact review was recorded successfully." };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-assistant", partID: "part-final" },
    deniedText,
  );
  assert.match(deniedText.text, /artifact review was denied/i);
  assert.doesNotMatch(deniedText.text, /recorded successfully/);

  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-later-user", origin: "external-user" },
    { parts: [{ type: "text", text: "Rewrite the plan." }] },
  );
  const laterText = { text: "I will route the rewrite before making any further changes." };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-later-assistant", partID: "part-later" },
    laterText,
  );
  assert.match(laterText.text, /artifact review was denied/i);
  clearRouteHandoff(sessionID);
});

test("persisted permission rejection settles only the matching pending execution", async () => {
  const sessionID = "ses-plugin";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(
    buildRouteHandoff({
      sessionID,
      messageID: "msg-task",
      messages: ["Build a robust feature"],
      skillNames: ["brainstorming"],
    }),
  );
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  await hooks["experimental.chat.system.transform"](
    { sessionID },
    { system: [] },
  );
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Change.", acceptance_criteria: ["Works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go for it" }] },
  );
  await hooks["tool.execute.preexecute"](
    {
      sessionID,
      tool: "edit",
      callID: "call-permission",
      capability: "mutate",
    },
    {},
  );
  assert.equal(fake.state().data.pendingExecutions.length, 1);
  await hooks["tool.execute.permission_rejected"](
    { sessionID, tool: "edit", callID: "call-permission", rejectedAt: 60 },
    {},
  );
  assert.equal(fake.state().data.pendingExecutions.length, 0);
  clearRouteHandoff(sessionID);
});

test("a direct task child inherits its approved parent lifecycle and records receipts on that parent", async () => {
  const sessionID = "ses-parent";
  const childID = "ses-direct-child";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(
    buildRouteHandoff({
      sessionID,
      messageID: "msg-task",
      messages: ["Build a robust feature"],
      skillNames: ["brainstorming"],
    }),
  );
  const fake = fakeClient();
  fake.grantDirectTaskChild(childID, sessionID);
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  await hooks["experimental.chat.system.transform"](
    { sessionID },
    { system: [] },
  );
  await hooks.tool.task_quality_checkpoint.execute(
    {
      repaired_plan: "1. Delegate one direct task.",
      acceptance_criteria: ["The child write is recorded on the parent."],
    },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "GO." }] },
  );
  await hooks["tool.execute.preexecute"](
    {
      sessionID,
      tool: "task",
      callID: "parent-task",
      capability: "mutate",
    },
    {},
  );
  assert.equal(fake.state(sessionID).data.pendingExecutions.length, 1);

  const admission = { decision: "deny" };
  await hooks["tool.execute.admission"](
    {
      sessionID: childID,
      tool: "write",
      callID: "child-write",
      args: {},
      source: "builtin",
      capability: "mutate",
    },
    admission,
  );
  assert.equal(admission.decision, "allow");
  await hooks["tool.execute.preexecute"](
    {
      sessionID: childID,
      tool: "write",
      callID: "child-write",
      capability: "mutate",
    },
    {},
  );
  await hooks["tool.execute.persisted"](
    {
      sessionID: childID,
      tool: "write",
      callID: "child-write",
      completedAt: 70,
    },
    { title: "write", output: "proof written", metadata: {} },
  );
  assert.equal(fake.state(sessionID).data.pendingExecutions.length, 1);
  await hooks["tool.execute.persisted"](
    {
      sessionID,
      tool: "task",
      callID: "parent-task",
      completedAt: 71,
      attestedAgent: "independent-reviewer",
      attestedChildBuiltinReads: 1,
    },
    { title: "task", output: "child completed", metadata: {} },
  );
  assert.equal(fake.state(sessionID).data.pendingExecutions.length, 0);
  assert.equal(
    fake.state(sessionID).data.receipts.some((receipt) => receipt.callID === "child-write"),
    true,
  );
  assert.equal(
    fake.state(sessionID).data.receipts.find((receipt) => receipt.callID === "parent-task")?.agent,
    "independent-reviewer",
  );
  assert.equal(
    fake.state(sessionID).data.receipts.find((receipt) => receipt.callID === "parent-task")?.childBuiltinReads,
    1,
  );
  assert.equal(fake.state(childID), null);
  clearRouteHandoff(sessionID);
});

test("a generic caller-created child cannot borrow a parent lifecycle without an engine TaskTool grant", async () => {
  const sessionID = "ses-parent";
  const childID = "ses-forged-child";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(
    buildRouteHandoff({
      sessionID,
      messageID: "msg-task",
      messages: ["Build a robust feature"],
      skillNames: ["brainstorming"],
    }),
  );
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  await hooks["experimental.chat.system.transform"](
    { sessionID },
    { system: [] },
  );
  await hooks.tool.task_quality_checkpoint.execute(
    {
      repaired_plan: "1. Perform one approved task.",
      acceptance_criteria: ["Forged children remain blocked."],
    },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "GO." }] },
  );

  const admission = { decision: "allow" };
  await hooks["tool.execute.admission"](
    {
      sessionID: childID,
      tool: "write",
      callID: "forged-write",
      args: {},
      source: "builtin",
      capability: "mutate",
    },
    admission,
  );
  assert.equal(admission.decision, "deny");
  assert.equal(fake.state(sessionID).data.receipts.length, 0);
  clearRouteHandoff(sessionID);
});

test("mutation precommit failures reject execution instead of becoming best-effort logs", async () => {
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });

  await assert.rejects(
    () =>
      hooks["tool.execute.preexecute"](
        {
          sessionID: "ses-plugin",
          tool: "edit",
          callID: "call-missing",
          capability: "mutate",
        },
        {},
      ),
    /no durable task-quality lifecycle exists for mutation precommit/,
  );
});

test("plain CRAP report is delivered once as a fresh engine turn and the next checkpoint records the repair", async () => {
  const sessionID = "ses-plain-crap";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const report = "Break the retry loop. Preserve cobalt-17.";
  fake.setReview(async (input) => ({
    route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
    submission: { kind: input.submission.kind, digest: digestText(input.submission.content) },
    review: { status: "complete", report, reportDigest: digestText(report), reviewID: "review-plain-1", completedAt: 10, toolCalls: 2 },
  }));
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });

  const first = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Initial plan.", acceptance_criteria: ["It works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(first.title, "Plan review delivered");
  assert.doesNotMatch(first.output, /cobalt-17/);
  assert.deepEqual(fake.deliveries, [{ sessionID, reviewID: "review-plain-1" }]);
  assert.equal(fake.state(sessionID).data.pendingReview.delivery.messageID, "msg-review-1");

  const pendingSystem = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, pendingSystem);
  assert.match(pendingSystem.system.join("\n"), /untrusted feedback/i);
  const pendingAdmission = { decision: "allow" };
  await hooks["tool.execute.admission"](
    { sessionID, tool: "edit", callID: "call-review-injection", args: {}, source: "builtin", capability: "mutate" },
    pendingAdmission,
  );
  assert.equal(pendingAdmission.decision, "deny");

  const second = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Preserve cobalt-17.\n2. Repair the retry loop.", acceptance_criteria: ["It works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(second.title, "Repaired plan recorded");
  assert.equal(fake.deliveries.length, 1);
  assert.equal(fake.state(sessionID).data.phase, "awaiting-approval");
  assert.equal(fake.state(sessionID).data.addressReceipt.deliveryMessageID, "msg-review-1");
  clearRouteHandoff(sessionID);
});

test("plain CRAP delivery recovers the same durable message after the first response is lost", async () => {
  const sessionID = "ses-plain-crap-resume";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const report = "Preserve the retry ceiling after restart.";
  fake.setReview(async (input) => ({
    route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
    submission: { kind: input.submission.kind, digest: digestText(input.submission.content) },
    review: { status: "complete", report, reportDigest: digestText(report), reviewID: "review-resume-1", completedAt: 10, toolCalls: 0 },
  }));
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  fake.failNextResumeAfterDelivery();

  const interrupted = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Initial plan.", acceptance_criteria: ["It works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(interrupted.title, "Task-quality plan not recorded");
  assert.match(interrupted.output, /delivery response lost/);
  assert.equal(fake.state(sessionID).data.pendingReview.delivery, undefined);

  const recovered = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Initial plan.", acceptance_criteria: ["It works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(recovered.title, "Plan review delivered");
  assert.equal(fake.state(sessionID).data.pendingReview.delivery.messageID, "msg-review-1");
  assert.equal(fake.deliveries.length, 1);
  clearRouteHandoff(sessionID);
});

test("plain CRAP artifact review closes only after delivered feedback causes new receipt-backed work", async () => {
  const sessionID = "ses-plain-crap-artifact";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Build it.\n2. Verify it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "bash", callID: "call-initial", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-initial", completedAt: 20 },
    { output: "initial proof" },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-artifact", origin: "external-user" },
    { parts: [{ type: "text", text: "Run final artifact review now." }] },
  );
  const report = "Repair the overflow branch and rerun the proof.";
  fake.setReview(async (input) => {
    if (input.rereview) {
      return {
        route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
        submission: { kind: input.submission.kind, digest: input.submission.digest },
        review: {
          status: "complete",
          rereview: { reviewID: input.rereview.reviewID },
          result: { verdict: "pass", summary: "overflow repair verified", findings: [], dispositions: [] },
        },
      };
    }
    return {
      route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
      submission: { kind: input.submission.kind, digest: digestText(input.submission.content) },
      review: { status: "complete", report, reportDigest: digestText(report), reviewID: "review-artifact-1", completedAt: 30, toolCalls: 0 },
    };
  });
  const artifactText = "Implemented the approved change and observed the focused proof pass.";
  const first = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: artifactText },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(first.title, "Artifact review delivered");
  assert.equal(fake.state(sessionID).data.pendingReview.delivery.messageID, "msg-review-1");

  const premature = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: artifactText },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(premature.title, "Artifact repair not recorded");
  assert.match(premature.output, /newly settled post-report/);

  await hooks["tool.execute.preexecute"]({ sessionID, tool: "edit", callID: "call-repair", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "edit", callID: "call-repair", completedAt: 40 },
    { output: "overflow branch repaired" },
  );
  const identicalWithoutProof = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: artifactText },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(identicalWithoutProof.title, "Artifact repair not recorded");
  assert.match(identicalWithoutProof.output, /byte-identical resubmission needs at least one new verification receipt/);

  await hooks["tool.execute.preexecute"]({ sessionID, tool: "vitest", callID: "call-verify", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "vitest", callID: "call-verify", completedAt: 50 },
    { output: "proof rerun passed" },
  );
  const closed = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: artifactText },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(closed.title, "Artifact review recorded");
  assert.equal(closed.metadata.taskQuality.completionAuthorized, true);
  assert.equal(fake.reviews.at(-1).rereview?.reviewID, "review-artifact-1");
  assert.equal(fake.state(sessionID).data.phase, "artifact-reviewed");
  assert.equal(fake.state(sessionID).data.addressReceipt.postReportReceiptCount, 2);
  assert.equal(fake.state(sessionID).data.reviewRounds, 1);
  clearRouteHandoff(sessionID);
});

test("engine terminal hook records a fully persisted prose plan only for the routed parent", async () => {
  const sessionID = "ses-terminal-plan";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });

  await hooks["experimental.task_quality.terminal"]({
    sessionID,
    messageID: "msg-assistant-plan",
    parentMessageID: "msg-unrelated",
    text: "1. This must not become a plan.",
  });
  assert.equal(fake.state(sessionID).data.phase, "planning");
  assert.equal(fake.reviews.length, 0);

  await hooks["experimental.task_quality.terminal"]({
    sessionID,
    messageID: "msg-assistant-plan",
    parentMessageID: "msg-task",
    text: "1. Implement the change.\n2. Run the focused proof.",
  });
  assert.equal(fake.state(sessionID).data.phase, "awaiting-approval");
  assert.equal(fake.reviews.length, 1);
  assert.equal(fake.reviews[0].submission.kind, "plan");
  assert.match(fake.reviews[0].acceptanceCriteria.join("\n"), /scope drift/i);
  clearRouteHandoff(sessionID);
});

test("engine terminal hook holds and closes an explicit artifact-review follow-up", async () => {
  const sessionID = "ses-terminal-artifact";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Build it.\n2. Verify it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "bash", callID: "call-proof", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-proof", completedAt: 20 },
    { output: "proof passed" },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-final-review", origin: "external-user" },
    { parts: [{ type: "text", text: "Run final artifact review now." }] },
  );
  assert.equal(fake.state(sessionID).data.phase, "awaiting-artifact-review");
  const held = { hold: false };
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-artifact", parentMessageID: "msg-final-review" },
    held,
  );
  assert.equal(held.hold, true);
  await hooks["experimental.task_quality.terminal"]({
    sessionID,
    messageID: "msg-artifact",
    parentMessageID: "msg-final-review",
    text: "Implemented the approved change and the focused proof passed.",
  });
  assert.equal(fake.state(sessionID).data.phase, "artifact-reviewed");
  assert.equal(fake.reviews.at(-1).submission.kind, "artifact");
  clearRouteHandoff(sessionID);
});

test("engine terminal hook replaces an ineligible held completion with lifecycle feedback", async () => {
  const sessionID = "ses-terminal-ineligible-artifact";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Build it.\n2. Verify it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  const held = { hold: false };
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-artifact", parentMessageID: "msg-go" },
    held,
  );
  assert.equal(held.hold, true);
  const output = { text: "Everything is complete.", release: false };
  await hooks["experimental.task_quality.terminal"](
    { sessionID, messageID: "msg-artifact", parentMessageID: "msg-go", text: output.text },
    output,
  );
  assert.equal(output.release, true);
  assert.match(output.text, /not eligible for artifact review yet/i);
  assert.equal(fake.state(sessionID).data.phase, "approved");
  clearRouteHandoff(sessionID);
});

test("engine terminal artifact hold routes CRAP repair back through a new receipt before completion", async () => {
  const sessionID = "ses-terminal-crap-artifact";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Build it"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Build it.\n2. Verify it.", acceptance_criteria: ["Proof passes."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "go" }] },
  );
  await hooks["tool.execute.preexecute"]({ sessionID, tool: "bash", callID: "call-proof", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "bash", callID: "call-proof", completedAt: 20 },
    { output: "proof passed" },
  );

  const unrelated = { hold: false };
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-artifact", parentMessageID: "msg-unrelated" },
    unrelated,
  );
  assert.equal(unrelated.hold, false);
  const approvalBound = { hold: false };
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-artifact", parentMessageID: "msg-go" },
    approvalBound,
  );
  assert.equal(approvalBound.hold, true);

  const report = "Repair the overflow branch and rerun the proof.";
  fake.setReview(async (input) => {
    if (input.rereview) {
      return {
        route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
        submission: { kind: input.submission.kind, digest: input.submission.digest },
        review: {
          status: "complete",
          rereview: { reviewID: input.rereview.reviewID },
          result: { verdict: "pass", summary: "overflow repair verified", findings: [], dispositions: [] },
        },
      };
    }
    return {
      route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
      submission: { kind: input.submission.kind, digest: digestText(input.submission.content) },
      review: { status: "complete", report, reportDigest: digestText(report), reviewID: "review-terminal-artifact-1", completedAt: 30, toolCalls: 0 },
    };
  });
  const firstOutput = { text: "Implemented the approved change and the focused proof passed." };
  await hooks["experimental.task_quality.terminal"](
    { sessionID, messageID: "msg-artifact", parentMessageID: "msg-go", text: firstOutput.text },
    firstOutput,
  );
  assert.match(firstOutput.text, /feedback was delivered for repair/i);
  assert.equal(fake.state(sessionID).data.pendingReview.delivery.messageID, "msg-review-1");

  await hooks["tool.execute.preexecute"]({ sessionID, tool: "edit", callID: "call-repair", capability: "mutate" }, {});
  await hooks["tool.execute.persisted"](
    { sessionID, tool: "edit", callID: "call-repair", completedAt: 40 },
    { output: "overflow branch repaired" },
  );
  const repairBound = { hold: false };
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-repair", parentMessageID: "msg-review-1" },
    repairBound,
  );
  assert.equal(repairBound.hold, true);
  const repairedOutput = { text: "Repaired the overflow branch and reran the proof successfully." };
  await hooks["experimental.task_quality.terminal"](
    { sessionID, messageID: "msg-repair", parentMessageID: "msg-review-1", text: repairedOutput.text },
    repairedOutput,
  );
  assert.equal(fake.state(sessionID).data.phase, "artifact-reviewed");
  assert.equal(fake.state(sessionID).data.addressReceipt.postReportReceiptCount, 1);
  assert.equal(fake.reviews.at(-1).rereview?.reviewID, "review-terminal-artifact-1");
  assert.match(repairedOutput.text, /passed an independent re-review/i);
  clearRouteHandoff(sessionID);
});

// ---------------------------------------------------------------------------
// FIX-3: the completion gate's actionable interceptions must be legible - each
// must tell the builder the true STATE, the exact NEXT ACTION (literal
// checkpoint tool + its receipt/resubmission precondition), and the pending
// REVIEW FINDINGS - and must escalate to imperative numbered steps when the
// same phase intercepts a third consecutive time.
// ---------------------------------------------------------------------------

async function runCompletionGate(fake, hooks, sessionID, data, { generation = 1 } = {}) {
  const current = fake.state(sessionID);
  await fake.internal.update({
    sessionID,
    expectedRevision: current ? current.revision : 0,
    expectedGeneration: current ? current.generation : 0,
    generation,
    data,
  });
  const out = { text: "Everything is complete and verified; nothing is pending." };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: `${sessionID}-assistant`, partID: "part-final" },
    out,
  );
  return out.text;
}

test("FIX-3/A3.1: each actionable interception names its checkpoint tool and receipt/state requirement, and pending-artifact round-trips the findings excerpt", async () => {
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
    experimental_internal_automation: fake.automation,
  });

  const artifactReport =
    "Finding 1: parsePort returns null for the zero-padded input '003000'.\n" +
    "Finding 2: formatEndpoint drops the port when the port equals 1.\n" +
    "Required: repair both and re-run the port probes before re-review.";

  // 1) pendingArtifact - approved with an open artifact-review report pending repair.
  const pendingArtifactText = await runCompletionGate(fake, hooks, "ses-a31-pending-artifact", {
    version: 1,
    phase: "approved",
    pendingReview: { kind: "artifact", reviewID: "r-pa", report: artifactReport, delivery: { messageID: "m-pa" } },
  });
  assert.match(pendingArtifactText, /task_quality_artifact_checkpoint/);
  assert.match(pendingArtifactText, /new/i);
  assert.match(pendingArtifactText, /receipt/i);
  assert.match(pendingArtifactText, /pending repair/i);
  // Round-trip: the exact synthetic findings surface inside the interception.
  assert.ok(
    pendingArtifactText.includes(artifactReport),
    "pending-artifact interception must echo the review findings",
  );

  // 2) repairableFailed - artifact-review-failed with the approval still intact.
  const repairableReport = "Re-review gap: the lower-bound port case is still unhandled.";
  const repairableFailedText = await runCompletionGate(fake, hooks, "ses-a31-repairable", {
    version: 1,
    phase: "artifact-review-failed",
    generation: 1,
    repairedPlan: { generation: 1, digest: "plan-digest-a31" },
    approval: { generation: 1, planDigest: "plan-digest-a31" },
    reviewHistory: [{ report: repairableReport, disposition: "rereview-non-pass" }],
  });
  assert.match(repairableFailedText, /task_quality_artifact_checkpoint/);
  assert.match(repairableFailedText, /new/i);
  assert.match(repairableFailedText, /receipt/i);
  assert.ok(
    repairableFailedText.includes(repairableReport),
    "repairable interception must echo the last review findings from history",
  );

  // 3) rereviewParked - awaiting-artifact-rereview: no new receipt, byte-exact resubmit only.
  const parkedReport = "Parked findings: the re-review verdict never persisted for the addressed submission.";
  const rereviewParkedText = await runCompletionGate(fake, hooks, "ses-a31-parked", {
    version: 1,
    phase: "awaiting-artifact-rereview",
    pendingReview: { kind: "artifact", reviewID: "r-rp", report: parkedReport, delivery: { messageID: "m-rp" } },
    rereview: { addressedDigest: "digest-addressed" },
  });
  assert.match(rereviewParkedText, /task_quality_artifact_checkpoint/);
  assert.match(rereviewParkedText, /awaiting-artifact-rereview/);
  assert.match(rereviewParkedText, /exact same addressed artifact bytes/i);
  assert.ok(rereviewParkedText.includes(parkedReport));

  // 4) pendingPlan - awaiting-plan-repair: the PLAN checkpoint tool, not the artifact one.
  const planReport = "Plan finding: step 3 declares no acceptance check.";
  const pendingPlanText = await runCompletionGate(fake, hooks, "ses-a31-plan", {
    version: 1,
    phase: "awaiting-plan-repair",
    pendingReview: { kind: "plan", reviewID: "r-pp", report: planReport, delivery: { messageID: "m-pp" } },
  });
  assert.match(pendingPlanText, /task_quality_checkpoint/);
  assert.doesNotMatch(pendingPlanText, /task_quality_artifact_checkpoint/);
  assert.match(pendingPlanText, /repaired plan/i);
  assert.ok(pendingPlanText.includes(planReport));

  // 5) awaiting - approved task still needs its first independent review.
  const awaitingText = await runCompletionGate(fake, hooks, "ses-a31-awaiting", {
    version: 1,
    phase: "awaiting-artifact-review",
  });
  assert.match(awaitingText, /task_quality_artifact_checkpoint/);
  assert.match(awaitingText, /artifact review is still required/i);
  assert.match(awaitingText, /receipt/i);

  // While non-escalated (a single interception each), every actionable message
  // opens with STATE: and offers a single NEXT ACTION:, never numbered steps.
  for (const text of [pendingArtifactText, repairableFailedText, rereviewParkedText, pendingPlanText, awaitingText]) {
    assert.match(text, /^STATE:/);
    assert.match(text, /NEXT ACTION:/);
    assert.doesNotMatch(text, /Do exactly this, in order/);
  }
});

// ---------------------------------------------------------------------------
// FIX-C (smoke3 wedge): the completion gate must NOT rewrite the one response
// that answers the delivered plan review. That response's terminal parent
// (stashed at terminal-start) is the review-delivery message, and
// captureTerminalPlan records its text as the addressed plan - so an
// interception there replaces the model's actual repaired plan with
// boilerplate in both the transcript and the durable record.
// ---------------------------------------------------------------------------

test("FIX-C: the addressed-plan response passes through the completion gate untouched, while unrelated responses in the same phase are still intercepted", async () => {
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
    experimental_internal_automation: fake.automation,
  });
  const sessionID = "ses-fixc-addressed";
  await fake.internal.update({
    sessionID,
    expectedRevision: 0,
    expectedGeneration: 0,
    generation: 1,
    data: {
      version: 1,
      phase: "awaiting-plan-repair",
      pendingReview: { kind: "plan", reviewID: "r-fixc", report: "Plan finding: trim the input.", delivery: { messageID: "m-fixc-delivery" } },
    },
  });

  // The addressed-plan response: its terminal parent IS the review delivery.
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-fixc-addressed", parentMessageID: "m-fixc-delivery" },
    {},
  );
  const repairedPlan =
    "Repaired plan: trim the port input, validate with /^\\d+$/, accept only 1-65535, and prove it with a live probe round-trip.";
  const addressedOut = { text: repairedPlan };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-fixc-addressed", partID: "part-final" },
    addressedOut,
  );
  assert.equal(
    addressedOut.text,
    repairedPlan,
    "the addressed-plan response must reach captureTerminalPlan unrewritten",
  );

  // Control 1: a response whose terminal parent is NOT the review delivery is
  // an unrelated completion claim and must still be intercepted.
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-fixc-unrelated", parentMessageID: "m-some-other-turn" },
    {},
  );
  const unrelatedOut = { text: "All done; nothing is pending." };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-fixc-unrelated", partID: "part-final" },
    unrelatedOut,
  );
  assert.match(unrelatedOut.text, /^STATE:/);
  assert.match(unrelatedOut.text, /task_quality_checkpoint/);

  // Control 2: with no terminal-start stash at all (no parent linkage), the
  // gate keeps its existing fail-closed interception behavior.
  const unstashedOut = { text: "Everything is complete and verified; nothing is pending." };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-fixc-unstashed", partID: "part-final" },
    unstashedOut,
  );
  assert.match(unstashedOut.text, /^STATE:/);
  assert.match(unstashedOut.text, /task_quality_checkpoint/);
});

// ---------------------------------------------------------------------------
// FIX-C2 (review finding on FIX-C): the pass-through must outrank the latched
// denial rewrites too. A completionDenied latch (an artifact checkpoint
// mis-called during plan repair leaves it set - the catch only releases it
// when the pending review is an artifact) and a planCheckpointDenied latch (a
// failed plan checkpoint) both rewrote the addressed-plan response ahead of
// the FIX-C guard, recreating the exact smoke3 corruption through a sibling
// branch. The latches must still deny every UNRELATED response.
// ---------------------------------------------------------------------------

test("FIX-C2: latched denials must not rewrite the addressed-plan response, and still deny unrelated responses", async () => {
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
    experimental_internal_automation: fake.automation,
  });
  const sessionID = "ses-fixc2-latched";
  await fake.internal.update({
    sessionID,
    expectedRevision: 0,
    expectedGeneration: 0,
    generation: 1,
    data: {
      version: 1,
      phase: "awaiting-plan-repair",
      pendingReview: { kind: "plan", reviewID: "r-fixc2", report: "Plan finding: trim the input.", delivery: { messageID: "m-fixc2-delivery" } },
    },
  });

  // Door 1 - completionDenied: mis-call the ARTIFACT checkpoint while a plan
  // repair is owed. The eligibility throw latches the denial, and because the
  // pending review is a plan (not an artifact) the catch does not release it.
  const misCall = await hooks.tool.task_quality_artifact_checkpoint.execute(
    { artifact: "Premature completion claim during plan repair." },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.match(misCall.output, /No completion claim is authorized/);
  assert.equal(fake.state(sessionID).data.phase, "awaiting-plan-repair");

  const repairedPlan =
    "Repaired plan: trim the port input, validate with /^\\d+$/, accept only 1-65535, and prove it with a live probe round-trip.";
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-fixc2-addressed", parentMessageID: "m-fixc2-delivery" },
    {},
  );
  const addressedOut = { text: repairedPlan };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-fixc2-addressed", partID: "part-final" },
    addressedOut,
  );
  assert.equal(
    addressedOut.text,
    repairedPlan,
    "a latched completionDenied must not replace the addressed plan with denial boilerplate",
  );

  // Control: an unrelated response under the same latch is still denied.
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-fixc2-unrelated", parentMessageID: "m-some-other-turn" },
    {},
  );
  const unrelatedOut = { text: "All done; nothing else is pending." };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-fixc2-unrelated", partID: "part-final" },
    unrelatedOut,
  );
  assert.match(unrelatedOut.text, /No completion claim is authorized/);

  // Door 2 - planCheckpointDenied: a failed plan checkpoint latches the plan
  // denial; the addressed-plan response must outrank that latch too.
  const failed = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "Plan", acceptance_criteria: [] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.match(failed.output, /No implementation is authorized/);
  await hooks["experimental.task_quality.terminal.start"](
    { sessionID, messageID: "msg-fixc2-addressed-2", parentMessageID: "m-fixc2-delivery" },
    {},
  );
  const addressedOut2 = { text: repairedPlan };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-fixc2-addressed-2", partID: "part-final" },
    addressedOut2,
  );
  assert.equal(
    addressedOut2.text,
    repairedPlan,
    "a latched planCheckpointDenied must not replace the addressed plan with checkpoint boilerplate",
  );

  // Control: unrelated text with the plan latch set still gets its message.
  const unrelatedOut2 = { text: "Proceeding to implement now." };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-fixc2-unrelated-2", partID: "part-final" },
    unrelatedOut2,
  );
  assert.match(unrelatedOut2.text, /plan checkpoint was not recorded/);
});

// ---------------------------------------------------------------------------
// FIX-C2 hardening (converged review MINOR on 80a77c9): the pass-through must
// mirror recordAddressedPlan's full eligibility guard. awaiting-plan-repair
// with a pending revocation or unsettled execution is unreachable through the
// plugin's own transitions, but an externally corrupted durable record can
// present it; capture would refuse to record, so the response must not stream
// through clean and unrecorded - the rewrites still own it.
// ---------------------------------------------------------------------------

test("FIX-C2 hardening: an ineligible awaiting-plan-repair record never passes the addressed-plan response through", async () => {
  const corruptions = [
    {
      name: "revocationPending",
      extra: { revocationPending: { messageID: "m-revoke", requestedAt: 1 } },
      pattern: /still settling/,
    },
    {
      name: "unsettled execution",
      extra: { pendingExecutions: [{ callID: "call-orphan", tool: "bash", recordedAt: 1 }] },
      pattern: /STATE: awaiting-plan-repair/,
    },
  ];
  for (const corruption of corruptions) {
    const fake = fakeClient();
    const hooks = await TaskQualityPlugin({
      client: fake.client,
      experimental_task_quality: fake.internal,
      experimental_internal_automation: fake.automation,
    });
    const sessionID = `ses-fixc2-hardening-${corruption.name.replace(/\s+/g, "-")}`;
    await fake.internal.update({
      sessionID,
      expectedRevision: 0,
      expectedGeneration: 0,
      generation: 1,
      data: {
        version: 1,
        phase: "awaiting-plan-repair",
        pendingReview: { kind: "plan", reviewID: "r-fixc2-h", report: "Plan finding: trim the input.", delivery: { messageID: "m-fixc2-h-delivery" } },
        ...corruption.extra,
      },
    });
    await hooks["experimental.task_quality.terminal.start"](
      { sessionID, messageID: "msg-fixc2-h-addressed", parentMessageID: "m-fixc2-h-delivery" },
      {},
    );
    const out = { text: "Repaired plan: trim, validate, range-check 1-65535." };
    await hooks["experimental.text.complete"](
      { sessionID, messageID: "msg-fixc2-h-addressed", partID: "part-final" },
      out,
    );
    assert.notEqual(
      out.text,
      "Repaired plan: trim, validate, range-check 1-65535.",
      `${corruption.name}: capture would refuse this record, so the response must not pass through`,
    );
    assert.match(out.text, corruption.pattern, `${corruption.name}: the expected rewrite owns the response`);
  }
});

// ---------------------------------------------------------------------------
// FIX-A/FIX-B (smoke3 wedge): once the plan is recorded (awaiting-approval) or
// approved, the system guidance must describe the actual phase - not the
// planning-era "repair the plan" text - and a redundant plan checkpoint must
// redirect truthfully instead of spending a reviewer run, latching a denial,
// and rebuffing the model with "No implementation is authorized" after GO.
// ---------------------------------------------------------------------------

test("FIX-A: system guidance in awaiting-approval and approved matches the actual phase instead of planning-era text", async () => {
  const sessionID = "ses-fixa-guidance";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(
    buildRouteHandoff({
      sessionID,
      messageID: "msg-task",
      messages: ["Build a robust feature"],
      skillNames: ["brainstorming"],
    }),
  );
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Make the change.\n2. Run the proof.", acceptance_criteria: ["The real surface works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(fake.state().data.phase, "awaiting-approval");

  const awaitingSystem = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, awaitingSystem);
  const awaitingText = awaitingSystem.system.join("\n");
  assert.match(awaitingText, /already checkpointed and durably recorded/);
  assert.match(awaitingText, /go\/no-go/);
  assert.doesNotMatch(awaitingText, /qualifying routed task/);
  assert.doesNotMatch(awaitingText, /repair the plan/i);

  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "GO." }] },
  );
  assert.equal(fake.state().data.phase, "approved");

  const approvedSystem = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, approvedSystem);
  const approvedText = approvedSystem.system.join("\n");
  assert.match(approvedText, /implementation is authorized within the approved scope/);
  assert.match(approvedText, /Completion-claim gate/);
  assert.doesNotMatch(approvedText, /qualifying routed task/);
  assert.doesNotMatch(approvedText, /repair the plan/i);
  clearRouteHandoff(sessionID);
});

test("FIX-B: a redundant plan checkpoint after recording or approval redirects truthfully without a reviewer run or a denial latch", async () => {
  const sessionID = "ses-fixb-redirect";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(
    buildRouteHandoff({
      sessionID,
      messageID: "msg-task",
      messages: ["Build a robust feature"],
      skillNames: ["brainstorming"],
    }),
  );
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
  });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });
  await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Make the change.\n2. Run the proof.", acceptance_criteria: ["The real surface works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(fake.state().data.phase, "awaiting-approval");
  const reviewsAfterFirst = fake.reviews.length;

  // Redundant checkpoint while awaiting GO: truthful redirect, no reviewer run.
  const redundantAwaiting = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Make the change.\n2. Run the proof.", acceptance_criteria: ["The real surface works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(redundantAwaiting.title, "Plan already recorded");
  assert.match(redundantAwaiting.output, /go\/no-go/);
  assert.doesNotMatch(redundantAwaiting.output, /No implementation is authorized/);
  assert.equal(fake.reviews.length, reviewsAfterFirst, "a redundant checkpoint must not spend a reviewer run");
  assert.equal(fake.state().data.phase, "awaiting-approval");

  await hooks["chat.message.persisted"](
    { sessionID, messageID: "msg-go", origin: "external-user" },
    { parts: [{ type: "text", text: "GO." }] },
  );
  assert.equal(fake.state().data.phase, "approved");

  // The wedge: a redundant checkpoint right after GO must not rebuff the model.
  const redundantApproved = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Make the change.\n2. Run the proof.", acceptance_criteria: ["The real surface works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(redundantApproved.title, "Plan already approved");
  assert.match(redundantApproved.output, /task_quality_artifact_checkpoint/);
  assert.doesNotMatch(redundantApproved.output, /No implementation is authorized/);
  assert.equal(fake.reviews.length, reviewsAfterFirst);
  assert.equal(fake.state().data.phase, "approved");

  // No denial latch: the final response is not rewritten, and mutation
  // admission stays open under the intact approval.
  const out = { text: "Proceeding with the approved implementation now." };
  await hooks["experimental.text.complete"](
    { sessionID, messageID: "msg-after-go", partID: "part-final" },
    out,
  );
  assert.equal(out.text, "Proceeding with the approved implementation now.");
  const admitted = { decision: "deny" };
  await hooks["tool.execute.admission"](
    { sessionID, tool: "edit", callID: "call-impl", args: {}, source: "builtin", capability: "mutate" },
    admitted,
  );
  assert.equal(admitted.decision, "allow");
  clearRouteHandoff(sessionID);
});

test("FIX-3/A3.1: the review-findings excerpt is byte-bounded to 1 KB and marks truncation", async () => {
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
    experimental_internal_automation: fake.automation,
  });
  const longReport = "HEAD-MARK " + "x".repeat(4000);
  const text = await runCompletionGate(fake, hooks, "ses-a31-bounded", {
    version: 1,
    phase: "approved",
    pendingReview: { kind: "artifact", reviewID: "r-long", report: longReport, delivery: { messageID: "m-long" } },
  });
  const marker = "REVIEW FINDINGS (excerpt): ";
  const idx = text.indexOf(marker);
  assert.ok(idx >= 0, "the interception must include a findings excerpt");
  const excerpt = text.slice(idx + marker.length);
  assert.match(excerpt, /HEAD-MARK/);
  assert.match(excerpt, /\[\.\.\.\]$/);
  assert.ok(Buffer.byteLength(excerpt, "utf8") <= 1024, "excerpt must not exceed the 1 KB byte bound");
  assert.ok(
    Buffer.byteLength(excerpt, "utf8") < Buffer.byteLength(longReport, "utf8"),
    "a long report must actually be truncated",
  );
});

test("FIX-3/A3.2: a third consecutive same-phase interception escalates to numbered steps, and a phase change resets escalation", async () => {
  const fake = fakeClient();
  const hooks = await TaskQualityPlugin({
    client: fake.client,
    experimental_task_quality: fake.internal,
    experimental_internal_automation: fake.automation,
  });
  const sessionID = "ses-a32-escalation";
  const report = "Finding: the retry path still swallows the zero-padded port.";
  const pendingArtifactData = {
    version: 1,
    phase: "approved",
    pendingReview: { kind: "artifact", reviewID: "r-esc", report, delivery: { messageID: "m-esc" } },
  };
  await fake.internal.update({
    sessionID,
    expectedRevision: 0,
    expectedGeneration: 0,
    generation: 1,
    data: pendingArtifactData,
  });

  async function gate(messageID) {
    const out = { text: "Everything is complete and verified." };
    await hooks["experimental.text.complete"]({ sessionID, messageID, partID: "p" }, out);
    return out.text;
  }

  const first = await gate("m1");
  const second = await gate("m2");
  const third = await gate("m3");

  // The first two same-phase interceptions stay in the legible NEXT ACTION form.
  for (const text of [first, second]) {
    assert.match(text, /NEXT ACTION:/);
    assert.doesNotMatch(text, /Do exactly this, in order/);
  }
  // The third consecutive interception in the same phase escalates to steps.
  assert.doesNotMatch(third, /NEXT ACTION:/);
  assert.match(third, /Do exactly this, in order/);
  assert.match(third, /\n1\. /);
  assert.match(third, /\n2\. /);
  assert.match(third, /\n3\. /);
  assert.match(third, /task_quality_artifact_checkpoint/);

  // A genuine phase change resets escalation: the next interception in a
  // different phase is back to the non-escalated NEXT ACTION form.
  const afterState = fake.state(sessionID);
  await fake.internal.update({
    sessionID,
    expectedRevision: afterState.revision,
    expectedGeneration: afterState.generation,
    generation: 1,
    data: { version: 1, phase: "awaiting-artifact-review" },
  });
  const afterPhaseChange = await gate("m4");
  assert.match(afterPhaseChange, /NEXT ACTION:/);
  assert.doesNotMatch(afterPhaseChange, /Do exactly this, in order/);

  // Returning to the original phase starts a fresh count, so it is not
  // immediately re-escalated - the counter tracked only the same-phase stall.
  const backState = fake.state(sessionID);
  await fake.internal.update({
    sessionID,
    expectedRevision: backState.revision,
    expectedGeneration: backState.generation,
    generation: 1,
    data: pendingArtifactData,
  });
  const backToPending = await gate("m5");
  assert.match(backToPending, /NEXT ACTION:/);
  assert.doesNotMatch(backToPending, /Do exactly this, in order/);
});

test("leverD: an independent structured non-pass first review is delivered as feedback and its repair is recorded (no wedge)", async () => {
  // The Lever D crown-jewel path: an ISOLATED reviewer (different model) returns
  // a STRUCTURED needs_changes verdict rather than a same-model CRAP report.
  // Before the fix the adapter threw on this shape, captureTerminalPlan swallowed
  // it, and the run dead-hung in `planning`. After the fix the structured
  // rejection travels the SAME proven delivery path a same-model CRAP report
  // uses: delivered once as feedback, then the repaired plan is recorded and the
  // task advances to awaiting-approval. This asserts byte-for-byte the same
  // lifecycle outcomes as the same-model CRAP plan test above.
  const sessionID = "ses-leverd-structured";
  clearRouteHandoff(sessionID);
  recordRouteHandoff(buildRouteHandoff({ sessionID, messageID: "msg-task", messages: ["Repair parsePort"], skillNames: ["brainstorming"] }));
  const fake = fakeClient();
  fake.setReview(async (input) => (
    input.rereview
      ? {
          // A post-repair re-review is same-model CRAP by engine design in both
          // arms; keep the harness faithful so the repair path is exercised.
          route: { kind: "crap", model: { providerID: "local", modelID: "model" } },
          submission: { kind: input.submission.kind, digest: digestText(input.submission.content) },
          review: { status: "complete", rereview: { reviewID: input.rereview.reviewID }, result: { verdict: "pass", summary: "findings addressed", findings: [], dispositions: [] } },
        }
      : {
          // First review: an isolated 30B reviewer, structured non-pass verdict.
          route: { kind: "subagent", model: { providerID: "asus30b", modelID: "qwen3-coder-30b" }, health: "validated" },
          submission: { kind: input.submission.kind, digest: digestText(input.submission.content) },
          review: {
            status: "complete",
            reviewID: "review-indep-1",
            completedAt: 42,
            toolCalls: 3,
            result: {
              verdict: "needs_changes",
              summary: "The plan writes outside src and never runs the parsePort tests.",
              findings: [
                { severity: "blocking", message: "Step 2 edits README.md, violating the src-only constraint.", evidence: "plan step 2" },
                { severity: "blocking", message: "No step runs the parsePort tests to validate the repair.", evidence: "acceptance criteria omit the suite" },
              ],
              dispositions: [],
            },
          },
        }
  ));
  const hooks = await TaskQualityPlugin({ client: fake.client, experimental_task_quality: fake.internal });
  await hooks["experimental.chat.system.transform"]({ sessionID }, { system: [] });

  const first = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Edit README.md and src.", acceptance_criteria: ["It works."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  // Delivered as feedback — NOT thrown, NOT approved.
  assert.equal(first.title, "Plan review delivered");
  assert.deepEqual(fake.deliveries, [{ sessionID, reviewID: "review-indep-1" }]);
  const delivered = fake.state(sessionID).data;
  assert.equal(delivered.phase, "awaiting-plan-repair");
  assert.equal(delivered.pendingReview.delivery.messageID, "msg-review-1");
  assert.equal(delivered.pendingReview.reviewID, "review-indep-1");
  // Provenance of the true independent reviewer is preserved end to end.
  assert.equal(delivered.pendingReview.route.kind, "crap");
  assert.equal(delivered.pendingReview.route.model, "asus30b/qwen3-coder-30b");
  // The synthesized feedback carries the verdict and each evidence-cited finding.
  assert.match(delivered.pendingReview.report, /needs_changes/);
  assert.match(delivered.pendingReview.report, /README\.md/);
  assert.match(delivered.pendingReview.report, /parsePort tests/);
  // Mirror the engine's durablePendingReview acceptance predicates against the
  // persisted record so a field-shape regression is caught deterministically
  // here (the live 80B run exercises the real engine; this pins the contract
  // offline). The digest is PLAIN sha256 of the exact report bytes — the same
  // computation the engine recomputes on resume — not the \r\n-normalizing
  // digestText, so this test faithfully reflects what the engine will verify.
  const pr = delivered.pendingReview;
  assert.equal(pr.route.kind, "crap", "only transport the resume handler accepts");
  assert.ok(typeof pr.route.model === "string" && pr.route.model.includes("/"), "route.model is a provider/model identity");
  assert.match(pr.reviewID, /^[A-Za-z0-9_.:-]{1,160}$/, "engine-owned review identity");
  assert.ok(typeof pr.report === "string" && pr.report.length > 0, "non-empty deliverable report");
  assert.ok(Buffer.byteLength(pr.report, "utf8") <= 24 * 1024, "report within MAX_REPORT_BYTES");
  assert.match(pr.reportDigest, /^[a-f0-9]{64}$/, "digest is 64 hex chars");
  assert.equal(pr.reportDigest, createHash("sha256").update(pr.report, "utf8").digest("hex"), "digest is plain sha256 of the exact report bytes");
  assert.ok(pr.delivery && typeof pr.delivery.messageID === "string" && pr.delivery.messageID.length > 0, "durable delivery message id");

  // The delivered feedback is treated as untrusted and blocks mutation until repaired.
  const pendingSystem = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, pendingSystem);
  assert.match(pendingSystem.system.join("\n"), /untrusted feedback/i);
  const pendingAdmission = { decision: "allow" };
  await hooks["tool.execute.admission"](
    { sessionID, tool: "edit", callID: "call-review-injection", args: {}, source: "builtin", capability: "mutate" },
    pendingAdmission,
  );
  assert.equal(pendingAdmission.decision, "deny");

  // The builder addresses the findings; the repaired plan is recorded and the
  // task advances — a repaired-better outcome, not a dead hang.
  const second = await hooks.tool.task_quality_checkpoint.execute(
    { repaired_plan: "1. Make changes only within src.\n2. Run the parsePort tests.", acceptance_criteria: ["Tests pass."] },
    { sessionID, directory: ".", worktree: ".", metadata() {} },
  );
  assert.equal(second.title, "Repaired plan recorded");
  assert.equal(fake.deliveries.length, 1);
  assert.equal(fake.state(sessionID).data.phase, "awaiting-approval");
  assert.equal(fake.state(sessionID).data.addressReceipt.deliveryMessageID, "msg-review-1");
  clearRouteHandoff(sessionID);
});
