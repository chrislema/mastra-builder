# Part 3: What Is Mastra?

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

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
