# Part 7: Workflows and Loops — The Assembly Line

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

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
