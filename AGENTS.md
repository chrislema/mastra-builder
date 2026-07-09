# AGENTS.md

## CRITICAL: Load `mastra` skill first

Load the `mastra` skill BEFORE any Mastra work. Never rely on cached knowledge — APIs change between versions.

## CRITICAL: Re-anchor on operating doctrine

After loading the `mastra` skill, read `docs/OPERATING_DOCTRINE.md` before making goal-driven changes. The active goal is important, but do not let it become myopic: preserve the rubric lens, Mastra-native design, Cloudflare-first scope, and evidence of real forward progress.

For repo-wide review, correctness claims, benchmark failures, scaffold changes, or any request to make sure the system is "right" or "not guessing", also read `docs/TRACEABILITY_ASSESSMENT.md`. Use it to map source requirement -> producer -> generated artifact -> verifier -> observed evidence before proposing another paid delivery run.

For workflow cleanup or delivery-run iteration, also read `docs/WORKFLOW_CLEANUP_TODO.md` before editing. For work that changes `src/mastra/delivery-engine/workflow.ts`, read `docs/workflow-enhance.md` as the active ordered plan.

## Rules

- Register all agents, tools, workflows, and scorers in `src/mastra/index.ts`
- Use the `dev` and `build` scripts from `package.json` instead of running `mastra dev` / `mastra build` directly

## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
- [Skills Discovery](https://mastra.ai/.well-known/skills/index.json)
