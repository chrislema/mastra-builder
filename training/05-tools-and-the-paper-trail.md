# Part 5: Tools and the Paper Trail

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

### What a tool is

By itself, a model can only produce text. A **tool** is a function the surrounding system offers to the model: "if you output a request in this exact shape, I will run this function and hand you the result." Tools are how agents touch the world — read files, query databases, call services.

In Mastra you define one with `createTool`. Here's a real (abbreviated) example:

```ts
export const recordDeliveryEventTool = createTool({
  id: 'record-delivery-event',
  description: 'Append a delivery event and persist the current state.',
  inputSchema: z.object({
    repoPath: repoPathField,             // optional; defaults from context
    event: z.record(z.string(), z.any()),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input, context) => appendDeliveryEventState({ ... }),
});
```

Two new things here:

**Zod schemas.** The `z.object({...})` bits use **Zod**, a TypeScript library for describing the *shape* of data — "this must be an object with a string called `repoPath`." A **schema** is exactly that: a formal description of what data must look like. Schemas do double duty in Mastra: they *validate* (reject malformed data at the border) and they *document* (the model is shown the schema, so it knows precisely what arguments the tool wants). Nearly everything in this project — tool inputs, workflow steps, agent outputs — is fenced with Zod schemas. This is the type-checked nervous system of the harness.

**Description fields.** The `description` isn't decoration. It's the text the model reads when deciding whether and how to use the tool. Writing clear tool descriptions is prompt engineering.

### The sixteen delivery tools, and what they're really for

The Delivery Engine registers sixteen tools, and almost all of them are about one thing: **the paper trail.** A sample:

- `initialize-delivery-run` — open a new run's record book.
- `start-delivery-stage` / `end-delivery-stage` — clock a role in and out of a stage of work.
- `record-delivery-event` — append one line to the event log.
- `write-delivery-artifact` / `record-delivery-artifact` — save a work product (a plan, a report) and register it.
- `record-delivery-judgment` — file a grading result.
- `update-delivery-task` — set a task's status (pending → building → complete/stuck/blocked).
- `get-delivery-run-status` — read a compact status summary.
- `run-deterministic-check` — run one of the coded rule-checks (Part 9) without asking a model.
- `aggregate-judgment` — do the grading math in code.
- `persist-delivery-state` / `list-delivery-state-records` — sync the paper trail into Mastra's database and query it back.

All of this lands in a folder called **`.delivery/`** inside the project being built:

```
.delivery/
  run.json          ← the run's current state: status, stage, tasks, artifacts, judgments
  events.jsonl      ← the event log: one JSON line per thing that happened
  boundary.json     ← who is allowed to touch what, right now (exists only mid-stage)
  artifacts/        ← every plan, report, note, and judgment as a JSON file
    judgments/      ← every grading result
    traces/         ← full transcripts of what each agent was asked and answered
  runs/             ← final human-readable reports per run
```

The event log (`events.jsonl`) deserves special attention. Every tool call an agent makes, every file it writes, every command that runs, every stage that starts or ends, every deployment, every verification — each becomes one timestamped line. The project defines a formal **event vocabulary** (`stage_start`, `tool_use`, `run_code`, `artifact_write`, `deploy`, `live_verify`, and so on) and a rule: *events are append-only; nothing rewrites history; corrections are new events.*

Why so much bookkeeping? Because the paper trail is what turns "trust me" into "check for yourself" — for humans *and* for the machine. Later we'll meet checks that read this very log to answer questions like "did any code actually run before this agent claimed it was done?" The log is not a diagnostic afterthought. It is a load-bearing wall.

One more detail that shows the craftsmanship: state lives in **two places on purpose**. Mastra's database (a LibSQL/SQLite file) is the durable, queryable record; `.delivery/` is a **projection** — a human-inspectable export written alongside it. If they ever disagree (say a run crashed mid-write), reconciliation code picks the more complete one, preferring a finished local record over a stale "still running" database entry. Redundant state with a reconciliation rule beats a single point of confusion.
