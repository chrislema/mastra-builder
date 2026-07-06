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
  implementationRetryMode,
  implementationWeakDimensionRemediation,
  missingOwnedSurfacePaths,
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
    'Workflow step src/workflows/steps/fetch-bookmarks.ts is not imported or called from src/workflows/weekly.ts; the step can pass in isolation while the Cloudflare Workflow still runs the old pass-through stub.',
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
});
