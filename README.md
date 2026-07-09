# Mastra Builder for Cloudflare Workers

This project is a Mastra-native delivery harness for building Cloudflare Worker web
applications and SaaS products. It is intentionally opinionated around standalone Workers,
Worker Static Assets for vanilla HTML/CSS/JS frontends, Wrangler, D1, KV, R2, Durable
Objects, Queues, Workers AI, and custom-domain-ready deployment paths. The default bias is
Workers over Pages; Pages and Pages Functions are allowed only when the vision/spec
documents explicitly call for them.

The project takes inspiration from `github.com/chrislema/claude-environments`, but it is
not a Claude wrapper and does not keep Claude-specific plugins, hooks, or commands. Those
ideas have been translated into Mastra first-class citizens: registered role agents,
native workflows, Mastra workspace hooks, delivery tools, processors, thread-scoped
working memory, LibSQL storage, observability exporters, custom API routes, native
scorers, datasets, eval gates, and human-in-the-loop suspend/resume.

## First-Class Mastra + Cloudflare Shape

The harness is designed to look and behave like an advanced Mastra project, not a prompt
bundle that happens to run inside Mastra:

- Native workflows split planning, review, build, per-task build execution, release gate,
  and deployment into inspectable Mastra workflow surfaces.
- Agents are registered with role-specific models, shared processors, `requestContext`
  contracts, a repo-bound Mastra workspace, delivery tools, skills, and run-scoped memory.
- Workspace hooks enforce role/task file boundaries, command policy, dependency-read
  budget, write tracking, and event capture before and after tool calls.
- Delivery state is portable in `.delivery/` and also mirrored into Mastra storage and
  observability so Studio can inspect workflow runs, logs, traces, and terminal snapshots.
- Scorers and eval suites are registered as native Mastra resources, with deterministic
  gates for handoffs, rubric floors, pass rates, Cloudflare topology, binding hygiene,
  service fit, sequencing, and Wrangler deployment hygiene.
- Human input uses Mastra suspend/resume for planner blockers and production deployment
  approval instead of ad hoc pauses.
- Cloudflare guidance is encoded as task-plan gates, role instructions, skills, release
  evidence, and eval fixtures so the builder produces Worker-first systems rather than
  generic web apps.

## What Is Registered

`src/mastra/index.ts` registers:

- `deliveryStartWorkflow`, the one-field Studio/API facade, plus `deliveryWorkflow` and
  native stage workflows: `deliveryPlanningWorkflow`, `deliveryScaffoldWorkflow`,
  `deliveryReviewWorkflow`, `deliveryBuildWorkflow`, `deliveryBuildTaskWorkflow`,
  `deliveryReleaseGateWorkflow`, and `deliveryDeploymentWorkflow`
- role agents: planner, architect, engineer, designer, tester, deployment advisor, judge
- delivery state tools for `.delivery/`, including observability persistence/list tools
- delivery scorers for handoff readiness, workflow completion, scaffold readiness, local
  evidence, model spend, rubric floor, judgment pass rate, deterministic checks, and
  Cloudflare architecture hygiene
- `deliveryMemory`, a thread-scoped Mastra working-memory contract for live run coordination
- delivery processors for repo-bound execution, policy override blocking, evidence-backed
  completion claims, token limiting, Unicode normalization, and secret redaction
- a dynamic delivery workspace rooted by `requestContext.repoPath`
- custom routes `GET/POST /delivery/launcher` and `POST /delivery/run` for starting
  resource-scoped delivery workflow runs
- storage-backed observability for final delivery run state snapshots and events

The default weather scaffold has been removed.

## Run Locally

Create `.env` from `.env.example` and set `OPENAI_API_KEY`. The default delivery and
judge models are `openai/gpt-5.5`. To test a smaller execution model while keeping
planner/architect/judge on GPT 5.5, set:

```shell
ZHIPU_API_KEY=your-zai-api-key
DELIVERY_EXECUTION_MODEL=zai-coding-plan/glm-5.2
```

You can also override individual slots with `DELIVERY_PLANNING_MODEL`,
`DELIVERY_ARCHITECT_MODEL`, `DELIVERY_ENGINEER_MODEL`, `DELIVERY_DESIGNER_MODEL`,
`DELIVERY_TESTER_MODEL`, and `DELIVERY_JUDGE_MODEL`.

```shell
npm install
npm run typecheck
npm test
npm run ci:delivery
npm run build
npm run dev
```

Open the Studio URL printed by `npm run dev`. On Chris's machine this is commonly
`http://localhost:4112`, but Mastra may choose a different port if another Studio process
is already running. For the simplest browser entry point, open the API route
`/api/delivery/launcher` on that same server and enter only the project folder.

In Studio, use `deliveryStartWorkflow` when you want the facade with one required field:
`projectFolder`. Use `deliveryWorkflow` only when you intentionally want the full internal
workflow input surface.

## Run A Delivery Workflow

From the command line:

```shell
npm run delivery:run -- --projectFolder /absolute/path/to/project-folder
```

`--repo` and `--repoPath` remain supported aliases for older scripts. `visionPath`
defaults to `vision.md`, `specPath` is optional and auto-detected as `spec.md` when that
file exists, `maxRetries` defaults to `2`, and `deployMode` defaults to `local`.

The same native runner is exposed as a Mastra custom API route:

```shell
curl -X POST http://localhost:4112/api/delivery/run \
  -H 'Content-Type: application/json' \
  -d '{
    "projectFolder": "/absolute/path/to/project-folder"
  }'
```

Use the API base URL printed by `npm run dev`; in local Studio output this is usually
`http://localhost:4112/api`, making the route `/api/delivery/run`.

For a small HTML launcher instead of raw JSON, open:

```text
http://localhost:4112/api/delivery/launcher
```

Use the actual host and port printed by `npm run dev`.

Both paths call `deliveryWorkflow.createRun({ resourceId })`, pass
`requestContext.repoPath`, and include delivery trace metadata. The CLI waits for the native
workflow result with workflow state by default. The HTTP route uses `startAsync()` and
returns `{ workflowId, runId, resourceId, status }` immediately so long-running delivery
builds do not block the request. CLI runs also write `.delivery/runs/<workflowRunId>.json`
and `.delivery/runs/latest.json` inside the target project for post-run diagnosis.

## Workflow Input

`deliveryWorkflow` can start from a single field:

```json
{
  "projectFolder": "/absolute/path/to/project-folder"
}
```

`projectFolder` can be an existing repo or a new project folder with `vision.md` in it; a
Git repo is not required before the run starts. `repoPath` is still accepted as a
compatibility alias, but `projectFolder` is the human-facing name. `visionPath` defaults to
`vision.md`, and `specPath` is optional. When `specPath` is omitted, `spec.md` is used only
if it already exists in the project folder. Relative document paths are resolved under the
project folder, and absolute paths inside the folder are normalized to repo-relative paths.
The workflow writes authoritative state and artifacts under `<projectFolder>/.delivery/`.

Use `deployMode: "local"` unless a production deployment is explicitly intended. It is the
default, so Studio/API callers can leave it blank. The legacy aliases `mock` and `real` are
still accepted, but the harness is designed around local Wrangler validation first and
human approval before production deploy. `maxRetries` also defaults to `2` when omitted or
left blank.

Target projects are assumed to be standalone Cloudflare Workers projects with vanilla
JavaScript Worker modules and vanilla HTML, CSS, and JavaScript frontends. Pages Functions
are allowed only when `vision.md` or `spec.md` declaratively requires Cloudflare Pages or
Pages Functions, but the deterministic scaffold is Worker-only and will fail fast rather
than generate a misleading Worker scaffold for an explicit Pages project. TypeScript Worker
source is also an explicit exception, not the default.
The delivery agents should not introduce React, JSX/TSX, frontend frameworks,
preprocessors, generic Node/Express servers, filesystem-backed runtime state, or a new
frontend build step.

New Worker config should define Wrangler `env.staging` and `env.production`.
Bindings and vars required by the Worker must be mirrored inside those environments because
Wrangler does not inherit them across environments. Production approval runs the native
Wrangler path with `wrangler deploy --env production`.
For brand-new Worker projects, the first root scaffold task should create `package.json`,
`.gitignore`, `wrangler.jsonc`, and the Worker entrypoint together so Wrangler dry-run
verification can run from the first build slice. D1 migrations should remain separate
downstream tasks.
New Worker package scripts should match those explicit environments: `scripts.dev` runs
`wrangler dev --env staging`, and `scripts.deploy` runs `wrangler deploy --env production`.

When a target project does use TypeScript Worker source, the scaffold should use Wrangler's
generated types instead of hand-written Worker runtime types: `scripts.generate-types` runs
`wrangler types`, `scripts.typecheck` runs `npm run generate-types && tsc --noEmit`, and
`tsconfig.json` includes `./worker-configuration.d.ts` plus `node`. On a fresh scaffold the
release gate runs `wrangler types` before package checks when `worker-configuration.d.ts`
does not exist yet; when generated types already exist, it runs `wrangler types --check`
before package checks. It then plans dry-run deploy, startup profiling, staging-aware local
D1 migrations, and local `wrangler dev --env staging` probes.
During implementation, vanilla JavaScript Worker slices fall back to Wrangler deploy dry-run
verification when the target project has no explicit `typecheck`, `check`, `test`, or `build`
script, so the build loop can keep validating Worker bundles without forcing TypeScript.

Use local `git` for source-control checkpoints. Use the `gh` CLI only when an explicit
human instruction calls for pushes, pull requests, or other remote GitHub actions. Do not
use GitHub Actions as the deployment path. Production deployments should use Wrangler CLI
directly through `wrangler deploy --env production`.

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

The top-level `deliveryWorkflow` is composed from smaller native stage workflows so
Mastra Studio and observability can inspect each major handoff separately. The current
pipeline runs:

1. `deliveryPlanningWorkflow` initializes `.delivery/run.json`, creates the readout and
   task plan, runs deterministic plan gates, judges the task plan, and persists plan state.
2. `deliveryReviewWorkflow` runs architect review and can bounce to planner within
   `maxRetries`.
3. `deliveryBuildWorkflow` expands implementation tasks and runs `deliveryBuildTaskWorkflow`
   for each engineer/designer task in dependency order.
4. `deliveryReleaseGateWorkflow` collects Wrangler/local evidence, produces the tester
   release gate, and judges it.
5. `deliveryDeploymentWorkflow` writes a local validation report or, after approval, runs
   Wrangler production deploy, judges the deployment report, finalizes the run, and persists
   terminal state.

Judgment math is always computed in TypeScript. Models only produce raw gate and dimension
scores.

## Native Delivery State Storage

`.delivery/run.json` and `.delivery/events.jsonl` remain the portable inspection layer
inside the target repo. Mastra runtime state defaults to the ignored repo-local database
`.mastra/builders.db`, or to `MASTRA_STORAGE_URL` / `MASTRA_STORAGE_PATH` when either is
set in `.env`. The configured storage id is `builders-delivery-storage`, and traces/logs use
the `builders-delivery-engine` observability service name. Mastra also gets first-class
observability records:

- `persist-delivery-state` writes one delivery snapshot log plus event logs into the
  configured observability store.
- `list-delivery-state-records` queries those records by `repoPath` and/or `runId`.
- reads still recognize older records written under the legacy `builders` service name.
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
- deterministic scaffold profile fit
- scaffold test runtime matrix hygiene
- scaffold binding completeness
- vanilla frontend compliance
- local evidence readiness
- model spend per completed task
- lowest rubric judgment score
- rubric judgment pass rate
- deterministic check pass rate
- Cloudflare Worker-first topology
- Cloudflare storage/service fit
- Cloudflare binding hygiene
- Cloudflare task sequencing
- Cloudflare deployment hygiene

## Native Eval Suite

The delivery eval suite uses a Mastra Dataset named `delivery-scorecard-regression` with
`targetType: scorer`, scorer IDs attached as dataset metadata, and stored experiments for CI
history. Each fixture carries explicit expected scores for every registered delivery scorer,
with positive and negative coverage for each scorer. The eval tests also read back native
Mastra `scores` rows from the LibSQL `scores` domain for every scorer, so this is a stored
Mastra eval path rather than only an in-memory assertion.

The Cloudflare architecture eval suite uses a second Mastra Dataset named
`cloudflare-architecture-regression`. It evaluates content decisions instead of workflow
shape: Worker-first topology, explicit Pages exceptions, D1/KV/R2/Durable Objects/Queues/
Workers AI/Vectorize fit, Wrangler binding hygiene, safe implementation sequencing, and
direct Wrangler deployment instead of GitHub Actions deployment.

`npm run eval:delivery:gate` writes a Mastra-style gate report with:

- hard gate results for experiment completion, item failures, persistence failures, score
  mismatches, dataset size, and scorer coverage
- threshold results for success rate, score alignment rate, and scorer coverage rate
- a `passed`, `scored`, or `failed` verdict that mirrors Mastra gates-and-threshold semantics
- trend deltas when `DELIVERY_EVAL_BASELINE` points to a previous report

`npm run eval:cloudflare:gate` does the same for the Cloudflare architecture dataset and
can write a report to `CLOUDFLARE_EVAL_REPORT`. Its tests also prove score rows are
persisted in the native `scores` domain. `npm run ci:delivery` runs both native eval gates
after typecheck and tests.

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
generated type freshness for TypeScript Workers, `wrangler deploy --dry-run`,
`wrangler check startup`, local D1 migrations when configured, static Worker config checks,
and local `wrangler dev --env staging` runtime probes before any production approval path. When
`env.staging` exists, local D1 migration evidence uses that staging environment as well. New Worker
scaffolds should also ignore `*.cpuprofile` so startup-profile evidence stays out of git.

`npm run build` has completed successfully for this project. If a restricted sandbox stalls
while Mastra installs generated output dependencies, rerun the same package script in a
network-enabled environment rather than calling `mastra build` directly.
