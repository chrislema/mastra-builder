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
- Added native rubric judgment harness:
  - TypeScript aggregation port
  - judge output schemas
  - deterministic gate precedence
  - task-plan judge artifacts
  - recorded `.delivery/run.json` judgments
- Added architect review stage:
  - structured `review-report` output
  - review-report rubric judgment
  - blocked-plan planner bounce loop
  - bounded retries before stuck state
- Added delivery build loop skeleton:
  - topological task execution
  - engineer/designer routing
  - active boundary surfaces per task
  - implementation notes
  - deterministic implementation gates
  - implementation rubric judgments
  - stuck/blocked task propagation
- Added release gate stage:
  - tester structured `release-gate` output
  - test/probe evidence event checks
  - tier-order and blocker deterministic gates
  - release-gate rubric judgment
  - deployment stop on gate failure
- Added deployment stage:
  - release-gate read event before deploy
  - mock/real deploy mode prompt contract
  - deployment-report artifact
  - deploy/live verification deterministic gates
  - deployment-report rubric judgment
  - final run complete/failed/stuck finish handling
- Added regression and self-tests:
  - deterministic check tests
  - aggregation behavior tests
  - `.delivery/` state lifecycle fixture test
  - rubric exemplar integrity harness
  - `npm test` script
- Added Studio/runtime polish:
  - Delivery Engine README usage
  - workflow input contract
  - `requestContext.repoPath` behavior
  - example input locations
  - verification commands and build note
- Added native Mastra scoring:
  - registered delivery scorers in `src/mastra/index.ts`
  - live scoring on plan, review, build, release-gate, and deployment workflow steps
  - planner -> architect, architect -> build, build -> tester, and tester -> deployer
    handoff readiness scorers
  - completion, rubric floor, judgment pass rate, and deterministic check pass rate scorers
  - direct scorer unit tests
- Added native workflow decomposition:
  - split planner artifact creation from plan gates and task-plan judgment
  - split deployer report creation from deployment gates, judgment, and finalization
  - moved scorer attachment to the explicit gate/judgment steps

Checkpoint commit:

- `6220908 Port delivery engine foundation to Mastra`
- `11037bb Add delivery engine port roadmap`
- `f59419c Add native rubric judgment harness`
- `9fc5e09 Add architect review stage`
- `66d5cf1 Add delivery build loop skeleton`
- `4cec422 Add release gate stage`
- `1471391 Add deployment stage`
- `99c4d0c Add delivery engine regression tests`
- `30cc1dd Document delivery engine usage`
- `5a775e6 Add native Mastra delivery scorers`

## Next Slices

### 1. Judge Harness And Aggregation (Completed)

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

### 2. Architect Review Stage (Completed)

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

### 3. Build Loop Skeleton (Completed)

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

### 4. Release Gate Stage (Completed)

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

### 5. Deployment Stage (Completed)

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

### 6. Regression And Self-Tests (Completed)

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

### 7. Studio/Runtime Polish (Completed)

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

### 8. Native Mastra Scoring (Completed)

Goal: use Mastra's first-class scorer system for delivery quality signals.

Work:

- Add `createScorer()` definitions for handoff readiness, workflow completion, and
  delivery quality signals.
- Register scorers in `src/mastra/index.ts`.
- Attach live scorers to workflow handoff steps with full sampling.
- Score workflow step output from stage status, recorded checks, and judgments.
- Add direct unit tests for scorer behavior.

Done when:

- Studio/API can discover registered delivery scorers.
- Delivery workflow runs can emit live handoff and final-step scores.
- Scorer tests and TypeScript pass.

Natural commit:

- `Add native Mastra delivery scorers`

### 9. Native Workflow Decomposition (Completed)

Goal: make major generation and gate/judgment boundaries visible as first-class Mastra
workflow steps.

Work:

- Split planner artifact generation into its own step.
- Split task-plan deterministic gates and rubric judgment into a scored plan-gate step.
- Split deployer report generation into its own step.
- Split deployment deterministic gates, rubric judgment, and run finalization into a scored
  deployment judgment step.
- Preserve current behavior while increasing trace, retry, and Studio visibility.

Done when:

- The workflow exposes narrower step boundaries for planner and deployment stages.
- TypeScript and deterministic tests pass.

Natural commit:

- `Decompose delivery workflow gate steps`

## Open Questions

- Whether the target repo should be accessed by dynamic workspace context only, or whether
  we should also provide a direct workflow input for single-repo deployments.
- Whether to keep file-based skills under `src/mastra/delivery-engine/skills` long term or
  convert some high-traffic skills to `createSkill()` definitions.
- Whether judge models should stay `openai/gpt-5-mini` initially or use a cheaper model
  once rubric behavior is stable.
- Whether deployment should remain mock-first until release-gate and live verification are
  robust.
- Whether to extend native scoring beyond workflow handoffs into per-agent and
  experiment/dataset evaluation flows once live scoring is stable.
- Whether review retries should become native `.dountil()` loops with explicit planner
  revision steps.
- Whether the build loop should become a nested task workflow run through `.foreach()`
  once task-level schemas are stable.
- Whether release-gate retries should split tester artifact generation from release-gate
  judgment in the same pattern as planner and deployment.
