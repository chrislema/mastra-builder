# Delivery Engine for Mastra

This project is a Mastra-native port of the delivery engine ideas from
`github.com/chrislema/claude-environments`. The Claude repo remains the Claude-specific
implementation. This repo uses Mastra first-class pieces: agents, tools, workflow steps,
workspace hooks, typed artifacts, deterministic checks, rubric aggregation, native scorers,
working memory, and custom API routes.

## What Is Registered

`src/mastra/index.ts` registers:

- `deliveryWorkflow`
- role agents: planner, architect, engineer, designer, tester, deployment advisor, judge
- delivery state tools for `.delivery/`, including observability persistence/list tools
- delivery scorers for handoff readiness, workflow completion, rubric floor, judgment
  pass rate, and deterministic check pass rate
- `deliveryMemory`, a thread-scoped Mastra working-memory contract for live run coordination
- delivery processors for repo-bound execution, policy override blocking, evidence-backed
  completion claims, token limiting, Unicode normalization, and secret redaction
- a dynamic delivery workspace rooted by `requestContext.repoPath`
- custom route `POST /delivery/run` for starting a resource-scoped delivery workflow run
- storage-backed observability for final delivery run state snapshots and events

The default weather scaffold has been removed.

## Run Locally

Create `.env` from `.env.example` and set `OPENAI_API_KEY`. The default delivery and
judge models are `openai/gpt-5.5`; Z.ai / GLM can still be selected per slot with
`DELIVERY_MODEL` or `DELIVERY_JUDGE_MODEL`.

```shell
npm install
npm run typecheck
npm test
npm run ci:delivery
npm run build
npm run dev
```

Open the Studio URL printed by `npm run dev`, then run `deliveryWorkflow` from the
Workflows tab. On Chris's machine this is commonly `http://localhost:4112`, but Mastra may
choose a different port if another Studio process is already running.

## Run A Delivery Workflow

From the command line:

```shell
npm run delivery:run -- --repo /absolute/path/to/target-repo --vision vision.md --spec spec.md
```

The same native runner is exposed as a Mastra custom API route:

```shell
curl -X POST http://localhost:4112/api/delivery/run \
  -H 'Content-Type: application/json' \
  -d '{
    "repoPath": "/absolute/path/to/target-repo",
    "visionPath": "vision.md",
    "specPath": "spec.md",
    "maxRetries": 2,
    "deployMode": "local"
  }'
```

Use the API base URL printed by `npm run dev`; in local Studio output this is usually
`http://localhost:4112/api`, making the route `/api/delivery/run`.

Both paths call `deliveryWorkflow.createRun({ resourceId })`, pass
`requestContext.repoPath`, and include delivery trace metadata. The CLI waits for the native
workflow result with workflow state by default. The HTTP route uses `startAsync()` and
returns `{ workflowId, runId, resourceId, status }` immediately so long-running delivery
builds do not block the request.

## Workflow Input

`deliveryWorkflow` expects:

```json
{
  "repoPath": "/absolute/path/to/target-repo",
  "visionPath": "vision.md",
  "specPath": "spec.md",
  "maxRetries": 2,
  "deployMode": "local"
}
```

`visionPath` and `specPath` must point to files inside `repoPath`; relative paths are
resolved under `repoPath`, and absolute paths inside the repo are normalized to
repo-relative paths. The workflow writes authoritative state and artifacts under
`<repoPath>/.delivery/`.

Use `deployMode: "local"` unless a production deployment is explicitly intended. The
legacy aliases `mock` and `real` are still accepted, but the harness is designed around
local Wrangler validation first and human approval before production deploy.

Target projects are assumed to be standalone Cloudflare Workers projects with vanilla
JavaScript Worker modules and vanilla HTML, CSS, and JavaScript frontends. Pages Functions
and TypeScript Worker source are explicit exceptions, not the default. The delivery agents
should not introduce React, JSX/TSX, frontend frameworks, preprocessors, generic
Node/Express servers, filesystem-backed runtime state, or a new frontend build step.

When a target project does use TypeScript Worker source, the scaffold should use Wrangler's
generated types instead of hand-written Worker runtime types: `scripts.generate-types` runs
`wrangler types`, `scripts.typecheck` runs `npm run generate-types && tsc --noEmit`, and
`tsconfig.json` includes `./worker-configuration.d.ts` plus `node`. The release gate also
requires `wrangler types --check` before package checks, dry-run deploy, local D1
migrations, and local `wrangler dev` probes.

Use local `git` for source-control checkpoints. Use the `gh` CLI only when an explicit
human instruction calls for pushes, pull requests, or other remote GitHub actions. Do not
use GitHub Actions as the deployment path. Production deployments should use Wrangler CLI
directly.

## Request Context

Agents and workspace tools use `requestContext.repoPath` to decide which repository they
can read, write, search, and run commands in. The workflow supplies that context for every
agent call. If you call an agent directly from Studio or an API client, include the same
request context. Delivery agents now use a Mastra input processor that blocks calls without
`requestContext.repoPath`.

Repo-bound delivery tools also accept explicit `repoPath` for direct API use, but default
to `requestContext.repoPath` when the input omits it. That keeps agent tool calls focused on
the action being recorded instead of repeating workspace location.

The delivery agents also share registered `deliveryMemory`. It is thread-scoped and only
for live coordination facts such as current stage, open questions, and approval state.
Durable decisions, artifacts, scores, events, and task status still go through delivery
tools, workflow state, and storage.

## Example Inputs

Example product docs are included at:

- `src/mastra/delivery-engine/examples/vision.md`
- `src/mastra/delivery-engine/examples/spec.md`

To dry-run with them, create a target repo, place those files at its root, and pass that
repo path into `deliveryWorkflow`.

## Pipeline Shape

The workflow currently runs:

1. Initialize `.delivery/run.json`.
2. Planner creates readout and task plan.
3. Plan gate runs deterministic checks and judges the task plan.
4. Architect reviews the plan and can bounce to planner within `maxRetries`.
5. Engineer/designer build loop executes tasks in dependency order.
6. Tester produces and judges a release gate.
7. Native deployment stage writes a local validation report or, after approval, runs Wrangler production deploy and writes a deployment report.
8. Deployment gate runs deterministic checks, judges the deployment report, and finalizes the run.
9. The run finishes as `complete`, `failed`, or `stuck`.
10. Final `.delivery` run state is persisted into Mastra observability storage.

Judgment math is always computed in TypeScript. Models only produce raw gate and dimension
scores.

## Native Delivery State Storage

`.delivery/run.json` and `.delivery/events.jsonl` remain the portable inspection layer
inside the target repo. Mastra also gets first-class observability records:

- `persist-delivery-state` writes one delivery snapshot log plus event logs into the
  configured observability store.
- `list-delivery-state-records` queries those records by `repoPath` and/or `runId`.
- `mirror-delivery-state` and `list-delivery-state-mirrors` remain compatibility aliases.
- The workflow automatically persists terminal states after finalizing a run.

## Native Scoring

Delivery scorers are registered in `src/mastra/index.ts`, so Mastra Studio can see and run
them as first-class scorers. The plan gate, review, build, release-gate, and deployment
judgment steps attach stage-specific scorer groups with full sampling for live workflow
scoring.

The current scorer set covers:

- planner -> architect handoff readiness
- architect -> build handoff readiness
- build -> tester handoff readiness
- tester -> native deployment handoff readiness
- workflow completion
- lowest rubric judgment score
- rubric judgment pass rate
- deterministic check pass rate

## Native HITL

The workflow uses Mastra suspend/resume for human input:

- `create-planner-artifacts` suspends with resume label `answer-planner-questions` only when
  the vision/spec/source docs contain a true blocker and no executable root task can be planned.
  Malformed or overcautious plans continue into deterministic gate/repair instead of pausing.
  Resume with:

```json
{
  "answers": [{ "question": "...", "answer": "..." }],
  "notes": "optional extra context"
}
```

- `create-deployment-report` suspends with resume label `approve-production-deployment` before
  any production deployment command runs. Resume with:

```json
{
  "approved": true,
  "approver": "name or handle",
  "notes": "optional approval context"
}
```

## Native Processors / Guardrails

Delivery agents attach shared Mastra processors:

- input: Unicode normalization, required `requestContext.repoPath`, delivery policy override
  blocking, and per-step token limiting
- output: secret redaction plus a retryable guardrail for completion claims without delivery
  artifacts, events, checks, judgments, or release-gate evidence

The same processor instances are registered in `src/mastra/index.ts` under `processors`, so
they are inspectable as native Mastra resources.

## Verification

Use:

```shell
npm run typecheck
npm test
npm run eval:delivery:gate
npm run ci:delivery
npm run build
```

For target Worker projects, the delivery release gate plans Wrangler-native evidence:
generated type freshness for TypeScript Workers, `wrangler deploy --dry-run`, local D1
migrations when configured, static Worker config checks, and local `wrangler dev` runtime
probes before any production approval path.

`npm run build` has completed successfully for this project. If a restricted sandbox stalls
while Mastra installs generated output dependencies, rerun the same package script in a
network-enabled environment rather than calling `mastra build` directly.
