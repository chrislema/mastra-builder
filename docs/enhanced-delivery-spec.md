# Enhanced Delivery Spec

## Purpose

This spec resets the Delivery Engine around the lesson from the benchmark runs:
the expensive failure mode is not that agents occasionally make mistakes. The
expensive failure mode is asking agents to rediscover Cloudflare Worker project
structure, test runtime choices, and verification policy inside paid workflow
runs.

The next Delivery Engine should use Mastra for orchestration, observability,
agents, memory, and scoring. It should use deterministic Cloudflare Worker
project rails for everything that can be known before a model is called.

## North Star

Given a project folder containing `vision.md` and optionally `spec.md`, the
system should produce a vanilla HTML/CSS/JavaScript or TypeScript Cloudflare
Worker application that reaches local validation and a human approval gate.

The run should feel boring in the right places:

- Worker scaffold is deterministic.
- Test/runtime matrix is deterministic.
- Bindings, Wrangler config, scripts, and generated types are deterministic.
- Agents fill product-specific code inside known rails.
- Mastra Studio shows progress, traces, scores, artifacts, and the human gate.
- Full paid delivery runs happen only after cheap fixture tests prove the rails.

## Problem Summary

The current system has made real progress, but the benchmark loop exposed a
wrong center of gravity.

- We built too much coding-runtime behavior into a large workflow.
- We spent model calls fixing project-shape issues that should be fixed by
  deterministic scaffold policy.
- Evidence tasks sometimes inherited implementation contracts in ways that made
  deterministic gates brittle.
- Generated project tests were allowed to discover runtime policy late. Example:
  `test/contracts.test.ts` was pure domain logic but `vitest.config.ts` routed
  `test/**/*.test.ts` through `@cloudflare/vitest-pool-workers`, causing the
  run to stop on a basic test-environment mismatch.
- The loop was expensive because every small policy miss became a full
  multi-agent delivery pass.

The reset is to stop treating the model as the owner of delivery infrastructure.
The model should implement the product. The harness should own the delivery
system.

## Target Architecture

### Workflow Rewrite Stance

Changing the workflow is in scope and likely necessary.

The reset should not preserve the current workflow shape out of habit. The
current workflow got too large because it absorbed scaffold policy, task-plan
repair policy, evidence routing, retry policy, command planning, and report
assembly. The enhanced design should treat the existing workflow as a source of
working behavior and lessons, not as the fixed architecture.

Allowed changes:

- Split the current delivery workflow into multiple Mastra workflows.
- Replace large workflow-local helper clusters with focused modules.
- Add a scaffold-first workflow stage that runs before implementation agents.
- Change task packet shape to include scaffold profile, surface kinds, runtime
  kinds, and evidence kinds.
- Replace broad deterministic gates with typed stage outputs where possible.
- Remove model calls from stages that can be deterministic.
- Rename internal workflow IDs if Studio/operator entry points remain simple.

Protected behavior:

- `delivery-start` remains the simple operator entry point.
- Runs remain visible in Mastra Studio and report artifacts.
- Agents, scorers, memory, tools, and workflows remain registered in
  `src/mastra/index.ts`.
- Existing benchmark observations remain valid historical evidence.
- The system remains Cloudflare Worker first, vanilla frontend first, and
  Wrangler CLI first.

The goal is not to avoid workflow changes. The goal is to make the workflow
more Mastra-native by making it thinner, typed, durable, inspectable, and less
dependent on paid model calls for known Cloudflare project policy.

### 1. Mastra-Native Control Plane

Mastra remains the first-class delivery coordinator.

- `delivery-start` accepts one required input: `projectFolder`.
- Input normalization discovers `vision.md`, optional `spec.md`, git state, and
  existing delivery state.
- Workflows are split by durable stage:
  - `delivery-start`
  - `delivery-plan`
  - `delivery-scaffold`
  - `delivery-implement`
  - `delivery-evidence`
  - `delivery-local-gate`
  - `delivery-report`
- Agents perform bounded judgment and implementation:
  - planner: product decomposition and open decisions.
  - architect: Cloudflare architecture review.
  - engineer: source code implementation inside assigned surfaces.
  - designer: vanilla public UI implementation.
  - tester: product-specific tests and runtime evidence.
  - judge: scoring and quality review.
- Scorers evaluate task plans, implementation notes, local evidence, Cloudflare
  policy fit, and final readiness.
- Memory stores compact run facts, not whole transcripts:
  - canonical domain terms.
  - accepted contracts.
  - chosen Cloudflare bindings.
  - generated scaffold profile.
  - farthest verified task.
  - unresolved human decisions.

### 2. Deterministic Cloudflare Worker Project Factory

Create a first-class project factory that runs before implementation agents.
This factory should not call a model.

It owns:

- `package.json`
- `wrangler.jsonc`
- `tsconfig.json` when TypeScript is selected.
- `vitest.config.ts` or `vitest.config.js`.
- `.gitignore`
- `.dev.vars.example`
- `public/index.html`
- `public/styles.css`
- `public/app.js`
- `src/index.ts` or `src/index.js`
- `src/contracts.ts` or `src/contracts.js` for TypeScript/JavaScript profiles.
- `test/` folder layout.
- optional `migrations/`, `r2/`, `kv/`, or fixture folders when requested.

The factory should support a small number of explicit profiles:

- `worker-vanilla-js`
- `worker-typescript`
- `worker-d1`
- `worker-kv`
- `worker-r2`
- `worker-workers-ai`
- `worker-workflows`
- `worker-authenticated-admin`
- `pages-explicit` only when the vision/spec says Pages.

Profiles compose, but they must be finite and testable. If a requested feature
does not map to a profile, planner records an open decision instead of
inventing infrastructure.

### 3. Deterministic Test Runtime Matrix

The test environment must be generated from file purpose, not guessed by agents.

Default test classes:

- Node/domain tests:
  - `test/contracts.test.ts`
  - `test/validation.test.ts`
  - `test/domain.test.ts`
  - `test/*.node.test.ts`
  - runtime: Node.
- Worker/API tests:
  - `test/api-routes.test.ts`
  - `test/provider-adapters.test.ts`
  - `test/worker-smoke.test.ts`
  - `test/*.worker.test.ts`
  - runtime: `@cloudflare/vitest-pool-workers`.
- Frontend DOM tests:
  - `test/frontend-*.test.js`
  - `test/ui-*.test.js`
  - runtime: `jsdom`.
- Release/local tests:
  - driven by Wrangler commands and HTTP probes, not unit-test globs.

Acceptance criteria:

- Pure contract tests never run in the Workers pool.
- Frontend tests never require React, Vite, or a bundler.
- Worker tests use fake env bindings unless local Wrangler evidence is
  explicitly requested.
- Runtime classification is validated by cheap fixture tests in this repo before
  any paid delivery run.

### 4. Source Contracts As Typed Project Rails

Contracts are still central, but they should live in typed project rails instead
of broad workflow text parsing.

The factory creates contract modules and schemas for:

- Env bindings.
- API route DTOs.
- validation limits.
- client-safe error codes.
- provider error normalization.
- public UI state vocabulary when needed.
- D1 entity names and status values when D1 is requested.

Agents may extend these contracts, but deterministic checks should verify:

- downstream code imports shared contracts instead of redefining shapes.
- API routes and UI agree on DTO names.
- D1 schema and repository code use the same column names.
- generated tests import contracts from the contract module.

Do not encode product-specific phrasing as general workflow law.

### 5. Workflow as Orchestrator, Not Framework

The workflow should become thinner.

Move policy into focused modules:

- `project-factory/`
  - scaffold profiles.
  - package scripts.
  - Wrangler config generation.
  - test runtime matrix.
  - binding policy.
- `delivery-plan/`
  - task graph normalization.
  - ownership boundaries.
  - evidence task routing.
- `delivery-evidence/`
  - command planning.
  - local runtime probes.
  - fixture validators.
- `delivery-memory/`
  - compact run facts.
  - accepted vocabulary.
  - contract registry.
- `delivery-scorers/`
  - Mastra scorers and eval fixtures.

The workflow should call these modules. It should not become a second private
framework beside Mastra.

## Implementation Plan

### Implementation Status

- Phase 0: complete.
- Phase 1: complete; the deterministic Worker project factory and test runtime
  matrix are covered by repo unit tests.
- Phase 2: complete; `delivery-scaffold` materializes a scaffold manifest,
  validates generated files against it, and feeds the manifest into later
  workflow stages.
- Phase 3: in progress; planner prompts no longer require root scaffold task
  ownership, active plan scaffold hygiene delegates root rails to the project
  factory, and task rows now receive workflow-derived `task`/`surface`/
  `evidence`/`runtime` metadata.
- Phase 4: in progress; `test/fixtures/delivery-projects/` now covers minimal
  JS Worker, TypeScript public UI, Workers AI, D1, KV/R2, explicit Pages, and
  benchmark-shaped source docs through cheap project-factory fixture tests.
- Phase 5: in progress; scaffold profile, runtime matrix, binding completeness,
  vanilla frontend, local evidence readiness, and model spend scorers are
  registered, and workflow events now include deterministic gate results and
  typed task packet emission.

### Phase 0: Freeze Expensive Run Loop

Goal: stop spending on full delivery runs until deterministic rails are ready.

Tasks:

- Add this spec.
- Add a note to `docs/OPERATING_DOCTRINE.md` that full delivery runs are paused
  during the enhanced-delivery reset unless explicitly approved.
- Keep `docs/RUN_OBSERVATIONS.md` as the factual benchmark history.
- Do not run `delivery:run` while implementing Phases 1-4.

Exit criteria:

- Spec committed.
- No active delivery process.
- Repo clean.

### Phase 1: Project Factory

Goal: create deterministic Worker project scaffolding that can be tested without
agents.

Tasks:

- Add `src/mastra/delivery-engine/project-factory/`.
- Define `ProjectProfile` and `ProjectFactoryInput` schemas.
- Implement profile selection from normalized source policy:
  - Worker default.
  - Pages only when explicitly requested.
  - TypeScript default for API-heavy projects unless source asks for JS.
  - vanilla public assets always.
- Generate canonical files for a minimal Worker app.
- Generate feature-specific bindings for Workers AI, D1, KV, R2, and Workflows.
- Generate a deterministic `vitest.config` with Node, Worker, and jsdom
  projects.
- Add fixture tests for each profile and profile composition.

Exit criteria:

- Fixture scaffolds pass repo unit tests.
- Generated `vitest.config` classifies contract, worker, and frontend tests
  correctly.
- `npm run typecheck` passes.

### Phase 2: Scaffold-First Workflow Stage

Goal: make scaffolding a first-class workflow step before agent implementation.

Tasks:

- Add `delivery-scaffold` workflow.
- Run project factory after planning and before build tasks.
- Persist a `scaffold-manifest.json` artifact containing:
  - profile list.
  - generated files.
  - test runtime matrix.
  - binding map.
  - package scripts.
  - validation commands.
- Add deterministic gates that compare generated project files against the
  scaffold manifest.
- Ensure implementation agents receive the scaffold manifest in task packets.

Exit criteria:

- Existing workflow can call scaffold stage without a model.
- Studio shows scaffold artifact and deterministic scaffold score.
- Tests cover project-folder inputs with no git repo and no spec file.

### Phase 3: Task Plan Simplification

Goal: stop using task-plan normalization to repair scaffold facts late.

Tasks:

- Remove scaffold/test-runtime responsibilities from planner prompts.
- Planner produces product tasks only after factory profile selection.
- Task ownership rules reference factory surfaces.
- Evidence tasks are generated from source task type and factory test matrix.
- Source criteria stay in `source_acceptance_criteria`; evidence tasks keep
  test-shaped acceptance criteria.
- Replace broad criterion text checks with typed task/evidence metadata:
  - `task.kind`
  - `surface.kind`
  - `evidence.kind`
  - `runtime.kind`

Exit criteria:

- Task plan fixture tests produce stable tasks for the benchmark app.
- No generated contract/domain test is routed to Worker pool.
- Smell audit remains at `Total smells: 0`.

### Phase 4: Cheap Fixture Harness

Goal: prove harness behavior without paid model calls.

Tasks:

- Add fixture projects under `test/fixtures/delivery-projects/`.
- Include at least:
  - minimal Worker JS.
  - TypeScript Worker with public UI.
  - Worker with Workers AI binding.
  - Worker with D1.
  - Worker with KV/R2.
  - benchmark-shaped app.
- Add tests that run project factory and validation planners against fixtures.
- Add static checks for generated files.
- Add command-plan tests without executing network-dependent commands.
- Add optional local command execution only where sandbox-safe.

Exit criteria:

- Fixture suite catches the Run 9 class of error.
- Fixture suite catches Pages-vs-Worker drift.
- Fixture suite catches React/Vite introduction.
- Fixture suite catches missing Workers AI binding.

### Phase 5: Mastra Observability And Scoring Reset

Goal: keep Mastra expert-level, but measure the right things.

Tasks:

- Add scorers for:
  - scaffold profile fit.
  - test runtime matrix correctness.
  - Cloudflare binding completeness.
  - vanilla frontend compliance.
  - local evidence readiness.
  - model spend per completed task.
- Record structured events for:
  - scaffold generation.
  - task packet emission.
  - deterministic gate result.
  - agent call start/end.
  - command start/end.
  - retry reason.
  - human gate.
- Store compact memory facts after each stage.
- Add Studio-friendly summaries that show:
  - current stage.
  - farthest verified task.
  - deterministic blockers.
  - agent blockers.
  - local evidence status.
  - estimated model spend.

Exit criteria:

- Studio can explain progress without reading raw logs.
- Scorers appear for scaffold, evidence, and implementation quality.
- Memory can answer why a term or binding was chosen.

### Phase 6: Reintroduce Agents Under Rails

Goal: use agents for product-specific code only after deterministic rails pass.

Tasks:

- Update task packets to include:
  - scaffold manifest.
  - allowed surfaces.
  - runtime class.
  - source contracts.
  - direct dependency surfaces.
  - exact verification command class.
- Keep prompts short and bounded.
- Disallow agents from editing scaffold-owned files unless a task explicitly
  owns them.
- Route test-writing tasks by runtime kind.
- Add model budget caps by stage.

Exit criteria:

- Agents do not write `vitest.config` to fix a product test.
- Agents do not add dependencies outside task ownership.
- Agents cannot turn a Node contract test into a Worker-pool test.
- Failed verification produces a typed blocker classification.

### Phase 7: One Paid Benchmark Run

Goal: run one full delivery pass only after Phases 1-6 are green.

Run condition:

- All fixture tests pass.
- Typecheck passes.
- Smell audit passes.
- Scaffold matrix verifies the benchmark project shape.
- The run journal has a clear forward-progress question.

Success criteria:

- Gets past the last known Run 9 blocker.
- Reaches local evidence generation.
- Stops only at a meaningful human gate or a genuinely product-specific bug.
- Produces a cost/stage report.

Failure protocol:

- Read report and events.
- Classify as factory bug, task-plan bug, agent implementation bug,
  environment issue, or human decision.
- Fix with fixture/unit tests first.
- Do not immediately rerun full delivery unless the fix cannot be tested
  cheaply.

## New File/Module Inventory

Planned additions:

- `docs/enhanced-delivery-spec.md`
- `src/mastra/delivery-engine/project-factory/index.ts`
- `src/mastra/delivery-engine/project-factory/schemas.ts`
- `src/mastra/delivery-engine/project-factory/profiles.ts`
- `src/mastra/delivery-engine/project-factory/files.ts`
- `src/mastra/delivery-engine/project-factory/test-runtime-matrix.ts`
- `src/mastra/delivery-engine/project-factory/wrangler-config.ts`
- `src/mastra/delivery-engine/project-factory/package-manifest.ts`
- `src/mastra/delivery-engine/scaffold-workflow.ts`
- `src/mastra/delivery-engine/scaffold-scorers.ts`
- `test/delivery-engine/project-factory.test.ts`
- `test/delivery-engine/test-runtime-matrix.test.ts`
- `test/fixtures/delivery-projects/`

Likely edits:

- `src/mastra/delivery-engine/workflow.ts`
- `src/mastra/delivery-engine/workflow-schemas.ts`
- `src/mastra/delivery-engine/runner.ts`
- `src/mastra/index.ts`
- `docs/OPERATING_DOCTRINE.md`
- `README.md`

## Acceptance Criteria

This reset is done when:

- A benchmark-shaped fixture proves the scaffold/test matrix without a model.
- The generated project routes contract tests to Node, Worker/API tests to the
  Workers pool, and frontend tests to jsdom.
- Planner no longer owns core scaffold policy.
- Agents no longer repair core scaffold/test environment facts during paid runs.
- Mastra Studio exposes scaffold, plan, implementation, evidence, scorer, and
  local-gate status clearly.
- A full benchmark run gets beyond the Run 9 blocker without changing generated
  test runtime policy during the run.
- Total model spend per successful local-gate run is predictable enough to be
  budgeted before the run starts.

## Explicit Non-Goals

- Do not make this generic for mobile, desktop, React, Next, or arbitrary hosts.
- Do not add GitHub Actions deployment.
- Do not default to Pages.
- Do not rely on agents to invent Wrangler config, test runtime routing, or
  binding policy.
- Do not hide blockers by weakening evidence gates.
- Do not resume full paid run loops until fixture coverage proves the rails.

## Immediate Next Step

Start with Phase 1. Build the project factory and test runtime matrix first.
The first regression fixture should encode the Run 9 failure:

- input profile: TypeScript Worker with public UI and contract tests.
- generated `vitest.config.ts` must route `test/contracts.test.ts` to Node.
- generated Worker/API tests must still route to the Workers pool.
- generated frontend shell tests must route to jsdom.

Only after that passes should the delivery workflow be changed to call the
factory.
