# AI Agent Project Evaluation Rubric

This rubric translates the thinking from the two PDFs in this project into a practical framework for evaluating AI projects.

- `Principles of Building AI Agents` explains the foundational building blocks: models, prompts, tools, memory, MCP, workflows, RAG, multi-agent systems, observability, evals, deployment, coding agents, sandboxes, and multimodal capabilities.
- `Patterns for Building AI Agents` turns those foundations into production patterns: capability design, iterative architecture, context engineering, eval discipline, SME labeling, production datasets, security controls, and agent access boundaries.

The books should not be treated as automatically correct. Treat them as a lens: a project scores well when it shows clear thinking about the same design pressures these books emphasize.

## Core Interpretation

The shared thesis is:

1. Agents are not just prompts. They are systems that combine models, instructions, tools, memory, context, workflows, and permissions.
2. Good agent design starts with organizational design: list the capabilities, group related work, define roles, assign tools, and avoid one overgrown mega-agent.
3. Reliability comes from controlling context and control flow. Agents need the right information, not all information.
4. Production quality is measured, not guessed. Teams need traces, evals, failure-mode taxonomies, business metrics, labeled datasets, and regression gates.
5. Agent autonomy increases both usefulness and risk. Human checkpoints, guardrails, access control, and sandboxes are first-class architecture, not add-ons.
6. Start simple, then evolve. Build the burning problem first, observe what users actually ask for, split or route agents when the system becomes unwieldy, and improve against real production data.

## Scoring Method

Score each category from 0 to 4, then multiply by its weight.

- 0: Missing or actively harmful.
- 1: Ad hoc prototype. Some awareness, little implementation.
- 2: Basic implementation. Works for happy paths, weak production discipline.
- 3: Solid implementation. Clear design, tested behavior, known trade-offs.
- 4: Excellent implementation. Production-grade, measured, observable, secure, and intentionally evolved.

Total score: 100 points.

## Rubric

| Category | Weight | What Good Looks Like |
| --- | ---: | --- |
| 1. Problem Framing and Capability Architecture | 10 | The team can name the user jobs, business process, agent capabilities, natural task groupings, and priority order. It has avoided a giant all-purpose agent unless the scope truly supports one. |
| 2. Model, Prompt, and Output Foundations | 10 | The project chooses models intentionally for quality, latency, cost, context size, and reasoning needs. Prompts define role, constraints, examples, formatting, and refusal/fallback behavior. Structured output is used where application logic needs schemas. |
| 3. Tool and Integration Design | 10 | Tools are clear, semantic, scoped, and reusable. Tool names, descriptions, schemas, and return values help the model choose correctly. Integrations, including MCP or third-party services, are treated as explicit trust and reliability boundaries. |
| 4. Context, Memory, and Retrieval Management | 12 | The project manages working memory, semantic recall/RAG, observational or summarized history, and context compression. It avoids context poisoning, distraction, confusion, clash, and rot. Retrieval is tuned with chunking, metadata, reranking, and fallback strategies when appropriate. |
| 5. Workflow and Control Flow Design | 10 | The project uses deterministic workflows where open-ended agent autonomy is too loose. It has meaningful steps, branching, chaining, merging, retries, suspend/resume, streaming updates, and human checkpoints for risky or uncertain actions. |
| 6. Multi-Agent Architecture | 8 | Multiple agents exist only when specialization improves reliability or maintainability. Subagents have cohesive roles, focused toolsets, success criteria, and context-sharing rules. Parallelism is used only where outputs will remain compatible. |
| 7. Evaluation and Continuous Improvement | 15 | The project has offline and/or online evals, known failure modes, critical business metrics, cross-referenced failure-mode impact, test datasets, SME labeling where needed, production-data sampling, and regression thresholds in the development loop. |
| 8. Observability, Cost, Latency, and UX Feedback | 10 | The team can inspect traces, spans, model calls, tool calls, inputs, outputs, latency, token usage, and errors. The user experience streams progress and avoids silent long waits. Cost and latency are measured and tuned, not discovered by surprise. |
| 9. Security, Permissions, and Safety | 10 | The project addresses prompt injection, the lethal trifecta, sandboxed code execution, input/output guardrails, granular tool permissions, user authorization, agent identity, and human approval for high-impact actions. |
| 10. Deployment and Operational Readiness | 5 | The project has a realistic backend architecture for long-running stateful agent loops, durable workflow state, safe local development tools, deployment strategy, scaling model, and rollback/debug path. |

## Evaluation Checklist

Use these questions when grading a project.

### 1. Problem Framing and Capability Architecture

- What specific human process or user job is the agent replacing, augmenting, or accelerating?
- Are the desired capabilities listed comprehensively?
- Are capabilities grouped by data source, job role, process step, toolset, or department?
- Is there one burning problem solved well before expanding scope?
- If there are multiple agents, why are they separate?

### 2. Model, Prompt, and Output Foundations

- Why was this provider/model chosen?
- Is there routing between large, small, reasoning, or cheaper models?
- Are prompts explicit about role, goals, constraints, examples, and prohibited behavior?
- Does the project use structured outputs for downstream application logic?
- Are prompt changes evaluated rather than accepted by vibes?

### 3. Tool and Integration Design

- Are tools designed around clear analyst-like operations?
- Does each tool have a specific schema, clear name, and clear invocation conditions?
- Are tool results concise enough to help rather than flood context?
- Are third-party integrations evaluated for reliability, permissions, and trust?
- If MCP is used, are MCP servers treated like potentially risky third-party APIs?

### 4. Context, Memory, and Retrieval Management

- What context must the model see for each step?
- What context should be excluded?
- Is long-term memory separated from raw conversation history?
- Is context summarized, pruned, or compressed before it becomes harmful?
- Does retrieval include chunking, embeddings, metadata, top-K tuning, and reranking where useful?
- Are errors and failed tool calls fed back into context for recovery?

### 5. Workflow and Control Flow Design

- Which steps are deterministic workflow steps and which are open-ended agent decisions?
- Can the process pause for human input, slow APIs, or asynchronous work?
- Are risky actions gated by review or approval?
- Does the system stream progress and intermediate status to the user?
- Are workflow step inputs and outputs meaningful enough to debug?

### 6. Multi-Agent Architecture

- Are subagents specialized by capability, data domain, or output type?
- Is there a router, supervisor, or coordinator where needed?
- Do subagents share enough context to avoid incompatible outputs?
- Is parallel execution limited to independent tasks?
- Are workflows exposed as tools where a repeatable sequence needs structure?

### 7. Evaluation and Continuous Improvement

- What are the known failure modes?
- What are the business-critical success metrics?
- Which failure modes most affect those metrics?
- Is there an eval test suite with a benchmark dataset?
- Are evals run in CI or before deployment?
- Are real production traces sampled and turned into datasets?
- Are SMEs involved where domain judgment matters?
- Are LLM judges used with binary or categorical scoring where appropriate?

### 8. Observability, Cost, Latency, and UX Feedback

- Can the team inspect a full trace from user input through agent decisions, tool calls, and final output?
- Are token usage, model costs, latency, and failures tracked?
- Can developers debug tools independently from the agent?
- Is there a local development environment that makes agent behavior visible?
- Does the product make slow work feel understandable with progress updates?

### 9. Security, Permissions, and Safety

- Does the agent combine private data access, untrusted content, and external communication?
- If yes, which leg of that triangle is constrained?
- Can the agent execute code, and if so, is execution sandboxed?
- Are tool permissions granted narrowly and just in time?
- Are input and output guardrails present for user-facing use cases?
- Are destructive or high-stakes actions separated into planning and execution modes?

### 10. Deployment and Operational Readiness

- Where does the long-running agent loop run?
- How is workflow state persisted?
- What happens on timeout, restart, retry, or partial failure?
- Can the system scale without runaway token costs?
- Are deployment, monitoring, rollback, and incident review paths defined?

## Score Bands

- 90-100: Production-grade agent system. Strong evidence across architecture, evals, observability, and safety.
- 75-89: Strong project. Likely useful and maintainable, with a few gaps to close before broad trust.
- 60-74: Promising prototype. Core value exists, but production readiness is uneven.
- 40-59: Demo-quality. Useful lessons, but reliability, evals, context control, or safety are underdeveloped.
- 0-39: Concept stage or fragile build. The project may work in narrow happy paths but does not yet embody the agent-system discipline described by the books.

## Suggested Grading Output

For each project, produce:

1. Overall score and band.
2. Category scores with one-sentence justification each.
3. Top 3 strengths.
4. Top 3 risks or gaps.
5. Recommended next actions, prioritized by expected score impact.
6. Evidence notes: traces, prompts, eval files, tool schemas, datasets, security docs, or product workflows reviewed.

## Important Biases in This Rubric

This rubric favors production-ready agent systems over impressive demos. A simple project with narrow scope, clear tools, good evals, safe permissions, and strong observability should score higher than a flashy autonomous system that cannot explain, measure, or constrain its behavior.

It also favors incremental architecture. A project does not need multi-agent orchestration, RAG, MCP, or sandboxes unless the use case calls for them. The right question is not "does it use every pattern?" but "does it use the right primitives for its risk, scope, and task complexity?"
