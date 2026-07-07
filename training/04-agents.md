# Part 4: Agents — The Workers

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

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
