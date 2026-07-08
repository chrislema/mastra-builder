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

As of this TODO, there is an in-progress refactor:

- `src/mastra/delivery-engine/acceptance-contracts.ts` has been expanded with:
  - `AcceptanceContractRecord`
  - `acceptanceContractReferences`
  - `evaluateAcceptanceCriterion`
  - `acceptanceContractsForCriteria`
  - `verificationWithAcceptanceContractGaps`
  - implementation acceptance evidence helpers moved conceptually out of the
    workflow

Not finished yet:

- `src/mastra/delivery-engine/workflow.ts` still contains the old implementation
  acceptance evaluator block around the release-gate/build helper area.
- The workflow imports have not yet been switched to the new acceptance-contract
  helpers.
- The duplicate old block has not yet been removed from `workflow.ts`.
- Tests have not yet been run after this extraction.

If resuming after compaction, first run `git status --short` and inspect these
two files before editing further.

## Cleanup Sequence

1. Finish the acceptance evaluator extraction.
   - Import `acceptanceContractReferences`,
     `acceptanceContractsForCriteria`, and
     `verificationWithAcceptanceContractGaps` from
     `acceptance-contracts.ts`.
   - Keep `workflow.ts` responsible for choosing criteria and IDs only:
     `taskVerificationAcceptanceContractCriteria` and `acceptanceContractId`.
   - Delete the duplicated old acceptance evaluator helpers from `workflow.ts`.
   - Preserve exported wrapper functions from `workflow.ts` if tests import
     them, but make wrappers delegate to the acceptance-contract module.

2. Verify the refactor cheaply.
   - Run the focused workflow policy tests that cover acceptance contracts.
   - Run `npm run typecheck`.
   - Run the full test suite only after the focused tests pass.
   - Do not run a paid benchmark workflow just to test this refactor.

3. Commit and push the cleanup.
   - Natural commit name: `Extract implementation acceptance evaluation`.
   - Only commit once the worktree is coherent and tests/typecheck pass.

4. Then reassess bigger cleanup.
   - Identify remaining policy clusters inside `workflow.ts`.
   - Prefer moving stable clusters into focused modules over adding new logic.
   - Good candidates:
     - Worker config policy and hygiene
     - Release-gate evidence planning
     - Task-plan normalization policy
     - Generated slice dependency hygiene
   - Avoid touching all clusters in one commit.

5. Resume run iteration only after cleanup is stable.
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
