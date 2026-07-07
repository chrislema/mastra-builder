# Learning Mastra by Watching a Software Factory Run

*A plain-language introduction to Mastra — agents, workflows, loops, harnesses, and evals — taught through one real project.*

---

## Part 1: Before We Start

### Who this is for

This guide assumes you know almost nothing about AI. You do not need to be a programmer to follow most of it, though a little coding experience helps in the middle sections. Every time a new term shows up, I will stop and explain it. If you already know a term, skip the explanation and keep moving.

### What we're going to do

Most introductions to AI frameworks teach you features one at a time, in a vacuum. "Here is an agent. Here is a tool. Here is memory." That's like learning carpentry by reading a catalog of saws. You memorize the parts but you never see a house get built.

We're going to do the opposite. We're going to walk through one complete, real project — a system I'll call the **Delivery Engine** — and let it teach us the framework. The Delivery Engine is built on **Mastra** ([mastra.ai](https://mastra.ai)), an open-source TypeScript framework for building AI applications. By the end, you'll understand what Mastra gives you and, more importantly, *why* each piece exists.

### What the example project does

Here is the whole idea in one paragraph:

> You write a short document, in plain English, describing a small web application you want — "I want a tiny link-counting service for my newsletter." You point the Delivery Engine at a folder containing that document. The engine then plans the work, reviews the plan, writes the code, tests it, and prepares it for deployment — with AI doing the *thinking* and ordinary computer code doing the *checking*. When it finishes, you have a working application, plus a complete paper trail showing what was done, what was verified, and what was judged.

In other words: it's a software factory. AI workers do the labor. But the factory floor is full of rules, inspections, checklists, and quality gates — and those are written in plain, boring, reliable code.

That last sentence is the most important one in this guide. Hold onto it.

### One piece of vocabulary before anything else: the "harness"

You'll hear the word **harness** throughout this guide, so let's define it now.

A harness is everything you build *around* an AI model to keep it safe, honest, and productive. The model is the horse; the harness is the straps, the reins, the blinders, and the cart. A horse without a harness is impressive but useless for hauling. A harness without a horse doesn't move. You need both.

The Delivery Engine is, at its core, a harness. It's an opinionated set of rules, boundaries, checks, and feedback loops wrapped around AI models so that they produce software you can actually trust. Mastra is the framework that makes building such a harness practical.

### Where this project came from

The Delivery Engine started life as a different project called *claude-environments*, built for a specific AI product (Anthropic's Claude Code). The author took years of professional judgment — how to plan software, how to review it, what makes code trustworthy, what mistakes AI coders make — and encoded it as rules and checklists for that one tool.

This project is a port of those ideas into Mastra. The difference matters: instead of the judgment living in configuration files for one vendor's product, it now lives in **first-class framework objects** — agents, workflows, tools, scorers, and evaluation suites — that any part of the system can inspect, test, and reuse. We'll see exactly what each of those words means shortly.

---

## Part 2: The Absolute Basics — Models, Prompts, and Why We Can't Just Trust Them

### What is an AI model?

The AI systems we're talking about are called **large language models**, or **LLMs**. An LLM is a computer program trained on enormous amounts of text. Its one skill is this: given some text, predict what text should come next. That sounds narrow, but it turns out that "predict good next text" covers an astonishing range of abilities — answering questions, writing essays, summarizing documents, and yes, writing computer code.

When you use ChatGPT or Claude, you are talking to an LLM.

A few terms you'll see:

- A **prompt** is the text you send to the model. It can be a question, an instruction, a document, or all three at once.
- The **response** (or **completion**) is the text the model sends back.
- **Tokens** are the small chunks of text (roughly word-fragments) that models read and write. Models are priced by the token, which is why long conversations cost more money than short ones. Remember this — it explains several design choices later.
- A **model provider** is a company that runs models and sells access to them — OpenAI, Anthropic, Google, and others. You typically talk to their models over the internet through an **API** (Application Programming Interface — a way for one program to talk to another).

### The one thing you must understand about LLMs

LLMs are *confident narrators, not reliable ones.*

A model will tell you, in fluent and reassuring prose, that it finished a task, that the tests passed, that the code works. Sometimes that's true. Sometimes the model is wrong and doesn't know it. Sometimes it produces something that *looks* exactly like a correct answer but isn't. People call these failures **hallucinations**, but for building systems, the more useful framing is this:

> **A model's claim is not evidence. Only evidence is evidence.**

The entire Delivery Engine is organized around that sentence. When an AI worker says "I implemented the feature," the engine does not believe it. It checks: did files actually change? Does the code actually compile? Does the running application actually answer requests? The model's confident summary counts for nothing until real proof exists.

You'll see this principle — the project calls it **"evidence over confident narration"** — enforced by machinery again and again.

### So why use models at all?

Because they're genuinely good at the things code is bad at: reading a messy human document and figuring out what the person wants, breaking a vague goal into concrete steps, writing new code that didn't exist before, judging whether a plan "makes sense." These are **judgment tasks**. No ordinary program can do them.

The trick — the whole craft of this field — is dividing the work correctly:

- **Judgment goes to the model.** Understanding intent, planning, writing, reviewing, scoring quality.
- **Everything mechanical goes to code.** Checking rules, counting things, enforcing boundaries, running tests, doing math, keeping records.

The Delivery Engine states this as an explicit design law, which its documentation calls the **sorting principle**:

1. If a rule is **deterministic and blockable** → enforce it with code (tools, checks, hooks). *Deterministic* means it always gives the same answer for the same input — no opinion involved.
2. If a rule is **judgment but gradeable** → measure it with a rubric and a scoring system (we'll meet these).
3. If a rule is **judgment and generative** (it produces new work) → give it to an AI agent with good instructions.

Keep that three-way sort in mind. Almost every component we're about to meet exists to serve one of those three lines.

---

## Part 3: What Is Mastra?

**Mastra** is a framework — a toolkit of pre-built, well-tested components — for building AI applications in TypeScript. (TypeScript is a popular programming language; it's JavaScript with type checking added, meaning the computer verifies you're using data shapes consistently.)

Why use a framework instead of calling a model API directly? For the same reason you don't build a house starting from trees: the raw material is available, but the pre-cut lumber saves you months. Out of the box, Mastra gives you:

- **Agents** — AI workers with instructions, tools, and memory.
- **Workflows** — step-by-step processes with typed inputs and outputs, loops, branching, pausing, and resuming.
- **Tools** — functions agents can call to act on the world.
- **Workspaces** — controlled file-and-terminal access for agents, with hooks to intercept everything they try.
- **Memory** — conversation history and structured "working memory" for agents.
- **Storage** — databases for persisting all of the above.
- **Scorers and Datasets** — machinery for measuring quality and running regression tests on AI behavior.
- **Observability** — logging and tracing so you can see what happened inside a run.
- **A dev server and Studio** — a local web interface where you can see your agents and workflows, chat with them, run them, and inspect results.
- **An HTTP server** — so your agents and workflows can be triggered from the web.

One Mastra habit worth knowing early: everything gets **registered** in one central place. In this project that's the file `src/mastra/index.ts`:

```ts
export const mastra = new Mastra({
  workflows: { deliveryWorkflow, deliveryPlanningWorkflow, /* ...5 more */ },
  agents: deliveryAgents,          // eight agents
  memory: { deliveryMemory },
  processors: deliveryProcessors,  // guardrails
  scorers: deliveryScorers,        // quality measurements
  tools: deliveryStateTools,       // sixteen tools
  workspace: deliveryWorkspace,    // file/terminal access rules
  storage: new LibSQLStore({ ... }),   // the database
  server: { apiRoutes: deliveryApiRoutes },
  observability: new Observability({ ... }),
});
```

That single object *is* the application. When you run `npm run dev`, Mastra reads it, starts a local server, and opens **Mastra Studio** — a browser interface where every agent, workflow, tool, and scorer listed above appears as something you can click on, run, and inspect. (In this guide I'll describe what Studio shows rather than include screenshots; every time I say "in Studio you'd see...", picture a clean web dashboard listing these components.)

Registration isn't bureaucracy. It's what makes the pieces *inspectable*. A rule buried in a prompt is invisible; a scorer registered on the Mastra instance shows up in Studio, can be run on demand, and can be tested in CI. The whole port from the earlier project to Mastra was essentially an exercise in moving judgment out of invisible places and into registered, inspectable ones.

### What the models cost, and how this project chooses them

Mastra addresses models with a simple string: `"provider/model-name"`, like `"openai/gpt-5.5"`. This is Mastra's **model router** — one consistent way to name any model from any provider.

The Delivery Engine adds a small but smart layer on top (`models.ts`): every *role* in the factory gets its own model "slot," configured by environment variables. (An **environment variable** is a named setting you give a program from outside, without changing its code — like a dial on the outside of a machine.)

- `DELIVERY_MODEL` — the default for everything (out of the box: `openai/gpt-5.5`).
- `DELIVERY_PLANNING_MODEL`, `DELIVERY_ARCHITECT_MODEL` — the "thinking" roles.
- `DELIVERY_EXECUTION_MODEL` — a shared slot for the "doing" roles (engineer, designer, tester), so you can move all three to a cheaper model with one setting.
- `DELIVERY_JUDGE_MODEL` — the judge, separately configurable.

Why bother? Money and fit. Planning and judging benefit from the strongest models. Cranking out code slices can often be done by a cheaper one. The project's `.env.example` file shows exactly this experiment: keep the planner and judge on GPT-5.5, move execution to a low-cost coding model, and see if quality holds. Because quality is *measured* in this system (Part 9), that experiment produces numbers, not vibes.

There's also a guard here worth noticing: before any run starts, code checks that the needed API keys are present *and not placeholders* (it literally rejects values like `your-api-key`). A run that would fail an hour in because of a missing key instead fails in the first second with a clear message. Small thing; very much in the spirit of the whole system — **fail loud, fail early.**

---

## Part 4: Agents — The Workers

### What an agent is

An **agent** is an LLM given three things: an identity (instructions describing who it is and how it behaves), capabilities (tools it may call), and context (memory, and access to relevant information). You talk to an agent; behind the scenes it may take several steps — think, call a tool, look at the result, call another tool — before answering. That step-taking is what makes it an *agent* rather than a plain chat model. It acts.

In Mastra, you create one like this (trimmed-down real code from this project):

```ts
export const plannerAgent = new Agent({
  id: 'planner',
  name: 'Planner',
  description: 'Turns product documents into dependency-aware task plans...',
  model: plannerModel,               // e.g. "openai/gpt-5.5"
  instructions: `...who you are, what you own, what you must never do...`,
  workspace: deliveryWorkspace,      // its hands (files & terminal)
  tools: deliveryStateTools,         // its record-keeping equipment
  skills: [skill('decompose-tasks'), ...],  // its reference manuals
  memory: deliveryMemory,            // its shared whiteboard
  inputProcessors, outputProcessors, // its guardrails (Part 8)
});
```

The `instructions` field is what practitioners call a **system prompt** — standing orders the model receives before every conversation. It's where personality, policy, and boundaries live in text form.

### Why eight agents instead of one?

The Delivery Engine registers eight agents. This is the first big design decision worth understanding: **why not one brilliant agent that does everything?**

Three reasons:

1. **Focus.** LLMs follow instructions better when there are fewer of them. An agent whose entire worldview is "you review plans for structural risk; you never write code" reviews plans better than an agent juggling forty concerns.
2. **Boundaries.** If the planner *cannot* write code — mechanically cannot, because the system blocks it — then a planning mistake can't silently turn into a code mistake. Separate roles let the harness enforce separate permissions.
3. **Checkability.** When roles hand work to each other, each handoff is a place to inspect quality. One monolithic agent has no seams; you can't put a checkpoint inside a blur.

Meet the cast:

| Agent | Job | Can it write files? |
|---|---|---|
| **Planner** | Reads your vision document and produces a concrete task plan | No — plans only |
| **Architect** | Reviews the plan for structural problems before any code is written | No — review only |
| **Engineer** | Implements backend/server code tasks | Yes — only in engineer-owned files |
| **Designer** | Implements frontend (visual/UI) tasks in plain HTML/CSS/JavaScript | Yes — only in UI files |
| **Tester** | Gathers evidence and decides whether the work is releasable | Only test files |
| **Deployment Advisor** | Reads deployment evidence and explains readiness — advises, never deploys | No |
| **Judge** | Scores one artifact against one rubric. Nothing else. | No |
| **Supervisor** | An interactive front door that can delegate to the others and launch the workflow | — |

Each role's instructions are a mixture of mission ("Implement production code for the current task with minimal, coherent change"), values ("Trust over cleverness. Evidence over confident narration."), and hard prohibitions ("Must not: smuggle in unrelated cleanups... use silent degradation").

Two agents deserve a closer look because they teach general lessons.

### The Judge: a measurement instrument, not a reviewer

The judge's instructions are short and severe:

> "You score exactly one subject against exactly one rubric. You are a measurement instrument, not a reviewer. No advice, no rewrites, no opinions beyond the rubric. ... Never aggregate. Code aggregates scores and gates."

Notice what's *forbidden*: math. The judge fills in raw scores and cites evidence; TypeScript code adds them up. Why? Because LLMs are unreliable at arithmetic and *very* unreliable at grading their own summaries. If the model computed its own final grade, a charming model could talk itself into a pass. By keeping aggregation in code, the final number is beyond persuasion. This is the sorting principle in miniature: judgment (does this dimension deserve a 3 or a 4?) goes to the model; arithmetic goes to code.

### The Supervisor: agents made of agents

The supervisor agent is configured with the *other seven agents* as sub-agents and all the workflows as callable resources:

```ts
export const deliverySupervisorAgent = new Agent({
  id: 'delivery-supervisor',
  agents: { planner, architect, engineer, designer, tester, deployer, judge },
  workflows: { deliveryWorkflow, deliveryPlanningWorkflow, /* ... */ },
  ...
});
```

This is Mastra's composition story: an agent can delegate to specialist agents, and it can launch workflows as easily as it calls a tool. In Studio, you'd chat with the supervisor like a project manager: "What's the status of the run in this repo?" and it would call the status tool; "Run a full delivery for this folder" and it would kick off the pipeline.

### The Deployment Advisor: knowing what agents should *not* do

Early versions of systems like this often let an agent run the deployment command itself. The Delivery Engine deliberately does not. Deployment — the step that changes the real world — is executed by the *workflow* (plain code, after human approval). The agent's role shrank to advisor: read the evidence, explain readiness, critique the report. The lesson generalizes: **the more irreversible an action, the less it should be left to a model's judgment in the moment.** Put irreversible actions in code, behind explicit gates.

---

## Part 5: Tools and the Paper Trail

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

---

## Part 6: The Workspace — Hands, With Tripwires

### What a workspace is

Agents that build software need to read files, write files, and run commands. Mastra's **Workspace** provides exactly that: a filesystem interface and a **sandbox** (a controlled environment for running terminal commands), exposed to agents as tools. The critical feature isn't the access — it's the *control*.

The Delivery Engine's workspace is built dynamically per request:

```ts
export const deliveryWorkspace = new Workspace({
  id: 'delivery-workspace',
  filesystem: ({ requestContext }) =>
    new LocalFilesystem({ basePath: repoPathFromContext(requestContext), contained: true }),
  sandbox: ({ requestContext }) =>
    new LocalSandbox({ workingDirectory: repoPathFromContext(requestContext), timeout: 120_000 }),
  ...
});
```

Note `contained: true` and that `basePath`. This introduces **request context** — a small bundle of information that travels with every request through the system. The Delivery Engine puts one crucial fact in it: `repoPath`, the folder of the project being built. The workspace roots itself there, *contained*, meaning agents physically cannot read or write outside that folder. Point the same system at a different folder and the same agents operate there instead — the workspace is a template, instantiated per target.

An **input processor** (Part 8) enforces that no delivery agent can even be called without `repoPath` present. No context, no hands.

### Hooks: intercepting every action

Here's where the harness gets teeth. Mastra workspaces support **hooks** — functions that run *before* and *after* every workspace tool call. `beforeToolCall` can veto the action entirely. The Delivery Engine's hooks implement five tripwires:

**1. Dangerous command blocking.** Before any terminal command runs, a blocklist checks for known footguns: recursive force-deletes (`rm -rf`), destructive git operations (`git reset`, `git checkout`), `sudo`, recursive permission changes, and the classic "download a script from the internet and pipe it straight into a shell." Each is refused with a reason: *"recursive force delete requires human review."* The agent sees the refusal and must find another way.

**2. File ownership boundaries.** Remember `boundary.json`? When a stage starts, the system writes down which role is active and which file patterns that role owns and is forbidden from. The rules come from one source-of-truth file, `policy/boundaries.json`:

- Engineer owns `src/**`, `workers/**`, `migrations/**`, config files... and is *forbidden* from `public/**` (the UI) and framework files like `*.tsx`.
- Designer owns `public/**`, styles, and static assets... and is forbidden from server code, database files, and Wrangler configs.
- Planner, architect, deployer, judge own **nothing** — forbidden from everything. They think; they don't touch.

The `beforeToolCall` hook checks every attempted write against the active boundary *and* against the current task's declared surfaces (each task lists the exact files it owns). A designer trying to edit a database migration is blocked mid-keystroke, with a reason, and the blocked attempt is logged as an event. This is Rule 3 of the project's constitution — "small blast radius" — implemented as a mechanism instead of a plea.

**3. The read budget.** A known failure mode of AI coders: instead of writing code, they wander — listing directories, reading file after file, "investigating" while the token bill climbs. The hook counts read/list calls during build stages. Six reads before any write, and further reads are refused: *"Stop investigating and write or edit the task's owned surfaces."* A tripwire against expensive dithering.

**4. Dependency-read blocking.** Reading `node_modules/` (the folder of third-party library code, often enormous) is blocked during delivery stages. Agents are told to rely on the project's type checking instead of spelunking through libraries. Again: token discipline enforced by code, not by hoping.

**5. Content policy.** Even the *content* being written gets screened. If a write contains `bcrypt` (a password-hashing library banned by this project's security policy in favor of a specific alternative) or MD5, the write is refused: *"Crypto policy violation."* The wrong security primitive can't even reach the disk.

And after every tool call, `afterToolCall` appends a `tool_use` event to the log — tool name, paths touched, command, success or failure. The paper trail writes itself.

Step back and appreciate the shape of this. None of these five protections asks the model to behave. They *make misbehavior mechanically impossible or immediately visible*. That's the essential harness move: whenever a rule can be enforced deterministically, enforce it in code, and save the model's obedience budget for the rules only judgment can uphold.

---

## Part 7: Workflows and Loops — The Assembly Line

### What a workflow is, and how it differs from an agent

An **agent** is open-ended: you give it a goal, and it decides its own steps. A **workflow** is the opposite: a process whose steps *you* define in code — this happens, then this, then this, with loops and branches where you say so. The model may act inside a step, but the step order is law.

Rule of thumb (straight from Mastra's own docs): agents for open-ended tasks, workflows for defined processes. Software delivery — plan, review, build, test, deploy — is about as defined as processes get. So the Delivery Engine's backbone is a workflow.

In Mastra, a workflow is built from **steps**. Each step declares a Zod schema for its input and output, and an `execute` function:

```ts
const initializeRunStep = createStep({
  id: 'initialize-delivery-run',
  inputSchema: deliveryWorkflowInputSchema,
  outputSchema: initializedSchema,
  execute: async ({ inputData, mastra, state, setState }) => { ... },
});
```

Then steps are chained:

```ts
export const deliveryPlanningWorkflow = createWorkflow({ id: 'delivery-planning', ... })
  .then(initializeRunStep)
  .then(createPlannerArtifactsStep)
  .then(createPlanGateStep)
  .then(syncPlanStateStep)
  .commit();
```

Because every seam is schema-checked, a step that produces malformed output fails *at the seam*, loudly, instead of poisoning the next step quietly. Type-checked plumbing between AI stages is one of the most underrated safety features in this entire architecture.

### Workflows made of workflows

The top-level `deliveryWorkflow` is beautifully short, because it's composed of five **stage workflows**, each independently registered and independently runnable:

```ts
export const deliveryWorkflow = createWorkflow({ id: 'delivery-workflow', ... })
  .then(deliveryPlanningWorkflow)     // plan and gate the plan
  .then(deliveryReviewWorkflow)       // architect review loop
  .then(deliveryBuildWorkflow)        // build every task
  .then(deliveryReleaseGateWorkflow)  // gather evidence, decide releasability
  .then(deliveryDeploymentWorkflow)   // validate locally or deploy, then finish
  .commit();
```

Why decompose? Visibility and reuse. In Studio's Workflows tab, each stage appears as its own inspectable unit — you can watch a run move through them, see each step's inputs and outputs, and even re-run a single stage. The project's development history (preserved in `docs/delivery-engine-port.md`) shows this decomposition was done deliberately, slice by slice, precisely to make major boundaries visible as first-class steps.

### Loops: the three ways this system repeats itself

Now we reach one of the concepts you asked to see clearly: **loops**. In AI systems, a loop is any structure that tries, checks, and tries again. Uncontrolled loops are how AI systems burn money and thrash; well-designed loops are how they get *good*. Mastra gives workflow-native loop constructs, and the Delivery Engine uses each where it fits.

**`.dountil` — retry until a condition holds.** The architect review is a loop: review the plan → if blocked, bounce it to the planner for revision → review again:

```ts
export const deliveryReviewWorkflow = createWorkflow({ ... })
  .then(prepareReviewLoopStep)
  .dountil(executeReviewAttemptStep, async ({ inputData }) => inputData.terminal)
  .then(finalizeReviewLoopStep)
  .commit();
```

Each pass through `executeReviewAttemptStep` either ends the loop (sets `terminal: true`) or increments an attempt counter and goes around again. The same pattern drives the release-gate retry loop and the per-task build attempt loop.

**`.foreach` — do this for every item.** The build stage expands the approved plan into an ordered list of tasks, then runs a *nested workflow* once per task:

```ts
export const deliveryBuildWorkflow = createWorkflow({ ... })
  .then(prepareBuildTasksStep)                            // plan → ordered work items
  .foreach(deliveryBuildTaskWorkflow, { concurrency: 1 }) // one nested workflow per task
  .then(aggregateBuildTaskResultsStep)
  .commit();
```

`concurrency: 1` means one at a time — tasks depend on each other, so parallel building would create chaos. Note also the ordering: tasks are sorted by **topological order**, meaning nothing runs before the things it depends on. That sort is done by plain code (a standard graph algorithm), because ordering a dependency graph is deterministic — the model doesn't get a vote.

**Bounded retries with a budget.** Every loop in this system carries a `maxRetries` budget (default: 2). And here is the philosophy, straight from the project's constitution:

> "A bounded loop that parks as STUCK beats an unbounded loop that thrashes."

When retries are exhausted, work doesn't limp forward and it doesn't spin forever. The task is marked **stuck**, everything depending on it is marked **blocked**, and the run parks with a clear record of what failed and what remediation was suggested. A human can then look at exactly the right thing. "Stuck" is not a failure of the system — it *is* the system, working. Knowing when to stop is a feature you must design.

### Loop babysitters: timeouts and progress watchdogs

The Delivery Engine wraps every agent call inside a supervisor function (`runWithDeliveryStageTimeout`) that watches for four distinct ways a loop iteration can go bad — each with its own detection and its own name in the event log:

1. **Hard timeout.** The stage exceeded its total time budget. Abort.
2. **No-tool-call timeout.** A build agent has produced nothing but text for a whole minute — it's musing, not working. Abort with a targeted message.
3. **Post-write quiet timeout.** The agent wrote files... and then went quiet without finishing. Likely wedged. Abort.
4. **Read-budget exceeded.** The workspace tripwire (Part 6) fired repeatedly — the agent is stuck in investigation mode. Abort.

Now, the clever part: **what happens after an abort is not generic.** The failure is *classified* (there's literally a function, `implementationFailureClass`, that sorts remediation text into categories: `missing_surface`, `preflight_stub`, `read_budget`, `code_verification`, `policy_boundary`, `judge_timeout`, `model_no_action`...) and the *next attempt is reshaped accordingly*:

- If the failure was "never created the files," the retry runs in **write-first mode**: the agent gets *only* write tools (reading is stripped away entirely), a tool call is *required*, and the prompt says: create these exact missing files now, investigate nothing.
- If the failure was "placeholder stubs never got replaced," the retry runs in **replace-stubs mode** with edit tools only and the stub list in hand.
- If verification failed with specific compiler errors, the retry runs in **focused-repair mode**: the harness extracts each TypeScript error (file, line, message) from the failure output and hands the agent a precise fix-list *plus the current contents of the relevant files*, so it doesn't have to spend reads rediscovering them.

This is what a mature loop looks like: not "try again," but *diagnose, then constrain the retry to exactly the fix*. Each retry is cheaper and more likely to land than the attempt before it. The harness even *pre-creates* missing files as compile-safe stubs before an attempt (so verification tooling can run from the start), and can "salvage" a timed-out attempt — if the agent got the files into place before the clock ran out, the workflow just proceeds to verification instead of wasting the work.

And every one of these behaviors is deterministic code. The model experiences them as a strict but fair supervisor.

---

## Part 8: Structured Output, Memory, and Guardrails

### Structured output: making models speak JSON

Free-form prose is lovely for humans and terrible for pipelines. When the planner produces a task plan, the next steps need to *compute* over it — count tasks, check the dependency graph, verify each task has an owner. So the plan must arrive as **structured data**: JSON (JavaScript Object Notation — the universal bracket-and-quote text format for structured data) matching a schema.

Mastra supports this directly: when calling an agent, you pass a `structuredOutput` option with a Zod schema, and the framework pushes the model to answer in exactly that shape. The Delivery Engine defines schemas for every artifact type — `readoutSchema`, `taskPlanSchema`, `reviewReportSchema`, `implementationNoteSchema`, `releaseGateSchema`, `deploymentReportSchema` — so each stage's product is a validated, typed object.

But models are imperfect, so the project adds a defensive layer (`structured-output.ts`) that reads like a lesson in humility. When a response arrives, the parser tries, in order: the properly structured object; any nested object in the response that happens to validate; JSON inside code fences in the text; any *balanced JSON snippet* found anywhere in the text (it walks the braces by hand). It even repairs common shape mistakes — an architect returning a bare list of findings instead of the full report object gets wrapped into a valid report, and the repair itself is logged as a `structured_output_repaired` event.

And when nothing salvageable arrives? The system **fails closed**. If the tester's release-gate output can't be parsed, the code *synthesizes a failing gate* — decision: fail, every critical area marked missing, with a blocker explaining what happened. Garbled output is treated as "not proven safe," never as "probably fine." Remember that phrase, *fail closed* — it means "when in doubt, the safe answer wins" — because it's the default posture of this entire system.

### Memory: the shared whiteboard, deliberately small

Mastra's **Memory** gives agents two things: recent conversation history, and **working memory** — a structured scratchpad persisted between calls. The Delivery Engine configures one shared memory for all agents:

```ts
export const deliveryMemory = new Memory({
  options: {
    lastMessages: 12,
    workingMemory: { enabled: true, scope: 'thread', schema: deliveryWorkingMemorySchema },
  },
});
```

Details worth unpacking:

- **`scope: 'thread'`** — memory is partitioned by conversation thread. The engine maps *one delivery run to one thread* (the thread ID is the run ID) and one target repository to one **resource** (a stable ID derived by hashing the repo path). Two runs never share a whiteboard; two projects never share anything.
- **The schema.** Even the scratchpad is typed! Working memory must fit a Zod schema with slots for: current stage, active task, acceptance contracts in play, open questions, assumptions, risks, Cloudflare resource assumptions, handoff notes, and approval state. Agents can't scribble anything anywhere; they fill in a form.
- **Role policies.** When the workflow calls an agent, it passes memory options per role — and the judge's memory is **read-only**. A judge that could write to the shared whiteboard could, in principle, influence the next thing it judges. Sealed.

But the deepest lesson here is what memory is *not* used for. The shared instructions say it plainly:

> "Use thread-scoped working memory only for live coordination facts... Persist durable decisions, artifacts, scores, and status through the delivery tools and workflows."

And the porting notes state the principle: **"Prefer executable state over narrative memory."** Anything that matters goes in `run.json`, the artifacts, and the event log — places code can verify. Memory is for the small talk of coordination, and the judge is explicitly told memory "must not be used as evidence." An AI system whose source of truth is what an AI remembers is a rumor mill. This one's source of truth is a filing cabinet.

### Processors: guardrails on the pipe

Mastra **processors** are filters attached to an agent's input and output — every message passes through them, coming and going. The Delivery Engine attaches six, and they're a tour of practical AI safety:

**On the way in (input processors):**

1. **Unicode normalizer.** Strips control characters and normalizes text. Mundane hygiene; also closes off a class of sneaky-invisible-character tricks.
2. **Repo-path guard.** Rejects any call lacking `requestContext.repoPath`. No agent operates without knowing (and being confined to) its target.
3. **Instruction-override guard.** Pattern-matches the incoming text for attempts to talk the agent out of its harness: "ignore the delivery state," "skip the release gate," "pretend the tests passed," "bypass deployment approval." Any match aborts the call. This defends against **prompt injection** — the trick where hostile instructions hide inside content the model reads (a file, a document, a web page) and try to hijack it. The defense isn't a smarter model; it's a dumb, reliable regular-expression tripwire in front of the model. (Deterministic and blockable → code. There's the sorting principle again.)
4. **Token limiter.** Caps input at 60,000 tokens. A runaway context is a runaway bill and degraded attention. Hard ceiling.

**On the way out (output processors):**

5. **Secret redactor.** Scans responses for things shaped like passwords, keys, and tokens, and redacts them. The workflow layer independently does the same to its trace files, replacing any known secret value from the environment with `[REDACTED]`. Defense in depth: even if a secret sneaks into a model's context, it doesn't get to leave.
6. **The evidence-claim guard.** The signature move of this project. It pattern-matches the agent's *own output* for completion claims ("done," "implemented successfully," "deployment complete") and then checks whether the same message cites any actual evidence — artifact paths, event references, check results, test output. A confident claim with no evidence gets the response **rejected and retried once**, with the instruction: "Completion claims need evidence. Cite `.delivery` artifacts, run_code/live_verify events, checks, judgments..." The harness literally will not accept "trust me" as an answer.

These processors are also registered on the Mastra instance itself — so they're not invisible plumbing; they show up in Studio as named, inspectable resources.

---

## Part 9: Judging — Checks, Rubrics, and the Courtroom

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

---

## Part 10: Scorers and Evals — Measuring the Machine

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

---

## Part 11: Humans in the Loop — Suspend and Resume

For all its autonomy, this system knows two moments when a human is not optional. Mastra's answer is **suspend/resume**: a workflow step can *suspend* — pause and persist itself, possibly for hours or days — with a typed payload explaining why, and later *resume* with a typed human answer, continuing exactly where it stopped. Both payloads are Zod-schema'd, so pauses and answers are structured data, not vibes.

**Pause 1: The planner is truly blocked.** If the vision document has a genuine blocker, the planning step suspends with the label `answer-planner-questions`, carrying the questions and where to look. You resume with structured answers, and planning continues with your input included.

But look at how hard the system works to *not* pause. The suspend condition is `shouldSuspendForPlannerQuestions`: it fires only if a blocking ambiguity survives the `isTrueBlockingAmbiguity` filter (which discards settled-policy questions, safe assumptions dressed as blockers, and anything that doesn't name what it blocks) **and** the plan has no executable root task at all. Everything softer is recorded as a deferred question and the run proceeds on documented safe assumptions. The philosophy — enforced by the planner's own trajectory rubric, whose heaviest dimension is "blocking questions only" — is that an autonomous system that constantly asks permission isn't autonomous, and a human interrupted for preferences stops reading the interruptions. Escalation is a scarce resource; the harness budgets it.

**Pause 2: Production deployment.** Before any production deploy command runs, the deployment step suspends with the label `approve-production-deployment`, presenting the release gate summary and blockers. You resume with `{ approved: true/false, approver, notes }`. Approval and rejection are both recorded as `human_approval` events — the paper trail includes you. A rejection finalizes the run as failed *without running any deploy command*. And note the default: `deployMode` is `local`, meaning the standard run never touches production at all; it ends with local validation and a report. Production is opt-in, gated, logged, and named.

Two pauses. One for "I genuinely cannot know what you want." One for "this action is irreversible." Everything else, the machine handles or parks as stuck. That's a complete theory of human-in-the-loop in two rules.

---

## Part 12: Skills, Doors, and Watching It Run

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

---

## Part 13: A Run, Start to Finish — The Tally Story

Time to put every part together and just *watch*. The repository includes example inputs for a product called **Tally** — and they're worth reading as a lesson in how to talk to a system like this.

**The vision** (`vision.md`) is human and small: a solo newsletter author wants link-click counting. "Every existing analytics tool she tried is a dashboard-shaped kitchen sink; she wants a service so small she can read all of its code in ten minutes and trust it." Creating a tracked link returns a short ID; visiting it redirects and counts; asking for stats returns the count. Explicitly out of scope: accounts, dashboards, scale.

**The spec** (`spec.md`) is precise where precision pays: exact routes with exact status codes and response shapes ("`POST /api/links`... on invalid URL: `400` with `{ "error": ..., "next_steps": ... }`"), exact storage schema, exact file layout, and constraints ("Every error response is JSON with `error` and `next_steps`. No stack traces... no silent fallbacks"). Vision says *why and what*; spec says *exactly what*; the engine supplies *how*.

You create a folder, drop both files in, and run:

```
npm run delivery:run -- --projectFolder /path/to/tally
```

**Minute 0 — Intake.** The runner validates input, checks API keys, resolves the folder, writes a "running" report stub, creates a workflow run scoped to this repo, and starts it with `repoPath` in the request context. `initialize-delivery-run` writes `.delivery/run.json` (status: running, stage: readout) and the first event: `run_init`.

**Minutes 1–3 — Planning.** The planner receives both documents *pasted directly into its prompt* (a deliberate economy — no tool-call round trips to read two known files), plus the full project policy and this repo's scaffold facts. It returns two structured artifacts: a **readout** (intent, technical shape, safe assumptions, blocking ambiguities) and a **task plan**. The Tally spec is clean, so no suspension: perhaps seven tasks — scaffold, schema migration, ID helper, link storage, Worker routes, optional UI (designer-owned), README — each with owner, dependencies, concrete file paths, and checkable acceptance criteria.

Before judging, the **normalizers** silently tidy: verify the root scaffold owns the right files, split anything oversized, append the operator-documentation task if the planner forgot, rewire slice dependencies. Then the **plan gate**: twelve deterministic checks (acyclic graph, schema completeness, all the hygiene rules), then the judge scores the plan against the task-plan rubric, code aggregates, and — if anything failed — a *plan repair loop* feeds the remediation back to the planner, re-checks, re-judges, up to the retry budget, with a regression check ensuring no acceptance criterion silently vanishes during revision. Studio's timeline shows all of it: `plan` stage, `judge:task-plan` stage, scores attached. (And a cost note: planner output is cached by a fingerprint of the source documents — rerun the same docs under the same policy version and planning is free.)

**Minutes 3–5 — Review.** The architect reads the plan against its checklist — granularity, error handling, trust boundaries, state authority, fail-fast behavior, data flow, security, complexity, binding completeness — and returns a structured verdict: approved, approved with conditions, or blocked. The report itself gets judged (yes, the review is reviewed — against the review-report rubric, whose gates include "the verdict must match the findings" and "critical-area findings are never waved through as conditions"). Blocked → bounce to planner for revision → re-review, inside the `.dountil` loop, budget-bounded. Tally's plan passes, perhaps with a condition or two, and the status becomes `reviewed`. (In `--review fast` mode this stage is skipped entirely, on the argument that the plan already passed a deterministic-plus-rubric gate — a documented, logged tradeoff you choose per run.)

**Minutes 5–25 — The build loop.** The heart. Tasks execute in dependency order, each through the nested `deliveryBuildTaskWorkflow`:

1. **Pre-checks.** Earlier task stuck? This one's marked blocked; skip. A prior run already left a *passing* implementation for this task, with files present and a valid judgment on disk? Reuse it — log `implementation_artifact_reused`, mark complete, spend zero tokens. (This "resume cursor" makes re-running after a mid-run failure cheap: the completed prefix fast-forwards.)
2. **Stage start.** `boundary.json` appears: role engineer, stage `build:T3`, surfaces = exactly this task's files. The tripwires from Part 6 are now armed with *this* task's rules.
3. **Stubs.** Missing owned files are pre-created as compile-safe placeholders so verification tooling can run from the first minute.
4. **The attempt.** The engineer gets a **task packet** — one self-contained JSON briefing: the task, its acceptance contracts (each with an ID, tracked like requirements), boundary surfaces, dependency files, prior-attempt remediation, failure class, platform policy findings, and execution rules ("Make the smallest coherent change"; "Do not run shell commands; the workflow runs verification"; "After writing, stop reading and return"). The packet exists so the agent *doesn't need to explore* — exploration is the expensive failure mode. Watchdogs run: total timeout, no-tool-call timeout, post-write quiet timeout, read budget.
5. **Verification — by the workflow, not the agent.** Code picks the strongest available check (typecheck script, tests, build — or, for plain-JavaScript Workers with no scripts, a deployment dry-run through the platform CLI), installs dependencies if needed, runs it, logs `run_code` events. Known failure patterns may trigger auto-repairs; then it verifies again.
6. **The implementation note — synthesized, not self-reported.** Files touched come from the *event log*, not the agent's claims. Each acceptance contract is marked verified or unverified based on actual evidence: matching verification commands, targeted structural checks (code parses the Wrangler config to verify environments and bindings; parses `.gitignore` for required exclusions; parses the entrypoint for required exports), or token-overlap analysis between the criterion and the actual file contents. Unverifiable contracts are listed as *gaps* — visible, not papered over.
7. **Fourteen deterministic gates** on the attempt: ownership, surfaces present, stubs replaced, integration wiring (a route module imported but never wired into the router is caught by static analysis — "done in isolation" is not done), platform bindings, config and package hygiene, schema constraints, acceptance contracts, code-ran-before-complete, verification passed, crypto compliance. Failures skip the judge entirely (why pay for judgment on work that failed the checklist?) and loop back with targeted remediation — unless the failure is the *harness's own fault* (a boundary rule wrongly rejecting a legitimate path is detected as an "engine policy mismatch" and parks the task rather than burning the agent's retries on an unwinnable fight — the harness holds *itself* accountable), or workspace contamination from outside the plan (also parked, with its own name).
8. **Judgment.** The implementation rubric — six critical gates including "no silent degradation" and "no fire-and-forget," six weighted dimensions. Pass → complete. Fail with *actionable* remediation → focused-repair retry. Fail where every complaint is non-actionable for this task (a nuanced fast-path: deterministic checks green, verification performed, remediation all cosmetic-or-out-of-scope) → accept, *record the low score honestly*, and flag it for the release gate. Even the exception is logged.

Task by task, `run.json` fills in: `T1:complete, T2:complete, ...` — statuses you can watch tick over in Studio or by reading the file.

**Minutes 25–30 — The release gate.** First, *code* gathers evidence — this stage barely trusts the tester with anything mechanical. Static analysis of config, package, schema, and binding hygiene. Every available verification script. A production-deploy dry-run. A startup profile. Local database migrations against isolated state. Then the showstopper: the harness **boots the actual application** locally (spawning the platform's dev server on a free port with isolated state and a temporary admin secret), and runs an HTTP **probe plan derived from the spec itself**. For Tally, that means: serve the static page; create a link and capture the returned ID; fetch its stats (clicks: 0); follow the redirect (302 to the right destination); fetch stats again (clicks: *exactly* 1 — atomicity, proven live); confirm unknown IDs return the exact specified JSON error shape; malformed JSON returns 400 with `next_steps`. The spec's acceptance criteria have become executable probes.

Only then does the tester agent act — and it's *forbidden from tools*: "Do not claim evidence that is not listed here." It synthesizes the evidence into a structured release-gate decision, which then faces its own deterministic gates (tier order, no-pass-with-blockers, evidence-before-findings, all-required-evidence-passed — this last one making it impossible for a charitable tester to wave through a failed command) and the release-gate rubric, whose heaviest dimension is evidence traceability. Pass → `release_ready`. Fail honestly → `gate_failed`, deployment never happens. Grade poorly → retry loop with remediation.

**Minutes 30–32 — Deployment and the finish.** In default local mode: the workflow records that the gate was read (feeding the paranoid trajectory check), logs a local `deploy` and `live_verify` event pair backed by the probe evidence, and synthesizes a deployment report — environment, revision, every verification row, issues, a rollback section, and next steps that tell you the *exact command* to run when you want the production path (which would suspend for your approval, run the real deploy CLI, parse the emitted URL, and probe the live site). The deployment report is judged (rubric: "no deploy through blockers," "verification evidence present," weights on verification quality and rollback readiness); the run finishes `complete` or `failed`; terminal state persists everywhere; the final report lands in `.delivery/runs/`.

On disk now: a working application — Worker entry, migration, helpers, optional UI, README — and beside it a `.delivery/` folder containing every plan, every review, every attempt note, every judgment with cited evidence, every probe result, and an event log of every single action. You were asked for input at most twice. And nothing in the final state depends on anyone's confident narration.

---

## Part 14: What to Take With You

If you remember nothing else, remember these seven transferable lessons — every one of them visible in the code we just toured:

**1. Sort every rule into its home.** Deterministic and blockable → code (tools, checks, hooks). Judgment but gradeable → rubrics and scorers. Judgment and generative → agents and skills. When you find judgment repeating itself, promote it downward. This one habit organizes everything else.

**2. Claims are not evidence.** Log actions as events. Derive reports from logs, not from self-description. Reject completion claims that cite no evidence. Make "the tests passed" a checkable fact with a paper trail, or don't accept it.

**3. Constrain, don't implore.** A boundary enforced by a `beforeToolCall` hook is worth a thousand "please do not" sentences in a prompt. Spend prompts on judgment; spend code on rules.

**4. Bound every loop, and make "stuck" a first-class state.** Budgeted retries, watchdog timeouts, diagnosed failures, *reshaped* retries. A system that knows when to stop and park with a clear record is more autonomous — not less — than one that thrashes.

**5. Fail closed, everywhere.** Unparseable output is a failing result. An unevaluated gate is a failed gate. A judge outage is "not proven," never "probably fine." Doubt resolves toward safety by default, at every layer.

**6. Measure the measurers.** Judges get rubrics; rubrics get exemplars; scorers get datasets with positive *and negative* ground truth; the whole thing gates CI. The day you change a prompt or swap a model, your evals — not your optimism — tell you what happened.

**7. Interrupt humans only for the two real things.** Genuine blockers, and irreversible actions. Everything else: proceed on a *recorded* safe assumption, or park as stuck. Escalation is a budget.

And the Mastra inventory you now know by heart, because you've seen each piece earning its keep: **agents** (workers with instructions, tools, memory, guardrails), **tools** (schema-fenced functions), **workspaces** (contained hands with hooks), **workflows** (typed steps, `.then` / `.dountil` / `.foreach`, suspend/resume), **memory** (scoped, schema'd, deliberately small), **processors** (guardrails on the pipe), **scorers** (live gauges), **datasets and experiments** (evals), **storage and observability** (the flight recorder), **skills** (bottled expertise), and **Studio** (the window onto all of it).

If you want to go further: install Mastra (`npm create mastra@latest`), run `npm run dev`, open Studio, and build one agent with one tool and one guardrail. Then add a check that its claims match its actions. Congratulations — you've started a harness. The rest is the same move, repeated with taste.

The docs live at [mastra.ai](https://mastra.ai). The judgment — that part you have to supply yourself. But now you've seen what it looks like when someone writes theirs down.
