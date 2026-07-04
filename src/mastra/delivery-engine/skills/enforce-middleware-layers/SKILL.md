---
name: enforce-middleware-layers
description: Evaluates and enforces layered request-boundary architecture for Cloudflare Worker API routes. Use when building Worker request guards, enforcing plans or feature access, or attaching request context to downstream handlers.
---

Primary roles: engineer

## Purpose

Inspects Worker request-boundary layers for correct separation of concerns — authentication, authorization, and usage enforcement — and ensures business handlers remain thin by verifying that entitlement checks, denial responses, and context propagation happen at the right layer.

## Procedure

1. **Identify the Worker request pipeline.** Locate the Worker entry, router, auth guard, API guard, and handler/helper boundaries. Confirm layering exists (entry handles request context, auth guard handles identity, API guard handles authorization and usage).

2. **Verify request-context/auth guard responsibilities.** Check that it:
   - Looks for session cookie or Authorization header
   - Verifies the session with the auth system
   - Attaches user, company, and plan data to request context
   - Redirects unauthenticated users to login
   - Allows public paths (landing, login, signup, static assets) to pass through

3. **Verify API guard responsibilities.** Check that it:
   - Confirms user exists from the auth guard (does not re-authenticate)
   - Checks subscription status (active, past_due, canceled)
   - Calculates current usage from the database
   - Enforces plan limits (prevents requests when limit exceeded)
   - Checks feature access based on plan
   - Attaches usage stats and limits to context

4. **Inspect the context shape.** Confirm the request-scoped context object is populated with the expected structure and that downstream handlers consume it without making additional auth or entitlement checks.

5. **Evaluate denial behavior.** For each denial scenario, verify the response is fast-failing with actionable content:
   - Inactive subscription: 403 with status and renewal URL
   - Usage limit exceeded: 429 with current usage, limit, reset date, and upgrade URL
   - Feature not on plan: 403 with plan name and upgrade path

6. **Check for duplication and leakage.** Flag any business logic that has leaked into guards, and any entitlement or auth checks duplicated between guards and handlers.

7. **Produce findings.** Document layer assignments, context shape correctness, denial behavior gaps, and any duplication or leakage issues.

## Reference

### Layered Architecture

Worker request handling should be layered with clear responsibilities at each level:

**Worker entry/router** (`workers/*.js`):
- Parse URL and method
- Create a request-scoped context object
- Route to guarded API handlers
- Keep domain decisions out of the router

**Auth guard** (`src/middleware/auth.js` or equivalent helper):
- Check for session cookie or Authorization header
- Verify session with auth system
- Attach user/company/plan data to request-scoped context
- Redirect unauthenticated users to login
- Allow public paths (landing, login, signup, static assets)

**API guard** (`src/middleware/api.js` or equivalent helper):
- Verify authentication (user must exist from auth guard)
- Check subscription status (active, past_due, canceled)
- Calculate current usage from database
- Enforce plan limits (prevent requests if limit exceeded)
- Check feature access based on plan
- Attach usage stats and limits to context

**Why layered:**
- Separation of concerns: auth vs authorization vs usage
- Performance: only check usage for API calls, not page views
- Each layer has single responsibility
- Can add/remove guard layers without affecting others

### Context Shape

Worker guard helpers populate request-scoped context for downstream handlers:

```
requestContext = {
  user: { id, email, role, ... },
  company: { id, name, subscriptionStatus, ... },
  plan: { name, maxUsers, features, ... },
  usage: { current, limit, remaining },
  sessionToken: "..."
}
```

This data flows to all downstream handlers without additional auth checks.

### Denial Patterns

Fail fast with actionable responses:
- Inactive subscription: 403 with status and renewal URL
- Usage limit exceeded: 429 with current usage, limit, reset date, and upgrade URL
- Feature not available on plan: 403 with plan name and upgrade path

### Anti-Patterns

- **Auth checks in handlers**: If a handler re-verifies the session or re-checks plan status, the guard layer is incomplete or untrusted.
- **Business logic in guards**: Guards should not make domain decisions (e.g., choosing quality tiers, formatting responses). They enforce access; handlers do the work.
- **Incomplete context**: If handlers need to query the database for user, company, or plan data that guards should have attached, the context shape is missing fields.
- **Silent denials**: Returning bare 403/429 without actionable information (renewal URL, upgrade path, usage stats) degrades user experience.

## Output

Produce a review report containing:

1. **Layer map**: Which Worker entry, guard, and handler files exist and what each one is responsible for.
2. **Context shape audit**: The actual request context structure vs. the expected shape, with any missing fields called out.
3. **Denial behavior checklist**: For each denial scenario (inactive subscription, usage exceeded, feature unavailable), whether the response includes the required actionable content.
4. **Duplication findings**: Any auth or entitlement checks found in handlers that belong in middleware.
5. **Leakage findings**: Any business logic found in middleware that belongs in handlers.
