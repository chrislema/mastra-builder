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
For a brand-new Worker project, the first root engineer scaffold task owns `package.json`,
`.gitignore`, `wrangler.jsonc`, and the Worker entrypoint together so Wrangler dry-run
validation can run from the first build slice. D1 migrations belong in later engineer tasks.
New Worker config must define `env.staging` and `env.production`; mirror required bindings
and vars inside both because Wrangler does not inherit them across environments.
New Worker package scripts must target those environments through config: `scripts.dev`
runs `wrangler dev --env staging`, and `scripts.deploy` runs `wrangler deploy --env production`.
When TypeScript Worker source is explicitly required, the scaffold must use Wrangler's
generated `worker-configuration.d.ts` types: `scripts.generate-types` runs `wrangler types`,
`scripts.typecheck` runs `npm run generate-types && tsc --noEmit`, and `tsconfig.json`
includes `./worker-configuration.d.ts` plus `node`.

## Open Decisions

- Only unresolved items that block a specific task from being implemented safely
- Do not include settled defaults such as standalone Workers, vanilla frontend files, Wrangler deploy --env production, local validation before production approval, or Workers AI binding shape

## Risks

- Sequencing or implementation risks worth carrying forward
