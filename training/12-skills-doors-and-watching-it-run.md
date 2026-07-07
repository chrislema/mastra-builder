# Part 12: Skills, Doors, and Watching It Run

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

### Skills: bottled expertise

Mastra **skills** are folders of instructions — each a `SKILL.md` file with a description — that agents load *when relevant* rather than carrying in every prompt. Think of the difference between what a carpenter knows (instructions) and the reference manuals in the truck (skills): you don't read the manual for hanging doors while tiling a floor.

The Delivery Engine ships seventeen, each tagged with the roles it serves: `decompose-tasks` (planner — how to break documents into dependency-ordered tasks), `enforce-blast-radius` (architect/planner — when something is too big and must split), `enforce-thin-proxy` and `enforce-middleware-layers` (engineer — keeping request-handling layers disciplined), `implement-auth` and `implement-billing` (engineer — security and payments patterns), `build-ui` (designer — the project's visual system), `audit-trust-boundaries`, `audit-traceability`, `check-release-gate` (tester)... Each is a *procedure* — numbered steps, tests to apply, red flags to hunt — not a lecture. The workspace loads the whole skills directory with `bm25: true`, enabling keyword search (BM25 is a classic text-relevance algorithm) so agents can find the right manual on demand. Notice this is the third residence of judgment — code for the enforceable, rubrics for the gradeable, skills for the generative — the sorting principle's third drawer.

### Doors: four ways in

The same engine is reachable through four surfaces, all funneling into one shared runner so behavior never depends on which door you used:

1. **Studio** (`npm run dev`) — run `deliveryWorkflow` from the Workflows tab, watch steps light up live, inspect every input/output, answer suspensions interactively, browse traces and scores.
2. **Command line** — `npm run delivery:run -- --projectFolder /path/to/project`. Waits for completion, prints a compact result, sets the exit code by outcome, and handles Ctrl-C by marking the run failed *before* exiting (even interruption keeps the records honest).
3. **HTTP API** — `POST /api/delivery/run`, a custom route registered with OpenAPI documentation. It uses `startAsync()` — start the run, return `{ runId, status: "started" }` immediately — because a build takes many minutes and no web request should wait that long.
4. **A launcher page** — `GET /delivery/launcher` serves a small hand-rolled HTML form (project folder, vision/spec text areas, deploy and review mode, retries) for starting runs from a browser. It's a nice reminder that a Mastra server is a real web server; you can hang plain web pages off it.

The runner behind all four normalizes input (one required field — the project folder; everything else has defaults), can *write* your pasted vision text into the folder for you, stamps every run with **tracing metadata and tags** (`delivery-engine`, `deploy:local`, `review:thorough`) so observability queries can slice runs by kind, scopes each run by a resource ID derived from the repo path, and — win or lose — writes a final report to `.delivery/runs/<runId>.json` plus `latest.json`. There is no outcome without a report.

### Observability: the flight recorder

**Observability** is the discipline of making a system's internals visible: **logs** (recorded messages), **traces** (tree-structured timelines of an operation — a workflow run is the root **span**, each step a child span), and metrics. Mastra ships this as a first-class subsystem; the project configures it with a storage exporter (records land in the local database), an optional platform exporter (mirrors to Mastra's hosted service if a token is set), and a `SensitiveDataFilter` that scrubs secrets from spans — the third, independent layer of secret-scrubbing in this codebase.

The engine goes further and writes its *own* domain records into observability storage: every terminal run persists a snapshot span plus one span per delivery event, stably-fingerprinted (re-persisting produces no duplicates), queryable by repo and run ID, with backward compatibility for records written under the system's old service name. Judgments are additionally pushed into Mastra's **scores** store — so in Studio, rubric results appear alongside scorer results as one quality history. The `.delivery/` folder answers "what happened in this repo?"; observability storage answers "what has happened across every run this engine ever made?"
