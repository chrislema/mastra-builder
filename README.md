# Delivery Engine for Mastra

This project is a Mastra-native port of the delivery engine ideas from
`github.com/chrislema/claude-environments`. The Claude repo remains the Claude-specific
implementation. This repo uses Mastra first-class pieces: agents, tools, workflow steps,
workspace hooks, typed artifacts, deterministic checks, rubric aggregation, and native
scorers.

## What Is Registered

`src/mastra/index.ts` registers:

- `deliveryWorkflow`
- role agents: planner, architect, engineer, designer, tester, deployer, judge
- delivery state tools for `.delivery/`
- delivery scorers for handoff readiness, workflow completion, rubric floor, judgment
  pass rate, and deterministic check pass rate
- a dynamic delivery workspace rooted by `requestContext.repoPath`

The default weather scaffold has been removed.

## Run Locally

```shell
npm install
npm test
./node_modules/.bin/tsc --noEmit
npm run dev
```

Open `http://localhost:4111` for Mastra Studio, then run `deliveryWorkflow` from the
Workflows tab.

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

`visionPath` and `specPath` may be absolute paths, but relative paths are resolved under
`repoPath`. The workflow writes authoritative state and artifacts under
`<repoPath>/.delivery/`.

Use `deployMode: "mock"` unless a real deployment is explicitly intended.

## Request Context

Agents and workspace tools use `requestContext.repoPath` to decide which repository they
can read, write, search, and run commands in. The workflow supplies that context for every
agent call. If you call an agent directly from Studio or an API client, include the same
request context or the workspace will fall back to the current process directory.

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
3. Judge scores the task plan.
4. Architect reviews the plan and can bounce to planner within `maxRetries`.
5. Engineer/designer build loop executes tasks in dependency order.
6. Tester produces and judges a release gate.
7. Deployer runs mock or real deployment and produces a judged deployment report.
8. The run finishes as `complete`, `failed`, or `stuck`.

Judgment math is always computed in TypeScript. Models only produce raw gate and dimension
scores.

## Native Scoring

Delivery scorers are registered in `src/mastra/index.ts`, so Mastra Studio can see and run
them as first-class scorers. The plan, review, build, release-gate, and deployment steps
attach stage-specific scorer groups with full sampling for live workflow scoring.

The current scorer set covers:

- planner -> architect handoff readiness
- architect -> build handoff readiness
- build -> tester handoff readiness
- tester -> deployer handoff readiness
- workflow completion
- lowest rubric judgment score
- rubric judgment pass rate
- deterministic check pass rate

## Verification

Use:

```shell
npm test
./node_modules/.bin/tsc --noEmit
npm run build
```

In this sandbox, `npm run build` bundled the Mastra app successfully, then stalled during
the dependency-install phase because network access was blocked. In a normal networked
environment, rerun the same package script rather than calling `mastra build` directly.
