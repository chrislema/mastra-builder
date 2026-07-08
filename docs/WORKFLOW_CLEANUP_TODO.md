# Workflow Cleanup TODO

Read this after `docs/OPERATING_DOCTRINE.md` whenever resuming Delivery Engine
workflow work.

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

1. Release-gate command planning.
   - Move Wrangler command construction, local-vs-npx resolution, Worker dev,
     dry-run deploy, startup check, generated Worker types check, D1 migration
     command planning, transcript fixture command planning, and static evidence
     result assembly out of `workflow.ts`.
   - Keep `workflow.ts` responsible for release-gate orchestration and process
     execution.

2. Implementation retry and stale-verification policy.
   - Move verification failure path extraction, stale downstream repair policy,
     out-of-plan verification classification, implementation failure
     classification, timeout salvage, retry-mode selection, and retry tool
     choice into focused implementation policy modules.
   - Keep workspace writes, Mastra events, and stage execution orchestration in
     `workflow.ts`.

3. Planner prompt policy.
   - Move project policy text, Worker-first assumptions, owned-surface guidance,
     root scaffold guidance, plan-gate repair prompt fragments, and source
     policy insertions into small prompt/policy builders.
   - Keep the planner/architect workflow steps in `workflow.ts`.

4. Build/deployment orchestration helpers.
   - Move build verification command plans, deployment report construction,
     human-approval formatting, and deployment next-step summaries into focused
     modules.
   - Keep Mastra step definitions, suspend/resume wiring, and state lifecycle
     in `workflow.ts`.

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
