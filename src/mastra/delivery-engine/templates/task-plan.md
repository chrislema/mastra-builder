# Task Plan

## Scope

- What this plan covers

## Tasks

### TASK-ID
- Owner:
- Deliverable:
- Depends on:
- Acceptance criteria:
- Owned files or surfaces:

Use concrete Worker project paths only. New Worker projects should prefer `wrangler.jsonc`
unless an existing repo or source document already uses `wrangler.toml`. UI work belongs in
vanilla `public/*.html`, `public/*.css`, and `public/*.js` files, not React or framework files.
When TypeScript Worker source is explicitly required, the scaffold must use Wrangler's
generated `worker-configuration.d.ts` types: `scripts.generate-types` runs `wrangler types`,
`scripts.typecheck` runs `npm run generate-types && tsc --noEmit`, and `tsconfig.json`
includes `./worker-configuration.d.ts` plus `node`.

## Open Decisions

- Only unresolved items that block a specific task from being implemented safely
- Do not include settled defaults such as standalone Workers, vanilla frontend files, Wrangler deploy, local validation before production approval, or Workers AI binding shape

## Risks

- Sequencing or implementation risks worth carrying forward
