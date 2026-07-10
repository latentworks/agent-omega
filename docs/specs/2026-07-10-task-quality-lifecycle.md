# Agent Omega v2.6 — Task-Quality Lifecycle

**Status:** implemented and approved for v2.6.0 release preparation on 2026-07-10. Publication requires the matching Windows engine asset, checksum, privacy scrub, and CI verification.

## Problem and outcome

Agent Omega already has strong procedures for skill routing, design approval, planning, verification, iteration, council consultation, memory, and optional web research. Those procedures can still be skipped, mis-sequenced, or treated as unrelated tools by weaker models.

v2.6 adds one model- and client-agnostic task-quality lifecycle around the existing procedures. For a qualifying task, the builder must make a plan, receive a fresh adversarial review, repair the plan, receive the user's normal go/no-go, acquire any identified evidence, implement, verify at the real surface, receive a fresh artifact review, and either repair/retest or report residual risk honestly.

The product outcome is not "a smarter model." It is a predictable operating process that makes local and cloud models more reliable, hot-swappable agents without replacing Omega's current features.

## Pinned decisions

- **Name:** C.R.A.P. means **Clean-Room Adversarial Pass**. It is the guaranteed fallback when no healthy independent reviewer can be reserved.
- **Ownership:** engine/plugin layer. The desktop sidecar remains an ACP/session/transport owner; it may display engine-originated status later but must not implement another agent-control loop.
- **Review priority:** use a healthy capable subagent when one is available and suitable; otherwise use CRAP with the active lead model in a fresh, isolated review context.
- **CRAP context:** reviewer receives only the task contract, acceptance criteria, plan or artifact, and compact evidence packet. It does not receive the builder's conversation, rationale, prior review, or hidden chain-of-thought.
- **Reviewer permissions:** mutation-denied and allow-listed by the engine: read/search and optional web only. Reviewers consume immutable engine-recorded builder command/test receipts; they never receive shell execution. A future genuine sandbox is separately scoped work, not an implied exception.
- **Approval evidence:** only a later, user-authored message while the lifecycle is explicitly awaiting approval can authorize mutation. The model, a subagent, a tool result, or inferred enthusiasm cannot self-approve. Ambiguous language stays blocked and prompts one plain clarification.
- **Tool capability policy:** mutating, read-only, and unknown/external tools are classified by engine-owned metadata. Unknown tools default to denied during review and before approval; names, prompt claims, or untrusted MCP annotations never make a tool safe. MCP tools remain unknown unless a trusted local user/Omega policy pins a capability to the server and tool identity/version.
- **Existing features are preserved:** skill-router, brainstorming, writing-plans, verify, verify-guard, iterate-loop, council, engram, setup, and existing permissions retain their current jobs.
- **Single qualification owner:** `skill-router` remains the task classifier and hands a structured qualification result to task-quality. Task-quality does not make a second competing model classification; a mutating call with no valid lifecycle record fails closed and asks the lead to establish the missing plan state.
- **No user-go bypass:** a repaired plan is still shown to the user before any implementation. This v2.6 lifecycle strengthens the plan; it does not convert discussion into silent execution.
- **Release shape:** candidate `v2.6.0` after all slices have real-path proof. Root `VERSION` remains untouched until release preparation.

## Scope

### Included

- Qualifying state-changing engineering tasks and explicit build/change requests.
- Plan review, evidence-gap classification, evidence-to-action tracking, and final artifact review.
- Deterministic capture of the repaired-plan approval turn and the exact task/review generation it authorizes.
- Healthy-reviewer selection with immediate CRAP fallback.
- Session-bound lifecycle state that survives normal reconnect/restart without duplicate reviews or accidental bypass.
- Clean-install and in-place-upgrade delivery: required plugin wiring reaches preserved personal configs, and an old/incompatible engine cannot silently pretend the lifecycle is enforced.
- Bounded status events that the existing sidecar can forward later.
- Deterministic unit/integration tests plus real agent behavior proof on the shipped engine path.

### Explicitly excluded

- Replacing or rewriting existing skills, council, memory, permission rules, or model configuration.
- Making web research automatic for every task or treating web results as authoritative by default.
- Sending any task content to a provider not already selected/allowed by the user.
- A blanket multi-agent requirement; independent review is preferred only when a usable reviewer exists.
- Unlimited self-correction/review loops, background autonomous work, or a new desktop dashboard.

## Default policy

1. A task qualifies when it can change code/configuration/state or the user explicitly asks to plan/build/review a material change. Simple factual answers and harmless one-step read-only questions do not open a lifecycle.
2. A qualifying task gets at most one plan review and one final artifact review by default. A failed verification uses the existing bounded `iterate-loop` ladder; no new unbounded loop is introduced.
3. A reviewer finding must include a concrete requirement/evidence reference and a failure scenario. Unsupported guesses are dropped.
4. Every surviving finding must be fixed, rebutted with current evidence, or surfaced as a remaining risk. Severity changes presentation, not the evidence requirement.
5. Evidence gaps become explicit actions: local/repo/runtime fact -> inspect locally; current API/docs/error/standard -> targeted anonymous-web research when available; unavailable research -> disclose the gap rather than invent certainty.
6. A reviewer agent is eligible only when explicitly configured for review and currently usable: its model/provider resolves, required credentials or local endpoint are available, its tool policy is compatible, it is not reserved, and its time/token budget can be enforced. Otherwise the lifecycle falls back immediately to CRAP.

## Lifecycle contract

```text
new qualifying task
  -> existing skill-router / existing design-and-plan procedure
  -> builder plan exists
  -> reserve healthy independent reviewer, else CRAP
  -> reviewer findings + evidence backlog
  -> builder repairs plan
  -> user sees repaired plan and gives an explicit user-authored go/no-go
  -> evidence actions resolved / rebutted / disclosed
  -> implementation
  -> existing verify-guard + iterate-loop real verification and repair
  -> reserve reviewer, else CRAP, for final artifact
  -> fix + re-test, or honest final limitation
```

The lifecycle owns transitions and task state. Existing skills own their procedures. `iterate-loop` remains the sole owner of `session.idle` re-prompts.

## Data and engine contracts

### Task-quality record

One session-bound record contains:

- task identity and qualification reason;
- lifecycle phase and monotonic transition/review identifiers;
- repaired-plan digest plus the approving user-message identity/time and the generation it authorizes;
- tool-capability policy version and the policy decision attached to each blocked call;
- task contract and acceptance criteria;
- selected reviewer route, health result, timeout/budget outcome, and fallback reason;
- plan/artifact references and compact reviewer findings;
- evidence backlog with source type, claim, action, status, and resolution/rebuttal;
- verification evidence and final disclosed risks.

It must be reconstructable after reconnect/restart. An in-memory plugin `Map` alone is insufficient.

### Narrow engine work required before enforcement

1. **Tool admission and capability metadata:** execution has two ordered phases: first run and capture every argument transform; then compute capability and gather policy decisions against the final arguments with monotonic deny-wins semantics; only then execute. No transform can run after admission and no later plugin can reopen a denial. One centralized function must cover normal built-ins, MCP tools, and the direct TaskTool path while preserving a structured denied tool result with the real call ID.
2. **Ephemeral reviewer run:** invoke the selected active model in a bounded fresh context under a trusted engine review-mode/non-recursion flag. The request uses a unique fresh provider-affinity identity, an allow-listed review system prefix and transforms, and no builder conversation, active-agent prompt, memory/router injection, or real-session affinity. It creates no visible or durable user session, supports cancellation, and uses an aggregate provider-turn/tool-call/time/output budget across a multi-step tool loop so the model can consume evidence and return a required final structured result. AI SDK and native runtime behavior must satisfy the same contract.
3. **Session task metadata reuse:** keep the fork's existing session record, but add an atomic namespaced lifecycle update with expected lifecycle revision/task generation. Plain plugin read-merge-write and the current whole-object `setMetadata` replacement are not sufficient for approval evidence under concurrent writes.
4. **Trusted prompt origin:** engine-created prompt/message events carry an unforgeable origin (`external-user`, `internal`, or `subagent`) and exact generated message identity. Only an `external-user` message can supply approval evidence.
5. **Build identity:** embed commit plus dirty/source digest and task-quality protocol/build identity in engine health. Bind the external binary-hash manifest to the identity reported by the running binary.

## Acceptance criteria

1. An eligible task cannot make a mutating tool call before a repaired plan is present and an explicit later user-authored go is recorded against that exact plan generation; the denial explains what is missing.
2. With a healthy independent reviewer, the plan and artifact pass use that reviewer and record the route.
3. With no healthy reviewer, CRAP runs using the active selected model in fresh context; a fixture proves the builder conversation/rationale is absent from the reviewer input.
4. Reviewers can inspect and research within policy but cannot mutate workspace state or execute shell commands. They consume immutable engine-recorded builder command/test receipts.
5. An unclassified or newly introduced tool is denied during review and before approval until its capability metadata is explicit; built-ins, trusted locally pinned MCP capabilities, unknown MCP tools, and direct TaskTool execution follow the same centralized deny-wins enforcement path.
6. Reviewer findings are structured; each is resolved, evidence-backed rebutted, or surfaced before completion.
7. Local facts trigger local inspection; current external facts/errors trigger targeted web research only when the existing web bridge is available. A missing bridge is visible and never silently treated as research.
8. Existing skill routing, user plan approval, verify-guard failure classification, and iterate-loop retry behavior remain single-owned and continue passing their present tests.
9. Reconnect/restart reconstructs state without replaying a completed review, bypassing a gate, or applying stale findings to a new task.
10. A user approval for an older plan, task, or session generation cannot authorize a newer or changed plan.
11. Real shipped-path proof runs a qualifying task through plan review, a denied premature edit, plan repair/go, evidence action, implementation/verification, final review, and clean completion.
12. All review/output paths preserve current privacy and provider permissions; no secrets, hidden reasoning, or unapproved content leave the machine.
13. Clean installs and Windows/macOS upgrades receive the `task-quality` plugin without overwriting personal model/council/memory data; foreign OpenCode configs remain untouched.
14. Startup exposes and checks an engine capability/protocol version. A v2.6 config on an older engine fails closed before accepting task work and gives a concrete engine-update instruction—never a silent success or an unenforced imitation.
15. Embedded commit plus dirty/source digest -> compiled engine hash -> staged engine hash -> packaged engine hash is reproducible and recorded; the real-path test queries the running binary's identity and proves the packaged app executed that exact artifact.
16. Web and tool outputs are untrusted evidence. They cannot alter lifecycle policy, approve a plan, expand provider/tool permissions, or inject instructions into the reviewer envelope.
17. Skill routing/classification runs once per user task and hands task-quality a structured result. If routing is unavailable or misses a task, a mutating call without a valid lifecycle record is denied rather than bypassing the lifecycle.

## Delivery slices

### Slice 0 — engine primitives and contract tests

Add the minimal fork APIs for centralized deny-wins tool admission/capability metadata, trusted-origin lifecycle events, atomic namespaced lifecycle metadata, isolated reviewer execution, and a capability/protocol/build identifier. Prove denial and isolated reviewer execution on the actual engine API before any Omega lifecycle wiring.

### Slice 1 — plan-quality skeleton

Add a small `task-quality` module under the engine configuration. It qualifies a task, creates/reconstructs the record, routes to subagent-or-CRAP, parses structured findings, returns the repaired plan to the user, and records only an explicit user-authored approval tied to that plan generation. Add upgrade reconciliation and old-engine detection before calling the slice real. Prove the full plan-review/go path through the actual ACP/sidecar/engine chain.

### Slice 2 — evidence-to-action gate

Add the evidence backlog and tool-admission rules. Reuse the existing local web bridge and current permissions; prove local, web-available, web-unavailable, rebuttal, and user-disclosure paths.

### Slice 3 — final artifact review

Attach final review to the existing verification completion state, not another idle hook. Prove reviewer findings re-enter the normal repair/retest path and that clean artifacts finish once.

### Slice 4 — visibility, hardening, and release proof

Forward bounded lifecycle status through the sidecar for the existing activity surface; cover errors, cancellation, reconnect/restart, timeouts, capability loss, and accessibility. Run the full packaged app path, privacy scrub, version sync, CI, and release checks.

## Gates and Definition of Done

- **Frame:** complete when this scope, defaults, and non-goals are approved by the user.
- **Foundations/risk proof:** Slice 0 freezes the engine/plugin contracts and proves a real denied edit plus a real isolated active-model review through the engine; no stubbed substitute. UI-token gate is **N/A** until Slice 4 adds UI.
- **Walking skeleton:** Slice 1 runs the thinnest complete plan-review/repair/user-approval/denial path through the packaged ACP/sidecar/engine chain; this is Human View #1.
- **Per-slice:** acceptance criteria, actual output, independent adversarial review, and security review are required. Security review is required because the feature handles tools, files, sessions, providers, and optional network access.
- **Polish:** explicitly cover loading, reviewer unavailable, timeout, cancelled review, engine restart, web unavailable, permission denied, and user-declined-plan states. UI work uses the existing visual system and `frontend-craft` at that phase.
- **Release:** packaged Agent Omega path is exercised with a real qualifying task; persistence is round-tripped; current test suite and new focused/integration tests pass; a final red-team attempts to bypass gates, contaminate CRAP context, trigger duplicate reviews, and leak data.

## Top blockers and proof order

1. Confirm centralized monotonic admission can cover built-ins, unknown or locally pinned MCP tools, and the direct TaskTool path without destabilizing normal permission/tool behavior.
2. Prove a provider-agnostic active-model fresh-context call has reliable cancellation, token/time caps, unique provider affinity, allow-listed system transforms, no recursive lifecycle, and no agent/memory/conversation/session contamination.
3. Prove trusted external-user origin, task identity, repaired-plan digest, explicit user approval, and atomic revision-checked metadata updates survive recovery without stale authorization; then prove clean/upgrade config migration plus embedded source identity and binary-hash provenance ensure the packaged app actually enforces the feature.

## Pinned execution boundary

The safe v2.6 boundary is: reviewers receive read/search/web only and inspect immutable engine-recorded builder command/test receipts. They never receive shell execution. A disposable, credential-stripped execution sandbox is deferred as separately scoped future work; a temporary worktree alone is not sufficient isolation.

## No-build checkpoint

The user approves this design/spec and the delivery order before implementation begins. The first implementation target is Slice 0, not a broad v2.6 rewrite.
