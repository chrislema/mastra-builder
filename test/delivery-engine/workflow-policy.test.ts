import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createMissingOwnedSurfaceStubs,
  deliveryBuildResumePlan,
  implementationDeterministicRemediation,
  implementationEnginePolicyMismatch,
  implementationFailureClass,
  implementationJudgmentCanComplete,
  implementationRetryMode,
  implementationWeakDimensionRemediation,
  judgeProviderErrorDetails,
  judgeUnavailableOutputForRubric,
  judgeUnavailableRemediation,
  missingOwnedSurfacePaths,
  openDecisionHygiene,
  ownedSurfaceHygiene,
  outOfPlanVerificationFailurePaths,
  priorStoppedBuildTaskIds,
  repairStaleDownstreamVerificationSurfaces,
  releaseGateForInvalidTesterOutput,
  releaseGateEvidenceCommandPlan,
  releaseGateLocalD1DatabaseName,
  releaseGateRuntimeProbePlan,
  releaseGateStaticEvidenceResults,
  releaseGateWorkerDevCommand,
  reusableImplementationArtifactForTask,
  shouldProceedAfterNonActionableImplementationJudgment,
  shouldSuspendForPlannerQuestions,
  staleDownstreamVerificationSurfacePaths,
  taskBoundarySurfaces,
  unreplacedPreflightStubPaths,
  verificationWithAcceptanceGaps,
  workflowStepIntegrationGaps,
  workersAiBindingGaps,
  wranglerConfigHasWorkersAiBinding,
} from '../../src/mastra/delivery-engine/workflow.ts';
import { aggregateJudgment, loadDeliveryEngineRubric } from '../../src/mastra/delivery-engine/judgment.ts';

const readout = (blocking_ambiguities: string[]) => ({
  artifact_type: 'readout' as const,
  product_intent: 'intent',
  technical_shape: 'shape',
  safe_assumptions: [],
  blocking_ambiguities,
  recommended_next_step: 'next',
});

const taskPlan = (tasks: Array<{ depends_on: string[]; acceptance_criteria?: string[]; owned_surfaces?: string[] }>) => ({
  artifact_type: 'task-plan' as const,
  scope: 'scope',
  tasks: tasks.map((task, index) => ({
    id: `T${index + 1}`,
    owner: 'engineer' as const,
    deliverable: 'deliverable',
    depends_on: task.depends_on,
    acceptance_criteria: task.acceptance_criteria ?? ['verified'],
    owned_surfaces: task.owned_surfaces ?? ['src/index.ts'],
  })),
  technology_decisions: [],
  open_decisions: [],
  risks: [],
});

test('planner questions are deferred when a task plan has an executable root task', () => {
  assert.equal(
    shouldSuspendForPlannerQuestions(readout(['Confirm downstream integration detail.']), taskPlan([{ depends_on: [] }])),
    false,
  );
});

test('planner questions suspend when no executable root task exists', () => {
  assert.equal(shouldSuspendForPlannerQuestions(readout(['Cannot start safely.']), taskPlan([])), true);
});

test('task plan open decisions must be decision-shaped blockers', () => {
  const blockerPlan = taskPlan([{ depends_on: [] }]);
  blockerPlan.open_decisions = [
    [
      'Topic: BOOKMARKS service binding call shape',
      'Why it matters: blocks T7 bookmark fetch implementation because the workflow cannot know whether to call fetch or RPC safely',
      'Options considered: fetch with date-window query; RPC method with explicit window arguments',
      'Follow-up impact: T7 cannot be finalized until the binding contract is confirmed',
    ].join(' | '),
  ];

  assert.deepEqual(openDecisionHygiene(blockerPlan), { passed: true, reason: 'ok' });

  const softDecisionPlan = taskPlan([{ depends_on: [] }]);
  softDecisionPlan.open_decisions = ['Whether the weekly cron should run on a specific day/time or simply every 7 days.'];
  assert.equal(openDecisionHygiene(softDecisionPlan).passed, false);
  assert.match(openDecisionHygiene(softDecisionPlan).reason, /not decision-shaped|safe assumption or risk/);

  const unblockedPlan = taskPlan([{ depends_on: [] }]);
  unblockedPlan.open_decisions = [
    [
      'Topic: Session duration',
      'Why it matters: product preference may change copy',
      'Options considered: 30 days; 7 days',
      'Follow-up impact: confirm only if product disagrees',
    ].join(' | '),
  ];
  assert.equal(openDecisionHygiene(unblockedPlan).passed, false);
  assert.match(openDecisionHygiene(unblockedPlan).reason, /safe assumption or risk|does not explain what implementation work it blocks/);
});

test('task plan owned surfaces must be concrete repo paths or explicit unknowns', () => {
  const concretePlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler.toml', 'src/index.ts', 'src/workflows/steps/fetch-bookmarks.ts', 'unknown: generated migration name depends on existing migration sequence'],
    },
  ]);
  assert.deepEqual(ownedSurfaceHygiene(concretePlan), { passed: true, reason: 'ok' });

  const conceptualPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler configuration', 'Worker Env types', 'Workflow binding registration'],
    },
  ]);
  const result = ownedSurfaceHygiene(conceptualPlan);
  assert.equal(result.passed, false);
  assert.match(result.reason, /conceptual surface/);
});

test('judge provider overloads synthesize bounded failing judge output', () => {
  const error = Object.assign(new Error('The service may be temporarily overloaded, please try again later'), {
    name: 'AI_APICallError',
    statusCode: 429,
    isRetryable: true,
    url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    data: {
      error: {
        code: '1305',
      },
    },
  });

  const details = judgeProviderErrorDetails(error);
  assert.ok(details);
  assert.equal(details.statusCode, 429);
  assert.equal(details.code, '1305');
  assert.equal(details.retryable, true);

  const rubric = loadDeliveryEngineRubric('task-plan');
  const judgeOutput = judgeUnavailableOutputForRubric({
    rubric,
    details,
    stage: 'judge:task-plan',
  });
  assert.equal(judgeOutput.gates.every((gate) => gate.passed === false), true);
  assert.equal(judgeOutput.dimensions.length, rubric.dimensions?.length ?? 0);
  assert.equal(judgeOutput.dimensions.every((dimension) => dimension.score === null), true);

  const remediation = judgeUnavailableRemediation('judge:task-plan', details);
  const judgment = aggregateJudgment({
    rubric,
    judgeOutput: {
      gates: judgeOutput.gates.map((gate) => ({ ...gate, evidence: remediation })),
      dimensions: judgeOutput.dimensions.map((dimension) => ({ ...dimension, evidence: remediation })),
    },
  });
  judgment.remediation = [remediation, ...judgment.remediation];

  assert.equal(judgment.passed, false);
  assert.match(judgment.remediation.join('\n'), /JUDGE_UNAVAILABLE judge:task-plan/);
  assert.match(judgment.remediation.join('\n'), /no target-code change is implied/);
});

test('implementation notes list acceptance criteria that workflow verification did not run', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-verification-gaps-'));
  writeFileSync(join(repoPath, 'src-existing.ts'), 'export {};\n');
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src-existing.ts', 'src-missing.ts'],
      acceptance_criteria: [
        'TypeScript typecheck passes.',
        'wrangler dev starts the Worker locally without errors.',
        'Worker entry point returns HTTP 200 on GET /health.',
      ],
    },
  ]).tasks;

  const verification = verificationWithAcceptanceGaps({
    repoPath,
    task,
    verification: {
      performed: ['npm run typecheck passed'],
      missing: [],
    },
  });

  assert.deepEqual(verification.performed, ['npm run typecheck passed']);
  assert.deepEqual(verification.missing, [
    'Owned surface missing after implementation: src-missing.ts',
    'Acceptance criterion not verified by automated checks: wrangler dev starts the Worker locally without errors.',
    'Acceptance criterion not verified by automated checks: Worker entry point returns HTTP 200 on GET /health.',
  ]);
});

test('owned surface presence normalizes annotated paths and ignores globs', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-owned-surfaces-'));
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo"\n');
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler.toml (triggers section)', 'src/**', 'src/ai/client.ts'],
    },
  ]).tasks;

  assert.deepEqual(missingOwnedSurfacePaths(repoPath, task), ['src/ai/client.ts']);
});

test('conceptual owned surfaces do not become missing file paths', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-conceptual-surfaces-'));
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler configuration', 'Worker Env types', 'Workflow binding registration'],
    },
  ]).tasks;

  assert.deepEqual(missingOwnedSurfacePaths(repoPath, task), []);
  assert.deepEqual(taskBoundarySurfaces(repoPath, task), [
    'wrangler configuration',
    'Worker Env types',
    'Workflow binding registration',
  ]);
});

test('missing owned surface preflight creates compile-safe stubs', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-preflight-stubs-'));
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/routes/runs.ts', 'src/storage/runs.ts'],
    },
  ]).tasks;

  const created = await createMissingOwnedSurfaceStubs({ repoPath, task, stage: 'build:T1' });

  assert.deepEqual(created, ['src/routes/runs.ts', 'src/storage/runs.ts']);
  assert.equal(existsSync(join(repoPath, 'src/routes/runs.ts')), true);
  assert.match(readFileSync(join(repoPath, 'src/routes/runs.ts'), 'utf8'), /export \{\};/);
  assert.deepEqual(missingOwnedSurfacePaths(repoPath, task), []);
});

test('preflight stub detector fails until generated stubs are replaced', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-preflight-stub-detector-'));
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/routes/runs.ts'] }]).tasks;

  await createMissingOwnedSurfaceStubs({ repoPath, task, stage: 'build:T1' });

  assert.deepEqual(unreplacedPreflightStubPaths(repoPath, task), ['src/routes/runs.ts']);

  writeFileSync(join(repoPath, 'src/routes/runs.ts'), 'export function routes() { return true; }\n');

  assert.deepEqual(unreplacedPreflightStubPaths(repoPath, task), []);
});

test('invalid tester structured output becomes a fail-closed release gate', () => {
  const gate = releaseGateForInvalidTesterOutput(
    new Error('tester release gate returned invalid structured output: response.object was undefined'),
  );

  assert.equal(gate.artifact_type, 'release-gate');
  assert.equal(gate.decision, 'fail');
  assert.equal(gate.event_type, 'pre_deployment');
  assert.equal(gate.tiers.some((tier) => tier.status === 'failed'), true);
  assert.equal(gate.critical_areas.every((area) => area.status === 'missing'), true);
  assert.match(gate.blockers.join('\n'), /invalid structured output/);
});

test('release gate evidence planner uses bounded local commands', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-evidence-'));
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
  );
  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    ['name = "demo-worker"', '[[d1_databases]]', 'binding = "DB"', 'database_name = "demo-db"'].join('\n'),
  );

  assert.equal(releaseGateLocalD1DatabaseName(repoPath), 'demo-db');
  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath).map((command) => ({
      tier: command.tier,
      command: command.command,
      required: command.required,
    })),
    [
      { tier: 'smoke', command: 'npm run typecheck', required: true },
      { tier: 'api', command: 'npx wrangler d1 migrations apply demo-db --local', required: false },
    ],
  );
  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath, '/tmp/probe-state').map((command) => command.command),
    [
      'npm run typecheck',
      'npx wrangler d1 migrations apply demo-db --local --persist-to /tmp/probe-state',
    ],
  );
});

test('release gate runtime probe planner uses the project Wrangler dev script', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-'));
  mkdirSync(join(repoPath, 'src/routes'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2),
  );
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "src/index.ts"\n');
  writeFileSync(join(repoPath, 'src/routes/health.ts'), 'export const path = "/health";\n');

  assert.deepEqual(releaseGateWorkerDevCommand(repoPath, 8999), {
    command: 'npm run dev -- --ip 127.0.0.1 --port 8999',
    executable: 'npm',
    args: ['run', 'dev', '--', '--ip', '127.0.0.1', '--port', '8999'],
  });
  assert.deepEqual(releaseGateWorkerDevCommand(repoPath, 8999, '/tmp/state'), {
    command: 'npm run dev -- --ip 127.0.0.1 --port 8999 --persist-to /tmp/state',
    executable: 'npm',
    args: ['run', 'dev', '--', '--ip', '127.0.0.1', '--port', '8999', '--persist-to', '/tmp/state'],
  });

  const plan = releaseGateRuntimeProbePlan(repoPath);
  assert.equal(plan?.required, true);
  assert.equal(plan?.command.command, 'npm run dev -- --ip 127.0.0.1 --port <port>');
  assert.deepEqual(
    plan?.probes.map((probe) => ({ path: probe.path, expectedStatus: probe.expectedStatus, statusBelow: probe.statusBelow })),
    [
      { path: '/', expectedStatus: undefined, statusBelow: 500 },
      { path: '/health', expectedStatus: 200, statusBelow: undefined },
    ],
  );
});

test('release gate runtime probe planner covers common Worker API state and error routes', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-probes-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "src/index.ts"\n');
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    [
      "if (pathname === '/profiles') {}",
      "if (pathname === '/runs') {}",
      "if (pathname === '/latest') {}",
      "if (pathname === '/health') {}",
    ].join('\n'),
  );

  const probes = releaseGateRuntimeProbePlan(repoPath)?.probes ?? [];
  assert.deepEqual(
    probes.map((probe) => `${probe.method} ${probe.path}`),
    [
      'GET /',
      'GET /health',
      'GET /latest',
      'POST /runs',
      'POST /runs',
      'POST /profiles',
      'POST /profiles',
      'POST /profiles',
      'POST /profiles',
      'GET /profiles',
    ],
  );
  assert.equal(probes.some((probe) => probe.body?.type === 'multipart-profile'), true);
  assert.equal(
    probes.some((probe) =>
      probe.jsonArrayAssertions?.some(
        (assertion) =>
          assertion.type === 'countObjects' &&
          assertion.count === 1 &&
          assertion.where.kind === 'audience_segments' &&
          assertion.where.isActive === true,
      ),
    ),
    true,
  );
});

test('release gate evidence planner seeds latest transcript and version audit fixtures when schema is present', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-transcript-fixture-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    ['name = "demo-worker"', 'main = "src/index.ts"', '[[d1_databases]]', 'binding = "DB"', 'database_name = "demo-db"'].join('\n'),
  );
  writeFileSync(join(repoPath, 'src/index.ts'), "if (pathname === '/latest') {}\n");
  writeFileSync(
    join(repoPath, 'migrations/0001_init.sql'),
    [
      'CREATE TABLE runs (id TEXT PRIMARY KEY);',
      'CREATE TABLE candidates (id TEXT PRIMARY KEY);',
      'CREATE TABLE transcripts (id TEXT PRIMARY KEY);',
    ].join('\n'),
  );

  const commands = releaseGateEvidenceCommandPlan(repoPath, '/tmp/probe-state').map((command) => command.command);
  assert.deepEqual(commands, [
    'npx wrangler d1 migrations apply demo-db --local --persist-to /tmp/probe-state',
    'npx wrangler d1 execute demo-db --local --persist-to /tmp/probe-state --file .delivery/tmp/release-gate-transcript-fixture.sql --json',
    'npx wrangler d1 execute demo-db --local --persist-to /tmp/probe-state --command "SELECT COUNT(*) AS transcript_versions, SUM(CASE WHEN id = \'release-gate-transcript-v1\' THEN 1 ELSE 0 END) AS preserved_original_versions, SUM(CASE WHEN id = \'release-gate-transcript-v2\' THEN 1 ELSE 0 END) AS regenerated_versions, (SELECT transcript_id FROM runs WHERE id = \'release-gate-run\') AS active_transcript_id FROM transcripts WHERE run_id = \'release-gate-run\'" --json',
  ]);
  assert.match(
    readFileSync(join(repoPath, '.delivery/tmp/release-gate-transcript-fixture.sql'), 'utf8'),
    /release-gate-transcript-v2/,
  );

  const latestProbe = releaseGateRuntimeProbePlan(repoPath)?.probes.find((probe) => probe.method === 'GET' && probe.path === '/latest');
  assert.equal(latestProbe?.expectedStatus, 200);
  assert.deepEqual(latestProbe?.jsonContains, {
    title: 'Release Gate Regenerated Transcript',
    hook: 'Regenerated hook.',
    primarySegment: 'operators',
    whyThisWasPicked: 'Regenerated selection rationale.',
  });
});

test('release gate runtime probe planner falls back to npx wrangler for Worker configs', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-npx-'));
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --host 0.0.0.0' } }, null, 2));
  writeFileSync(join(repoPath, 'wrangler.jsonc'), '{ "name": "demo-worker", "main": "src/index.ts" }\n');

  assert.deepEqual(releaseGateWorkerDevCommand(repoPath, 8999), {
    command: 'npx wrangler dev --ip 127.0.0.1 --port 8999',
    executable: 'npx',
    args: ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', '8999'],
  });
});

test('Workers AI projects require an active Wrangler AI binding and required Env field', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workers-ai-binding-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    [
      'import { createAiClient } from "./ai/client";',
      'export interface Env { AI?: Ai }',
      'export const load = (env: Env) => createAiClient(env);',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    ['name = "demo-worker"', '# [ai]', '# binding = "AI"'].join('\n'),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.toml', 'src/index.ts'] }]).tasks;

  assert.equal(wranglerConfigHasWorkersAiBinding(repoPath), false);
  assert.deepEqual(workersAiBindingGaps(repoPath, task), [
    'Workers AI source is present, but the Wrangler config does not contain an active [ai] binding = "AI" section.',
    'Worker Env marks AI as optional (AI?: Ai); AI-backed product behavior needs Env.AI to be a required binding.',
  ]);
  assert.deepEqual(
    releaseGateStaticEvidenceResults(repoPath).map((result) => ({
      command: result.command,
      ok: result.ok,
      required: result.required,
      error: result.error,
    })),
    [
      {
        command: 'static check: Workers AI binding configured',
        ok: false,
        required: true,
        error:
          'Workers AI source is present, but the Wrangler config does not contain an active [ai] binding = "AI" section. Worker Env marks AI as optional (AI?: Ai); AI-backed product behavior needs Env.AI to be a required binding.',
      },
    ],
  );

  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    ['name = "demo-worker"', '[ai]', 'binding = "AI"'].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    [
      'import { createAiClient } from "./ai/client";',
      'export interface Env { AI: Ai }',
      'export const load = (env: Env) => createAiClient(env);',
    ].join('\n'),
  );

  assert.equal(wranglerConfigHasWorkersAiBinding(repoPath), true);
  assert.deepEqual(workersAiBindingGaps(repoPath, task), []);
  assert.equal(releaseGateStaticEvidenceResults(repoPath)[0]?.ok, true);
});

test('stale downstream verification repair resets only future failed task surfaces', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-stale-downstream-repair-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/workflows/steps/score-candidates.ts'), 'export const score = 1;\n');
  writeFileSync(
    join(repoPath, 'src/workflows/steps/generate-transcript.ts'),
    'export const transcript = buildUsageStats();\n',
  );
  const plan = taskPlan([
    { depends_on: [], owned_surfaces: ['src/**', 'src/workflows/steps/score-candidates.ts'] },
    { depends_on: ['T1'], owned_surfaces: ['src/workflows/steps/generate-transcript.ts'] },
  ]);
  const failure = [
    "src/workflows/steps/score-candidates.ts(1,1): error TS2322: Type 'number' is not assignable.",
    "src/workflows/steps/generate-transcript.ts(1,27): error TS2304: Cannot find name 'buildUsageStats'.",
  ].join('\n');

  assert.deepEqual(
    staleDownstreamVerificationSurfacePaths({
      repoPath,
      taskPlan: plan,
      currentTaskIndex: 0,
      failure,
    }),
    ['src/workflows/steps/generate-transcript.ts'],
  );

  assert.equal(
    await repairStaleDownstreamVerificationSurfaces({
      repoPath,
      stage: 'build:T1',
      taskPlan: plan,
      currentTaskIndex: 0,
      failure,
    }),
    true,
  );
  assert.equal(readFileSync(join(repoPath, 'src/workflows/steps/score-candidates.ts'), 'utf8'), 'export const score = 1;\n');
  assert.match(readFileSync(join(repoPath, 'src/workflows/steps/generate-transcript.ts'), 'utf8'), /Delivery preflight stub/);
});

test('out-of-plan verification failures are classified as stale workspace contamination', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-stale-out-of-plan-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/env.ts'), 'export interface Env { AI: Ai }\n');
  writeFileSync(
    join(repoPath, 'src/workflows/steps/fetch-content.ts'),
    'import type { Env } from "../../env";\nexport const fetchContent = (env: Env) => env.BROWSER;\n',
  );
  const plan = taskPlan([{ depends_on: [], owned_surfaces: ['src/env.ts'] }]);
  const failure =
    'src/workflows/steps/fetch-content.ts(2,55): error TS2339: Property BROWSER does not exist on type Env.';

  assert.deepEqual(outOfPlanVerificationFailurePaths({ repoPath, taskPlan: plan, failure }), [
    'src/workflows/steps/fetch-content.ts',
  ]);
  assert.equal(
    implementationFailureClass([
      'DETERMINISTIC verification_passed failed: STALE_WORKSPACE_VERIFICATION: repo-wide verification failed in existing file(s) outside the current task plan: src/workflows/steps/fetch-content.ts',
    ]),
    'stale_workspace_verification',
  );
});

test('task boundaries include existing sibling TypeScript barrel files', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-boundary-surfaces-'));
  mkdirSync(join(repoPath, 'src/ai'), { recursive: true });
  writeFileSync(join(repoPath, 'src/ai/index.ts'), 'export {};\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/ai/client.ts', 'src/ai/types.ts'] }]).tasks;

  assert.deepEqual(taskBoundarySurfaces(repoPath, task), ['src/ai/client.ts', 'src/ai/types.ts', 'src/ai/index.ts']);
});

test('route task boundaries include the existing Worker entry integration surface', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-route-boundary-surfaces-'));
  mkdirSync(join(repoPath, 'src/routes'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default {};\n');
  writeFileSync(join(repoPath, 'src/routes/index.ts'), 'export {};\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/routes/profiles.ts'] }]).tasks;

  assert.deepEqual(taskBoundarySurfaces(repoPath, task), [
    'src/routes/profiles.ts',
    'src/routes/index.ts',
    'src/index.ts',
  ]);
});

test('workflow step task boundaries include the Workflow entrypoint integration surface', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workflow-boundary-surfaces-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/workflows/weekly.ts'), 'export class WeeklyWorkflow {}\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/workflows/steps/fetch-bookmarks.ts'] }]).tasks;

  assert.deepEqual(taskBoundarySurfaces(repoPath, task), [
    'src/workflows/steps/fetch-bookmarks.ts',
    'src/workflows/weekly.ts',
  ]);
});

test('workflow step implementation must be integrated into WeeklyWorkflow before reuse', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workflow-integration-gap-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/workflows/steps/fetch-bookmarks.ts'), 'export const fetchBookmarksStep = () => true;\n');
  writeFileSync(
    join(repoPath, 'src/workflows/weekly.ts'),
    'export class WeeklyWorkflow { async fetchBookmarks(context: unknown) { return context; } }\n',
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/workflows/steps/fetch-bookmarks.ts'] }]).tasks;

  assert.deepEqual(workflowStepIntegrationGaps(repoPath, task), [
    'Workflow step src/workflows/steps/fetch-bookmarks.ts is not called from src/workflows/weekly.ts; the step can pass in isolation while the Cloudflare Workflow still runs the old pass-through stub.',
  ]);

  writeFileSync(
    join(repoPath, 'src/workflows/weekly.ts'),
    "import { fetchBookmarksStep } from './steps/fetch-bookmarks';\nexport class WeeklyWorkflow { async fetchBookmarks(context: unknown) { return context; } }\n",
  );

  assert.deepEqual(workflowStepIntegrationGaps(repoPath, task), [
    'Workflow step src/workflows/steps/fetch-bookmarks.ts is not called from src/workflows/weekly.ts; the step can pass in isolation while the Cloudflare Workflow still runs the old pass-through stub.',
  ]);

  writeFileSync(
    join(repoPath, 'src/workflows/weekly.ts'),
    "import { fetchBookmarksStep } from './steps/fetch-bookmarks';\nexport class WeeklyWorkflow { step = fetchBookmarksStep; }\n",
  );

  assert.deepEqual(workflowStepIntegrationGaps(repoPath, task), []);
});

test('engine policy mismatch stops retries for normalized in-boundary paths', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-engine-policy-mismatch-'));
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.toml'] }]).tasks;

  const remediation = implementationEnginePolicyMismatch({
    repoPath,
    stage: 'build:T1',
    role: 'engineer',
    task,
    events: [
      { type: 'stage_start', stage: 'build:T1', role: 'engineer' },
      {
        type: 'tool_use',
        tool: 'mastra_workspace_edit_file',
        ok: false,
        paths: ['wrangler.toml (triggers section)'],
        error: "wrangler.toml (triggers section) is outside this task's owned surfaces [wrangler.toml]",
      },
    ],
  });

  assert.equal(remediation.length, 1);
  assert.match(remediation[0], /ENGINE_POLICY_MISMATCH T1/);
  assert.match(remediation[0], /wrangler\.toml/);
});

test('engine policy mismatch ignores genuinely out-of-boundary paths', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-engine-policy-real-block-'));
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/routes/runs.ts'] }]).tasks;

  assert.deepEqual(
    implementationEnginePolicyMismatch({
      repoPath,
      stage: 'build:T1',
      role: 'engineer',
      task,
      events: [
        { type: 'stage_start', stage: 'build:T1', role: 'engineer' },
        {
          type: 'tool_use',
          tool: 'mastra_workspace_edit_file',
          ok: false,
          paths: ['wrangler.toml'],
          error: "wrangler.toml is outside this task's owned surfaces [src/routes/runs.ts]",
        },
      ],
    }),
    [],
  );
});

const implementationNote = {
  artifact_type: 'implementation-note' as const,
  task: 'T1',
  changes: ['Implemented T1'],
  files_touched: ['src/index.ts'],
  assumptions: [],
  verification: {
    performed: ['npm run typecheck passed'],
    missing: ['Acceptance criterion not verified by automated checks: wrangler dev starts locally.'],
  },
  risks: [],
};

const implementationJudgment = {
  rubric: 'implementation',
  overall: 0.65,
  overall_uncapped: 0.65,
  threshold: 0.7,
  passed: false,
  gates: [],
  gates_failed: [],
  dimensions_scored: [
    { id: 'smallest_coherent_change', score: 4, weight: 8, evidence: 'ok' },
    { id: 'implementation_note_quality', score: 4, weight: 5, evidence: 'honest and complete' },
  ],
  dimensions_not_scored: [],
  dimensions_missing: [],
  remediation: [],
};

test('non-actionable implementation judgment can proceed to release-gate verification', () => {
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment: implementationJudgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    true,
  );
});

test('actionable implementation remediation still blocks the fast path', () => {
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment: {
        ...implementationJudgment,
        remediation: ['DIMENSION implementation_note_quality scored 2/5. Add missing checks.'],
      },
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    false,
  );
});

test('weak implementation dimensions synthesize actionable remediation', () => {
  const judgment = {
    ...implementationJudgment,
    dimensions_scored: [
      { id: 'smallest_coherent_change', score: 4, weight: 8, evidence: 'ok' },
      {
        id: 'state_explicitness',
        score: 3,
        weight: 7,
        evidence: 'candidate_scores does not carry run_id; selected candidate behavior is hard to audit.',
      },
    ],
  };

  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    false,
  );
  assert.deepEqual(implementationWeakDimensionRemediation(judgment), [
    'DIMENSION state_explicitness scored 3/5. Improve this before continuing: candidate_scores does not carry run_id; selected candidate behavior is hard to audit.',
  ]);
});

test('passing implementation judgments with weak dimensions still require repair', () => {
  const judgment = {
    ...implementationJudgment,
    overall: 0.82,
    passed: true,
    dimensions_scored: [
      { id: 'smallest_coherent_change', score: 5, weight: 8, evidence: 'ok' },
      {
        id: 'state_explicitness',
        score: 3,
        weight: 7,
        evidence: 'status columns are free text without CHECK constraints.',
      },
    ],
  };

  assert.equal(
    implementationJudgmentCanComplete({
      judgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    false,
  );
});

test('missing owned surfaces block the non-actionable implementation fast path', () => {
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment: implementationJudgment,
      deterministicResults: [
        { id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' },
        {
          id: 'owned_surfaces_present',
          check: 'owned_surfaces_present',
          passed: false,
          reason: 'missing owned surfaces: src/ai/client.ts',
        },
      ],
      note: implementationNote,
    }),
    false,
  );
});

test('deterministic implementation blockers produce retry remediation before model judging', () => {
  assert.deepEqual(
    implementationDeterministicRemediation([
      { id: 'owned_surfaces_present', check: 'owned_surfaces_present', passed: false, reason: 'missing owned surfaces: src/ai/client.ts' },
      { id: 'preflight_stubs_replaced', check: 'preflight_stubs_replaced', passed: false, reason: 'preflight stubs remain: src/routes/runs.ts' },
      { id: 'verification_passed', check: 'build_verification_passed', passed: false, reason: 'npm run typecheck failed: TS1128' },
      { id: 'crypto_compliance', check: 'no_bcrypt_weak_hash', passed: false, reason: 'bcrypt found' },
    ]),
    [
      'DETERMINISTIC owned_surfaces_present failed: missing owned surfaces: src/ai/client.ts',
      'DETERMINISTIC preflight_stubs_replaced failed: preflight stubs remain: src/routes/runs.ts',
      'DETERMINISTIC verification_passed failed: npm run typecheck failed: TS1128',
    ],
  );
});

test('reusable implementation artifacts require passing judgment and present owned surfaces', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-reuse-artifact-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export {};\n');
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['src/index.ts'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/index.ts'] }]).tasks;

  assert.deepEqual(reusableImplementationArtifactForTask(repoPath, task), {
    note: {
      ...implementationNote,
      task: 'T1',
      files_touched: ['src/index.ts'],
    },
    notePath: '.delivery/artifacts/note-T1.a1.json',
    judgment: {
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    },
    judgmentPath: '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json',
    judgeOutputPath: undefined,
    attempt: 1,
  });
});

test('reusable implementation artifacts reject stale Worker AI config artifacts', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-reuse-ai-binding-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\n# [ai]\n# binding = "AI"\n');
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    'import { createAiClient } from "./ai/client";\nexport interface Env { AI?: Ai }\nexport const load = (env: Env) => createAiClient(env);\n',
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['wrangler.toml', 'src/index.ts'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.toml', 'src/index.ts'] }]).tasks;

  assert.equal(reusableImplementationArtifactForTask(repoPath, task), undefined);
});

test('build resume plan points to the next task after the passing artifact prefix', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-resume-plan-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'src/one.ts'), 'export {};\n');
  writeFileSync(join(repoPath, 'src/two.ts'), 'export {};\n');
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['src/one.ts'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const plan = taskPlan([
    { depends_on: [], owned_surfaces: ['src/one.ts'] },
    { depends_on: ['T1'], owned_surfaces: ['src/two.ts'] },
  ]);

  assert.deepEqual(deliveryBuildResumePlan(repoPath, plan), {
    reusableTaskIds: ['T1'],
    resumeAfterTaskId: 'T1',
    nextTaskId: 'T2',
    totalTasks: 2,
  });
});

test('reusable implementation artifacts reject notes outside role ownership', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-reuse-boundary-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'public'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export {};\n');
  writeFileSync(join(repoPath, 'public/index.html'), '<!doctype html>\n');
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['public/index.html'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/index.ts'] }]).tasks;

  assert.equal(reusableImplementationArtifactForTask(repoPath, task), undefined);
});

test('build task preparation pauses after earlier stopped tasks', () => {
  const plan = taskPlan([
    { depends_on: [], owned_surfaces: ['src/setup.ts'] },
    { depends_on: [], owned_surfaces: ['src/profile.ts'] },
    { depends_on: [], owned_surfaces: ['src/weekly.ts'] },
  ]);

  assert.deepEqual(
    priorStoppedBuildTaskIds({
      taskPlan: plan,
      taskIndex: 2,
      taskStatuses: {
        T1: { status: 'complete' },
        T2: { status: 'stuck' },
      },
    }),
    ['T2'],
  );
});

test('implementation retry mode focuses timeout retries when owned files already exist', () => {
  assert.equal(
    implementationRetryMode({
      remediation: ['T3 build attempt timed out after 180000ms. Create missing owned surfaces.'],
      missingSurfaces: ['src/routes/profiles.ts'],
    }),
    'write-first',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['T3 build attempt timed out after 180000ms. Edit the boundary surfaces.'],
      missingSurfaces: [],
    }),
    'focused-repair',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['T3 build attempt made no tool calls after 60000ms. Create the missing owned surfaces.'],
      missingSurfaces: ['src/routes/profiles.ts'],
    }),
    'write-first',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['T3 build attempt made no tool calls after 60000ms. Make a focused write to the boundary surfaces.'],
      missingSurfaces: [],
    }),
    'focused-repair',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['DETERMINISTIC verification_passed failed: npm run typecheck failed: TS2307'],
      missingSurfaces: [],
    }),
    'focused-repair',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['GATE no_silent_degradation failed: record or surface the non-fatal AI summary failure.'],
      missingSurfaces: [],
    }),
    'focused-repair',
  );
});

test('implementation retry mode classifies deterministic failure families', () => {
  const missingSurfaceRemediation = ['DETERMINISTIC owned_surfaces_present failed: missing owned surfaces: src/routes/runs.ts'];
  assert.equal(implementationFailureClass(missingSurfaceRemediation), 'missing_surface');
  assert.equal(
    implementationRetryMode({
      remediation: missingSurfaceRemediation,
      missingSurfaces: ['src/routes/runs.ts'],
    }),
    'write-first',
  );

  const preflightStubRemediation = [
    'DETERMINISTIC preflight_stubs_replaced failed: preflight stubs remain: src/workflows/steps/create-briefs.ts',
  ];
  assert.equal(implementationFailureClass(preflightStubRemediation), 'preflight_stub');
  assert.equal(
    implementationRetryMode({
      remediation: preflightStubRemediation,
      missingSurfaces: [],
    }),
    'focused-repair',
  );

  const policyBoundaryRemediation = [
    'DETERMINISTIC file_ownership failed: wrangler.toml is outside engineer owned globs',
  ];
  assert.equal(implementationFailureClass(policyBoundaryRemediation), 'policy_boundary');
  assert.equal(
    implementationRetryMode({
      remediation: policyBoundaryRemediation,
      missingSurfaces: [],
    }),
    'focused-repair',
  );

  assert.equal(
    implementationFailureClass(['T2 build attempt made no tool calls after 60000ms. Make a focused write.']),
    'model_no_action',
  );

  const judgeTimeoutRemediation = [
    'JUDGE_TIMEOUT T7.a2: implementation judgment timed out after 300000ms. Preserve working code and retry.',
  ];
  assert.equal(implementationFailureClass(judgeTimeoutRemediation), 'judge_timeout');
  assert.equal(
    implementationRetryMode({
      remediation: judgeTimeoutRemediation,
      missingSurfaces: [],
    }),
    'focused-repair',
  );
});
