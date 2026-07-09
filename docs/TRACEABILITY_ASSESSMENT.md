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
| P1 | Remaining static smell audit findings | Cheap static audits should be clean or explicitly classified before another paid run. | `smell-audit.ts`, acceptance-contract evidence helpers, Worker config/package evidence, model catalog evidence policy | smell audit report for `/Users/chrislema/mastra/projects/benchmark/.delivery/artifacts/task-plan.revision-1.json` | `npm run audit:smells -- --projectFolder /Users/chrislema/mastra/projects/benchmark --taskPlan /Users/chrislema/mastra/projects/benchmark/.delivery/artifacts/task-plan.revision-1.json --assume-typecheck --assume-tests --json` | Current audit reports four smells: two T02 generic file evidence findings and two T03 unverified model-catalog helper behavior findings. Classify/fix with deterministic tests before any paid rerun. |

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

### Phase 6: Evals, Scorers, And Observability

- Trace every scorer/eval to positive and negative fixtures.
- Confirm observability records enough state, logs, scores, and artifacts to
  diagnose a run without asking Chris to paste terminal output.
- Confirm failure reports use the same classification vocabulary as this doc.

### Phase 7: Operator Docs And Run Discipline

- Check README/operator docs against actual commands and Studio behavior.
- Ensure `docs/RUN_OBSERVATIONS.md` records every paid run.
- Ensure no next paid run is recommended when a cheap traceability test can
  answer the question first.

## Current Stop Condition

Do not run another paid benchmark delivery pass until:

- The remaining static smell audit findings are classified or fixed with cheap
  deterministic tests.
- The new proof or decision is committed and pushed.
