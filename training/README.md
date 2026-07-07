# Training: Learning Mastra Through the Delivery Engine

A plain-language (10th-grade reading level) introduction to Mastra — agents, tools, workflows, loops, harnesses, memory, guardrails, judging, scorers, and evals — taught through this repository's Delivery Engine as the running example.

Two ways to read it:

- **Short on time:** [00-executive-summary.md](00-executive-summary.md) — the whole series in one sitting.
- **The full series** (~11,500 words across 14 parts, in order):

| # | Part | Covers |
|---|---|---|
| 1 | [Before We Start](01-before-we-start.md) | What the example project does; what a "harness" is |
| 2 | [The Absolute Basics](02-the-absolute-basics.md) | LLMs, prompts, tokens; why models can't be trusted; the sorting principle |
| 3 | [What Is Mastra](03-what-is-mastra.md) | The framework, registration, Studio, the model router, per-role models |
| 4 | [Agents](04-agents.md) | The eight roles and why roles exist; the judge; the supervisor |
| 5 | [Tools and the Paper Trail](05-tools-and-the-paper-trail.md) | createTool, Zod schemas, the 16 state tools, `.delivery/` and the event log |
| 6 | [The Workspace](06-the-workspace.md) | Contained file/terminal access; the five hook tripwires |
| 7 | [Workflows and Loops](07-workflows-and-loops.md) | Steps, `.then`/`.dountil`/`.foreach`, bounded retries, watchdogs, retry modes |
| 8 | [Structured Output, Memory, and Guardrails](08-structured-output-memory-and-guardrails.md) | JSON schemas, fail-closed parsing, working memory, the six processors |
| 9 | [Judging](09-judging.md) | Deterministic checks, rubrics and the judge, promoted hygiene gates and auto-repair |
| 10 | [Scorers and Evals](10-scorers-and-evals.md) | Live scorers, datasets, experiments, CI gates |
| 11 | [Humans in the Loop](11-humans-in-the-loop.md) | Suspend/resume; the two legitimate pauses |
| 12 | [Skills, Doors, and Watching It Run](12-skills-doors-and-watching-it-run.md) | Skills, the four entry surfaces, observability |
| 13 | [A Run, Start to Finish](13-a-run-start-to-finish.md) | The full Tally walkthrough, minute by minute |
| 14 | [What to Take With You](14-what-to-take-with-you.md) | The seven transferable lessons |

The single-file original lives at [`docs/teaching-mastra-with-the-delivery-engine.md`](../docs/teaching-mastra-with-the-delivery-engine.md).
