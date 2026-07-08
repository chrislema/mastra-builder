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
