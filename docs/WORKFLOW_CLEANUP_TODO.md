# Workflow Cleanup TODO

This file exists so cleanup work survives context compaction. Read it after
`docs/OPERATING_DOCTRINE.md` whenever resuming Delivery Engine workflow work.

## Goal

Clean up the Delivery Engine workflow so it can reach the local-test handoff
reliably without making `workflow.ts` larger, more brittle, or more dependent on
product-specific string parsing.

The target is not "add more checks." The target is:

- Smaller workflow orchestration code.
- Policy/evidence logic moved into focused modules.
- Contracts represented as stable, typed concepts where possible.
- Less regex/string matching in `workflow.ts`.
- Evidence that clean benchmark runs go farther, not backward.

## Current Known Run Baseline

The interrupted benchmark run `run-mrbf10al-3288dc21` reached:

- `T01` complete
- `T02` complete
- `T05` complete
- `T02-part-2` complete
- `T06` had completed attempt 2 typecheck and had just entered judge stage

It was marked failed because Codex interrupted the run with SIGINT, not because
the workflow naturally failed. Do not treat that run as proof that T06 failed.

## Current Refactor State

Completed cleanup checkpoints:

- `0fdaed7 Extract implementation acceptance evaluation`
  - `workflow.ts` now delegates implementation acceptance evaluation to
    `acceptance-contracts.ts`.
  - The duplicate local acceptance evaluator block was removed from
    `workflow.ts`.
  - The exported workflow adapter functions remain for tests and callers.
  - Verification passed: focused workflow policy test, `npm run typecheck`,
    `npm test`.
- `d4716c2 Extract delivery workflow schemas`
  - Workflow Zod contracts and inferred types now live in
    `workflow-schemas.ts`.
  - `workflow.ts` imports schema contracts instead of defining them inline.
  - Verification passed: `npm run typecheck`, `npm test`.
- `1f7299b Extract release gate probe evaluation`
  - Release-gate HTTP probe types and response assertion helpers now live in
    `release-gate-probes.ts`.
  - `workflow.ts` still owns Wrangler process lifecycle and release-gate
    orchestration, but delegates probe execution to the focused module.
  - Verification passed: `npm run typecheck`, `npm test`.
- `5558ad5 Extract delivery process utilities`
  - Shared child-process output, TCP port allocation, retry delay, and shutdown
    helpers now live in `process-utils.ts`.
  - `workflow.ts` still owns release-gate runtime orchestration.
  - Verification passed: `npm run typecheck`, `npm test`.
- `78f9095 Extract source document policy`
  - Source-document declarations for Pages, profile kinds, Talking Head
    transcript contracts, external Worker service bindings, and short-link
    lifecycle now live in `source-policy.ts`.
  - `workflow.ts` re-exports the same public helpers for compatibility.
  - Verification passed: `npm run typecheck`, `npm test`.
- Current cleanup pass
  - Replace bookmarks-specific shared harness policy with generic external
    Worker service binding policy.
  - Keep project-specific vocabulary in source docs and eval/test fixtures, not
    in central helper names or global planner prompt rules.
  - Replace bookmark-specific empty-run lifecycle normalization with generic
    empty input/source item lifecycle language while preserving old generated
    status canonicalization.
  - Rename the source-gated transcript policy from a project label to the
    generic `latestTranscriptRequired` capability.

If resuming after compaction, first run `git status --short`, then continue from
the next cleanup target below. Do not redo either completed extraction.

## Cleanup Sequence

1. Reassess bigger cleanup.
   - Identify remaining policy clusters inside `workflow.ts`.
   - Prefer moving stable clusters into focused modules over adding new logic.
   - Good candidates, in suggested order:
     - Worker config policy and hygiene.
     - Release-gate evidence planning beyond HTTP probe evaluation.
     - Task-plan normalization policy.
     - Generated slice dependency hygiene.
   - Avoid touching all clusters in one commit.

2. For each cleanup cluster.
   - Move behavior without changing policy.
   - Preserve exported workflow wrappers if tests import them.
   - Run `npm run typecheck` and `npm test`.
   - Run focused tests first when the cluster has focused coverage.
   - Commit and push each coherent extraction.

3. Resume run iteration only after cleanup is stable.
   - Clean the benchmark project back to `vision.md`.
   - Run the CLI delivery workflow.
   - Watch for forward progress against the baseline above.
   - If it stalls earlier than T06, stop and inspect before changing code.

## Rules For Future Fixes

- Do not add broad product-specific regex to `workflow.ts`.
- Do not encode one benchmark app's phrasing as general harness law.
- Do not make generated files into owned source surfaces.
- Do not keep patching if clean runs go backward.
- Prefer typed schemas, focused modules, eval fixtures, scorers, or generated
  project tests over central workflow string parsing.
- Every fix should either reduce complexity or move the clean run farther with
  clear evidence.
