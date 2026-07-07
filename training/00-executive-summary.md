# Executive Summary: Mastra and the Delivery Engine

*The one-sitting version of the full 14-part training series in this folder.*

---

## What this is about

**Mastra** ([mastra.ai](https://mastra.ai)) is an open-source TypeScript framework for building AI applications. This series teaches it through one real project — the **Delivery Engine** in this repository: a system that takes a plain-English product description (a `vision.md`, optionally a `spec.md`) and plans, reviews, builds, tests, and prepares a small Cloudflare Worker application for deployment. AI models do the *thinking*; ordinary code does the *checking*.

The central concept is the **harness** — everything built *around* an AI model to keep it safe, honest, and productive. Models are confident narrators, not reliable ones; a model's claim is not evidence. The harness is what turns "trust me" into "check for yourself."

## The one organizing law: the sorting principle

Every rule in the system lives in one of three homes:

1. **Deterministic and blockable → code.** Tools, checks, and workspace hooks enforce it mechanically. No model involved.
2. **Judgment but gradeable → rubrics and scorers.** A judge model fills in raw scores against written standards; code does the math.
3. **Judgment and generative → agents and skills.** Only genuinely creative work goes to a model with good instructions.

When a judgment call turns out to be stable and repeated, it gets *promoted down* the list — encoded as a check or auto-repair instead of re-asked every run.

## The Mastra building blocks, as this project uses them

- **Agents** — AI workers with instructions, tools, and memory. Eight roles here (planner, architect, engineer, designer, tester, deployment advisor, judge, supervisor), each with a narrow mission and hard prohibitions. Roles exist for focus, enforceable boundaries, and checkable handoffs. The judge only scores — code aggregates, so no model can grade its own work charitably. The deployment advisor *advises*; irreversible actions run in workflow code behind a human gate.
- **Tools** (`createTool`) — schema-validated functions agents can call. Here, sixteen tools that maintain the **paper trail**: run state in `.delivery/run.json`, an append-only event log in `.delivery/events.jsonl`, and every plan, note, and judgment filed as an artifact.
- **Workspace** — contained file/terminal access rooted at `requestContext.repoPath`, with `beforeToolCall` hooks acting as tripwires: dangerous commands blocked, role/task file-ownership boundaries enforced, a read budget against expensive dithering, `node_modules` reads refused, banned security primitives stopped at the keyboard.
- **Workflows** (`createWorkflow` / `createStep`) — the typed assembly line. The top-level `deliveryWorkflow` composes five stage workflows: **plan → review → build → release gate → deploy.** Loops are first-class: `.dountil` retry loops (review bounces, release-gate retries), `.foreach` over build tasks (nested workflow per task, dependency-ordered), all with bounded retry budgets. **A bounded loop that parks as STUCK beats an unbounded loop that thrashes.** Watchdog timeouts detect stalled agents, and failed attempts are *classified* so each retry is reshaped into a narrower, cheaper fix (write-first, replace-stubs, focused-repair modes).
- **Structured output** — every artifact (task plan, review report, release gate, deployment report) is a Zod-schema'd JSON object. A forgiving parser salvages near-misses; unsalvageable output **fails closed** (an unparseable release gate becomes a failing one).
- **Memory** — a thread-scoped, schema-typed working-memory whiteboard, one thread per run, judge read-only. Used only for live coordination; everything durable goes through tools and storage. *Executable state over narrative memory.*
- **Processors** — guardrails on every agent's input and output: Unicode normalization, required repo context, a prompt-injection tripwire ("skip the release gate" aborts the call), a token limiter, secret redaction, and the signature **evidence-claim guard**, which rejects and retries any completion claim that cites no artifacts, events, checks, or test output.
- **Judging** — three layers. *Deterministic checks* (13 coded rules: acyclic dependency graphs, files-in-boundary, "ran code before claiming complete," "read the release gate before deploying," "live-verify after deploy"...). *Rubrics + judge*: JSON grading standards with pass/fail gates and weighted 1–5 dimensions with written anchors; critical gate failures cap the score at zero; unevaluated gates fail closed; the output includes machine-generated remediation that feeds the retry loops. *Hygiene gates and auto-repairs*: promoted judgment — plan normalizers, config-hygiene checks, even automatic fixes for known compiler-error patterns.
- **Scorers and evals** — 14 registered scorers (handoff readiness, rubric floor, pass rates, Cloudflare architecture fit) run live on every workflow stage. Two **datasets** with ground truth — a delivery-scorecard regression suite and a Cloudflare-architecture judgment suite, both with positive *and negative* cases — run as **experiments** behind CI **gates** (`npm run ci:delivery`). Evals are regression tests for judgment: change a prompt or swap a model, and the numbers — not optimism — tell you what happened.
- **Human-in-the-loop** — Mastra suspend/resume, used at exactly two points: when the planner hits a *genuine* source-document blocker (aggressively filtered so preferences never pause a run), and before any *production* deployment (default mode is local-only). Both pauses and answers are typed payloads, and approvals land in the event log.
- **Surfaces and observability** — four doors into one shared runner: Mastra Studio, a CLI script, a `POST /api/delivery/run` HTTP route (async), and an HTML launcher page. Every run emits traces, logs, and scores into Mastra storage (with a sensitive-data filter), plus a final per-run report. There is no outcome without a report.

## What a run looks like

Point the engine at a folder containing `vision.md` (the included example is **Tally**, a tiny link-counting service). Planning produces a readout and a dependency-ordered task plan, which is normalized, gate-checked, judged, and repaired in a loop. The architect reviews (and the review itself is judged). The build loop executes each task inside its own boundary with pre-created stubs, workflow-run verification, an evidence-derived implementation note, fourteen deterministic gates, and a rubric judgment — retrying with diagnosed, narrowed prompts, or parking as stuck. The release gate is mostly code: static hygiene checks, dry-run deploys, local database migrations, and a live boot of the actual app probed with HTTP tests *derived from the spec* (create a link, follow the redirect, verify the click count incremented by exactly one). The tester only synthesizes the gathered evidence into a decision, which is itself gate-checked and judged. Deployment writes a judged report — local validation by default, or the real Wrangler production deploy after explicit human approval. What's left on disk: a working app, and a `.delivery/` folder proving every claim.

## The seven lessons worth stealing

1. **Sort every rule into its home** (code / rubric / agent), and promote repeated judgment downward.
2. **Claims are not evidence.** Log actions; derive reports from logs; reject unevidenced completion claims.
3. **Constrain, don't implore.** A hook that blocks a write beats a paragraph asking nicely.
4. **Bound every loop; make "stuck" a first-class state,** with diagnosed, reshaped retries.
5. **Fail closed, everywhere.** Unparseable, unevaluated, or unavailable means "not proven safe."
6. **Measure the measurers.** Rubrics get exemplars; scorers get datasets with negative cases; evals gate CI.
7. **Interrupt humans only for genuine blockers and irreversible actions.** Everything else proceeds on recorded safe assumptions or parks as stuck.

## Where to go deeper

The 14 parts in this folder expand each topic in order, ending with the full minute-by-minute Tally walkthrough (Part 13) and the lessons above (Part 14). Start at `01-before-we-start.md`.
