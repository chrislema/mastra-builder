# Delivery Engine for Mastra

This project is a Mastra-native port of the delivery engine ideas from
`github.com/chrislema/claude-environments`. The Claude repo remains the Claude-specific
implementation. This repo uses Mastra first-class pieces: agents, tools, workflow steps,
workspace hooks, typed artifacts, deterministic checks, rubric aggregation, native scorers,
working memory, and custom API routes.

## What Is Registered

`src/mastra/index.ts` registers:

- `deliveryWorkflow`
- role agents: planner, architect, engineer, designer, tester, deployer, judge
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

```shell
npm install
npm test
npm run ci:delivery
npm run build
npm run dev
```

Open `http://localhost:4111` for Mastra Studio, then run `deliveryWorkflow` from the
Workflows tab.

## Run A Delivery Workflow

From the command line:

```shell
npm run delivery:run -- --repo /absolute/path/to/target-repo --vision vision.md --spec spec.md
```

The same native runner is exposed as a Mastra custom API route:

```shell
curl -X POST http://localhost:4111/delivery/run \
  -H 'Content-Type: application/json' \
  -d '{
    "repoPath": "/absolute/path/to/target-repo",
    "visionPath": "vision.md",
    "specPath": "spec.md",
    "maxRetries": 2,
    "deployMode": "mock"
  }'
```

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
  "deployMode": "mock"
}
```

`visionPath` and `specPath` must point to files inside `repoPath`; relative paths are
resolved under `repoPath`, and absolute paths inside the repo are normalized to
repo-relative paths. The workflow writes authoritative state and artifacts under
`<repoPath>/.delivery/`.

Use `deployMode: "mock"` unless a real deployment is explicitly intended.

Target projects are assumed to be standalone Cloudflare Workers projects with vanilla
HTML, CSS, and JavaScript frontends. Pages Functions are an explicit exception, not the
default. The delivery agents should not introduce React, JSX/TSX, frontend frameworks,
preprocessors, generic Node/Express servers, filesystem-backed runtime state, or a new
frontend build step.

Use local `git` plus the `gh` CLI for repository operations such as commits, pushes,
and pull requests. Do not use GitHub Actions as the deployment path. Real deployments
should use Wrangler CLI, or an existing project script that directly wraps Wrangler.

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
7. Deployer runs mock or real deployment and writes a deployment report.
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
- tester -> deployer handoff readiness
- workflow completion
- lowest rubric judgment score
- rubric judgment pass rate
- deterministic check pass rate

## Native HITL

The workflow uses Mastra suspend/resume for human input:

- `create-planner-artifacts` suspends with resume label `answer-planner-questions` when
  planner readout finds blocking ambiguities. Resume with:

```json
{
  "answers": [{ "question": "...", "answer": "..." }],
  "notes": "optional extra context"
}
```

- `create-deployment-report` suspends with resume label `approve-real-deployment` before
  any real deployment command runs. Resume with:

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
npm test
npm run eval:delivery:gate
npm run ci:delivery
npm run build
```

`npm run build` has completed successfully for this project. If a restricted sandbox stalls
while Mastra installs generated output dependencies, rerun the same package script in a
network-enabled environment rather than calling `mastra build` directly.
