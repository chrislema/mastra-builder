# Delivery Smell Audit

Read this after `docs/OPERATING_DOCTRINE.md` when working on acceptance
contracts, deterministic gates, or delivery-run stalls caused by criteria
verification.

## Goal

Clean up the brittle evidence pattern without returning to expensive full-run
guesswork.

The smell is not "contracts exist." The smell is when behavior is treated as
proven by source-token overlap or when missing executable behavior evidence
causes another implementation retry loop instead of a test/eval/review path.

## Cheap Audit Command

Use this before another paid `delivery:run` when working on this class of issue:

```bash
npm run audit:smells -- --projectFolder /Users/chrislema/mastra/projects/benchmark --assume-typecheck --assume-tests
```

Use `--json` for machine-readable output and `--fail-on-smells` only when we
intentionally want the command to act as a gate.

## Baseline From 2026-07-08

Static probe against the preserved benchmark task plan, assuming typecheck and
tests were available as performed evidence:

- Tasks: 13
- Acceptance contracts: 173
- Structured evidence: 32
- Command/test evidence: 21
- Generic file evidence: 42
- Unverified contracts: 78
- Behavior-shaped criteria: 88
- Behavior criteria verified by generic file evidence: 23
- Behavior criteria still unverified: 44
- Total audit smells: 120

## Current Audit Counts

The zero-smell checkpoint below applied before the 2026-07-08 CLI Resume Run 3
rewrote the active benchmark plan. It remains useful as the previous known-good
cheap-audit state, but it is no longer the current active benchmark plan.

After stopping generic file evidence from verifying behavior-shaped criteria,
keeping behavior-only evidence gaps out of deterministic implementation retries,
copying API route, frontend, provider, contract, and validation criteria onto
explicit evidence tasks, preserving those criteria on implementation tasks as
first-class contracts, counting exact downstream evidence-task coverage before
treating generic file evidence as a smell, and replacing the last generic
Worker config/model catalog evidence with narrow structural contract checks:

- Acceptance contracts: 341
- Structured evidence: 35
- Command/test evidence: 46
- Generic file evidence: 23
- Unverified contracts: 237
- Behavior-shaped criteria: 155
- Behavior criteria verified by generic file evidence: 0
- Behavior criteria still unverified: 0
- Pending behavior evidence: 127
- Total audit smells: 0

`Unverified contracts` remains a gap counter for unfinished or not-yet-proven
work. It is intentionally broader than `Total audit smells`. A smell is now a
brittle evidence pattern: behavior proven by generic file evidence, behavior
with no routed evidence path, or generic source-token file evidence. Plain
structural gaps stay visible in task rows without inflating the smell count.
Documentation and declarative config criteria are classified as structural, not
runtime behavior.

This is an intentional intermediate state: behavior is no longer falsely marked
verified by token overlap, behavior-only proof gaps no longer cause
deterministic implementation retry loops, and route/frontend/provider/contract
proof is now routed toward generated tests instead of source-file overlap.
Implementation tasks keep the contracts as working memory; evidence tasks copy
those criteria and make missing executable proof visible as pending evidence.

Remaining gaps, not current smells:

- Generic file evidence remains counted as a broad evidence category, but exact
  downstream evidence-task coverage or narrow structural checkers prevent it
  from becoming a smell.
- API route, frontend, provider, contract, and validation behavior is routed
  into explicit evidence tasks. Their unverified rows are gap counters, not
  current audit smells.
- Remaining unverified contracts should be treated as future evidence coverage
  work, not as justification for reintroducing brittle workflow parsing.

## Active Benchmark Counts After CLI Resume Run 3

After the 2026-07-08 11:25 CDT resume run, the active benchmark task plan is
`/Users/chrislema/mastra/projects/benchmark/.delivery/artifacts/task-plan.revision-1.json`.
The cheap audit now reports:

- Acceptance contracts: 266
- Structured evidence: 25
- Command/test evidence: 53
- Generic file evidence: 20
- Unverified contracts: 168
- Behavior-shaped criteria: 121
- Behavior criteria verified by generic file evidence: 0
- Behavior criteria still unverified: 10
- Pending behavior evidence: 79
- Total audit smells: 15

This is a new evidence-routing cluster from the revised plan, not the stale
out-of-plan file blocker itself. The stale-file blocker should be fixed by
delivery-note provenance and compile-safe stubbing; do not solve it by adding
contract text parsing. Before another smell-cleanup pass, prioritize these two
clusters:

- `T03-contracts`: five structural contract criteria are still verified by
  generic `src/contracts.ts` file evidence. Prefer narrow structural helpers or
  an explicit contract behavior test task over source-token matching.
- `T04-api-guards`: ten guard criteria are behavior-shaped but have no routed
  evidence path. Prefer generated guard behavior tests, likely in
  `test/guards.test.{ts,js}`, over deterministic implementation retries.

## Active Benchmark Counts After Cross-Task Evidence Fix

After CLI Resume Run 6, cross-task contract drift criteria such as "No task
downstream needs to invent independent RunResult, error-code, or prompt-limit
shapes outside src/contracts.ts" are classified as pending evidence instead of
deterministic implementation blockers. The active benchmark cheap audit now
reports:

- Acceptance contracts: 281
- Structured evidence: 24
- Command/test evidence: 51
- Generic file evidence: 20
- Unverified contracts: 186
- Behavior-shaped criteria: 116
- Behavior criteria verified by generic file evidence: 0
- Behavior criteria still unverified: 0
- Pending behavior evidence: 91
- Total audit smells: 0

Remaining unverified rows are visible gap counters, not current smell blockers.
The next paid run should answer whether `T02-contracts` can complete and move
past the prior deterministic AC09 loop.

## Active Cleanup Queue

1. Add the repeatable smell audit module, CLI command, tests, and this doc.
   Done in commit `73d872b`.
2. Stop generic file evidence from verifying behavior-shaped criteria.
   Done in the next cleanup checkpoint; behavior-by-file-evidence is now zero.
3. Keep missing executable behavior evidence out of the deterministic
   implementation retry loop; route it toward generated project tests, judges,
   release-gate evidence, or explicit follow-up work.
   Done in the retry-loop cleanup checkpoint; structural contract gaps still
   block deterministic retries, behavior-only gaps do not.
4. Replace the highest-volume behavior criteria with test-task or command
   evidence patterns, starting with API route behavior and frontend state
   behavior. API route, frontend, contract, and validation behavior routing are
   partially complete: the normalizer now creates
   `test/api-routes.test.{ts,js}`, `test/frontend-behavior.test.{ts,js}`,
   `test/contracts.test.{ts,js}`, and `test/validation.test.{ts,js}` tasks,
   copies behavior contracts into those evidence tasks, preserves the contracts
   on implementation tasks, and classifies missing behavior evidence as pending
   evidence instead of a smell when a downstream evidence task carries the same
   contract.
5. Review the `without*Criteria` normalizers in `workflow.ts`; keep only typed
   ownership/scope normalization that cannot be expressed in task schemas,
   source-scoped contracts, or tests.

## Loop Rule

For each cleanup pass:

1. Run the cheap smell audit.
2. Pick one smell cluster.
3. Make a structural fix, not a broad string exception.
4. Run focused tests and typecheck.
5. Update this file with the new counts or the reason counts intentionally
   moved.
6. Commit and push.

Do not run the full delivery workflow until the cheap audit says the harness is
less brittle, or the next full run will answer a specific forward-progress
question that static tests cannot.
