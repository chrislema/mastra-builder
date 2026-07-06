# Worker Harness Curation Triage

Baseline: `46b461c` (`Split implementation tasks into smaller slices`, 2026-07-06 07:35 Central).

Scope: static curation of the 81 commits after the baseline through `f26afbe`, without running a paid delivery sample for each commit.

Current curation branch: `worker-harness-curation`.

## Decision Rules

- Keep Worker-first constraints that match Chris's normal stack: standalone Cloudflare Workers, vanilla HTML/CSS/JS, optional TypeScript, Wrangler CLI, Workers AI, D1, KV, R2, service bindings, custom domains.
- Source-gate product-domain assumptions. A Talking Head Builder rule is allowed only when `vision.md` or `spec.md` declares that contract.
- Source-gate occasional Pages support. Pages Functions are allowed only when source docs declare Cloudflare Pages or Pages Functions.
- Prefer cheap deterministic validation: `npm run typecheck`, `npm test`, focused `workflow-policy` tests, rubric tests, and static grep/blame review.
- Defer paid Mastra delivery runs until the cheap pass has no known curation fixes left.

## Applied Curation Fixes

| Commit | Decision | Reason | Validation |
| --- | --- | --- | --- |
| `fc13d06` Source-gate Talking Head release policies | Keep revised | Kept useful profile/transcript release-gate machinery, but gated `audience_segments`, `voice_profile`, `/latest`, `/runs`, and `/profiles` probes on source docs. | `npm run typecheck`; `npm test` |
| `c4d57bb` Source-gate bookmark adapter policy | Keep revised | Kept safe service-adapter behavior, but gated BOOKMARKS planner guidance on source docs and generalized rubric language. | `npm run typecheck`; `npm test` |

## Static Triage By Commit

| Commit | Category | Decision | Cheap Validation | Notes |
| --- | --- | --- | --- | --- |
| `5fac246` Make delivery planning Workers-first | Worker policy | Keep | planner/workflow policy tests | Directly matches narrowed harness. |
| `6e289fc` Synthesize local deployment reports | Delivery reporting | Keep | workflow policy tests | Required for local Wrangler gate before production approval. |
| `773c5de` Suspend only for true planning blockers | Autonomy | Keep | workflow policy tests | Matches "run through unless source docs truly block." |
| `d5fc970` Guard build stages against read stalls | Cost/control | Keep | workspace policy tests | Prevents expensive read loops. |
| `c21dddd` Repair task plans at plan gate | Autonomy | Keep | workflow policy tests | Repairs bad plans before spending build loops. |
| `35cb4d9` Tune implementation judgment recovery | Recovery | Keep | workflow policy tests | Keeps retry behavior bounded. |
| `554a233` Abort build attempts after read-budget loops | Cost/control | Keep | workflow policy tests | Explicitly addresses token burn. |
| `3513ef4` Enforce Worker config hygiene | Worker policy | Keep | workflow policy tests | Core Cloudflare Worker expertise. |
| `5b73c12` Enforce Worker scaffold tooling | Worker policy | Keep | workflow policy tests | Good guard against non-Wrangler scaffolds. |
| `cd75e4c` Allow engineer operator docs | Ownership | Keep | checks tests | Correct role boundary for README/operator docs. |
| `777bd10` Normalize Worker delivery planning | Worker policy | Keep | workflow policy tests | Strengthens root scaffold and Worker planning. |
| `50ab9af` Guide judges on safe adapter risks | Scoring/rubric | Keep revised | rubric tests | Generalized bookmark-specific wording in `c4d57bb`. |
| `2d8d96d` Normalize generated slice dependencies | Planning hygiene | Keep | workflow policy tests | Prevents downstream tasks from starting too early. |
| `2809499` Guard Talking Head profile kinds | Product contract | Keep revised | workflow policy tests | Source-gated in `fc13d06`. |
| `fa93327` Normalize safe adapter readout questions | Product/service contract | Keep revised | workflow policy tests | BOOKMARKS guidance source-gated in `c4d57bb`. |
| `93a6f1f` Pass exact Worker config policy to builds | Worker policy | Keep | workflow policy tests | Gives builders deterministic Cloudflare config requirements. |
| `c6e7125` Enforce profile kind contract at source | Product contract | Keep revised | workflow policy tests | Source-required profile kinds only after `fc13d06`. |
| `4aee69a` Scope build task policy packets | Cost/control | Keep | workflow policy tests | Reduces broad rereads and noisy context. |
| `9aa927c` Align Worker bindings deterministically | Worker policy | Keep | workflow policy tests | Critical for AI/D1/KV/R2/service binding correctness. |
| `e585c49` Recognize contracts profile source | Product contract | Keep revised | workflow policy tests | Useful once source-gated. |
| `0bbc571` Surface typecheck diagnostics in repair packets | Recovery | Keep | workflow policy tests | Makes repairs surgical. |
| `4f0c639` Auto repair unknown number narrowing | Recovery | Keep | workflow policy tests | Cheap deterministic TypeScript repair. |
| `9cef18b` Require JSONC D1 migration validation | Worker/D1 policy | Keep | workflow policy tests | Supports Wrangler/D1 validation. |
| `4f7a85f` Fail release gate on required evidence failures | Release gate | Keep | workflow policy tests | Prevents false pass after failed local checks. |
| `b5ccfec` Block local report after validation failures | Release gate | Keep | workflow policy tests | Keeps local deploy report honest. |
| `d9c6446` Authenticate local release probes | Release gate | Keep | workflow policy tests | Useful for admin routes when source-gated. |
| `620d759` Validate latest transcript release schema | Product contract | Keep revised | workflow policy tests | Talking Head-specific schema now source-gated in `fc13d06`. |
| `2df3d88` Prefer local Wrangler for release gates | Worker/Wrangler policy | Keep | workflow policy tests | Uses target project's installed Wrangler when available. |
| `ef286df` Require Worker scaffold gitignore hygiene | Worker hygiene | Keep | workflow policy tests | Protects local state/secrets/artifacts. |
| `3dbd546` Default delivery models to OpenAI | Model config | Keep | models/runner tests | Matches current choice to use OpenAI for builders/judges. |
| `cb48f33` Load env file for Mastra scripts | Operator ergonomics | Keep | runner tests | Lets `.env` drive local Mastra scripts. |
| `e19e00c` Refresh delivery operator docs | Docs | Keep | doc review | Aligns operator instructions. |
| `b5dd319` Use local production deploy modes | Deployment flow | Keep | runner/workflow tests | Keeps local and production modes explicit. |
| `76fe8bc` Promote delivery run report summary | Reporting | Keep | runner tests | Improves failure visibility. |
| `1a8dfbf` Reject frontend frameworks in Worker scaffolds | Worker policy | Keep | workflow policy tests | Matches no React/frameworks. |
| `a20132f` Require Worker tsconfig scaffold hygiene | TypeScript Worker policy | Keep | workflow policy tests | Applies when TypeScript is used. |
| `8f31bb5` Align scaffold prompts with Worker policy | Worker policy | Keep | workflow policy tests | Prompt alignment only. |
| `e6f3e89` Run full package verification in release gate | Release gate | Keep | workflow policy tests | Required for local quality gate. |
| `87c9679` Record dependency install as release evidence | Release evidence | Keep | workflow policy tests | Useful audit trail for install/build steps. |
| `8b8a8ac` Fail release gate without Worker config | Worker policy | Keep | workflow policy tests | A Worker project needs Wrangler config before release. |
| `4b62e37` Validate Worker config entrypoint | Worker policy | Keep | workflow policy tests | Prevents deploys with missing entrypoints. |
| `30f5b90` Require Worker service name in config hygiene | Worker policy | Keep | workflow policy tests | Needed for deployable Worker config. |
| `f2deab1` Skip dynamic probes after static release failures | Cost/control | Keep | workflow policy tests | Saves runtime work when static evidence already fails. |
| `77da5d4` Deploy production through native Wrangler path | Deployment flow | Keep | workflow policy tests | Matches "wrangler CLI deploy, not GitHub Actions." |
| `bbe1f19` Clarify deployment agent advisory role | Mastra-native workflow | Keep | scorer/rubric tests | Native workflow executes deploy; agent audits/advises. |
| `f1cf51e` Dry-run Wrangler deploy before production approval | Worker/Wrangler policy | Keep | workflow policy tests | High-value local validation before human approval. |
| `fbda956` Align deployment docs with native workflow | Docs | Keep | doc review | Documentation follows native Wrangler flow. |
| `62a8e13` Support JavaScript Worker scaffolds | Worker policy | Keep | workflow policy tests | Essential because default target is vanilla JS. |
| `e9ec3d4` Detect Workers AI in JavaScript Workers | Workers AI policy | Keep | workflow policy tests | Applies to JS Worker apps using Workers AI. |
| `ceef03f` Probe routes in JavaScript Worker sources | Release gate | Keep | workflow policy tests | Enables JS route detection without TS assumptions. |
| `fbd750f` Create runnable Worker preflight stubs | Recovery | Keep | workflow policy tests | Helps stalled/missing-surface repair. |
| `6b65546` Expand task boundaries for JavaScript modules | Worker policy | Keep | workflow policy tests | Makes JS app surfaces first-class. |
| `f88fab5` Guard JavaScript route integration | Worker policy | Keep | workflow policy tests | Prevents bypassing router/middleware integration. |
| `93c7799` Support JavaScript workflow integration checks | Worker/Workflow policy | Keep | workflow policy tests | JS support for Cloudflare Workflows. |
| `3a69e44` Restrict planner pauses to source blockers | Autonomy | Keep | workflow policy tests | Matches "do not pause unless major/source blocker." |
| `f1c7ccd` Align Worker config evidence with release gate tiers | Release gate | Keep | workflow policy tests | Keeps evidence classification coherent. |
| `499918c` Add TypeScript checking to delivery CI | Harness CI | Keep | `npm run typecheck`; `npm test` | Catches harness regressions cheaply. |
| `d761d4e` Typecheck delivery runner scripts | Harness CI | Keep | `npm run typecheck` | Prevents CLI breakage. |
| `c12e7c9` Typecheck delivery tests | Harness CI | Keep | `npm run typecheck`; `npm test` | Keeps tests honest. |
| `57de985` Use Wrangler directly for release validation | Worker/Wrangler policy | Keep | workflow policy tests | Avoids abstract scripts hiding deploy behavior. |
| `4f90422` Align production deploy approval language | HITL/deploy | Keep | workflow policy tests | Human gate only before production deploy. |
| `7a272b1` Require Workers Static Assets for public UI | Worker/static assets policy | Keep | workflow policy tests | Correct for vanilla UI on Workers. |
| `b436796` Probe Worker static assets in release gate | Release gate | Keep | workflow policy tests | Verifies public assets actually serve locally. |
| `a8990c3` Require explicit approval for remote GitHub actions | Git policy | Keep | workflow policy tests | Matches "commit locally, do not push/deploy remotely by default." |
| `0bf9d6c` Use Wrangler-generated Worker types | TypeScript Worker policy | Keep | workflow policy tests | Current Cloudflare best practice for TS Workers. |
| `cac7a78` Check generated Worker types in release gate | Release gate | Keep | workflow policy tests | Ensures config/binding types are current. |
| `4f2c244` Document Wrangler-generated Worker type flow | Docs | Keep | doc review | Docs match TS Worker path. |
| `b63bf33` Prefer JSONC config for new Worker scaffolds | Worker config policy | Keep | workflow policy tests | Good default; TOML only when existing/source-required. |
| `5a521f6` Profile Worker startup in release gate | Release gate | Keep | workflow policy tests | Valuable Wrangler startup evidence. |
| `624a288` Require explicit Worker deployment environments | Worker/Wrangler policy | Keep | workflow policy tests | Staging/production envs are important for real Worker deploys. |
| `254834c` Align Worker scripts with deployment environments | Worker/Wrangler policy | Keep | workflow policy tests | Scripts target staging/prod correctly. |
| `a57da6a` Gate Worker package hygiene before release | Worker hygiene | Keep | workflow policy tests | Prevents broken package scaffolds. |
| `642dbef` Validate D1 migrations against staging environment | D1/Wrangler policy | Keep | workflow policy tests | Good environment-specific D1 validation. |
| `1256625` Document explicit Worker environment commands | Docs/schema | Keep | workflow policy tests | Makes env-specific commands inspectable. |
| `abe4c67` Align Worker local secrets with staging probes | Worker/Wrangler policy | Keep | workflow policy tests | Correct `.dev.vars.staging` local secret behavior. |
| `b03f537` Verify JS Worker builds with Wrangler dry runs | Release gate | Keep | workflow policy tests | Critical for vanilla JS Workers. |
| `29ac68d` Require Worker config in root scaffold | Worker policy | Keep | workflow policy tests | Moves Wrangler validation earlier. |
| `1e5e936` Clarify local validation next step | Reporting | Keep | workflow policy tests | Better user-facing next action. |
| `0a58517` Align planner scaffold instructions with Worker config | Worker policy | Keep | workflow policy tests | Prompt/schema alignment. |
| `692d300` Always target Wrangler delivery environments | Worker/Wrangler policy | Keep | workflow policy tests | Ensures `--env staging` and `--env production` are used. |
| `f26afbe` Gate Pages Functions on source docs | Pages exception policy | Keep | workflow policy tests | Exactly matches occasional Pages exception. |

## Current Residual Risk

- Static tests prove the policy graph, deterministic gates, and release command planning. They do not prove a full multi-agent delivery trajectory.
- The only paid run that may be worthwhile later is one fresh Worker sample after this curation pass is complete.
- If that run is approved later, it should use a fresh empty temp target with `vision.md` and `spec.md`, then be watched for first blocker only.

## Current Recommendation

Do not run a paid sample yet. Continue static scans for over-generalized policy language, then run `npm run ci:delivery` and `npm run build` once the curation branch has no suspect global product rules.
