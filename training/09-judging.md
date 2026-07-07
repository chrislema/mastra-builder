# Part 9: Judging — Checks, Rubrics, and the Courtroom

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

We've arrived at the intellectual heart of the project. Building work is only half the factory. The other half is deciding — reliably, repeatably, cheaply — whether the work is *good*. The Delivery Engine's answer has three layers, and the layering *is* the lesson.

### Layer 1: Deterministic checks — rules that code can answer

A **deterministic check** is a yes/no rule a plain function can evaluate. No model, no cost, no variance, no charm. The project ports thirteen of them into TypeScript (`checks.ts`). A sampler, because the names alone teach the philosophy:

- `dependency_graph_acyclic` — the task plan's dependencies contain no cycles. (A plan where A waits for B and B waits for A can't be executed in any order. Graph algorithm; done.)
- `plan_schema_complete` — every task row has an ID, owner, deliverable, dependencies, acceptance criteria, and owned surfaces, and the owner is a role the build loop can actually execute.
- `file_ownership` / `write_paths_in_boundary` — every file written falls inside the writer's role and task boundaries. Reads the event log.
- `ran_code_before_complete` — somewhere in this stage's slice of the event log, code actually executed before the stage claimed completion. The failure message is a poem: *"stage completed without any code execution — confidence is not evidence."*
- `harness_run_before_findings` — a reviewer/tester produced findings only *after* running something. No armchair verdicts.
- `release_gate_read_before_deploy` — the deploy step read the release gate first. *"Deployed without reading the release gate — deploying on optimism."*
- `live_verify_after_deploy` — every deployment was followed by a real probe of the live system.
- `no_bcrypt_weak_hash` — the security-primitive rule from Part 6, checkable on any set of files.
- `tier_order` — tests ran in the required order (smoke → API → end-to-end), none skipped for the event type.
- `ended_explicitly` — the stage ended by finishing or by escalating, not by slamming into its turn limit. *"Thrash-to-timeout is a stability failure."*

Several of these are **trajectory checks**: they judge not the *product* but the *process*, by reading the event log — which is why the paper trail is load-bearing. You cannot fake "code ran before the claim" in a summary; the log either has the event or it doesn't.

### Layer 2: Rubrics and the judge — grading what code can't check

Some qualities can't be computed: *Is this plan concrete or just themes? Are these acceptance criteria actually checkable? Are the findings evidenced?* For these, the project uses **rubrics** — and if you've ever taught school, you know exactly what a rubric is: a written grading standard that turns "how good is this?" into specific, scored questions.

Each rubric is a JSON file with two kinds of content:

- **Gates** — pass/fail conditions. Each gate declares *how it's evaluated*: `{"deterministic": "dependency_graph_acyclic"}` means code answers it; `"llm"` means the judge answers it. Failed gates carry consequences — a `critical` gate typically **caps** the whole score at zero regardless of anything else.
- **Dimensions** — weighted quality scales from 1 to 5, each with written **anchors** describing what a 1, 3, and 5 look like, so the judge grades against descriptions rather than mood.

There are rubrics for every artifact (task plan, review report, implementation, release gate, deployment report...) and — this is unusual and excellent — **trajectory rubrics for every role**, grading behavior: the planner's rubric weights "blocking questions only" highest (don't pester humans with non-blockers); the engineer's weights "evidence over narration"; the tester's weights "fail-closed discipline"; the architect's, "evidence-based review" (*"an unread review is ceremonial"*). Each rubric even documents *why* its heaviest dimension is heaviest (`weight_rationale`), and embeds **exemplars** — a known-good and known-bad example with expected outcomes — that act as regression tests for the rubric itself. A rubric that can't tell its own good exemplar from its bad one isn't allowed to be used.

The judging procedure, per artifact:

1. Code runs all deterministic gates first. Free, instant, incorruptible.
2. The judge agent gets one artifact, one rubric, the deterministic results (marked "already decided — do not rescore"), and returns strict JSON: per-gate verdicts and per-dimension scores, *each with cited evidence*. The output is validated against a schema derived from the rubric — a judge that skips a required dimension is rejected and retried.
3. **Code aggregates**: weighted average of scored dimensions, normalized to 0–1; failed critical gates cap the score; dimensions the judge couldn't score are renormalized out (never guessed); any gate *nobody* evaluated **fails closed** — "gate was not evaluated — failing closed."
4. The output includes **remediation** — a machine-generated fix-list from failed gates and weak dimensions — which, as we saw in Part 7, becomes the input to the next loop iteration. Judgment isn't a verdict; it's a steering signal.
5. Everything is filed: the raw judge output, the aggregated judgment, and a full trace of the exchange, all under `.delivery/artifacts/judgments/`.

One more defensive touch: if the judge's *model provider* is down or overloaded (a network error, a rate limit), code detects it and synthesizes a failing-closed judgment that clearly says "the judge was unavailable — retry the run; nothing is implied about your code." Infrastructure failure is never mistaken for quality failure, in either direction.

### Layer 3: Hygiene gates and auto-repair — judgment that got promoted into code

Here's a dynamic you can only see in a project that has *run* for a while: rules migrate down the stack. When a judgment call turns out to be stable and repeated — the model keeps making the same class of plan mistake — the maintainers stop asking the model to avoid it and start *enforcing or fixing it in code*. The plan gate is full of these promoted rules (all plain functions):

- `openDecisionHygiene` — planners love to "escalate" preferences as blocking questions. This check rejects open decisions that aren't decision-shaped (Topic / Why it matters / Options / Impact), that re-ask settled policy, or that don't name what they block.
- `ownedSurfaceHygiene` — task file lists must be concrete paths, not wildcards or concepts ("the API layer" is not a file).
- `projectScaffoldHygiene`, `configSchemaTaskSplitHygiene`, `operatorDocumentationHygiene`, `generatedSliceDependencyHygiene`... each encodes one learned lesson about what makes plans executable.

Beyond checks, there are **normalizers** — functions that silently *fix* plans before judging: splitting oversized tasks into ≤2-file slices, separating config from database-schema tasks, injecting a missing documentation task, rewiring dependencies to point at the final slice of a split family, adding an auth-session task when a UI needs one, deduplicating route-integration tasks. And down at the build level, **auto-repairs**: a specific TypeScript error pattern (TS18046) gets patched by string transformation; a missing import gets added; stale leftover files that break verification get reset to stubs — each repair logged as an `auto_repair` event, no model tokens spent.

This is the sorting principle as a *living process*: judgment hardens into policy, policy hardens into code. The project's constitution says it directly: "Stable patterns become policy; policy becomes workflow; workflow becomes infrastructure."
