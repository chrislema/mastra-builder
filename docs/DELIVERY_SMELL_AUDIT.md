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

After stopping generic file evidence from verifying behavior-shaped criteria,
keeping behavior-only evidence gaps out of deterministic implementation retries,
copying API route and frontend behavior criteria onto explicit evidence tasks,
preserving those criteria on the implementation tasks as first-class contracts,
and carrying non-endpoint behavior from tasks that already declare explicit API
route behavior into the same route evidence task, and copying contract/validation
behavior onto explicit domain evidence tasks:

- Acceptance contracts: 266
- Structured evidence: 33
- Command/test evidence: 42
- Generic file evidence: 25
- Unverified contracts: 166
- Behavior-shaped criteria: 155
- Behavior criteria verified by generic file evidence: 0
- Behavior criteria still unverified: 5
- Pending behavior evidence: 122
- Total audit smells: 69

This is an intentional intermediate state: behavior is no longer falsely marked
verified by token overlap, behavior-only proof gaps no longer cause
deterministic implementation retry loops, and route/frontend behavior proof is
now routed toward generated tests instead of source-file overlap. Implementation
tasks keep the behavior contracts as working memory; evidence tasks copy those
criteria and make missing executable proof visible as pending evidence. The
harness still needs to route the remaining behavior proof to generated tests,
command evidence, judges, or release gates.

Largest clusters:

- `T05`: API route and same-task route behavior now have an explicit
  `T05-api-route-behavior-tests` task. The normalizer only broadens same-task
  behavior when the route task already carries explicit API route behavior, so
  auth/session/generated route-integration tasks do not get stray route-test
  tasks.
- `T06`, `T07`, `T08`, `T09`: frontend/runtime behavior now has explicit
  `*-frontend-behavior-tests` tasks; remaining smells are mostly structural
  generic-file evidence or non-behavior unverified UI/documentation contracts.
- `T04-provider-behavior-tests`: good direction, but still needs fuller command
  evidence for missing-key and Workers AI binding behavior.
- `T02`/`T02-part-2`: contract and validation behavior now have explicit
  `test/contracts.test.{ts,js}` and `test/validation.test.{ts,js}` evidence
  tasks. Remaining smells on those rows are structural generic-file evidence,
  not behavior-by-file evidence.

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
