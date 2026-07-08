import type { AggregatedJudgment, DeterministicGateResult } from './judgment';
import { externalServiceAdapterPolicyLine, type SourceDocument } from './source-policy';
import type { ReviewReport, SourcePolicy, TaskPlan } from './workflow-schemas';

export type PlannerRepoScaffoldState = {
  packageJson: 'present' | 'missing';
  tsconfigJson: 'present' | 'missing';
};

function sourceDocumentsBlock(sourceDocuments: SourceDocument[]) {
  return sourceDocuments.map((document) => `--- ${document.path}\n${document.content}`).join('\n\n');
}

function initialSpecContextLine(hasSpecPath: boolean) {
  return hasSpecPath
    ? ''
    : '\n- No separate spec document was provided. Treat the vision document as authoritative, infer safe implementation details from the project policy, and ask only for decisions that genuinely block implementation.';
}

export function initialPlannerPrompt({
  sourceDocuments,
  sourcePolicy,
  repoScaffoldState,
  compatibilityDate,
  hasSpecPath,
  humanAnswers,
}: {
  sourceDocuments: SourceDocument[];
  sourcePolicy: SourcePolicy;
  repoScaffoldState: PlannerRepoScaffoldState;
  compatibilityDate: string;
  hasSpecPath: boolean;
  humanAnswers: string;
}) {
  return `Use the source documents below. Do not call tools to read them. Produce:
1. A readout artifact.
2. A dependency-aware task-plan artifact.

Do not write code. Ask only blocking questions. Record safe assumptions in the readout.
Task owners must be engineer or designer. Verification, release gating, and deployment happen in later workflow stages, not task rows.
Project policy:
- This harness is for Chris's standalone Cloudflare Worker projects. Do not plan desktop apps, mobile apps, generic Node servers, React/Vite apps, or Cloudflare Pages unless vision.md/spec.md declaratively require Cloudflare Pages or Pages Functions.
- Default new projects to a vanilla JavaScript Worker with vanilla HTML/CSS/JS under public/ when a UI is needed. Use TypeScript only when the existing repo, source docs, or selected Cloudflare bindings require TypeScript.
- Prefer wrangler.jsonc for new Worker config unless the repo already has wrangler.toml or the source docs explicitly require TOML.
- New Worker config must define env.staging and env.production. Mirror required bindings and vars inside both environments because Wrangler does not inherit them across environments.
- Use wrangler CLI for deploy and local runtime validation; never use GitHub Actions as the deployment path.
- If vanilla UI files are planned under public/, configure Workers Static Assets in Wrangler with assets.directory "./public" and binding "ASSETS"; do not use Pages or a frontend build to serve them.
- Git/gh may support source-control steps, but production deployment is a separate Wrangler action after human approval: wrangler deploy --env production.
- New Worker config must use compatibility_date "${compatibilityDate}" unless the source docs explicitly require a different recent date.
Every task must have checkable acceptance criteria and owned_surfaces.
Factory-owned scaffold context:
- Target package.json is ${repoScaffoldState.packageJson}; target tsconfig.json is ${repoScaffoldState.tsconfigJson}.
- When the target project is new, a deterministic delivery-scaffold workflow will create package.json, .gitignore, wrangler.jsonc, tsconfig.json when needed, vitest.config.ts, the Worker entrypoint, public shell files, contract shell files, and canonical test runtime routing before implementation agents run.
- Do not create tasks whose only purpose is root scaffold ownership for package.json, .gitignore, wrangler.jsonc, tsconfig.json, vitest.config.ts, .dev.vars.example, or the initial public shell. Plan product-specific changes inside those surfaces only when the vision/spec requires implementation work there.
Worker task slicing:
- Keep D1 schema/migration work separate from Worker routes and repositories: migrations/*.sql belongs in a dedicated storage task when D1 is required.
- Include an engineer-owned README.md operator documentation task near the end. It must document local Wrangler validation, required Cloudflare resources/bindings/secrets, local git checkpoints, explicit human direction before gh push/PR actions, and human-approved wrangler deploy --env production.
- When a deliverable is split into generated slices such as T05, T05-part-2, and T05-part-3, downstream tasks outside that slice family must depend on the final slice ID, not the first or middle slice.
Owned-surface hygiene:
- Every owned_surfaces entry must be a concrete repo path, for example wrangler.jsonc, wrangler.toml, src/index.js, workers/tally.js, public/settings.html, migrations/0001_schema.sql.
- Do not use wildcards such as src/**/*.ts, src/storage/*.ts, public/**, or src/**. Enumerate each expected file path.
- Do not use conceptual labels such as "Worker Env types", "wrangler configuration", "Workflow binding registration", "API routes", or "UI assets".
- If the exact file is genuinely unknowable, use "unknown: <why>" instead of a label.
Role-boundary hygiene:
- Engineer tasks own Worker source/test/migration files such as src/**, workers/**, test/**, and migrations/**, plus product-specific config edits when the source docs require them.
- Designer tasks own static UI files such as public/index.html, public/styles.css, public/app.js, and assets/**.
- Do not put public/** files in engineer-owned tasks; create or reuse a designer task for vanilla HTML/CSS/JS UI work.
- Do not plan functions/** owned surfaces unless vision.md/spec.md declaratively require Cloudflare Pages or Pages Functions.
Open-decision hygiene:
- taskPlan.open_decisions is only for genuine blockers that prevent a task from being implemented safely.
- Do not stop for preferences the harness already settles: Worker over Pages unless source docs declaratively require Pages, vanilla UI over frameworks, Wrangler over GitHub Actions deploy, local validation before production, or Workers AI binding shape.
- If an unknown can be resolved by a safe default, put it in readout.safe_assumptions, not taskPlan.open_decisions.
- If an unknown is a non-blocking delivery concern, put it in taskPlan.risks.
${externalServiceAdapterPolicyLine(sourcePolicy)}
${initialSpecContextLine(hasSpecPath)}
- Every open_decisions entry must be one string with this exact field shape:
  "Topic: ... | Why it matters: ... | Options considered: ... | Follow-up impact: ..."
- The "Why it matters" or "Follow-up impact" field must name what task or implementation work is blocked.
Return only JSON matching this top-level shape: { "readout": {...}, "taskPlan": {...} }.${humanAnswers}

Source documents:
${sourceDocumentsBlock(sourceDocuments)}`;
}

export function planGateRevisionPrompt({
  taskPlan,
  deterministicResults,
  judgment,
  remediation,
  sourcePolicy,
  compatibilityDate,
}: {
  taskPlan: TaskPlan;
  deterministicResults: DeterministicGateResult[];
  judgment: AggregatedJudgment;
  remediation: string[];
  sourcePolicy: SourcePolicy;
  compatibilityDate: string;
}) {
  return `The task-plan gate failed before architect review. Revise the task plan to address the gate findings.

Return a full replacement taskPlan object. Do not write implementation code. Do not ask new human questions unless no executable Worker scaffold can be planned.

Project policy:
- This harness is for Chris's standalone Cloudflare Worker projects, not desktop apps, mobile apps, generic Node servers, React/Vite apps, or Cloudflare Pages unless vision.md/spec.md declaratively require Cloudflare Pages or Pages Functions.
- Default new projects to a vanilla JavaScript Worker with vanilla HTML/CSS/JS under public/ when a UI is needed. Use TypeScript only when the existing repo, source docs, or selected Cloudflare bindings require it.
- Use wrangler.jsonc for new Worker config unless the repo already has wrangler.toml or the source docs explicitly require TOML.
- New Worker config must define env.staging and env.production. Mirror required bindings and vars inside both environments because Wrangler does not inherit them across environments.
- Use Wrangler CLI for local validation and deployment; never make GitHub Actions the deployment path.
- If AI is used in the target Worker, plan an active Workers AI binding and an internal adapter around it.
- If vanilla UI files are planned under public/, configure Workers Static Assets in Wrangler with assets.directory "./public" and binding "ASSETS"; do not use Pages or a frontend build to serve them.
- New Worker config must use compatibility_date "${compatibilityDate}" unless the source docs explicitly require a different recent date.

Task-plan quality requirements:
- A deterministic delivery-scaffold workflow owns root Worker scaffold files before implementation agents run. Do not add planner rows solely to own package.json, .gitignore, wrangler.jsonc, tsconfig.json, vitest.config.ts, .dev.vars.example, or initial public shell files.
- Keep D1 schema/migration work separate from Worker routes and repositories: migrations/*.sql belongs in a dedicated storage task when D1 is required.
- Include an engineer-owned README.md operator documentation task near the end for local Wrangler validation, Cloudflare resources/bindings/secrets, local git checkpoints, explicit human direction before gh push/PR actions, and human-approved wrangler deploy --env production.
- When a deliverable is split into generated slices such as T05, T05-part-2, and T05-part-3, downstream tasks outside that slice family must depend on the final slice ID, not the first or middle slice.
- Preserve concrete deliverables, checkable acceptance criteria, owned surfaces, and task owner boundaries.
- Do not delete prior acceptance criteria during a repair. If you split or narrow a task, copy each prior criterion verbatim into source_acceptance_criteria on the slice or revised task that carries the original contract.
- Every consumes-output relation must be declared by task ID. If a later task uses storage, prompts, routes, services, generated types, bindings, or workflow steps from an earlier slice, add the dependency edge explicitly.
- Every taskPlan.tasks[].owned_surfaces entry must be a concrete repo path, not a conceptual label or wildcard. Use "unknown: <why>" only when the file truly cannot be known.
- Do not plan functions/** owned surfaces unless vision.md/spec.md declaratively require Cloudflare Pages or Pages Functions.
- Keep taskPlan.open_decisions limited to genuine blockers only. Non-blocking unknowns belong in risks.
${externalServiceAdapterPolicyLine(sourcePolicy)}
- Every taskPlan.open_decisions entry must use this exact field shape:
"Topic: ... | Why it matters: ... | Options considered: ... | Follow-up impact: ..."
- The "Why it matters" or "Follow-up impact" field must name what task or implementation work is blocked.

Gate remediation:
${remediation.map((item) => `- ${item}`).join('\n') || '- No textual remediation was provided; satisfy all failed gates and weak dimensions.'}

Deterministic gate results:
${JSON.stringify(deterministicResults, null, 2)}

Task-plan rubric judgment:
${JSON.stringify(judgment, null, 2)}

Current task plan:
${JSON.stringify(taskPlan, null, 2)}`;
}

export function architectBouncePlannerRevisionPrompt({
  taskPlan,
  reviewReport,
  revisionRemediation,
}: {
  taskPlan: TaskPlan;
  reviewReport: ReviewReport;
  revisionRemediation: string[];
}) {
  return `The architect blocked the task plan. Revise the task plan to address the review findings.

Return a full replacement taskPlan object. Preserve concrete deliverables, checkable acceptance criteria, dependencies, and owned surfaces.
Do not delete prior acceptance criteria during a revision. If you split or narrow a task, copy each prior criterion verbatim into source_acceptance_criteria on the slice or revised task that carries the original contract.
Do not write implementation code.
Every taskPlan.tasks[].owned_surfaces entry must be a concrete repo path, not a conceptual label or wildcard. Use "unknown: <why>" only when the file truly cannot be known.
Keep taskPlan.open_decisions limited to genuine blockers only. Non-blocking unknowns belong in risks. Safe defaults belong in the readout on the next full planning pass, so do not add them to taskPlan.open_decisions here.
Every taskPlan.open_decisions entry must use this exact field shape:
"Topic: ... | Why it matters: ... | Options considered: ... | Follow-up impact: ..."
The "Why it matters" or "Follow-up impact" field must name what task or implementation work is blocked.

Current task plan:
${JSON.stringify(taskPlan, null, 2)}

Architect review:
${JSON.stringify(reviewReport, null, 2)}

Rubric remediation from the review judge:
${revisionRemediation.map((item) => `- ${item}`).join('\n')}`;
}
