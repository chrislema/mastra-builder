# Delivery Engine — AI Agent Project Evaluation

*Graded against [`AI_AGENT_PROJECT_RUBRIC.md`](../AI_AGENT_PROJECT_RUBRIC.md) on 2026-07-07, following a full-repository review.*

**Provenance note:** the codebase and the rubric were produced independently. The Delivery Engine was built without reference to the two books the rubric distills; the rubric was authored afterward, from the books alone, by a different process. Where they align, that is convergence between independently derived judgment — not a project graded against its own design document.

Scoring method: each category scored 0–4, converted to points as (score ÷ 4) × weight.

---

## 1. Overall Score: 90 / 100 — Production-grade (bottom edge of the band)

The six top-weighted architecture categories score full marks; every point lost traces to a single root cause: **the system exhaustively measures its deterministic layer but has not yet measured its live LLM behavior** (no full paid trajectory run, no production-trace sampling, no cost telemetry). The project's own docs admit this — `docs/worker-harness-curation-triage.md`: *"Static tests prove the policy graph... They do not prove a full multi-agent delivery trajectory."*

## 2. Category Scores

| # | Category | Score | Points | Justification |
|---|---|:---:|:---:|---|
| 1 | Problem Framing & Capability Architecture | 4 | 10/10 | One burning problem (Chris's standalone Worker apps from vision docs), capabilities decomposed into eight cohesive roles grouped by process step, mega-agent explicitly avoided, and scope discipline is *enforced* (source-gating of product-specific rules in the curation triage). |
| 2 | Model, Prompt & Output Foundations | 4 | 10/10 | Per-role model slots with env overrides and a documented split-model experiment (`models.ts`, `.env.example`), placeholder-key preflight, role/constraint/must-not prompts, and Zod-schema'd structured output on every artifact with a salvage parser that fails closed. Caveat: prompt changes are validated by policy tests and cache versioning (`worker-first-local-v15`), not by model-in-the-loop evals. |
| 3 | Tool & Integration Design | 4 | 10/10 | Sixteen semantic, repo-scoped tools with clear IDs, descriptions, and input/output schemas; concise returns; request-context defaults with conflict rejection; the model provider is treated as a trust/reliability boundary (retryable-error classification, fail-closed judge outages). |
| 4 | Context, Memory & Retrieval | 4 | 12/12 | The standout category: curated task packets instead of exploration, read budgets, `node_modules` read blocking, a 60k token limiter, thread-scoped schema-typed working memory kept deliberately small ("executable state over narrative memory"), error diagnostics fed back into focused-repair retries, and BM25 skill retrieval. No RAG — correctly, because nothing needs it. |
| 5 | Workflow & Control Flow | 4 | 10/10 | Five composed stage workflows plus a nested per-task workflow; `.dountil` retry loops, `.foreach` with deliberate `concurrency: 1`; bounded budgets with stuck-as-first-class; typed step seams; suspend/resume gates on exactly the two right moments (true planner blockers, production deploys). |
| 6 | Multi-Agent Architecture | 4 | 8/8 | Roles are specialized with focused toolsets and mechanical boundaries, a supervisor coordinates and exposes workflows, per-role success criteria exist as *trajectory rubrics*, and context sharing is a typed memory contract with a read-only judge. |
| 7 | Evaluation & Continuous Improvement | 3 | 11.25/15 | Two ground-truth datasets with mandatory positive *and* negative coverage per scorer, CI gates with hard gates/thresholds/trend deltas, a rubric-exemplar regression harness, and a coded failure-mode taxonomy (`implementationFailureClass`) — but no end-to-end LLM trajectory evals, no production-trace sampling into datasets, and no ongoing SME labeling loop. |
| 8 | Observability, Cost, Latency & UX | 3 | 7.5/10 | Full traces/logs/scores with dual persistence, sensitive-data filtering, per-agent-turn trace artifacts, and no run without a report; but cost and latency are *controlled* (budgets, timeouts, caching, artifact reuse) rather than *measured* — token usage sits in traces without per-run cost aggregation, and progress isn't streamed to the launcher. |
| 9 | Security, Permissions & Safety | 3 | 7.5/10 | Unusually thorough guardrails (injection tripwire, three layers of secret redaction, command blocklist, role/task write boundaries, crypto policy enforced at write time, human-gated production deploys, secrets excluded from the sandbox env) — but the injection guard is bypassable regex, the sandbox is process-level with open network egress, and the lethal trifecta (private repo + untrusted source docs + network) has no fully closed leg. Appropriate for a single-user local tool; short of hardened. |
| 10 | Deployment & Operational Readiness | 3 | 3.75/5 | Durable LibSQL workflow state, stale-snapshot repair, SIGINT handlers that mark runs failed before exit, and a resume cursor that fast-forwards past passing work — but the harness itself is local-only by design, with no defined scaling or incident path beyond run reports. |

## 3. Top 3 Strengths

1. **The sorting principle, implemented end-to-end.** Deterministic rules run as code (13 checks, workspace hooks, plan normalizers, auto-repairs); gradeable judgment runs through rubrics with code-computed aggregation; only generative judgment reaches agents. Claims are never trusted — implementation notes are synthesized from the event log, and an output processor rejects completion claims that cite no evidence.
2. **Loop engineering as a discipline.** Bounded budgets, four distinct watchdog timeouts, failure *classification* that reshapes each retry (write-first / replace-stubs / focused-repair with extracted compiler diagnostics), timeout salvage, and cheap resumption via artifact reuse. "A bounded loop that parks as STUCK beats an unbounded loop that thrashes" is mechanism, not motto.
3. **Eval discipline on everything measurable.** Every scorer must have positive and negative ground truth or the CI gate fails; rubrics carry embedded known-good/known-bad exemplars as their own regression tests; gate reports compute trend deltas against baselines. The measurers are measured.

## 4. Top 3 Risks / Gaps

1. **The live system is unproven end-to-end.** All eval coverage is deterministic; no full multi-agent delivery trajectory has been validated with real models since the harness's recent narrowing (the project's own triage doc says the one worthwhile paid sample run is still pending). The harness is proven; the fleet inside it is not.
2. **Cost and latency are invisible.** Token usage is captured per agent turn in trace artifacts but never aggregated — there is no per-run token/dollar/duration report, so the GLM-vs-GPT split-model experiment can't currently be judged on cost-per-quality.
3. **Security depends on pattern-matching and process isolation.** A crafted vision/spec doc could phrase an injection the regex guard misses, and sandbox commands (npm, wrangler) have unrestricted network egress on the host machine. Fine for the current single-operator threat model — but that threat model is implicit, not written down.

## 5. Recommended Next Actions (by expected score impact)

1. **Run the one paid fresh-Worker sample** already recommended in the curation triage, on a clean temp target with the Tally docs — and *keep its traces as the first production dataset*. Converts Category 7's biggest gap directly. (~+2–4 pts)
2. **Aggregate cost/latency into the run report.** The usage data already exists in `.delivery/artifacts/traces/*`; sum tokens and wall-time per stage into `.delivery/runs/<runId>.json`. Small change, closes half of Category 8. (~+1–2 pts)
3. **Build a judge-stability eval** from sampled judge outputs (Chris as SME labeling a small set), so model swaps in `DELIVERY_JUDGE_MODEL` are gated by data. (~+1–2 pts)
4. **Write the threat model** (one page: assets, trust boundaries, accepted risks) and consider a network-restricted sandbox mode for runs on third-party vision docs. (~+1 pt)
5. **Stream stage progress to the launcher page** via workflow watch events, replacing the fire-and-forget confirmation. (UX polish, ~+0.5 pt)

## 6. Evidence Notes

Full-repo review (all ~120 files): `src/mastra/index.ts` (registration), `workflow.ts` (all 12,832 lines — pipeline, loops, retry modes, release-gate probes), `agents.ts`, `tools.ts`, `workspace.ts` (hooks), `processors.ts` (guardrails), `checks.ts`/`judgment.ts` (deterministic checks, aggregation), `scorers.ts`, `evals.ts`/`cloudflare-evals.ts` (datasets/gates), `memory.ts`/`context.ts`, `models.ts`, `observability.ts`/`state-service.ts` (dual persistence), `runner.ts`/`routes.ts`/`run-input.ts` (surfaces), all 13 rubrics incl. trajectory rubrics with exemplars, 9 schemas, 17 skills, `policy/boundaries.json`, `policy/events.md`, `templates/constitution.md`, `examples/vision.md`+`spec.md`, 4 runner/eval scripts, `.env.example`, and the full test inventory (~25 files incl. the 6.5k-line `workflow-policy.test.ts`). Self-assessment corroborated against `docs/delivery-engine-port.md` and `docs/worker-harness-curation-triage.md`.

## 7. On the Alignment Between Codebase and Rubric

The codebase and rubric agree on nearly every principle — evals weighted heaviest, structure over mega-agents, context curation over context dumping, guardrails and human checkpoints as first-class architecture, "right primitives for the risk" over pattern-collecting. Since neither informed the other (the project predates the author's contact with the books; the rubric was derived from the books alone), this alignment is independent convergence on the same design pressures. That cuts two ways, both useful:

- It **validates the rubric**: a working system built from practitioner judgment lands almost exactly where the books' framework predicts a good system should land.
- It **validates the project**: the industry's distilled patterns, applied blind, find the same strengths the project claims for itself — and the same gaps the project had already confessed to in its own docs.

The 10 missing points are therefore worth taking seriously: they are the places where two independent lines of judgment agree the work isn't finished.
