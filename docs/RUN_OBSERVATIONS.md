# Delivery Run Observations

Read this after `docs/OPERATING_DOCTRINE.md` whenever resuming benchmark or
delivery-run work. This is the durable run journal that survives context
compaction.

## Rule

Every CLI or Studio delivery run gets an entry here before it starts and an
update when it stops. The point is to preserve the actual forward-progress
thread, not just the final error.

For each run, record:

- Date and approximate time.
- Project folder.
- Command or Studio input.
- Whether the folder was preserved or cleaned.
- Forward-progress question.
- Workflow run ID, delivery run ID, and report path when known.
- Reused stages and newly executed stages.
- Farthest verified stage or task.
- Failure class: generated product bug, harness bug, model miss, missing
  evidence, environment issue, or human decision.
- Concrete error or judge gap.
- Current hypothesis.
- Cheap/static verification already tried.
- Next fix, rerun, or stop decision.

## Environment Notes

- `npm run build` for the Mastra harness needs network access because Mastra's
  build process installs dependencies after bundling. Sandbox-only attempts
  regularly fail with `ENOTFOUND registry.npmjs.org`; rerun with network access
  before treating build failure as a code issue.

## Active Benchmark Thread

### 2026-07-08 - Benchmark Resume Baseline

- Project folder: `/Users/chrislema/mastra/projects/benchmark`
- Folder handling: preserve existing folder and `.delivery` state so the run can
  resume from prior artifacts.
- Latest known workflow run: `c46b981f-4b48-4fd9-8958-a23954d1f270`
- Latest known delivery run: `run-mrbngnav-7c2fbebb`
- Latest known report:
  `/Users/chrislema/mastra/projects/benchmark/.delivery/runs/c46b981f-4b48-4fd9-8958-a23954d1f270.json`
- Reused stages in that run: `T01`, `T02`, `T05`
- New progress: `T03` generated provider adapter and normalized error surfaces,
  and TypeScript passed for generated code.
- Farthest verified task: `T03` reached deterministic/judge contract checking,
  past the earlier provider import/typecheck blocker.
- Current blocker: provider adapter contracts rejected AC14-AC18 even though the
  generated implementation split normalized provider errors into `src/errors.ts`
  while provider execution stayed in `src/providers.ts`.
- Failure class: missing harness evidence, not an obvious generated product
  typecheck failure.
- Current hypothesis: `providerAdapterContractEvidence` was too file-local and
  should recognize a split provider/error module without moving logic back into
  one generated file.
- Cheap verification before the next paid run: focused workflow policy test plus
  a static `acceptanceContractsForTask` probe against the benchmark `T03`
  artifact. Only rerun the full delivery workflow after those pass.
- Next forward-progress question: after the split-error evidence fix, does the
  preserved benchmark folder resume past `T03` instead of failing on AC14-AC18?

### 2026-07-08 - Split Provider Error Evidence Fix Verified

- Project folder: `/Users/chrislema/mastra/projects/benchmark`
- Folder handling: preserved; no full delivery run executed for this checkpoint.
- Fix scope: harness evidence in
  `src/mastra/delivery-engine/acceptance-contracts.ts` now recognizes provider
  adapter behavior split across `src/providers.ts` and `src/errors.ts`.
- Cheap/static verification:
  - `npm test -- test/delivery-engine/workflow-policy.test.ts` passed.
  - Static `acceptanceContractsForTask` probe against benchmark `T03` revision
    verified AC01-AC18 with no gaps.
  - `npm run typecheck` passed.
  - `git diff --check` passed.
  - `npm run build` passed with network access; the sandbox-only attempt failed
    at dependency install with `ENOTFOUND registry.npmjs.org`.
- Farthest verified stage remains `T03`; this checkpoint proves the known
  deterministic AC14-AC18 blocker should no longer stop the next resumed run.
- Next forward-progress question: run the preserved benchmark folder and confirm
  it proceeds beyond `T03` to the next real build or review blocker.

### 2026-07-08 - CLI Resume Run Started

- Project folder: `/Users/chrislema/mastra/projects/benchmark`
- Command:
  `npm run delivery:run -- --projectFolder /Users/chrislema/mastra/projects/benchmark --deploy local`
- Folder handling: preserved; do not clear existing generated files or
  `.delivery` state.
- Forward-progress question: does the resumed CLI run get past the previous
  `T03` deterministic AC14-AC18 blocker now that split provider/error module
  evidence is recognized?
- Cheap/static verification already tried before this run:
  - Focused workflow policy test passed.
  - Static benchmark `T03` contract probe verified AC01-AC18.
  - Typecheck and Mastra build passed.
- Workflow run ID: `aca6e9fe-db47-416e-b024-67d625e49a6d`
- Delivery run ID: `run-mrbopzmw-7647bb97`
- Report path:
  `/Users/chrislema/mastra/projects/benchmark/.delivery/runs/aca6e9fe-db47-416e-b024-67d625e49a6d.json`
- Result: `deliveryStatus` was `stuck`.
- Reused stages: `T01`, `T02`, `T05`.
- Newly completed stage: `T03` passed after retry and judged `0.85`.
- Farthest verified task: `T03` complete; the prior T03 AC14-AC18 blocker is
  fixed.
- New blocker: `T06` stuck on `T06-AC07`, "Removing a file updates state and
  token estimates."
- Failure class: likely missing executable behavior evidence. The generated
  `public/app.js` contains `removeReferenceFileAndUpdateTokenEstimates`,
  mutates `state.referenceFiles`, calls token estimate rendering, and wires a
  `[data-remove-file]` click handler. Do not fix this by adding more static
  string/pattern recognition.
- Next fix direction: move frontend state criteria like file removal/token
  estimates to generated-project behavior tests that run the code, such as a
  DOM/browser test that adds a reference file, removes it, and asserts chips,
  state, token estimate, and run payload behavior.

### 2026-07-08 - CLI Resume Run 2 Started

- Project folder: `/Users/chrislema/mastra/projects/benchmark`
- Command:
  `npm run delivery:run -- --projectFolder /Users/chrislema/mastra/projects/benchmark --deploy local`
- Folder handling: preserved; do not clear generated files or `.delivery` state.
- Forward-progress question: with the project preserved after the prior T06
  retry edits, does the run reuse/clear `T06` and move forward, or does it
  repeat the same `T06-AC07` blocker?
- Guardrail: if it repeats the T06 removal/token estimate blocker, do not fix it
  with more static string matching. Treat it as evidence that the next harness
  improvement should run generated-project behavior tests.
- Workflow run ID: `8fbcf2d9-73d3-4d8e-b7e8-f6ebb4f21e3a`
- Delivery run ID: `run-mrbpd4pf-1712dda9`
- Report path:
  `/Users/chrislema/mastra/projects/benchmark/.delivery/runs/8fbcf2d9-73d3-4d8e-b7e8-f6ebb4f21e3a.json`
- Result: `deliveryStatus` was `stuck`; workflow control path completed and
  reported the stuck delivery state.
- Reused stages: `T01`, `T03`, `T06`.
- Newly completed stages: `T02` judged `0.75`; `T02-part-2` judged `0.913`
  after retries.
- Farthest verified task: `T02-part-2` complete, with `T03` and `T06` reused
  as passing artifacts. The prior `T06-AC07` blocker did not repeat.
- New blocker: `T04` stuck on `T03-AC14`, requiring provider adapter failures
  to be converted to normalized `provider_error` or `timeout_or_network_error`
  values with client-safe messages defined by `src/contracts.ts`.
- Failure class: harness bug / missing behavior evidence. `T04` repeatedly
  passed `npm run typecheck`, then failed deterministic
  `acceptance_contracts_satisfied` checks that asked for more provider-specific
  file evidence. This is the brittle contract pattern the operating doctrine
  warns against.
- Other signal: the run replanned into a 12-task graph and only reused part of
  the previous path. That churn is worth watching because it can make resume
  behavior appear to move backward even when individual artifacts are reused.
- Post-run noise: LibSQL emitted `CLIENT_CLOSED` writes during shutdown after
  the report was already written. Treat that as observability shutdown noise
  unless it prevents traces/scores from being persisted in Studio.
- Current hypothesis: the provider acceptance criteria are being enforced as
  task-boundary/file-evidence strings instead of executable behavior. The next
  fix should move these criteria toward generated-project tests or typed helper
  evidence, and should also ensure deterministic retry/remediation respects the
  intended retry budget.
- Stop decision: do not run another paid delivery pass before fixing the `T04`
  contract boundary with focused harness tests.

### 2026-07-08 11:25 CDT - CLI Resume Run 3 Started

- Project folder: `/Users/chrislema/mastra/projects/benchmark`
- Command:
  `npm run delivery:run -- --projectFolder /Users/chrislema/mastra/projects/benchmark --deploy local`
- Folder handling: preserved; pick up from existing generated files and
  `.delivery` state instead of clearing the project.
- Forward-progress question: after the smell-audit cleanup reached
  `Total smells: 0`, does the preserved benchmark resume past the previous
  `T04` provider contract blocker and run to the final local-test/human gate?
- Cheap/static verification already tried before this run:
  - `node --import tsx --test test/delivery-engine/smell-audit.test.ts`
    passed.
  - `node --import tsx --test test/delivery-engine/workflow-policy.test.ts`
    passed.
  - `npm run typecheck` passed.
  - `npm run audit:smells -- --projectFolder
    /Users/chrislema/mastra/projects/benchmark --assume-typecheck
    --assume-tests --fail-on-smells` passed with `Total smells: 0`.
- Guardrail: if the run stalls again, read the report and classify the failure.
  Do not respond by adding broad text/string matching in `workflow.ts`.
- Workflow run ID: `ffd8ef90-744c-41e0-bfd4-0215cf8b63cb`
- Delivery run ID: `run-mrcahks3-d99ba6c6`
- Resource ID: `delivery:9ec42a6ede484450`
- Report path:
  `/Users/chrislema/mastra/projects/benchmark/.delivery/runs/ffd8ef90-744c-41e0-bfd4-0215cf8b63cb.json`
- Result: `deliveryStatus` was `stuck`; workflow control path completed and
  wrote a report.
- Completed/reused stages:
  - `T01` completed after repairing Vitest config issues and judged `1.0`.
  - `T02` reused a passing artifact judged `0.813`.
  - `T07-ui-shell` completed after one quiet retry and judged `0.904`.
- Farthest verified task: `T07-ui-shell` complete. The previous `T04`
  provider contract blocker did not repeat in this run.
- New blocker: `T03-contracts` wrote `src/contracts.ts`, then repo-wide
  `npm run typecheck` failed because preserved stale downstream
  `src/validation.ts` still imported old contract names such as
  `ERROR_MESSAGES`, `MAX_MODELS_PER_RUN`, `ApiErrorBody`, `ErrorCode`,
  `ModelMetadata`, `PublicModelSummary`, and `RunErrorResult`.
- Failure class: harness/resume boundary. The generated project was preserved,
  but the revised task graph did not own or archive stale downstream files from
  prior runs before using repo-wide verification as a deterministic gate.
- Other signals:
  - T01 initially failed because the generated Vitest config imported the old
    `@cloudflare/vitest-pool-workers/config` path; the retry fixed that.
  - T01 then failed because `vitest run` had no test files; the retry added
    `passWithNoTests: true` and passed.
  - Designer stages can spend a full no-tool timeout before a small edit, then
    rely on salvage verification. Track this, but do not fix it before the
    stale-file resume boundary.
  - LibSQL emitted `CLIENT_CLOSED` writes during shutdown after the report was
    already written; treat as observability shutdown noise unless traces/scores
    are missing in Studio.
- Current hypothesis: preserved resumes need a deterministic stale-surface
  cleanup or ownership-expansion rule before repo-wide verification. If a file
  outside the active task plan is generated by a prior delivery run and imports
  contracts that the active task just changed, the harness should either reset
  it to a compile-safe stub or ensure the revised plan owns it before blocking
  the run.
- Stop decision: do not run another paid delivery pass before adding focused
  tests around stale downstream files such as `src/validation.ts` and fixing the
  resume boundary structurally.

### 2026-07-08 11:45 CDT - CLI Resume Run 4 Started

- Project folder: `/Users/chrislema/mastra/projects/benchmark`
- Command:
  `npm run delivery:run -- --projectFolder /Users/chrislema/mastra/projects/benchmark --deploy local`
- Folder handling: preserved; pick up from existing generated files and
  `.delivery` state instead of clearing the project.
- Forward-progress question: after commit `8d738a3` added delivery-note
  provenance repair for stale out-of-plan files, does the preserved benchmark
  get past the `src/validation.ts` stale contract import typecheck blocker and
  continue toward the final local-test/human gate?
- Cheap/static verification already tried before this run:
  - `node --import tsx --test test/delivery-engine/workflow-policy.test.ts`
    passed.
  - `npm run typecheck` passed.
  - `git diff --check` passed.
  - `npm run audit:smells -- --projectFolder
    /Users/chrislema/mastra/projects/benchmark --assume-typecheck
    --assume-tests` reports 15 active evidence-routing smells in the revised
    benchmark plan; those are documented in `docs/DELIVERY_SMELL_AUDIT.md` and
    are separate from the stale-file resume blocker.
- Guardrail: if this run stalls, classify the failure from the report first.
  Do not add broad string matching in `workflow.ts`.
- Workflow run ID: `ef820857-7925-4bbf-a025-ac703512b776`
- Delivery run ID: `run-mrcb80pq-921f0601`
- Resource ID: `delivery:9ec42a6ede484450`
- Report path:
  `/Users/chrislema/mastra/projects/benchmark/.delivery/runs/ef820857-7925-4bbf-a025-ac703512b776.json`
- Result: `deliveryStatus` was `stuck`; workflow control path completed and
  wrote a report.
- Reused stages: `T01`.
- Newly executed stages:
  - Planning/review completed with one architect bounce and a judged revised
    plan.
  - `T02-test-harness` ran four attempts; every verification pass after the
    first stale-file auto-repair had `npm run typecheck` and `npm run test`
    passing.
- Farthest verified task: `T02-test-harness` verification commands passed, but
  the implementation judge never accepted the task.
- Confirmed fix from commit `8d738a3`: the stale `src/validation.ts` typecheck
  blocker recurred, the harness auto-repaired only `src/validation.ts`, and the
  immediate typecheck rerun passed.
- New blocker: the `T02-test-harness` implementation notes included
  `src/validation.ts` in `files_touched` because the workflow counted the
  harness `auto_repair` event as part of the implementation surface. The judge
  repeatedly scored the task below threshold for unrelated file scope even
  though deterministic verification passed.
- Failure class: harness accounting bug. Auto-repair events should remain
  observable, but stale out-of-plan repairs should not be folded into the
  task's implementation-note file list. In-boundary auto-repairs can still count
  as task files because they change the current task surface.
- Stop decision: fix `implementationFilesTouched` so out-of-plan auto-repairs do
  not pollute implementation notes, add focused tests, then run cheap checks
  before another paid delivery pass.

### 2026-07-08 11:59 CDT - CLI Resume Run 5 Started

- Project folder: `/Users/chrislema/mastra/projects/benchmark`
- Command:
  `npm run delivery:run -- --projectFolder /Users/chrislema/mastra/projects/benchmark --deploy local`
- Folder handling: preserved; pick up from existing generated files and
  `.delivery` state instead of clearing the project.
- Forward-progress question: after commit `c4b994c` excluded stale
  out-of-plan `auto_repair` writes from implementation-note `files_touched`,
  does the preserved benchmark clear `T02-test-harness` and move to the next
  task instead of repeating the note-scope judge failure?
- Cheap/static verification already tried before this run:
  - `node --import tsx --test test/delivery-engine/workflow-policy.test.ts`
    passed with the new auto-repair accounting regression tests.
  - `npm run typecheck` passed.
  - `git diff --check` passed.
- Guardrail: if this run stalls, classify the failure from the report first.
  Do not add broad string matching in `workflow.ts`.
- Workflow run ID: `ffadadff-e46e-4629-aaf1-1c9d9d17fad8`
- Delivery run ID: `run-mrcbp970-f490cf97`
- Resource ID: `delivery:9ec42a6ede484450`
- Report path:
  `/Users/chrislema/mastra/projects/benchmark/.delivery/runs/ffadadff-e46e-4629-aaf1-1c9d9d17fad8.json`
- Result: `deliveryStatus` was `stuck`; workflow control path completed and
  wrote a report.
- Farthest verified task: none in build for this run. The run stopped during
  deterministic planner revision gates before the build cursor.
- Confirmed/non-confirmed: this run did not reach `T02-test-harness`, so commit
  `c4b994c` has not yet been validated by a full delivery pass.
- New blocker: planner revision assigned `T07` to owner `engineer` while owning
  `public/app.js`, which violates the current role boundary:
  `engineer may not write public/app.js`.
- Failure class: harness plan-normalization gap. A frontend-only task whose
  concrete owned surfaces are all public assets should be normalized to
  `designer` before deterministic role hygiene. Mixed scaffold/runtime tasks
  should remain strict and fail if they combine engineer-owned and public
  designer-owned surfaces incorrectly.
- Stop decision: add a focused role-boundary normalization test and normalize
  all-public engineer tasks to designer, then run cheap checks before another
  paid delivery pass.

### 2026-07-08 12:07 CDT - CLI Resume Run 6 Started

- Project folder: `/Users/chrislema/mastra/projects/benchmark`
- Command:
  `npm run delivery:run -- --projectFolder /Users/chrislema/mastra/projects/benchmark --deploy local`
- Folder handling: preserved; pick up from existing generated files and
  `.delivery` state instead of clearing the project.
- Forward-progress question: after commit `9323d82` normalizes frontend-only
  public tasks to `designer`, does the preserved benchmark pass planner
  revision role hygiene, reach `T02-test-harness`, and validate commit
  `c4b994c` by clearing the stale auto-repair note-accounting blocker?
- Cheap/static verification already tried before this run:
  - `node --import tsx --test test/delivery-engine/workflow-policy.test.ts`
    passed with the new frontend-only role normalization test.
  - `npm run typecheck` passed.
  - `git diff --check` passed.
  - Static probe against the active benchmark
    `.delivery/artifacts/task-plan.revision-1.json` showed role hygiene
    `passed: true`, with `T07`, `T08`, and `T09` normalized to `designer`.
- Guardrail: if this run stalls, classify the failure from the report first.
  Do not add broad string matching in `workflow.ts`.
- Workflow run ID: `51ed258b-30ee-480b-92ea-002871d563dc`
- Delivery run ID: `run-mrcc0sk7-f2204c68`
- Resource ID: `delivery:9ec42a6ede484450`
- Report path:
  `/Users/chrislema/mastra/projects/benchmark/.delivery/runs/51ed258b-30ee-480b-92ea-002871d563dc.json`
- Result: `deliveryStatus` was `stuck`; workflow control path completed and
  wrote a report.
- Confirmed fix from commit `9323d82`: planner revision role hygiene passed in
  the live workflow. The run reached the build cursor instead of stopping on
  `public/app.js` ownership.
- Build resume cursor: reused `T01`, `T02`, and `T05`; next task was
  `T02-contracts` out of 20 tasks.
- Newly executed stage: `T02-contracts` wrote `src/contracts.ts`; `npm run
  typecheck` and `npm run test` passed on each attempt.
- Farthest verified task: `T02-contracts` had passing verification commands but
  did not complete because deterministic acceptance-contract verification kept
  retrying it.
- New blocker: `T02-contracts-AC09`, "No task downstream needs to invent
  independent RunResult, error-code, or prompt-limit shapes outside
  src/contracts.ts", was treated as a current-task structural blocker even
  though it is a cross-task evidence invariant. The source contract task cannot
  fully prove downstream non-duplication before downstream tasks exist; this
  belongs as pending evidence for contract/downstream tests, not a deterministic
  implementation retry.
- Failure class: harness evidence-policy gap. This is the `T03/T02 contracts`
  smell cluster documented in `docs/DELIVERY_SMELL_AUDIT.md`.
- Stop decision: classify cross-task contract-drift criteria as behavior-like
  evidence criteria so they stay visible as pending evidence but do not block
  deterministic implementation completion for the source contract task.

### 2026-07-08 12:20 CDT - CLI Resume Run 7 Started

- Project folder: `/Users/chrislema/mastra/projects/benchmark`
- Command:
  `npm run delivery:run -- --projectFolder /Users/chrislema/mastra/projects/benchmark --deploy local`
- Folder handling: preserved; pick up from existing generated files and
  `.delivery` state instead of clearing the project.
- Forward-progress question: after commit `78596d1` treats cross-task contract
  drift criteria as pending evidence, does the preserved benchmark clear the
  prior `T02-contracts-AC09` deterministic retry loop and move to the next build
  task?
- Cheap/static verification already tried before this run:
  - `node --import tsx --test test/delivery-engine/workflow-policy.test.ts`
    passed with the new cross-task contract drift regression test.
  - `node --import tsx --test test/delivery-engine/smell-audit.test.ts`
    passed.
  - `npm run typecheck` passed.
  - `git diff --check` passed.
  - `npm run audit:smells -- --projectFolder
    /Users/chrislema/mastra/projects/benchmark --assume-typecheck
    --assume-tests` reported `Total smells: 0` on the active benchmark plan.
- Guardrail: if this run stalls, classify the failure from the report first.
  Do not add broad string matching in `workflow.ts`.
- Workflow run ID: `d75f9062-c64b-46bd-85bd-7e1bb0b159ec`
- Delivery run ID: `run-mrccgg7b-1bc9bcad`
- Resource ID: `delivery:9ec42a6ede484450`
- Report path:
  `/Users/chrislema/mastra/projects/benchmark/.delivery/runs/d75f9062-c64b-46bd-85bd-7e1bb0b159ec.json`
- Result: `deliveryStatus` was `stuck`; workflow control path completed and
  wrote a report.
- Confirmed/non-confirmed: this run stopped in deterministic planner revision
  gates before reaching build, so commit `78596d1` has not yet been validated by
  a full delivery pass.
- New blocker: planner revision assigned `T04` to owner `engineer` while owning
  `docs/security-boundary.md`; current engineer role boundaries allowed
  `README.md` but not `docs/**`.
- Failure class: harness role-boundary gap. Technical/operator documentation is
  a legitimate engineer-owned surface in this Worker delivery harness, so
  `docs/**` should be allowed without weakening public UI or runtime ownership.
- Stop decision: add `docs/**` to engineer-owned surfaces with a focused role
  hygiene test, then run cheap checks before another paid delivery pass.
