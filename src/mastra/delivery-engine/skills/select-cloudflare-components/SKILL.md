---
name: select-cloudflare-components
description: Selects Cloudflare Workers-first architecture, infrastructure services, and model capabilities for a feature set based on dependency chains, iteration needs, and consistency principles. Use when deciding whether Pages Functions are explicitly warranted, evaluating whether a feature needs Workflows or Durable Objects, choosing model-routing needs, or reviewing architecture for deployment consistency.
---

Primary roles: planner, architect

## Purpose

Evaluates a feature set against Cloudflare's infrastructure options and selects a Workers-first deployment model, identifies Workflow candidates, assigns infrastructure services, and chooses model capabilities per feature. Enforces the consistency principle: never split features between Pages Functions and Workers.

## Procedure

1. List all features in the system or project under review. For each feature, note: whether it needs independent iteration, whether it has multi-step dependency chains, whether it needs real-time coordination or stateful connections.
2. Determine the deployment model:
   - Default to standalone Workers.
   - If any feature requires Workflows, Durable Objects, Queues, scheduled work, service bindings, or repeated independent iteration, the deployment model is Workers.
   - Use Pages Functions only when the existing repo or spec explicitly requires Pages and every feature fits that model.
   - Verify the consistency principle: no features split between Pages Functions and Workers.
3. For each feature with multi-step processing, evaluate whether it needs Workflows. Apply the dependency chain test: if one operation's output feeds into another's input (A then B then C), use Workflows. If operations are independent (even if long-running), do not use Workflows.
4. Assign infrastructure services to each feature using the service selection table. Map data storage, compute, caching, and communication needs.
5. For each feature that uses an LLM, select the model capability class:
   - Use the default configured Mastra model for rule application, calculations, structured transformations, format conversion, framework/rubric application, and structured data extraction.
   - Request an explicitly configured stronger writing/reasoning model only when the feature depends on nuance, subtle pattern recognition, quality evaluation, human voice, creative judgment, or voice fidelity.
6. Verify the complete architecture for consistency: all features use the same deployment model, service bindings connect Workers correctly, and no feature is an exception to the thin proxy pattern.

## Reference

### Standalone Workers vs. Pages Functions

Chris's default is standalone Workers. The decision is not "which is simpler for a small app"; it is "is there a strong reason not to use Workers?"

**Default to standalone Workers when:**
- The feature is an API, background process, scheduled job, data workflow, or service endpoint.
- The feature may later need Workflows, Durable Objects, Queues, service bindings, or independent observability.
- The spec is silent about Pages.
- You want one consistent Cloudflare compute model.

**Use Pages Functions only when:**
- The existing repo is already a Pages Functions project, or the spec explicitly asks for Pages.
- The work is tightly coupled to a static Pages site and does not need Worker-specific services.
- The whole feature set can remain in Pages Functions without exceptions.

### The Consistency Principle

Never split features between Pages Functions and Workers. If any feature belongs in Workers, the cohesive system goes Workers-first. If an existing project is truly Pages Functions, all features stay in Functions. This applies to everything: forms, logging, security. The thin proxy pattern should do the same thing everywhere — no exceptions where "this one does a little more."

### Workflows

Duration is not the deciding factor. Dependency chains are.

- **Use Workflows when:** one operation's output feeds into another operation's input (A then B then C).
- **Don't use Workflows when:** operations are independent, even if they're all long-running. Independent parallel operations don't need orchestration.

### Model Routing

- **Default configured model**: handles rule application, calculations, structured transformations, format conversion, framework/rubric application, and structured data extraction.
- **Specialized configured model**: reserve for features that truly depend on nuanced analysis, serious writing, voice fidelity, or creative judgment. Name the required capability and let the Mastra model router/provider configuration bind it.

### Infrastructure Services

| Service | Use For |
|---------|---------|
| Workers | Default compute, auth, business logic, APIs, data processing, scheduled jobs |
| Pages | Existing/static site hosting when explicitly required |
| D1 | Multi-tenant data, work queues, usage tracking, sessions |
| R2 | PDFs, generated media, artifacts, user uploads |
| KV | Metadata caching, rate limit counters |
| Workflows | Multi-step processes with dependency chains |
| Durable Objects | Real-time coordination, stateful connections |
| Service Bindings | Worker-to-worker communication |
| Cron Triggers | Usage resets, cleanup, monitoring, recovery |

### Decision Defaults

When uncertain:
1. Default to standalone Workers.
2. Ask only when choosing Pages vs. Workers would materially change the repo shape.
3. Explain any Pages exception with concrete evidence from the repo or spec.

## Output

Produce the following:

- The deployment model (Workers by default, or Pages Functions by explicit exception) with justification.
- Any Pages exception with the specific evidence that required it.
- Workflow candidates identified by their dependency chains, with the chain spelled out.
- Infrastructure service assignments per feature.
- Model capability assignment per feature with rationale.
- Confirmation that the consistency principle holds — no split between Pages and Workers.
