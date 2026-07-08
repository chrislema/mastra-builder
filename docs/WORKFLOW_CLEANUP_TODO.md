# Workflow Cleanup TODO

Read this after `docs/OPERATING_DOCTRINE.md` whenever resuming Delivery Engine
workflow work. Then read `docs/workflow-enhance.md`, which is the active ordered
plan for reducing `workflow.ts` into thin Mastra workflow composition plus
focused modules.

## Goal

Keep making `src/mastra/delivery-engine/workflow.ts` smaller and more
Mastra-native without changing delivery behavior. Move policy, prompts, command
plans, and report assembly into focused modules. Preserve workflow exports while
tests and callers still import them.

The target is not more checks. The target is cleaner orchestration:

- Mastra workflows own durable stage control.
- Focused modules own Cloudflare Worker policy and evidence planning.
- Typed contracts and schemas beat broad string parsing.
- Every cleanup checkpoint is verified before commit.

## Baseline

The known interrupted benchmark run `run-mrbf10al-3288dc21` reached:

- `T01` complete
- `T02` complete
- `T05` complete
- `T02-part-2` complete
- `T06` completed attempt 2 typecheck and had just entered judge stage

It failed because Codex interrupted the run with SIGINT. Do not treat it as a
natural T06 failure.

## Active Cleanup Queue

The active queue is the ordered phase list in `docs/workflow-enhance.md`.
Continue there first; keep this file as the compact status and guardrail page.

Acceptance-contract smell cleanup is active. Read
`docs/DELIVERY_SMELL_AUDIT.md` before editing acceptance evidence,
deterministic implementation gates, or task-plan criteria normalization.

Before adding another workflow cleanup cluster, read the operating doctrine and
verify the change makes `workflow.ts` smaller, clearer, and more Mastra-native
without weakening delivery behavior.

## Already Extracted

Do not redo these:

- Workflow schemas: `workflow-schemas.ts`
- Acceptance evaluation: `acceptance-contracts.ts`
- Process utilities: `process-utils.ts`
- Source document policy: `source-policy.ts`
- Release-gate HTTP probes: `release-gate-probes.ts`
- Release-gate runtime probe planning: `release-gate-runtime-probe-plan.ts`
- Latest-transcript fixture policy: `release-gate-transcript-fixture.ts`
- Source-scoped task-plan contracts: `task-plan-source-contracts.ts`
- Generated-slice policy: `task-plan-generated-slices.ts`
- Task dependency/order utilities: `task-plan-dependencies.ts`
- Worker config/package hygiene: `worker-hygiene.ts`
- Release-gate command planning: `release-gate-command-plan.ts`
- Implementation retry and stale-verification policy: `implementation-retry-policy.ts`
- Planner prompt policy: `planner-prompt-policy.ts`
- Build verification and deployment report policy: `build-deployment-policy.ts`

## Cleanup Rules

- Do one coherent extraction per commit and push each commit.
- Move behavior without changing policy.
- Preserve public workflow wrappers if tests import them.
- Run focused tests first, then `npm run typecheck`, then `npm run build`.
- Do not add broad product-specific regex to `workflow.ts`.
- Do not run paid full delivery runs until static/unit verification says the
  cleanup is stable.
- If a cleanup makes the workflow more brittle or less Mastra-native, stop and
  reassess before patching forward.
