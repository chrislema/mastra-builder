# Spec - Tally v1

A standalone Cloudflare Worker with D1 for storage and no frontend build step. Keep
the app small enough to read in one sitting.

## Runtime

- Cloudflare Worker module syntax is the runtime surface.
- D1 is the source of truth. No Node HTTP server, no filesystem-backed runtime state,
  no Express-style server, and no npm runtime dependencies.
- Use the configured D1 binding `DB`.
- Static vanilla UI is optional and may live under `public/`, but the API and redirect
  behavior belong in the Worker.

## Routes

### `POST /api/links`
- Handled by the Worker fetch router.
- Body: JSON `{ "url": "<destination>" }`.
- Validates the destination: must parse as a URL with protocol `http:` or `https:`.
- On success: `201` with `{ "id": "<short id>", "url": "<destination>", "clicks": 0 }`.
  Short id: 6 chars, URL-safe.
- On invalid body or URL: `400` with `{ "error": "<what is wrong>", "next_steps": "<how to fix the request>" }`.

### `GET /l/:id`
- Known id: `302` redirect to the destination, click count incremented by exactly 1.
- Unknown id: `404` with `{ "error": "unknown link id", "next_steps": "create one via POST /api/links" }`.

### `GET /api/links/:id`
- Known id: `200` with `{ "id", "url", "clicks" }`.
- Unknown id: `404`, same shape as above.

### `GET /api/health`
- `200` with `{ "ok": true }`.

## Storage

- Migration `migrations/0001_links.sql` creates a `links` table.
- Columns: `id TEXT PRIMARY KEY`, `url TEXT NOT NULL`, `clicks INTEGER NOT NULL DEFAULT 0`,
  `created_at TEXT NOT NULL`.
- Click increments are atomic D1 updates. No in-memory-only state is authoritative.
- Missing rows return the explicit unknown-link error shape.

## Files

- `workers/tally.js` is the Worker entry and fetch router.
- `src/utils/links.js` contains D1 link operations.
- `src/utils/id.js` contains id generation.
- `migrations/0001_links.sql` contains the D1 schema.
- `wrangler.jsonc` declares the Worker and D1 binding. Use an existing
  `wrangler.toml` only if the repository already has one.

## Error behavior

- Every error response is JSON with `error` and `next_steps` fields. No stack traces,
  no HTML error pages, no silent fallbacks.
- Malformed JSON body returns `400`, not a crash.

## Constraints

- Keep the Worker route layer thin: parse request, call helpers or D1, log enough context,
  and return actionable responses.
- No Pages Functions unless vision.md or spec.md declaratively requires Cloudflare Pages or Pages Functions.
- No React, JSX/TSX, frontend frameworks, preprocessors, Node HTTP server, Express,
  filesystem-backed runtime state, or new frontend build step.
