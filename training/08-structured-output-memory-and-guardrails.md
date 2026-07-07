# Part 8: Structured Output, Memory, and Guardrails

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

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
