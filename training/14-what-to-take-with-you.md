# Part 14: What to Take With You

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

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
