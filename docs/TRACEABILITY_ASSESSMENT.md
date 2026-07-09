# Traceability Assessment

Read this after `docs/OPERATING_DOCTRINE.md` whenever the goal is to review,
repair, or trust the Delivery Engine. This document exists because "tests are
green" is not the same thing as "the generated project works."

## Principle

Chris should not need magic words to get a rigorous assessment. When asked to
review this repo for correctness, assume the real request is:

> Run a traceability assessment. For every important claim this harness makes,
> map: source requirement -> harness producer -> generated artifact -> verifier
> -> observed evidence. Do not accept structural checks as proof of executable
> correctness. Materialize a fresh project when needed and run the generated
> project's own declared commands. Identify every unproven assumption,
> version-drift risk, stale test, and wrong failure classification before any
> paid delivery run.

## Active Goal

Run a repo-wide traceability assessment that maps source requirements to harness
producers, generated artifacts, verifiers, and observed evidence. Fix gaps with
cheap deterministic tests before any paid delivery rerun. Keep this process
durable across context compaction by updating this file at each natural
checkpoint.

This is the active repo-wide loop until explicitly replaced:

1. Start from the first open row in the Active Traceability Matrix.
2. Decompose that row into concrete claims the harness makes.
3. For each claim, map source requirement -> producer -> generated artifact ->
   verifier -> observed evidence.
4. If evidence is lower than the claim requires, add the smallest deterministic
   proof or record an explicit decision that the claim is out of scope.
5. Update this file with the proof or decision, then commit and push.

The Phase 5 deterministic audit is closed. The all-profile Worker binding
scaffold has deterministic Wrangler schema and hygiene proof, generated scaffold
scripts align with release-gate command planning, Pages and Durable Object scope
boundaries are explicit, and local runtime probe planning is covered by tests.
Live Wrangler runtime evidence still belongs to the next approved local release
gate because the Codex sandbox can deny local listener creation.

The Phase 6 deterministic audit is closed. Delivery and Cloudflare eval suites
now prove scorer fixtures, gate thresholds, isolated Mastra experiment runs, and
native `scores` domain read-back. Observability state, spans/logs, rubric score
mirroring, and runner reports are covered by deterministic tests.

The Phase 7 deterministic audit is closed. README/operator docs now match
registered routes, package scripts, Studio facade behavior, source-document
defaults, Wrangler type-generation behavior, score persistence claims, and run
journal discipline.

The repo-wide traceability pass has no open P1 rows. The next paid delivery run
is allowed only when Chris explicitly approves a specific forward-progress
question.

## Traceability Assessment Trigger

When Chris asks for the repo to be reviewed "like a traceability assessment,"
"no more guessing," "make sure everything is right and intelligent," "would an
expert be impressed," or any similar wording, do not answer with confidence
alone. Run this assessment loop and report evidence level by evidence level.

The exact operating sentence is:

> Run a traceability assessment. For every important claim this harness makes,
> map source requirement to harness producer, generated artifact, verifier, and
> observed evidence. Do not accept structural checks as proof of executable
> correctness. Use current installed dependency schemas and types where
> available. Fix missing proof with cheap deterministic tests before any paid
> model run.

## Compaction Re-Entry Checklist

When context has been compressed, resume from here before touching code:

1. Read `docs/OPERATING_DOCTRINE.md`, then this file.
2. Check `git status --short` and identify the most recent completed checkpoint.
3. Continue the first open row in the Active Traceability Matrix.
4. Use the Required Loop for that row: requirement -> producer -> artifact ->
   verifier -> observed evidence -> gap classification -> cheap fix.
5. Update this file with the new evidence, then commit and push at the next
   natural checkpoint.

## Required Loop

For every significant feature, gate, scaffold file, workflow stage, agent
contract, scorer, eval, and Cloudflare policy:

1. **Source Requirement**: Identify the source of truth: `vision.md`, docs,
   rubric, Cloudflare policy, Mastra API, operator preference, or run evidence.
2. **Harness Producer**: Name the exact module/function/prompt/tool that
   creates or enforces the behavior.
3. **Generated Artifact**: Name the emitted file, state record, event, score,
   workflow output, or generated project behavior.
4. **Verifier**: Name the actual test, typecheck, runtime command, scorer, eval,
   or local probe that proves the artifact works.
5. **Observed Evidence**: Record the most recent proof. Structural checks,
   regex checks, and file-presence checks are lower evidence than typecheck,
   generated-project tests, Wrangler probes, and runtime behavior.
6. **Gap Classification**: If evidence is missing or weak, classify it as:
   scaffold baseline, harness bug, generated product bug, model miss, missing
   evidence, environment issue, wrong failure classification, or human decision.
7. **Cheap Fix First**: Add deterministic fixture/unit/type tests before another
   paid `delivery:run`. Do not use full model runs to discover bugs that static
   or generated-project tests can reveal.
8. **Commit Checkpoint**: Commit and push after each natural traceability
   checkpoint.

## Evidence Ladder

Use the strongest reasonable proof. Do not let lower levels masquerade as higher
ones.

| Level | Evidence | Meaning |
| --- | --- | --- |
| 0 | Claim only | A prompt, comment, or doc says it should work. Not proof. |
| 1 | Structural | File exists, string/glob is present, schema shape looks right. |
| 2 | Type-level | The harness and generated artifact compile against current types. |
| 3 | Command | The generated project's declared command passes. |
| 4 | Runtime | Local Wrangler/dev-server/probe executes behavior. |
| 5 | End-to-end | Fresh delivery run reaches local-test/human approval handoff. |

If a feature claims to generate working software, Level 1 is not enough.

## Hard Rules

- No paid benchmark rerun while a known Level 2 or Level 3 scaffold baseline gap
  is open.
- Deterministic scaffold outputs must be executable-proofed, not just
  shape-proofed.
- Generated project dependencies using `latest` require drift-aware validation
  or pinned versions with explicit update tests.
- Fresh-project failures in scaffold-owned files are not stale workspace
  contamination.
- Wrong failure classifications are bugs because they send the next repair loop
  to the wrong place.
- Broad string matching is not traceability. Prefer typed fixtures,
  materialized generated projects, generated-project typecheck/test commands,
  and small runtime probes.

## Active Traceability Matrix

| Status | Area | Source Requirement | Producer | Artifact | Current Verifier | Gap |
| --- | --- | --- | --- | --- | --- | --- |
| Closed | Worker scaffold Vitest matrix | Generated Worker projects must typecheck and test with declared dependencies. | `project-factory/test-runtime-matrix.ts`, `project-factory/toolchain.ts` | `vitest.config.ts`, generated `package.json` | `project-factory.test.ts` materializes scaffold and runs TypeScript against pinned Vitest/Cloudflare pool types. | Closed in `3d129a7`; per-project `passWithNoTests` removed and Worker test toolchain pinned. |
| Closed | Fresh failure classification | Clean generated projects should not be labeled stale workspace contamination. | implementation verification/retry classification using recorded scaffold manifest provenance | `SCAFFOLD_BASELINE_VERIFICATION` remediation | `workflow-policy.test.ts` covers fresh scaffold-owned `vitest.config.ts` failure. | Closed in `fc4617e`; scaffold-owned verification failures are not stale and stop as harness scaffold baseline failures. |
| Closed | Scaffold validation gate | Deterministic scaffold should be safe before T01 builds on it. | `project-factory/validation.ts`, scaffold workflow | scaffold manifest and checks | `scaffold_vitest_config_typecheck` runs before T01 and compiles generated `vitest.config.ts` against the pinned Worker test toolchain. | Closed in `ddeff36`; bad generated Vitest config fails during scaffold validation before model build tasks. |
| Closed | Dependency drift | Generated project toolchain versions must not silently drift under the harness. | `project-factory/toolchain.ts`, `project-factory/package-manifest.ts` | generated `package.json` | Exact-version package assertions plus generated `vitest.config.ts` compile proof. | Closed in `3d129a7`; generated packages no longer use `latest`. |
| Closed | Acceptance-contract sequencing | Source contract tasks should not be blocked by behavior only provable in downstream tests. | `taskVerificationAcceptanceContractCriteria`, `taskDeferredAcceptanceContractCriteria`, implementation task packets, smell audit | immediate `acceptance_contracts`, explicit `deferred_acceptance_contracts`, pending evidence counts | `acceptance-contract-sequencing.test.ts`, `smell-audit.test.ts`, benchmark artifact smell audit, typecheck, Mastra build | Closed in this checkpoint; benchmark T01 now has four immediate structural contracts and three pending deferred evidence contracts instead of blocking on behavior evidence. |
| Closed | Remaining static smell audit findings | Cheap static audits should be clean or explicitly classified before another paid run. | `smell-audit.ts`, acceptance-contract evidence helpers, Worker config/package evidence, model catalog evidence policy | smell audit report for `/Users/chrislema/mastra/projects/benchmark/.delivery/artifacts/task-plan.revision-1.json` | `npm run audit:smells -- --projectFolder /Users/chrislema/mastra/projects/benchmark --taskPlan /Users/chrislema/mastra/projects/benchmark/.delivery/artifacts/task-plan.revision-1.json --assume-typecheck --assume-tests --json` | Closed in this checkpoint; audit reports `smellCount: 0`. T02 uses structured Wrangler/package evidence, and T03 helper behavior is routed to a model-catalog evidence task. |
| Closed | Mastra-native surface registration | Every first-class Mastra surface should be registered, typed, and Studio-visible without leaking internal state. | `src/mastra/index.ts`, agents, tools, workflows, scorers, processors, memory, workspaces, API routes | registered Mastra runtime surface map and tests | `index-registration.test.ts`, full test suite, `npm run typecheck` | Closed in this checkpoint; test now proves agents, workflows, agent processor workflows, tools, scorers, processors, memory, workspace, and API routes are registered through Mastra's current key/id APIs. |
| Closed | Worker package hygiene scaffold baseline | Deterministic TypeScript Worker scaffolds must satisfy the same package, gitignore, and tsconfig hygiene checks the release gate uses. | `project-factory/files.ts`, `workerPackageScaffoldGaps` | generated `.gitignore`, `tsconfig.json`, `package.json` | `project-factory.test.ts`, cheap materialized scaffold proof, full test suite, `npm run typecheck`, `npm run build` with network | Closed in this checkpoint; fresh TypeScript Worker scaffolds now emit `module: "ESNext"`, `WebWorker` lib, and wildcard local secret/state ignores, and `workerPackageScaffoldGaps` returns no gaps. |
| Closed | Workers AI scaffold local test safety | AI-enabled Worker scaffolds must be honest that Workers AI is remote without causing `npm test` to start remote binding proxy sessions or emit cost warnings. | `project-factory/wrangler-config.ts`, `project-factory/test-runtime-matrix.ts` | generated `wrangler.jsonc`, generated `vitest.config.ts` | `project-factory.test.ts`, `project-factory-fixtures.test.ts`, `test-runtime-matrix.test.ts`, full test suite, `npm run typecheck`, fresh generated scaffold `npm run typecheck` and `npm test` | Closed in this checkpoint; generated AI bindings now use `remote: true` and generated Worker-pool tests set `remoteBindings: false`, so the scaffold's own commands pass without the Wrangler AI remote-resource warning. |
| Closed | Worker compatibility date scaffold policy | New Worker scaffolds should use the same current compatibility date as the Worker config hygiene policy and task packet rails. | `worker-compatibility-date.ts`, `project-factory/schemas.ts`, `worker-hygiene.ts` | generated `wrangler.jsonc` compatibility_date and worker config hygiene diagnostics | `project-factory.test.ts`, full test suite, `npm run typecheck`, all-profile generated scaffold `workerConfigHygieneGaps`, all-profile generated scaffold `npm run typecheck` and `npm test` | Closed in this checkpoint; the project factory and Worker hygiene share one compatibility-date helper, fresh all-profile scaffolds emit `2026-07-09`, and `workerConfigHygieneGaps` returns no gaps. |
| Closed | Static assets scaffold runtime smoke | Worker-first vanilla frontends need generated tests that exercise `env.ASSETS.fetch`, not only check file presence. | `project-factory/files.ts` | generated `test/worker-smoke.test.ts`, generated Worker static asset fallback | `project-factory.test.ts`, full test suite, `npm run typecheck`, fresh all-profile generated scaffold `npm test` | Closed in this checkpoint; the generated Worker smoke test now verifies `/api/health` and the ASSETS fallback path, and a fresh all-profile scaffold reports 3 passing tests. |
| Closed | Source-declared custom domain routes | Custom domains are in Chris's Worker deployment scope, but should only affect config when source docs or intent declare exact domains. | `source-policy.ts`, `planner-prompt-policy.ts`, `project-factory/wrangler-config.ts` | source policy `customDomains`, planner policy line, generated production `routes` entries with `custom_domain: true` | `workflow-policy.test.ts`, `project-factory.test.ts`, full test suite, `npm run typecheck`, custom-domain generated scaffold `workerConfigHygieneGaps`, `npm run typecheck`, and `npm test` | Closed in this checkpoint; exact custom domains are normalized from source docs/intent, production-only custom-domain routes are emitted, staging remains route-neutral, and a fresh custom-domain scaffold has zero config hygiene gaps. |
| Closed | Cloudflare binding profile schema and hygiene proof | Worker-first profiles for Workers AI, D1, KV, R2, Workers Workflows, Static Assets, and Wrangler env mirrors must compose in one generated scaffold and match the installed Wrangler toolchain. | `project-factory/profiles.ts`, `project-factory/files.ts`, `project-factory/wrangler-config.ts`, `worker-hygiene.ts` | generated `wrangler.jsonc`, `src/index.ts`, scaffold manifest binding map, generated environment mirrors | `project-factory.test.ts` materializes an all-profile scaffold, validates `wrangler.jsonc` against `node_modules/wrangler/config-schema.json` with AJV, runs `workerConfigHygieneGaps`, runs `validateMaterializedScaffold`, full test suite, and `npm run typecheck` | Closed in this checkpoint; the combined scaffold now proves schema-valid Wrangler config, top-level/staging/production binding mirrors, Env binding alignment, and scaffold validation for AI, D1, KV, R2, Workflows, and Static Assets without a paid delivery run. |
| Closed | Pages exception scope guard | Pages Functions are allowed only when source docs require Pages, but the deterministic scaffold baseline must not pretend to support Pages runtime output. | `source-policy.ts`, `planning/pages-policy.ts`, `scaffold-workflow.ts`, README operator scope | source policy `pagesRequired`, task-plan Pages hygiene, scaffold fail-fast error, no Worker scaffold written for explicit Pages source | `workflow-policy.test.ts`, `project-factory.test.ts`, `project-factory-fixtures.test.ts`, `scaffold-workflow.test.ts`, full test suite, and `npm run typecheck` | Closed in this checkpoint; Pages remains a source-gated planning/scoring exception, and explicit Pages projects now fail fast at the Worker-only deterministic scaffold boundary until a dedicated Pages scaffold and runtime proof are intentionally added. |
| Closed | Durable Object scope and hygiene proof | Durable Objects are a Worker architecture choice for real-time coordination/stateful connections, but not a deterministic scaffold profile in Chris's default Worker harness. If a task introduces DO config, binding names must align across Wrangler config, environments, and Env. | `cloudflare-evals.ts`, `skills/select-cloudflare-components/SKILL.md`, `worker-hygiene.ts`, task-boundary hygiene | Cloudflare architecture eval fixture, generated task-level `durable_objects.bindings`, `Env` `DurableObjectNamespace`, env mirrors | `scorers.test.ts`, Cloudflare eval fixtures/gates, `workflow-policy.test.ts` DO binding-alignment regression, full test suite, and `npm run typecheck` | Closed in this checkpoint; DO remains an architecture/scorer/task-level capability rather than a project-factory scaffold claim, and Worker config hygiene now explicitly catches and accepts DO binding alignment. |
| Closed | Generated scripts and release-gate command alignment | Generated Worker package scripts and release-gate commands must agree, avoid redundant composite checks, and generate Wrangler types before checking freshness when `worker-configuration.d.ts` is absent. | `project-factory/package-manifest.ts`, `build-deployment-policy.ts`, `release-gate-command-plan.ts`, `evidence/release-gate-evidence.ts` | generated `package.json` scripts, scaffold `validationCommands`, release-gate command plan | `workflow-policy.test.ts` materializes a generated Worker scaffold and checks the release-gate command plan, `project-factory.test.ts`, full test suite, and `npm run typecheck` | Closed in this checkpoint; fresh TypeScript Worker scaffolds now plan `wrangler types` before package checks, existing generated types still use `wrangler types --check`, and generated `check` scripts no longer duplicate `typecheck`/`test` evidence. |
| Closed | Local runtime probe planning boundary | Local runtime probes must be planned deterministically from Worker config, public assets, health/API routes, and source-gated product routes. Actual `wrangler dev` execution requires a local process that can bind `127.0.0.1`. | `release-gate-runtime-probe-plan.ts`, `release-gate-probes.ts`, `evidence/release-gate-evidence.ts` | `ReleaseGateRuntimeProbePlan`, static asset probes, health probes, short-link/profile/latest-transcript probes | `workflow-policy.test.ts` runtime-probe planner tests, release-gate evidence planner tests, full test suite, `npm run typecheck`, and observed sandbox `listen EPERM` for nested Worker-pool command execution | Closed as a deterministic audit decision; unit tests own probe planning, while live Wrangler listener/runtime evidence is deferred to the next approved local release gate outside the restricted sandbox. |
| Closed | Evals, scorers, and observability proof | Every scorer/eval/observability claim should map to fixtures, registration, persisted state, score records, and diagnostic reports that a Mastra expert can inspect. | `scorers.ts`, `evals.ts`, `cloudflare-evals.ts`, `observability.ts`, `state-service.ts`, `runner.ts`, Mastra registration | scorer outputs, eval gate reports, native `scores` rows, observability logs/spans/score events, `.delivery` projections, `.delivery/runs/latest.json` | `evals.test.ts` and `cloudflare-evals.test.ts` run isolated Mastra scorer experiments and read back native `scores` rows for every scorer; `observability.test.ts` writes/reads LibSQL observability state and rubric scores; `index-registration.test.ts`; `runner.test.ts`; full test suite; `npm run typecheck` | Closed in this checkpoint; scorer/eval/observability claims are backed by fixture coverage, threshold gate reports, persisted score read-back, storage-backed state diagnostics, and run reports without a paid delivery run. |
| Closed | Operator docs and run discipline | Operator-facing docs should match actual Studio/CLI commands, source-document defaults, paid-run stop conditions, and run-journal discipline. | README, `docs/RUN_OBSERVATIONS.md`, runner/API schemas, launcher route, package scripts | documented commands, Studio launcher behavior, run observation entries, stop condition wording | `operator-docs.test.ts` checks README commands/routes against `package.json` and registered API routes, verifies fresh-vs-existing Wrangler type-generation wording, and fails orphaned run-journal start entries; `runner.test.ts`; full test suite; `npm run typecheck` | Closed in this checkpoint; README reflects the `deliveryStartWorkflow` facade, `/api/delivery/launcher`, CLI/API reports, native score persistence, and current release-gate type-generation behavior, while the run journal no longer has an orphaned Run 9 start entry. |

## Completed Checkpoints

- `e65e40b`: Added this traceability doctrine and wired it into
  `AGENTS.md` / `docs/OPERATING_DOCTRINE.md`.
- `3d129a7`: Removed invalid generated Vitest project options, pinned the Worker
  test toolchain, and added a generated-config TypeScript compile proof.
- `fc4617e`: Classified fresh scaffold-owned verification failures as
  `SCAFFOLD_BASELINE_VERIFICATION` using the recorded scaffold manifest instead
  of calling them stale workspace contamination.
- `ddeff36`: Added a scaffold workflow validation check that typechecks
  generated `vitest.config.ts` before any T01 model build task runs.
- this checkpoint: Split immediate and deferred acceptance contracts so source tasks no
  longer stall on behavior evidence owned by downstream test tasks; smell audit
  preserves those deferred source requirements as pending evidence.
- this checkpoint: Replaced generic T02 config/package script evidence with
  structured parsers and added model-catalog behavior evidence tasks; benchmark
  static smell audit is now zero.
- this checkpoint: Added a Mastra registry proof that checks every Delivery
  Engine first-class surface through current Mastra registration APIs; full
  tests and typecheck pass.
- this checkpoint: Aligned the deterministic Worker scaffold with release-gate
  package hygiene by generating Worker-safe TypeScript config and local
  secret/state ignores; a fresh scaffold now passes `workerPackageScaffoldGaps`.
- this checkpoint: Made generated Workers AI scaffolds explicit about remote AI
  bindings while keeping Worker-pool tests from starting remote binding proxy
  sessions; a fresh AI scaffold passes its own typecheck and test commands
  without the Wrangler AI remote-resource warning.
- this checkpoint: Unified the project factory and Worker hygiene policy on one
  current compatibility-date helper; an all-profile Worker scaffold now has zero
  config hygiene gaps and passes its own typecheck/test command path.
- this checkpoint: Added generated Worker smoke coverage for the ASSETS fallback
  path; a fresh all-profile scaffold's own `npm test` now runs 3 passing tests.
- this checkpoint: Added source-declared custom domain policy and production-only
  custom-domain Wrangler routes; a fresh custom-domain scaffold has zero config
  hygiene gaps and passes its own typecheck/test command path.
- this checkpoint: Added an explicit all-profile Cloudflare Worker scaffold
  proof that validates generated `wrangler.jsonc` against the installed
  Wrangler schema, checks Worker config hygiene, confirms env binding mirrors,
  and keeps project-factory scaffold validation green.
- this checkpoint: Made explicit Pages source policy fail fast at the
  Worker-only deterministic scaffold boundary instead of writing a misleading
  standalone Worker scaffold; Pages remains a planning/scoring exception until
  a dedicated Pages scaffold and runtime proof exist.
- this checkpoint: Clarified Durable Objects as an architecture/scorer/task-level
  capability, not a deterministic scaffold profile, and added Worker config
  hygiene coverage for DO binding alignment.
- this checkpoint: Aligned generated Worker scaffold scripts with release-gate
  command planning, generating missing Wrangler types before freshness checks
  and avoiding duplicate composite `check` execution when `typecheck` and
  `test` are already planned.
- this checkpoint: Closed the deterministic half of Cloudflare runtime proof by
  documenting that local runtime probe planning is unit-tested while live
  `wrangler dev` listener evidence belongs to the next approved local release
  gate outside the restricted Codex sandbox.
- this checkpoint: Proved delivery and Cloudflare eval suites persist native
  Mastra score rows for every registered scorer, and tied Phase 6 to
  registration, threshold gate reports, observability storage, and runner report
  tests.
- this checkpoint: Aligned operator docs with package scripts, registered API
  routes, Studio facade guidance, CLI/API report behavior, Wrangler type
  generation, native score persistence, and fixed the misplaced Run 9 journal
  outcome with a regression test for orphaned started runs.

## Ordered Repo-Wide Pass

### Phase 1: Scaffold Baseline

- Materialize representative fresh Worker projects from the project factory.
- Prove generated `package.json`, `wrangler.jsonc`, `tsconfig.json`,
  `vitest.config.ts`, Worker entrypoint, public shell, and test shells compile
  or pass their declared commands.
- Fix P0/P1 scaffold gaps with fixture tests before any paid rerun.

### Phase 2: Verification And Failure Classification

- Map every deterministic verification failure class to its producer and repair
  route.
- Add regression tests for fresh scaffold-owned failures, preserved stale
  downstream failures, in-boundary repairs, and out-of-plan repairs.
- Ensure operator-facing remediation names the right class.

### Phase 3: Planning And Contract Evidence

- Map source criteria to task-plan normalization, task packets,
  implementation notes, deterministic gates, evidence tasks, and release gates.
- Move behavior-only requirements to generated-project tests or runtime probes.
- Keep source criteria visible as `source_acceptance_criteria` when another task
  owns the proof.

### Phase 4: Mastra-Native Surfaces

- Verify every agent, tool, workflow, scorer, processor, memory, workspace, API
  route, and storage/observability component is registered in
  `src/mastra/index.ts`.
- Confirm Studio-facing entrypoints hide internal state and use typed schemas.
- Confirm workflow modules remain focused and `workflow.ts` stays a barrel.

### Phase 5: Cloudflare Runtime Proof

- Map Worker-first policy to generated config, bindings, scripts, tests, and
  release evidence.
- Prove Workers AI, Static Assets, Wrangler env mirrors, D1/KV/R2/DO/Workflow
  decisions, and Pages exceptions with fixtures and local commands.
- Prefer Wrangler/local probes over static claims where behavior matters.

Status: deterministic audit closed. Live Wrangler runtime execution remains a
release-gate responsibility for the next approved local run because sandboxed
unit tests can block local listener creation.

### Phase 6: Evals, Scorers, And Observability

- Trace every scorer/eval to positive and negative fixtures.
- Confirm observability records enough state, logs, scores, and artifacts to
  diagnose a run without asking Chris to paste terminal output.
- Confirm failure reports use the same classification vocabulary as this doc.

Status: closed. Delivery and Cloudflare eval experiments run through isolated
Mastra storage, every scorer has positive and negative fixture coverage, score
rows are read back from the native `scores` domain, and observability/runner
tests cover storage-backed delivery state, rubric score mirroring, and diagnostic
reports.

### Phase 7: Operator Docs And Run Discipline

- Check README/operator docs against actual commands and Studio behavior.
- Ensure `docs/RUN_OBSERVATIONS.md` records every paid run.
- Ensure no next paid run is recommended when a cheap traceability test can
  answer the question first.

Status: closed. README and run-journal discipline are covered by
`operator-docs.test.ts`, runner schema tests, the active stop condition, and the
compaction re-entry instructions in this file.

## Current Stop Condition

Do not run another paid benchmark delivery pass until:

- Chris explicitly approves a paid run for a specific forward-progress question.
- `docs/RUN_OBSERVATIONS.md` has a pre-run entry for that question.
- The next proof, run result, or explicit stop decision is committed and pushed.
