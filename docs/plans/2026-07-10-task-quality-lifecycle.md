# Agent Omega v2.6 — Task-Quality Lifecycle Delivery Plan

**Status:** implemented for v2.6.0 on 2026-07-10. The original Windows engine-asset, checksum, privacy, and CI publication gates were satisfied; v2.6.2 also publishes the source-complete engine fork and verified native engine assets for all supported release targets.

## Decision

Build the lifecycle as a small companion to `iterate-loop`, with task-quality
state and transitions owned by a new configuration plugin. Add only the two
engine capabilities that a plugin cannot safely emulate: blocking a tool call
against engine-owned capability metadata and running an isolated reviewer.
Reuse the fork's existing durable session metadata rather than inventing a
third persistence path.

Do not put agent control flow in the desktop shell or sidecar. Do not turn
`council` into the mandatory reviewer. Do not add another `session.idle` owner.

## Real seams

| Concern | Current owner | v2.6 change |
| --- | --- | --- |
| Tool lifecycle | `opencode-fork/packages/opencode/src/session/tools.ts`, `session/prompt.ts`, `tool/registry.ts`, and MCP resolution | Add engine-owned read/mutate/unknown metadata plus one centralized deny-wins admission function after argument transforms and before execution. Cover built-ins, MCP, and direct TaskTool; unknown defaults denied before approval and inside review. |
| Plugin contract | `opencode-fork/packages/plugin/src/index.ts` and `opencode-fork/packages/opencode/src/plugin/index.ts` | Extend the hook contract so policies can deny, but aggregate monotonically: once denied, no later plugin can reopen the call. |
| Session persistence | `opencode-fork/packages/opencode/src/session/session.ts` and HTTP session handler | Keep existing session storage but add atomic namespaced lifecycle updates with expected revision/task generation; do not use whole-object plugin read-merge-write for authorization. |
| Independent review | `opencode-fork/packages/opencode/src/session/prompt.ts`, `session/tools.ts`, and `tool/task.ts` | Add a bounded internal review runner. It must use the selected active model and tool policy without creating the visible child session that `TaskTool` creates today. |
| Engine compatibility | fork capability endpoint/ACP initialization plus `sidecar.mjs` startup | Expose a task-quality protocol/capability version and refuse to claim enforcement when the bundled/selected engine is too old. |
| Task qualification | `config-template/opencode/skill-router/` | Keep one classifier. Extend its pure structured result/handoff so task-quality consumes the route instead of making a second competing classification call. A mutation with no valid task-quality record fails closed. |
| Lifecycle policy | Existing routing/planning/verification skills plus `iterate-loop` | Add `task-quality/` as a sibling coordinator. It owns task-quality transitions only; existing skills keep their procedures and `iterate-loop` remains the only idle re-prompt owner. |
| Configuration | `agent-omega/config-template/opencode/opencode.json` | Register `task-quality` in a deliberate hook order after routing and before verify/iterate behavior. |
| Upgrade delivery | `setup.mjs`, `mac/AgentOmega.swift`, doctor/setup checks | Reconcile the new required plugin and policy keys into existing Agent Omega configs while preserving personal config/council/memory; never modify a foreign OpenCode config. |
| Desktop visibility | `agent-omega/sidecar.mjs` and existing activity surface | Slice 4 only: forward engine status events. No lifecycle decisions here. |

## Contracts to freeze before fan-out

Parallel work starts only after these interfaces are written as types/fixtures and Sol has challenged them:

1. **State machine:** task identity, generation, phases, legal transitions, idempotency keys, cancellation, terminal states, and restart reconstruction.
2. **Approval evidence:** the digest of the reviewed/repaired plan plus the later user-message ID/time that explicitly approves that exact generation. A model/tool/subagent cannot write its own approval; ambiguous user text leaves the gate closed.
3. **Tool capabilities:** engine-owned `read`, `mutate`, and `unknown/external` classification, with conservative defaults and one centralized deny-wins path for built-ins, MCP, and direct TaskTool. MCP annotations are untrusted hints; only a trusted local mapping pinned to server/tool identity/version can classify an MCP tool as read-only.
4. **Review envelope:** stable/cache-friendly instruction prefix followed by allow-listed variable context, model/agent/provider identity, tool policy, time/token caps, abort behavior, trusted engine review-mode/non-recursion marker, unique provider-affinity identity, structured findings, and evidence attachment format. Reuse the engine's provider/cache path but bypass active-agent, memory/router, conversation, and non-allow-listed system transforms.
5. **Lifecycle events:** bounded status names and payload versions. The sidecar may forward them but never infer them.
6. **Engine provenance:** embedded commit plus dirty/source digest, protocol/build identity, build command, binary hash, staged Omega path, and packaged binary hash so tests cannot accidentally prove source mode while shipping an older executable.
7. **Artifact identity:** plan/artifact/evidence digests and source descriptors (repo diff, file hashes, command/runtime receipts) so reviews and approvals cannot attach to stale material.
8. **Compatibility/migration:** minimum task-quality protocol, old-engine behavior, clean-install behavior, Windows upgrade reconciliation, macOS upgrade reconciliation, and preserved/foreign-config invariants.
9. **Qualification handoff:** one router result per user task, task/generation identity, qualifying reason, classifier-unavailable behavior, and fail-closed handling for mutation without a valid lifecycle record.
10. **Trusted origin and concurrency:** unforgeable external-user/internal/subagent message origin, exact generated message ID, and atomic lifecycle compare-and-set semantics. Only the current external-user message can authorize its exact plan generation.

## Build order

### 0. Fork contracts — prove the mechanisms before Omega wiring

1. Freeze the ten contracts above and the negative-path fixtures before implementation fan-out.
2. Preserve `tool.execute.before` as the argument-transform phase and capture its final returned `args`. Add a distinct admission phase over those final arguments with engine-owned capability metadata and a result such as `{ decision: "allow" | "deny", reason, policyVersion }`. Aggregate denials monotonically; no admission hook can alter arguments and no later hook can change deny to allow.
3. Route final transformed arguments through one centralized admission function before every built-in/MCP/direct-TaskTool executor. A denial must produce a tool-visible failure, preserve the actual call ID, skip permission/execution, and still permit normal rendering/logging.
4. Define an internal isolated-review request/result API. Inputs: session/model/agent policy, compact allow-listed prompt parts, read/search/web-only tool classes, immutable engine-recorded builder command/test receipts, aggregate provider-turn/tool-call/time/output caps, abort signal, trusted engine review-mode/non-recursion guard, and fresh provider-affinity ID. Outputs: required final structured result, tool evidence, finish/cancel/error/budget state. Implement a bounded multi-step evidence loop with contract parity across AI SDK and native runtimes. Tests plant canaries in the active agent prompt, session transforms, memory/router context, builder conversation, and provider affinity and prove none cross the boundary; tests also prove a tool result can be consumed before the final findings are produced.
5. Add atomic namespaced lifecycle metadata updates with expected lifecycle revision/task generation. Add trusted prompt origin and generated message identity; only `external-user` may create approval evidence.
6. Expose task-quality protocol/capabilities plus embedded commit and dirty/source digest that the plugin/sidecar and provenance manifest can verify before claiming enforcement.
7. Add engine-level contract tests for: monotonic mutation/unknown denial without executor invocation, locally pinned versus untrusted MCP behavior, direct TaskTool parity, cancellation, timeout, contamination canaries, no reviewer recursion, no persistent child session, atomic metadata conflict/stale-generation rejection, trusted-origin approval, and old/new protocol negotiation.
8. First prove the fork through `AGENT_OMEGA_OPENCODE_SRC`. Then compile the fork, copy the exact binary into `agent-omega/engine/opencode.exe`, record its hash, build Agent Omega, and prove the packaged copy has the same hash.

**Gate:** exercise the actual fork API with a real denied edit and a real isolated review. If the isolated runner cannot safely share the selected active model without session pollution, or admission cannot remain deny-wins across all execution paths, stop here and redesign the primitive rather than building a plugin workaround.

### 1. Plan-quality lifecycle — one small owner

1. Create `config-template/opencode/task-quality/` with pure modules for qualification handoff, record validation/transitions, reviewer selection, review-prompt construction, finding parsing, and evidence backlog handling.
2. Extend `skill-router` to emit one structured task/generation classification for task-quality while retaining its existing skill directive. Keep the task-quality plugin entrypoint thin: consume that handoff, coordinate explicit lifecycle transitions, invoke reviewer selection, persist the record, and add only bounded status events. It must not reclassify the task or guess lifecycle phase from prose alone.
3. Capability resolver order: candidates from a configurable reviewer-agent list, defaulting in template order to configured subagents such as `helper2`/`helper1`; select the first that passes model/provider/credential/endpoint/permission/budget/cancellation checks, otherwise CRAP on the active selected model. Mere presence is not health proof, and the user can reorder or opt an agent out.
4. CRAP prompt construction is allow-list only: task contract, acceptance criteria, submitted plan/artifact, and compact evidence. Test that builder conversation, rationale, earlier review, and hidden model reasoning cannot enter it.
5. Return structured findings to the lead with an explicit disposition requirement: fix, evidence-backed rebuttal, or visible risk.
6. While awaiting approval, accept only a later user-authored explicit go/no-go tied to the repaired-plan digest and generation. Negative language takes precedence; ambiguous text stays blocked and causes one plain clarification. The lead, reviewer, and plugin cannot self-approve.
7. Reconcile the shipped plugin and required policy keys on clean install and in-place upgrade. Test Windows and macOS provisioners, preserved personal config/council/memory, and refusal to touch foreign OpenCode configs.
8. If the engine capability check fails, stop before accepting task work and surface one explicit incompatible-engine/update state; never load a prompt-only imitation or continue in an unenforced mode.
9. If routing is unavailable or no valid lifecycle record exists, a pending mutation is denied with a recovery instruction; it never silently bypasses the lifecycle.

**Gate:** through the packaged ACP chain, prove: qualifying request -> plan -> independent reviewer or CRAP -> repaired plan -> attempted premature edit denied -> explicit user go recorded. No app UI work yet.

### 2. Evidence-to-action

1. Persist evidence items with claim, local/external classification, required action, status, source, artifact digest, and disposition.
2. Admit mutations only when the repaired plan has the user's explicit go and required evidence is resolved, rebutted with evidence, or explicitly unavailable/disclosed.
3. Delegate local facts to local inspection. Delegate current external facts to the existing anonymous-web bridge only when configured and permitted; record unavailable rather than pretending research occurred.
4. Treat all local/web/tool results as untrusted data. Sanitize them into evidence fields; they cannot issue lifecycle commands, approve work, change the reviewer envelope, or expand tool/provider permissions.
5. Test local-only, web-available, web-unavailable, denied, rebutted, and disclosure paths.
6. Re-review a changed plan when its digest changes; prior approval and findings cannot silently carry forward.

**Gate:** a real task blocks on an evidence action, follows the available path, and records an honest completion state.

### 3. Final artifact review

1. Observe verified completion from the existing verify/iterate flow; do not subscribe to `session.idle` for another prompt loop.
2. Run one reviewer/CRAP artifact pass with the same isolation and mutation-denial constraints.
3. Send substantiated findings back through the normal repair/retest route. A clean artifact completes once; exhausted retries surface residual risk.
4. Test duplicate idle/completion events, cancellation, reviewer failure, and restart during each review phase.

**Gate:** real-path proof shows final-review finding -> repair -> real retest -> one clean completion.

### 4. Visibility, resilience, and release proof

1. Emit small engine-originated lifecycle statuses: qualified, awaiting plan review, reviewer route/fallback, evidence blocked, awaiting user go, reviewing artifact, reviewer unavailable, completed-with-risk.
2. Have `sidecar.mjs` forward those statuses to the existing activity display; it never decides phases or re-prompts.
3. Cover loading, timeout, cancellation, permission denied, web unavailable, restart/reconnect, capability loss, declined plan, and accessibility.
4. Run focused tests, existing suite, packaged desktop path, privacy scrub, version synchronization, and CI/release checks. Only then change `VERSION` for the agreed v2.6.0 release.
5. Verify Windows source mode, rebuilt Windows engine binary, packaged Windows app, and the platform-neutral/macOS build contract. A Windows-only local proof does not authorize a cross-platform release claim.

## Execution routing and parallel fan-outs

This section routes **our v2.6 build team**. It is separate from Omega's runtime reviewer resolver.

### Standing ownership

- **Terra high — lead/orchestrator:** owns the spec, frozen contracts, dependency order, integration, raw-result verification, task drawer, and every decision that crosses repos. The lead reads every diff and re-runs the real proof; worker reports are not proof.
- **Sol high — architect/adversary:** read-only architecture challenge before code, a mandatory review after the engine foundation proof, a mid-run review after Slice 2, and the final correctness/security/red-team verdict. Sol may recommend changes but does not concurrently edit a builder's files.
- **Terra medium — hard delegated builders:** narrow engine/fork work, concurrency/state-machine work, admission enforcement, isolated-runner plumbing, and recovery-sensitive integration tasks.
- **Luna high — clear medium work and large ingestion:** test-convention mapping, deterministic fixtures, pure plugin modules, resolver/parser/evidence adapters, integration matrices, and status/UI plumbing once the interface is frozen.
- **Luna medium — easy high-volume work only:** repetitive fixture expansion, compatibility tables, documentation cross-checks, and mechanical privacy/version inventories. It does not own security conclusions, engine concurrency, lifecycle transitions, or final verification.

### Fan-out rules

1. Maximum useful wave is the lead plus three workers. Sol review occupies a worker slot only after builders stop; it is not run concurrently with the code it must judge.
2. Parallel workers receive disjoint file ownership and one concrete acceptance contract. If two tasks need the same state-machine or engine file, serialize them.
3. Engine and Omega repo work may run in parallel only after the shared contract is frozen. Use isolated worktrees/branches for overlapping repositories when needed; no worker pushes, merges, versions, or releases.
4. Every wave converges through the Terra-high lead: inspect diffs, reconcile contracts, run focused tests, run the real path, then invoke Sol. Findings without file/line plus reproduction/evidence are dropped.
5. A failed contract or two failed fixes stops the fan-out and returns to root-cause/architecture review.

### Wave map

| Wave | Dependency | Parallel assignments | Convergence gate |
| --- | --- | --- | --- |
| A — contract preflight | User approves this plan | Terra high writes final types/fixtures; Luna high maps fork tests and binary staging; Luna high maps Omega hooks, router handoff, ACP, setup, and macOS provisioning; then Sol high attacks all ten contracts | Contracts frozen; no code ambiguity; qualification, explicit approval, migration, compatibility, and tool-classification rules testable |
| B — engine foundation proof | Wave A | Terra medium owns capability/admission path; Terra medium owns isolated-review runner; Luna high owns metadata/protocol/provenance harness and non-overlapping contract fixtures | Terra high integrates; source-mode real denial + fresh review; rebuilt/staged binary hash match; Sol high foundation review |
| C — plan-quality slice | Wave B accepted | Terra medium owns lifecycle state/admission wiring; Terra medium owns preservation-sensitive Windows/macOS migration and old-engine handling; Luna high owns reviewer resolver + CRAP envelope/parser plus approval/compatibility fixtures | Packaged ACP path reaches repaired plan, blocks premature mutation, records exact user approval; clean/upgrade/old-engine paths explicit; Human View #1 |
| D — evidence slice | Wave C accepted | Terra medium owns evidence gate/state transitions; Luna high owns local/web/unavailable adapters; Luna high owns evidence and stale-digest integration cases | Real evidence action resolved/rebutted/disclosed; no unapproved provider/tool use; Sol high mid-run review; Human View #2 after the complete slice |
| E — artifact/recovery slice | Wave D | Terra medium owns final-review/recovery/idempotency transitions; Luna high owns reviewer-failure/restart/cancellation scenarios; Luna medium expands repetitive negative fixtures after core cases pass | Finding -> repair -> retest -> one completion across reconnect/restart; correctness/security gate |
| F — visibility/release | Wave E | Terra medium owns sidecar event forwarding; Terra high invokes `frontend-craft` and owns visual direction; Luna high implements/tests the bounded existing activity-surface states; Luna medium performs docs/version/privacy inventory | Packaged app real task, accessibility/state pass, full suites, binary provenance, privacy scrub, Sol final red-team, user sign-off |

### Runtime reviewer routing inside Omega

The product must not hard-code Terra/Sol/Luna. Omega remains provider- and model-agnostic:

1. Read an ordered reviewer-candidate policy from the user's current configuration. The shipped default may nominate configured subagents such as `helper2`/`helper1`; the user can reorder or opt them out without changing model wiring.
2. Reserve it and prove model/provider resolution, endpoint/credential availability, permission compatibility, cancellation support, and budget before sending task data.
3. Give it the clean review envelope and mutation-denied investigative policy.
4. If any check fails or no eligible agent exists, immediately run CRAP with the active selected model in an isolated context.
5. Record the route and fallback reason without exposing credentials, hidden reasoning, or private operational details.

Independent context is mandatory; a different provider/model is optional. The fallback is always available because the active lead model already exists.

## Human checkpoints

- **Now — Intent/design:** the user approves or changes this spec and plan before Slice 0 code.
- **After Wave C — View #1:** show the working packaged plan-review/denial/approval skeleton in plain language.
- **After Wave D — View #2:** show the first complete evidence-gated slice. Remaining approved slices continue without extra routine approvals unless scope changes.
- **After Wave F — Sign-off:** present real-path proof, accepted gaps, privacy result, version/release proposal, and ask before any push/publish/release.

## Test and review discipline

- Every pure transition/parser/resolver has deterministic unit tests.
- Every fork primitive gets direct integration coverage before plugin consumers rely on it.
- Approval tests cover affirmative, negative, negated affirmative, ambiguous, stale plan, changed plan, replayed message, subagent/model-authored text, reconnect, and cancellation. Only an explicit current user turn can open the gate.
- Tool-policy tests enumerate built-ins and MCP tools, fail closed for unknown capabilities, and prove denied executors never ran or changed files/state.
- Migration tests cover clean install, Agent Omega upgrade, preserved custom provider/model/council/memory data, Windows reconciliation, macOS reconciliation, foreign-config refusal, old-engine detection, and a current-engine happy path.
- Evidence tests inject policy-looking instructions through local files, tool output, and web results and prove they remain inert data.
- Each slice gets an adversarial review aimed at gate bypass, reviewer-context contamination, stale metadata, unintended provider use, tool mutation, duplicate triggers, and data leakage.
- The final release gate is one real qualifying engineering task on the packaged app, not a mocked plugin callback.

## Files expected to change

The final set will be confirmed at implementation time, but the planned owners are:

- `<opencode-fork>/packages/plugin/src/index.ts`
- `<opencode-fork>/packages/opencode/src/plugin/index.ts`
- `<opencode-fork>/packages/opencode/src/session/tools.ts`
- `<opencode-fork>/packages/opencode/src/session/prompt.ts`
- `<opencode-fork>/packages/opencode/src/session/session.ts`
- `<opencode-fork>/packages/opencode/src/tool/registry.ts` and the adjacent MCP tool-resolution seam selected during Wave A
- focused adjacent engine test files, created only after matching the fork's current test conventions
- `config-template/opencode/task-quality/*`
- the narrow structured-result handoff in `config-template/opencode/skill-router/*` and its existing router tests
- `config-template/opencode/opencode.json`
- `setup.mjs`, `config-template/opencode/doctor.mjs`, and their migration/doctor tests
- `mac/AgentOmega.swift` provisioning reconciliation and focused macOS checks
- Slice 4 only: the existing status-forwarding seam in `sidecar.mjs` and its tests
- setup/build/release assets, checksums, and documentation needed to reproduce the fork revision -> engine hash -> packaged hash chain; the ignored engine binary itself is never treated as public source

## Explicit stop conditions

- The fork cannot provide tool denial across built-in and MCP tools without breaking normal permission/tool semantics.
- An isolated review cannot guarantee fresh context, selected-model fidelity, cancellation, unique provider affinity, transform/agent/memory isolation, and no persistent user-session contamination.
- Durable lifecycle records, trusted external-user origin, and explicit approval cannot be tied atomically to the exact task/plan generation strongly enough to prevent stale authorization after recovery.
- The rebuilt fork binary cannot be reproducibly identified and proven as the engine that the packaged app actually ran.

Any stop condition returns to architecture review. It does not get papered over with a prompt-only approximation.
