# Workflow Enhance Plan

## Purpose

This is the durable plan for making `src/mastra/delivery-engine/workflow.ts`
small, Mastra-native, and maintainable without weakening the Delivery Engine.
Read this after `docs/OPERATING_DOCTRINE.md` and before touching workflow
cleanup code.

The current workflow file contains working behavior, but it still acts like a
private framework beside Mastra. The target is a thin Mastra control plane that
wires typed steps and native workflows together while focused modules own
Cloudflare Worker policy, task-plan shaping, implementation evidence, judging,
and deployment synthesis.

## North Star

`workflow.ts` should answer only these questions:

- Which Mastra workflows exist?
- Which typed steps run in each workflow?
- What schemas, state, scorers, suspend/resume contracts, and error handlers
  are attached?
- How do stage workflows compose into the top-level delivery workflow?

It should not own:

- Cloudflare Worker project policy.
- Task-plan repair and normalization details.
- Acceptance evidence interpretation.
- Retry classification and remediation synthesis.
- Build command planning.
- Release-gate evidence collection.
- Deployment report synthesis.
- Agent response parsing and trace artifact mechanics.

## Target Shape

Long-term target:

- `workflow.ts`: roughly 500-900 lines, mostly workflow exports and composition.
- Stage workflows live under `src/mastra/delivery-engine/workflows/`.
- Step bodies call focused runner functions with explicit typed inputs/outputs.
- Policy modules are unit-tested directly.
- No broad product-specific regex is added to `workflow.ts`.

Example final shape:

```ts
export const deliveryPlanningWorkflow = createPlanningWorkflow();
export const deliveryReviewWorkflow = createReviewWorkflow();
export const deliveryBuildTaskWorkflow = createBuildTaskWorkflow();
export const deliveryBuildWorkflow = createBuildWorkflow();
export const deliveryReleaseGateWorkflow = createReleaseGateWorkflow();
export const deliveryDeploymentWorkflow = createDeploymentWorkflow();

export const deliveryWorkflow = createDeliveryWorkflow({
  planning: deliveryPlanningWorkflow,
  scaffold: deliveryScaffoldWorkflow,
  review: deliveryReviewWorkflow,
  build: deliveryBuildWorkflow,
  releaseGate: deliveryReleaseGateWorkflow,
  deployment: deliveryDeploymentWorkflow,
});
```

## Design Rules

- Preserve behavior first. Move code before changing policy.
- One coherent extraction per commit.
- Prefer typed modules, schemas, constants, and structured provenance over
  string matching.
- Keep Mastra primitives visible: workflows, steps, state schemas, scorers,
  request context, suspend/resume, and onError/onFinish.
- Keep Cloudflare specificity in focused modules, not scattered workflow helper
  clusters.
- Stop and reassess if a change makes workflow behavior more brittle, hides
  Mastra surfaces, or moves a known late-stage run backward.

## Ordered Extraction Plan

### Phase 0: Plan And Re-Anchor

Status: complete.

Tasks:

- Add this plan.
- Link it from `AGENTS.md`, `docs/OPERATING_DOCTRINE.md`, and
  `docs/WORKFLOW_CLEANUP_TODO.md`.
- Commit this documentation checkpoint before behavior refactors.

Exit criteria:

- Future compacted turns know to read this file before workflow cleanup.
- Repo remains clean after the checkpoint commit.

### Phase 1: Workflow Error, State Sync, And Step Utilities

Status: complete.

Goal: remove cross-cutting workflow mechanics from the policy-heavy file.

Extract to:

- `workflow-support/errors.ts`
- `workflow-support/state-sync.ts`
- `workflow-support/step-factory.ts`

Move:

- `workflowErrorFailure`
- `initializedDeliveryRunFailureTarget`
- `markDeliveryRunFailedOnWorkflowError`
- `normalizeDeliveryWorkflowState`
- `syncDeliveryWorkflowState`
- `createSyncDeliveryStageStateStep`
- sync stage steps

Completed extraction:

- `workflow-support/errors.ts`
- `workflow-support/state-sync.ts`

`step-factory.ts` was not needed yet because the current sync-step factory is
small and cohesive inside `state-sync.ts`.

Keep in `workflow.ts`:

- Imports for created steps.
- Workflow composition.

Verification:

- Focused workflow error/state tests.
- `npm run typecheck`
- `npm test`
- `npm run build` with network if build verification matters.

### Phase 2: Agent Runtime And Judge Infrastructure

Status: complete.

Goal: make agent execution mechanics reusable and testable outside workflows.

Extract to:

- `agent-runtime/responses.ts`
- `agent-runtime/trace-artifacts.ts`
- `agent-runtime/timeouts.ts`
- `agent-runtime/judge-runtime.ts`
- `agent-runtime/stage-timeout.ts`

Move:

- response text/object helpers.
- secret redaction.
- stage trace artifact writing.
- stage timeout wrapper.
- agent timeout constants.
- judge provider error extraction.
- judge unavailable fallback output.
- `judgeDeliveryArtifact`.
- stage tool-use checks.

Completed extraction:

- `agent-runtime/trace-artifacts.ts` for response text extraction, agent
  response serialization, secret redaction, and trace artifact writing.
- `agent-runtime/options.ts` for required-agent lookup, structured no-tool
  options, implementation workspace tool sets, and timeout constants.
- `agent-runtime/stage-timeout.ts` for stage timeout errors, no-tool/read-budget
  watchdogs, latest-write tracking, and timeout event recording.
- `agent-runtime/diagnostics.ts` for compact error diagnostics shared by
  workflow stages and agent runtime modules.
- `agent-runtime/judge-runtime.ts` for judge provider error shaping,
  unavailable-judge fallback output, and shared artifact judging.

Keep in workflow steps:

- Which agent/rubric is called.
- Which artifact is being judged.
- How the step output flows to the next step.

Verification:

- Existing judge/provider fallback tests.
- Existing trace/processor tests.
- `npm run typecheck`
- `npm test`

### Phase 3: Planning And Task-Plan Policy

Status: complete.

Goal: move planner normalization and task graph policy into a planning module.

Extract to:

- `planning/readout-policy.ts`
- `planning/open-decisions.ts`
- `planning/pages-policy.ts`
- `planning/task-plan-normalizer.ts`
- `planning/task-plan-gates.ts`
- `planning/task-plan-revision.ts`

Move:

- open decision hygiene.
- safe adapter ambiguity normalization.
- Pages Functions exception checks.
- owned surface hygiene.
- task-plan deterministic results.
- plan gate revision remediation.
- planner revision response parsing.
- topological task ordering if not already delegated.
- root call `normalizeTaskPlanForDelivery`.

Completed extraction:

- `planning/readout-policy.ts` for safe readout ambiguity normalization,
  open-decision hygiene, true-blocker classification, and planner question
  suspend policy.
- `planning/pages-policy.ts` for Pages Functions exception hygiene, backed by
  `task-plan-surface-policy.ts` effective owned-surface resolution.
- `planning/owned-surface-policy.ts` for concrete owned-surface hygiene.
- `planning/role-boundary-policy.ts` for task owner surface hygiene and
  planner role-boundary normalization.
- `planning/task-contracts.ts` for shared source task id and acceptance
  contract criteria helpers.
- `planning/large-task-policy.ts` for splitting oversized implementation tasks
  into ordered delivery slices.
- `planning/config-schema-policy.ts` for splitting Worker config and D1
  migration ownership, with shared Worker/D1 surface predicates in
  `task-plan-surface-policy.ts`.
- `planning/task-ids.ts` for collision-safe generated task ids.
- `planning/operator-documentation-policy.ts` for README/operator
  documentation planning and hygiene.
- `planning/profile-contract-policy.ts` for profile contract producer surfaces,
  consumer dependency normalization, and profile contract ordering hygiene.
- `planning/scaffold-policy.ts` for root Worker scaffold dependency
  normalization, source-surface predicates, and scaffold hygiene gates.
- `planning/acceptance-contract-preservation.ts` for task-plan revision
  acceptance-contract IDs, preservation, and regression checks.
- `planning/route-boundary-policy.ts` for route-integration predicates and
  final entrypoint route-boundary consistency hygiene.
- `planning/generated-slice-policy.ts` for generated-slice dependency
  normalization, final-slice dependency policy, and generated-slice hygiene.
- `planning/task-plan-gates.ts` for deterministic task-plan gate assembly.
- `task-plan-dependencies.ts` now owns topological task ordering.
- `planning/cloudflare-contract-criteria-policy.ts` for Cloudflare
  acceptance-criteria sanitizer predicates and status/surface
  canonicalization.
- `planning/scaffold-policy.ts` now owns root Worker scaffold detection.
- `planning/behavior-evidence-task-policy.ts` for provider adapter, API route,
  frontend UI, and validation behavior evidence task synthesis.
- `planning/route-criteria-policy.ts` for route endpoint criteria ownership,
  scheduler/workflow criteria drift cleanup, and final Worker entrypoint
  criteria sanitization.
- `planning/route-task-policy.ts` for auth/session route tasks, route
  integration tasks, final Worker entrypoint tasks, profile summary tasks, and
  Cloudflare route dependency rewiring.
- `planning/task-criteria-policy.ts` for shared task acceptance criteria
  append semantics.
- `planning/cloudflare-worker-contracts-policy.ts` for the full Cloudflare
  Worker contract normalizer and task verification acceptance criteria.
- `planning/task-plan-normalizer.ts` for the root task-plan normalization
  composition used by planning and revision steps.
- `planning/task-plan-revision.ts` for planner revision response parsing and
  plan-gate remediation synthesis.

Keep in planning workflow:

- planner call.
- suspend/resume for true blockers.
- call to deterministic plan gate.
- call to judge.
- state/artifact persistence.

Verification:

- Existing task-plan normalization tests.
- Existing Pages/Worker tests.
- Existing smell-audit tests.
- `npm run eval:delivery:gate`
- `npm run typecheck`
- `npm test`

### Phase 4: Implementation Task Execution

Status: in progress.

Goal: make build task execution a focused service rather than a long workflow
step body.

Extract to:

- `implementation/task-packet.ts`
- `implementation/task-boundaries.ts`
- `implementation/deterministic-gates.ts`
- `implementation/retry-runtime.ts`
- `implementation/reusable-artifacts.ts`
- `implementation/build-task-runner.ts`

Move:

- task boundary surface resolution.
- missing owned surface/stub detection.
- implementation note synthesis.
- implementation deterministic results.
- implementation remediation.
- retry mode and tool choice.
- reusable implementation artifact detection.
- build resume plan.
- touched-file/event analysis.
- focused repair context paths.

Completed extraction:

- `implementation/task-boundaries.ts` for task boundary surfaces, generated
  Wrangler type ownership, Worker config/package/binding hygiene guards,
  installed package freshness, source boundary filtering, and compile-safe
  preflight stubs for missing owned surfaces.
- `implementation/task-packet.ts` for dependency surface context, existing
  owned-file fallback, and focused repair context paths.
- `implementation/deterministic-gates.ts` for route integration, Workflow step
  integration, WorkflowEntrypoint imports, profile-kind contract alignment, and
  lifecycle status CHECK constraint gates.
- `implementation/reusable-artifacts.ts` for prior stopped task detection,
  reusable implementation artifact validation, build resume cursor planning,
  and touched-file inference from implementation-stage events.
- `implementation/judgment-policy.ts` for actionable implementation judge
  remediation, soft non-actionable completion policy, and implementation
  finding-step synthesis.
- `implementation/evidence.ts` for implementation note synthesis,
  acceptance-contract evidence gaps, deterministic implementation gate results,
  and deterministic remediation text.
- `repo-files.ts` for shared repo-relative file content reads used by workflow
  prompts and implementation evidence.
- `implementation/retry-runtime.ts` for stale verification surface detection
  and repair, engine policy mismatch detection, retry mode wrappers, timeout
  remediation, judge repair prompts, and TypeScript narrowing auto-repair.
- `implementation/attempt-prompt.ts` for implementation attempt task-packet
  assembly, retry-mode tool policy, recovery prompt text, and post-write
  timeout selection.

Keep in build-task workflow:

- prepare attempt.
- execute attempt by calling `runBuildTaskAttempt`.
- finalize attempt loop.
- scorers and state transitions.

Verification:

- Existing implementation retry tests.
- Existing task-packet rails tests.
- Existing reusable artifact tests.
- Existing workflow split tests.
- `npm run typecheck`
- `npm test`

### Phase 5: Build Verification And Local Evidence

Status: complete.

Goal: move command planning and command execution evidence out of workflow
composition.

Extract to:

- `evidence/build-verification.ts`
- `evidence/release-gate-evidence.ts`
- `evidence/command-runner.ts`
- `evidence/local-admin-secret.ts`

Move:

- dependency install helper.
- build verification command plans.
- record run-code start.
- run build verification.
- release-gate local admin secret preparation.
- release-gate evidence command execution.
- release-gate evidence collection.

Completed extraction:

- `evidence/command-runner.ts` for run-code start events, shared execFile
  command execution, and normalized command failure summaries.
- `evidence/build-verification.ts` for build verification command planning,
  dependency install evidence, verification execution, scoped repair, and
  stale-workspace failure classification.
- `evidence/local-admin-secret.ts` for release-gate local admin secret path
  selection, temporary token injection, and restoration.
- `evidence/release-gate-evidence.ts` for release-gate evidence planning,
  route discovery, static evidence, dynamic command execution, local Wrangler
  runtime probes, transcript fixtures, and required-evidence pass/fail policy.

Keep in release-gate workflow:

- call evidence collector.
- persist evidence artifact.
- synthesize release gate.
- judge or score release readiness.

Verification:

- Existing release gate command-plan tests.
- Existing Worker config hygiene tests.
- Existing release gate runtime probe tests.
- `npm run eval:cloudflare:gate`
- `npm run typecheck`
- `npm test`

### Phase 6: Deployment Policy

Status: complete.

Goal: keep local/production deployment decisions deterministic and isolated.

Extract to:

- `deployment/local-report.ts`
- `deployment/production-wrangler.ts`
- `deployment/deployment-gate.ts`

Move:

- deployment deterministic results.
- local deployment report from release-gate evidence.
- production Wrangler deploy command.
- production live verification.
- production deployment report synthesis.
- deployment success next steps.
- deployment gate failure next steps.

Completed extraction:

- `deployment/production-wrangler.ts` for production Wrangler deploy command
  execution, live URL verification, deploy observability events, and production
  deployment report synthesis.
- `deployment/local-report.ts` for deployment artifact lookup, release-gate
  evidence artifact loading, local deployment report synthesis, and deployment
  success next-step reporting.
- `deployment/deployment-gate.ts` for deployment deterministic completion
  checks and failed deployment next-step synthesis.

Keep in deployment workflow:

- local vs production branch.
- production approval suspend/resume.
- final report persistence.
- terminal state sync.
- deployment step scorers.

Verification:

- Existing local deployment report tests.
- Existing production Wrangler deploy tests.
- Existing deployment deterministic gate tests.
- `npm run typecheck`
- `npm test`

### Phase 7: Stage Workflow Modules

Goal: move native workflow definitions out of the root workflow file.

Create:

- `workflows/planning.workflow.ts`
- `workflows/review.workflow.ts`
- `workflows/build-task.workflow.ts`
- `workflows/build.workflow.ts`
- `workflows/release-gate.workflow.ts`
- `workflows/deployment.workflow.ts`
- `workflows/delivery.workflow.ts`
- `workflows/index.ts`

Move:

- `deliveryPlanningWorkflow`
- `deliveryReviewWorkflow`
- `deliveryBuildTaskWorkflow`
- `deliveryBuildWorkflow`
- `deliveryReleaseGateWorkflow`
- `deliveryDeploymentWorkflow`
- `deliveryWorkflow`

Keep `workflow.ts` temporarily as a compatibility barrel:

```ts
export * from './workflows';
```

Only remove the compatibility barrel after tests and imports no longer depend on
the historical path.

Verification:

- Tests that import workflow exports.
- Mastra registration tests.
- `npm run typecheck`
- `npm test`
- `npm run build`

### Phase 8: Final Workflow Slimming And Audit

Goal: prove the monolith is gone and expert-readable.

Tasks:

- Remove dead imports and obsolete helper exports.
- Add or update a test that fails if `workflow.ts` grows beyond the expected
  compatibility-barrel size.
- Update `docs/WORKFLOW_CLEANUP_TODO.md` with completed phases.
- Update README only if public operator behavior changed.
- Run all local quality gates.

Verification:

- `npm run typecheck`
- `npm test`
- `npm run eval:delivery:gate`
- `npm run eval:cloudflare:gate`
- `npm run build` with network access if needed.

Completion criteria:

- `workflow.ts` is a compatibility barrel or thin composition file.
- Native stage workflows remain registered and visible in Mastra Studio.
- Scorers/evals still pass.
- Cloudflare Worker-first behavior is unchanged or stronger.
- No paid full delivery run is needed to prove the refactor.

## Commit Protocol

Commit after each phase or smaller natural checkpoint:

1. Explain which cluster moved.
2. List the focused verification that passed.
3. Do not combine behavior changes with mechanical extraction unless required.
4. Push after each commit when remote access is available.

## Stop Conditions

Pause and reassess if:

- A phase requires changing workflow behavior to make extraction possible.
- Tests pass only after weakening checks.
- The extraction adds a new broad regex or product-specific exception.
- `workflow.ts` becomes smaller but stage behavior becomes less visible in
  Mastra.
- The same failure class repeats twice during the extraction loop.

## Current Goal

Implement this plan until `workflow.ts` is thin and the extracted modules own the
right responsibilities. Treat this document as the active checklist for workflow
cleanup across context compactions.
