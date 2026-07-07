# Part 11: Humans in the Loop — Suspend and Resume

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

For all its autonomy, this system knows two moments when a human is not optional. Mastra's answer is **suspend/resume**: a workflow step can *suspend* — pause and persist itself, possibly for hours or days — with a typed payload explaining why, and later *resume* with a typed human answer, continuing exactly where it stopped. Both payloads are Zod-schema'd, so pauses and answers are structured data, not vibes.

**Pause 1: The planner is truly blocked.** If the vision document has a genuine blocker, the planning step suspends with the label `answer-planner-questions`, carrying the questions and where to look. You resume with structured answers, and planning continues with your input included.

But look at how hard the system works to *not* pause. The suspend condition is `shouldSuspendForPlannerQuestions`: it fires only if a blocking ambiguity survives the `isTrueBlockingAmbiguity` filter (which discards settled-policy questions, safe assumptions dressed as blockers, and anything that doesn't name what it blocks) **and** the plan has no executable root task at all. Everything softer is recorded as a deferred question and the run proceeds on documented safe assumptions. The philosophy — enforced by the planner's own trajectory rubric, whose heaviest dimension is "blocking questions only" — is that an autonomous system that constantly asks permission isn't autonomous, and a human interrupted for preferences stops reading the interruptions. Escalation is a scarce resource; the harness budgets it.

**Pause 2: Production deployment.** Before any production deploy command runs, the deployment step suspends with the label `approve-production-deployment`, presenting the release gate summary and blockers. You resume with `{ approved: true/false, approver, notes }`. Approval and rejection are both recorded as `human_approval` events — the paper trail includes you. A rejection finalizes the run as failed *without running any deploy command*. And note the default: `deployMode` is `local`, meaning the standard run never touches production at all; it ends with local validation and a report. Production is opt-in, gated, logged, and named.

Two pauses. One for "I genuinely cannot know what you want." One for "this action is irreversible." Everything else, the machine handles or parks as stuck. That's a complete theory of human-in-the-loop in two rules.
