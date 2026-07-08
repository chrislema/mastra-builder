# Delivery Engine Operating Doctrine

This is the short re-anchor for every future Codex turn, especially after context
compaction. The active goal matters, but it must always be pursued inside this
bigger judgment frame.

## North Star

The Delivery Engine should feel like an expert Mastra-native, Cloudflare-first
software delivery system for Chris's real work: mostly plain HTML, CSS,
JavaScript, and TypeScript applications on Cloudflare Workers, with Workers AI,
D1, KV, R2, Workers Workflows, and direct Wrangler deployment where appropriate.

Success is not "make the current error disappear." Success is reaching the end
of a real delivery run with working local-test evidence while making the harness
simpler, more native, more observable, and more trustworthy.

## Rubric Lens

Every change should preserve or improve the rubric score in
`docs/AI_AGENT_PROJECT_RUBRIC.md`, especially:

- Problem framing: keep the system narrow and Worker-focused.
- Context control: give each agent the right context, not all context.
- Workflow design: use Mastra workflows for durable control flow, not a hidden
  private framework inside one step.
- Evals and observability: measure behavior, traces, latency, cost, and failure
  modes instead of guessing.
- Safety and permissions: keep file writes, shell commands, secrets, deployment,
  and human approvals explicit.

If a change helps one local error but makes these categories worse, it is not a
good change.

## Forward Progress Rule

For delivery-run iteration, maintain a simple scoreboard:

- What was the farthest verified stage/task before this change?
- Did this change get the next clean run farther, faster, or clearer?
- Did it reduce repeated failure, or only move the failure earlier?
- Did it reduce complexity, or add special-case machinery?

If a run previously reached late tasks and a new approach stalls at T01/T02,
stop and reassess. Do not keep adding patches just because each patch has a
local explanation.

## Run Journal Rule

Every CLI or Studio delivery run must be recorded in
`docs/RUN_OBSERVATIONS.md`. Do not rely on chat context, terminal scrollback, or
memory surviving compaction.

Before starting a run, add the project path, command or Studio input, whether the
folder is being preserved or cleaned, and the forward-progress question the run
is meant to answer.

After the run stops, update the same entry with the workflow run ID, delivery run
ID, report path, reused stages, farthest verified stage or task, failure class,
concrete error, current hypothesis, cheap verification already tried, and the
next fix or stop decision.

If a context compaction happens mid-loop, read this file before touching the
workflow or running the sample again.

## Contract Rule

Contracts are still the right idea, but only in the right form.

Good contracts:

- Stable shared types, schemas, constants, and domain vocabulary.
- Explicit task inputs/outputs and artifact schemas.
- Deterministic checks for facts the code can prove reliably.
- Runtime or test evidence that verifies behavior across layers.
- Memory entries that keep cross-agent terms aligned, such as `is_active` vs
  `active`.

Bad contracts:

- Large piles of regex/string matching in `workflow.ts`.
- Product-specific acceptance wording encoded as general harness law.
- Criteria that require generated files to be hand-owned.
- Checks that make the system brittle, opaque, or slower without improving real
  output quality.
- Fixes that pass tests by narrowing the test rather than strengthening the
  product-building loop.

If a contract needs many exceptions, it probably belongs in a typed schema,
skill, scorer, eval fixture, source document, or generated project test instead
of the central workflow.

## Guardrail Design Rule

When a workflow failure comes from control text, prompts, or remediation wording,
do not patch forward with more prompt-text exceptions unless there is no better
boundary. Prefer structured provenance and typed context:

- Mark workflow-generated agent calls with request context or metadata.
- Keep source-document prompts and workflow-control prompts distinct; do not use
  one broad trust marker for both.
- Let direct/untrusted calls keep strict input guardrails.
- Keep deterministic file policy in file/content checks, not prompt filters.
- If a regex tripwire needs an exception for normal harness language, redesign
  the trust boundary before adding the exception.

This matters because delivery prompts legitimately contain words like "ignore"
inside `.gitignore` policy, and those should not be confused with user attempts
to bypass delivery state or release gates.

## Mastra-Native Bias

Prefer first-class Mastra primitives over custom orchestration whenever they fit:

- Agents for role-specific judgment and generation.
- Workflows for typed, durable, inspectable control flow.
- Tools for scoped actions with clear schemas and concise returns.
- Memory for small, typed run facts and cross-agent continuity.
- Scorers/evals for measurable quality gates.
- Observability for traces, scores, logs, run status, latency, and token/cost
  aggregation.
- Studio-friendly entry points that hide internal state from the operator.

If the implementation starts to look like a second framework beside Mastra,
pause and redesign.

## Cloudflare-First Bias

Default assumptions:

- Worker over Pages unless the vision/spec explicitly asks for Pages.
- Vanilla HTML/CSS/JS and TypeScript over React/Vite.
- Wrangler CLI for local and production deployment, not GitHub Actions.
- Cloudflare bindings must be explicit and mirrored where needed.
- Generated Wrangler types are verification output, not hand-written owned
  source.

Cloudflare expertise should make the harness narrower and faster, not more
generic.

## Iteration Discipline

When fixing a failed run:

1. Read the run report, events, artifacts, and relevant trace first.
2. Classify the failure: generated product bug, harness bug, model miss, missing
   evidence, environment issue, or user-facing decision.
3. Prefer the smallest structural fix that addresses the class of failure.
4. Add focused tests only when they prove the actual invariant.
5. Commit and push at each natural stop.
6. Before another paid full run, ask whether a static/unit test can prove the
   fix more cheaply.
7. Run the next full sample only when it can answer a meaningful forward-progress
   question.

Do not run expensive loops to compensate for unclear thinking.

## Stop Conditions

Pause and reassess before editing when:

- The fix would add another broad special case to `workflow.ts`.
- The same class of issue has appeared twice.
- A change would make the system pass earlier gates but weaken late-stage local
  deploy evidence.
- The run is going backward compared with a previous known-good stage.
- The right fix appears to be "more prompt pressure" rather than better
  structure, memory, evals, or evidence.

The goal is not to be busy. The goal is to make the system better at reliably
delivering Cloudflare Worker applications.
