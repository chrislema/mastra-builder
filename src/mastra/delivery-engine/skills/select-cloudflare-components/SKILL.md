---
name: select-cloudflare-components
description: Selects the correct Cloudflare deployment model, infrastructure services, and model capabilities for a feature set based on dependency chains, iteration needs, and consistency principles. Use when deciding between Pages Functions and standalone Workers, evaluating whether a feature needs Workflows or Durable Objects, choosing model-routing needs, or reviewing architecture for deployment consistency.
---

Primary roles: planner, architect

## Purpose

Evaluates a feature set against Cloudflare's infrastructure options and selects the deployment model (Pages-only or Workers), identifies Workflow candidates, assigns infrastructure services, and chooses model capabilities per feature. Enforces the consistency principle: never split features between Pages Functions and Workers.

## Procedure

1. List all features in the system or project under review. For each feature, note: whether it needs independent iteration, whether it has multi-step dependency chains, whether it needs real-time coordination or stateful connections.
2. Determine the deployment model:
   - If any feature requires Workflows or Durable Objects, the deployment model is Workers (all features move to Workers).
   - If no feature needs Workflows or Durable Objects and features deploy as a cohesive unit, the deployment model is Pages Functions.
   - Verify the consistency principle: no features split between Pages Functions and Workers.
3. For each feature with multi-step processing, evaluate whether it needs Workflows. Apply the dependency chain test: if one operation's output feeds into another's input (A then B then C), use Workflows. If operations are independent (even if long-running), do not use Workflows.
4. Assign infrastructure services to each feature using the service selection table. Map data storage, compute, caching, and communication needs.
5. For each feature that uses an LLM, select the model capability class:
   - Use the default configured Mastra model for rule application, calculations, structured transformations, format conversion, framework/rubric application, and structured data extraction.
   - Request an explicitly configured stronger writing/reasoning model only when the feature depends on nuance, subtle pattern recognition, quality evaluation, human voice, creative judgment, or voice fidelity.
6. Verify the complete architecture for consistency: all features use the same deployment model, service bindings connect Workers correctly, and no feature is an exception to the thin proxy pattern.

## Reference

### Pages Functions vs. Standalone Workers

The decision is about deployment overhead, not code complexity.

**Keep everything in Pages Functions when:**
- Features don't need independent iteration.
- No feature requires Workflows or Durable Objects.
- The app is cohesive and deploys as a unit.
- No need to monitor individual features separately.

**Extract to standalone Workers when:**
- The feature uses Workflows (Workflows need Workers to run).
- The feature needs Durable Objects (real-time coordination, stateful connections).
- You plan to iterate on this feature repeatedly or expect to change the approach.

### The Consistency Principle

Never split features between Pages Functions and Workers. If some features are in Workers, all features go in Workers. If features are in Functions, all stay in Functions. This applies to everything: forms, logging, security. The thin proxy pattern should do the same thing everywhere — no exceptions where "this one does a little more."

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
| Workers | Stateless compute, auth, business logic, data processing |
| Pages | Static hosting, serverless functions, API proxies, UI |
| D1 | Multi-tenant data, work queues, usage tracking, sessions |
| R2 | PDFs, generated media, artifacts, user uploads |
| KV | Metadata caching, rate limit counters |
| Workflows | Multi-step processes with dependency chains |
| Durable Objects | Real-time coordination, stateful connections |
| Service Bindings | Worker-to-worker communication |
| Cron Triggers | Usage resets, cleanup, monitoring, recovery |

### Decision Defaults

When uncertain:
1. Ask clarifying questions — don't guess at intent.
2. Explain the tradeoffs — present options with reasoning.
3. Default to simplicity — the simpler option is usually right.

## Output

Produce the following:

- The deployment model (Pages-only or Workers) with justification.
- Any standalone Worker extractions with the specific reason for each (Workflows, Durable Objects, or independent iteration).
- Workflow candidates identified by their dependency chains, with the chain spelled out.
- Infrastructure service assignments per feature.
- Model capability assignment per feature with rationale.
- Confirmation that the consistency principle holds — no split between Pages and Workers.
