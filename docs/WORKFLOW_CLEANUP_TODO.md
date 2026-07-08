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
- Workflow error handling: `workflow-support/errors.ts`
- Workflow state sync steps: `workflow-support/state-sync.ts`
- Agent trace artifacts and response serialization:
  `agent-runtime/trace-artifacts.ts`
- Agent call options and timeout constants: `agent-runtime/options.ts`
- Agent stage timeout watchdogs and write/read-budget event helpers:
  `agent-runtime/stage-timeout.ts`
- Compact diagnostics shared by workflow and runtime modules:
  `agent-runtime/diagnostics.ts`
- Judge provider fallback and artifact judging:
  `agent-runtime/judge-runtime.ts`
- Planning readout and open-decision policy:
  `planning/readout-policy.ts`
- Pages Functions exception policy:
  `planning/pages-policy.ts`
- Owned-surface concreteness policy:
  `planning/owned-surface-policy.ts`
- Task owner role-boundary policy:
  `planning/role-boundary-policy.ts`
- Shared task contract helpers:
  `planning/task-contracts.ts`
- Oversized implementation task splitting:
  `planning/large-task-policy.ts`
- Worker config and D1 schema task splitting:
  `planning/config-schema-policy.ts`
- Generated task id helpers:
  `planning/task-ids.ts`
- Operator README planning and hygiene:
  `planning/operator-documentation-policy.ts`
- Profile contract producer/consumer dependency ordering:
  `planning/profile-contract-policy.ts`
- Root Worker scaffold dependency and hygiene policy:
  `planning/scaffold-policy.ts`
- Acceptance-contract preservation and revision regression policy:
  `planning/acceptance-contract-preservation.ts`
- Route integration and final entrypoint consistency hygiene:
  `planning/route-boundary-policy.ts`
- Generated-slice dependency policy:
  `planning/generated-slice-policy.ts`
- Deterministic task-plan gate assembly:
  `planning/task-plan-gates.ts`
- Topological task ordering:
  `task-plan-dependencies.ts`
- Cloudflare acceptance-criteria sanitizer and canonicalization policy:
  `planning/cloudflare-contract-criteria-policy.ts`
- Root Worker scaffold detection:
  `planning/scaffold-policy.ts`
- Behavior evidence task synthesis for provider, API, frontend, and
  validation contracts: `planning/behavior-evidence-task-policy.ts`

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
