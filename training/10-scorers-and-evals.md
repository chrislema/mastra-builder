# Part 10: Scorers and Evals — Measuring the Machine

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

Everything so far judges *the work*. This part is about judging *the system* — and it's the part most AI projects skip, to their eventual sorrow.

### Scorers: live gauges on the pipeline

A Mastra **scorer** (created with `createScorer`) is a small registered object that looks at some output and produces a score between 0 and 1, plus a written reason. Scorers attach to workflow steps; every time the step runs, its scorers run too (this project samples at 100% — every run, every time), and the scores land in storage where Studio can chart them.

The Delivery Engine registers fourteen. They fall into three families:

**Handoff readiness** (four scorers): did planning end in a state ready for review? Review ready for build? Build ready for testing? Testing ready for deployment? Each is nearly trivial — status equals expected value → 1, else 0, with an explanatory reason — and that's fine. A gauge doesn't need to be clever; it needs to be *trustworthy and always on*.

**Quality aggregates** (five): workflow completion; the **rubric floor** (the *lowest* judgment score in the run — because your weakest artifact, not your average, is what bites you); judgment pass rate; deterministic-check pass rate; acceptance-contract coverage.

**Cloudflare architecture judgment** (five): these grade *decision content* — did the architecture default to the right platform topology, pick storage services that fit the data, declare the required bindings, sequence tasks safely, and plan the sanctioned deployment path? Each compares an output against per-case **ground truth** (the known correct answer supplied with a test case), using normalized signal matching and order-aware comparison, all in code.

### Evals: regression tests for judgment

Now the crown jewel. Here's the problem evals solve, and you should feel the problem before hearing the solution:

You built all these scorers and judges. Next month you tweak a prompt, or swap the engineer's model for a cheaper one, or upgrade a library. **How do you know you didn't just make the system dumber?** Traditional code has unit tests for this. AI behavior needs the equivalent — and that's what an **eval** (evaluation suite) is: a fixed set of test cases with known correct answers, run against your AI components, scored automatically, and gated so regressions fail your build.

Mastra provides the machinery as **Datasets** and **Experiments**:

- A **dataset** is a stored collection of test items, each with an `input`, a `groundTruth` (the expected answer), and metadata. Datasets are typed — this project attaches Zod schemas for both input and ground truth — and versioned in Mastra storage.
- An **experiment** runs every item through a task and a set of scorers, records all scores, and returns a summary.

The Delivery Engine ships two suites:

**Suite 1: `delivery-scorecard-regression`.** Eight fixtures, each a synthetic delivery-run outcome — a clean planned handoff, an approved review, a completed delivery, a failed release gate, a stuck run with failed evidence, a run paused on human questions — each declaring the exact score every one of the delivery scorers should produce for it. Notice the negative cases: a suite of only happy paths can't catch a scorer that has quietly started saying "yes" to everything. The gate *requires* every scorer to have both positive and negative coverage, and fails if any scorer loses it.

**Suite 2: `cloudflare-architecture-regression`.** Eleven fixtures encoding platform judgment as test cases. Good candidates: a Worker with the right database for relational session data; a real-time app using the right coordination primitive; a documents-Q&A app with AI, vector search, and metadata storage correctly bound. Bad candidates that must score low: using a cache as the source of truth for queryable data; splitting one app across two deployment models nobody asked for; deploying through CI automation instead of the sanctioned CLI path; using AI features without declaring the AI binding. This suite is the project's *architectural taste, frozen into executable form*. If someone edits a scorer and suddenly the cache-misuse case scores well, CI turns red.

### Gates: turning measurements into a verdict

Running evals produces numbers; a **gate** turns numbers into a decision. The gate scripts (`npm run eval:delivery:gate`, `npm run eval:cloudflare:gate`) build a report with two tiers, mirroring Mastra's gates-and-thresholds semantics:

- **Hard gates** (any failure → verdict `failed`): experiment completed; no items errored; zero score mismatches against ground truth (tolerance: 0.001); dataset at full size; every scorer covered positively and negatively; nothing failed to persist.
- **Thresholds** (failure → verdict `scored`, a softer warning tier): success rate, score-alignment rate, coverage rate.

The report also computes **trend deltas** against a previous baseline report — is the score drift positive or negative since last time? — and the whole thing runs in CI: `npm run ci:delivery` is typecheck → unit tests → both eval gates. A pull request that degrades the system's judgment fails to merge, with a machine-written explanation of exactly which fixture and scorer disagreed.

One subtle nicety: the gate scripts spin up their own throwaway Mastra instance with a temporary database, run, and delete it. Evals never contaminate real state, and never depend on it.

### And beneath it all: ordinary tests

The harness itself is guarded by ~25 plain unit-test files — the deterministic checks, the aggregation math, the state lifecycle, the plan normalizers, the retry-mode classifier, the parsers — plus a **rubric exemplar harness** verifying that every rubric's embedded known-good/known-bad pair still separates correctly. Layers of trust: unit tests trust nothing; evals watch the judges; scorers watch the runs; judges watch the work; checks watch everything, for free. Who watches the watchmen? In this codebase: the layer below them.
