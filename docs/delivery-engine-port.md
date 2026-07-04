# Delivery Engine Mastra Port

This is the persistent roadmap for porting `github.com/chrislema/claude-environments`
into a Mastra-native delivery engine. The Claude repo remains alive for Claude; this
project should become the native Mastra version.

## Operating Rules

- Load the Mastra skill before Mastra API/code work.
- Commit at every natural stop or pause.
- Keep Claude-specific concepts out of runtime names and APIs.
- Preserve the sorting principle:
  - deterministic and blockable -> tools, checks, processors, workspace hooks
  - judgment and gradeable -> scorers, judge agent, aggregation
  - judgment and generative -> role agents and skills
- Prefer executable state over narrative memory.
- Verify each slice with `./node_modules/.bin/tsc --noEmit`.

## Done

- Cloned and inspected `chrislema/claude-environments`.
- Removed the default weather scaffold.
- Added Delivery Engine source materials:
  - skills
  - rubrics
  - schemas
  - templates
  - policy
  - examples
- Added Mastra-native role agents:
  - planner
  - architect
  - engineer
  - designer
  - tester
  - deployer
  - judge
- Added native delivery state tools for `.delivery/`.
- Ported deterministic check registry to TypeScript.
- Added a Mastra workspace with boundary, crypto, and event-log hooks.
- Registered delivery agents, tools, workspace, and first workflow in `src/mastra/index.ts`.
- Added `deliveryWorkflow` foundation:
  - initialize run state
  - planner readout
  - task plan
  - deterministic plan gates

Checkpoint commit:

- `6220908 Port delivery engine foundation to Mastra`

## Next Slices

### 1. Judge Harness And Aggregation

Goal: make rubric judging native and executable.

Work:

- Port `aggregate.mjs` to TypeScript.
- Add schemas/types for judge output and aggregated judgment.
- Add a `judgeArtifact` function or workflow step.
- Run deterministic gates before LLM judging.
- Use `judgeAgent` only for LLM gates and dimensions.
- Write judgment artifacts to `.delivery/artifacts/judgments/`.
- Record judgments in `.delivery/run.json`.

Done when:

- `task-plan.rubric.json` can be applied to `.delivery/artifacts/task-plan.json`.
- Deterministic gate failures are represented exactly once.
- Aggregation is code-computed, never model-computed.
- TypeScript passes.

Natural commit:

- `Add native rubric judgment harness`

### 2. Architect Review Stage

Goal: extend `deliveryWorkflow` past planning.

Work:

- Add architect review structured output.
- Write `.delivery/artifacts/review-report.json`.
- Judge review report.
- Bounce to planner when architect blocks the plan.
- Park run as stuck after bounded retries.

Done when:

- Workflow can run plan -> review -> approved or stuck.
- Review judgments are persisted.
- TypeScript passes.

Natural commit:

- `Add architect review stage`

### 3. Build Loop Skeleton

Goal: make task execution first-class without implementing every edge case at once.

Work:

- Topologically order task-plan tasks.
- Start/end `build:<task-id>` stages.
- Route tasks to engineer or designer.
- Materialize active boundary surfaces.
- Require implementation notes.
- Run implementation deterministic gates:
  - file ownership
  - ran code before complete
  - crypto compliance where applicable
- Mark task complete, stuck, or blocked.

Done when:

- Workflow can process a task list in dependency order.
- Failed tasks park as stuck.
- Downstream dependencies become blocked.
- TypeScript passes.

Natural commit:

- `Add delivery build loop skeleton`

### 4. Release Gate Stage

Goal: port tester/release-gate behavior.

Work:

- Add tester structured output for `release-gate`.
- Ensure tests/probes are recorded as evidence events.
- Run deterministic release gates:
  - tier order
  - blockers zero
  - harness before findings
- Judge release-gate LLM dimensions.
- Fail closed on missing critical evidence.

Done when:

- Workflow produces `.delivery/artifacts/release-gate.json`.
- Gate failure stops deployment.
- TypeScript passes.

Natural commit:

- `Add release gate stage`

### 5. Deployment Stage

Goal: port deployer behavior.

Work:

- Require release gate read before deployment.
- Support mock deploy first.
- Record deploy and live_verify events.
- Produce deployment-report artifact.
- Judge deployment-report.
- Finish run as complete, failed, or stuck.

Done when:

- Workflow produces deployment report.
- No deploy happens through known blockers.
- Live verification evidence is required.
- TypeScript passes.

Natural commit:

- `Add deployment stage`

### 6. Regression And Self-Tests

Goal: make the port trustworthy without relying on full LLM runs.

Work:

- Add unit tests for TypeScript deterministic checks.
- Add aggregation tests mirroring `aggregate.test.mjs`.
- Add fixture-based workflow tests for state transitions.
- Add exemplar regression harness for rubrics.

Done when:

- Local deterministic tests pass.
- Rubric aggregation behavior matches source repo.
- TypeScript passes.

Natural commit:

- `Add delivery engine regression tests`

### 7. Studio/Runtime Polish

Goal: make the engine pleasant to use from Mastra Studio/API.

Work:

- Add concise README usage for `deliveryWorkflow`.
- Document required `requestContext.repoPath` behavior.
- Add sample run instructions using copied `examples/`.
- Consider a top-level orchestration agent that exposes the workflow as a tool.
- Check `npm run dev`/Studio registration once the workflow is deeper.

Done when:

- A user can start Studio and understand the visible agents/workflow.
- README explains the native Mastra shape.
- TypeScript passes.

Natural commit:

- `Document delivery engine usage`

## Open Questions

- Whether the target repo should be accessed by dynamic workspace context only, or whether
  we should also provide a direct workflow input for single-repo deployments.
- Whether to keep file-based skills under `src/mastra/delivery-engine/skills` long term or
  convert some high-traffic skills to `createSkill()` definitions.
- Whether judge models should stay `openai/gpt-5-mini` initially or use a cheaper model
  once rubric behavior is stable.
- Whether deployment should remain mock-first until release-gate and live verification are
  robust.
