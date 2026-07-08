import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cloudflareBindingsHygieneScorer,
  cloudflareDeploymentHygieneScorer,
  cloudflareStorageFitScorer,
  cloudflareTaskSequencingScorer,
  cloudflareWorkerFirstTopologyScorer,
  deliveryAcceptanceContractCoverageScorer,
  deliveryArchitectToBuildHandoffScorer,
  deliveryBuildToTesterHandoffScorer,
  deliveryDeterministicChecksScorer,
  deliveryLocalEvidenceReadinessScorer,
  deliveryModelSpendPerCompletedTaskScorer,
  deliveryJudgmentPassRateScorer,
  deliveryPlanToArchitectHandoffScorer,
  deliveryRubricFloorScorer,
  deliveryScaffoldBindingsCompletenessScorer,
  deliveryScaffoldProfileFitScorer,
  deliveryTesterToDeployerHandoffScorer,
  deliveryTestRuntimeMatrixScorer,
  deliveryVanillaFrontendComplianceScorer,
  deliveryWorkflowCompletionScorer,
} from '../../src/mastra/delivery-engine/scorers.ts';

const completeOutput = {
  status: 'complete',
  runId: 'run-test',
  summary: 'done',
  checks: [
    { check: 'plan_schema_complete', passed: true, reason: 'ok' },
    { check: 'tier_order', passed: true, reason: 'ok' },
    { check: 'acceptance_criteria_contracts', passed: true, reason: 'ok' },
  ],
  judgments: [
    {
      subject: '.delivery/artifacts/task-plan.json',
      rubric: 'task-plan',
      path: '.delivery/artifacts/judgments/task-plan.judgment.json',
      overall: 0.92,
      passed: true,
    },
    {
      subject: '.delivery/artifacts/release-gate.json',
      rubric: 'release-gate',
      path: '.delivery/artifacts/judgments/release-gate.judgment.json',
      overall: 0.84,
      passed: true,
    },
  ],
  taskPlan: {
    tasks: [{ id: 'task-1' }],
  },
  releaseGate: {
    decision: 'pass',
    blockers: [],
  },
  nextSteps: ['monitor'],
};

const scaffoldOutput = {
  ...completeOutput,
  status: 'planned',
  sourcePolicy: {
    pagesRequired: false,
    latestTranscriptRequired: true,
    externalServiceBindings: ['BOOKMARKS'],
  },
  scaffoldManifest: {
    profileList: ['worker-typescript', 'worker-workers-ai', 'worker-d1'],
    language: 'typescript',
    main: 'src/index.ts',
    generatedFiles: [
      'package.json',
      'wrangler.jsonc',
      'vitest.config.ts',
      'src/index.ts',
      'src/contracts.ts',
      'public/index.html',
      'public/styles.css',
      'public/app.js',
      'test/contracts.test.ts',
      'test/api-routes.test.ts',
      'test/frontend-shell.test.js',
    ],
    testRuntimeMatrix: [
      {
        name: 'node',
        runtime: 'node',
        include: ['test/contracts.test.ts', 'test/validation.test.ts', 'test/domain.test.ts'],
      },
      {
        name: 'worker',
        runtime: 'worker',
        include: ['test/api-routes.test.ts', 'test/provider-adapters.test.ts', 'test/worker-smoke.test.ts'],
      },
      {
        name: 'frontend',
        runtime: 'jsdom',
        include: ['test/frontend-*.test.js', 'test/ui-*.test.js'],
      },
    ],
    bindingMap: {
      ASSETS: 'static assets binding for ./public',
      AI: 'Workers AI binding',
      DB: 'D1 database binding',
      BOOKMARKS: 'external Worker service binding',
    },
    packageScripts: {
      dev: 'wrangler dev --env staging',
      deploy: 'wrangler deploy --env production',
      test: 'vitest run',
    },
    validationCommands: ['npm run typecheck', 'npm test'],
  },
};

test('deliveryWorkflowCompletionScorer scores only complete workflow output as passing', async () => {
  const complete = await deliveryWorkflowCompletionScorer.run({ input: {}, output: completeOutput });
  assert.equal(complete.score, 1);
  assert.match(complete.reason ?? '', /completed/);

  const stuck = await deliveryWorkflowCompletionScorer.run({
    input: {},
    output: { ...completeOutput, status: 'stuck' },
  });
  assert.equal(stuck.score, 0);
  assert.match(stuck.reason ?? '', /stuck/);
});

test('delivery handoff scorers score expected stage transitions', async () => {
  const planReady = await deliveryPlanToArchitectHandoffScorer.run({
    input: {},
    output: { ...completeOutput, status: 'planned' },
  });
  assert.equal(planReady.score, 1);
  assert.match(planReady.reason ?? '', /architect review/);

  const reviewReady = await deliveryArchitectToBuildHandoffScorer.run({
    input: {},
    output: { ...completeOutput, status: 'reviewed' },
  });
  assert.equal(reviewReady.score, 1);

  const buildReady = await deliveryBuildToTesterHandoffScorer.run({
    input: {},
    output: { ...completeOutput, status: 'built' },
  });
  assert.equal(buildReady.score, 1);

  const deployReady = await deliveryTesterToDeployerHandoffScorer.run({
    input: {},
    output: { ...completeOutput, status: 'release_ready' },
  });
  assert.equal(deployReady.score, 1);
  assert.match(deployReady.reason ?? '', /passing release gate/);

  const prematureDeploy = await deliveryTesterToDeployerHandoffScorer.run({
    input: {},
    output: { ...completeOutput, status: 'built' },
  });
  assert.equal(prematureDeploy.score, 0);
  assert.match(prematureDeploy.reason ?? '', /release_ready/);
});

test('deliveryRubricFloorScorer exposes the lowest recorded judgment score', async () => {
  const score = await deliveryRubricFloorScorer.run({ input: {}, output: completeOutput });
  assert.equal(score.score, 0.84);
  assert.match(score.reason ?? '', /release-gate/);
});

test('deliveryJudgmentPassRateScorer scores judgment pass fraction', async () => {
  const score = await deliveryJudgmentPassRateScorer.run({
    input: {},
    output: {
      ...completeOutput,
      judgments: [
        completeOutput.judgments[0],
        { ...completeOutput.judgments[1], passed: false },
      ],
    },
  });
  assert.equal(score.score, 0.5);
  assert.match(score.reason ?? '', /Failed judgments/);
});

test('deliveryDeterministicChecksScorer scores deterministic check pass fraction', async () => {
  const score = await deliveryDeterministicChecksScorer.run({
    input: {},
    output: {
      ...completeOutput,
      checks: [
        completeOutput.checks[0],
        { check: 'tier_order', passed: false, reason: 'api skipped' },
      ],
    },
  });
  assert.equal(score.score, 0.5);
  assert.match(score.reason ?? '', /tier_order/);
});

test('deliveryAcceptanceContractCoverageScorer scores contract gates separately', async () => {
  const passing = await deliveryAcceptanceContractCoverageScorer.run({ input: {}, output: completeOutput });
  assert.equal(passing.score, 1);
  assert.match(passing.reason ?? '', /acceptance contract/);

  const failing = await deliveryAcceptanceContractCoverageScorer.run({
    input: {},
    output: {
      ...completeOutput,
      checks: [
        { check: 'acceptance_criteria_contracts', passed: true, reason: 'ok' },
        {
          check: 'task_plan_acceptance_contract_regression',
          passed: false,
          reason: 'T11 dropped WeeklyWorkflow pipeline contract',
        },
      ],
    },
  });
  assert.equal(failing.score, 0.5);
  assert.match(failing.reason ?? '', /WeeklyWorkflow pipeline/);

  const missing = await deliveryAcceptanceContractCoverageScorer.run({
    input: {},
    output: { ...completeOutput, checks: [] },
  });
  assert.equal(missing.score, 0);
  assert.match(missing.reason ?? '', /No acceptance contract checks/);
});

test('scaffold scorers score profile, runtime, binding, and frontend readiness', async () => {
  const profileFit = await deliveryScaffoldProfileFitScorer.run({ input: {}, output: scaffoldOutput });
  assert.equal(profileFit.score, 1);
  assert.match(profileFit.reason ?? '', /worker-typescript/);

  const runtime = await deliveryTestRuntimeMatrixScorer.run({ input: {}, output: scaffoldOutput });
  assert.equal(runtime.score, 1);
  assert.match(runtime.reason ?? '', /Runtime matrix separates/);

  const bindings = await deliveryScaffoldBindingsCompletenessScorer.run({ input: {}, output: scaffoldOutput });
  assert.equal(bindings.score, 1);
  assert.match(bindings.reason ?? '', /BOOKMARKS/);

  const frontend = await deliveryVanillaFrontendComplianceScorer.run({ input: {}, output: scaffoldOutput });
  assert.equal(frontend.score, 1);
  assert.match(frontend.reason ?? '', /vanilla/);
});

test('scaffold scorers catch missing bindings, broad Worker globs, and frontend framework drift', async () => {
  const missingBinding = await deliveryScaffoldBindingsCompletenessScorer.run({
    input: {},
    output: {
      ...scaffoldOutput,
      scaffoldManifest: {
        ...scaffoldOutput.scaffoldManifest,
        bindingMap: { ASSETS: 'static assets binding for ./public', DB: 'D1 database binding' },
      },
    },
  });
  assert.equal(missingBinding.score, 0.5);
  assert.match(missingBinding.reason ?? '', /AI/);

  const broadWorkerGlob = await deliveryTestRuntimeMatrixScorer.run({
    input: {},
    output: {
      ...scaffoldOutput,
      scaffoldManifest: {
        ...scaffoldOutput.scaffoldManifest,
        testRuntimeMatrix: [
          scaffoldOutput.scaffoldManifest.testRuntimeMatrix[0],
          { name: 'worker', runtime: 'worker', include: ['test/**/*.test.ts'] },
          scaffoldOutput.scaffoldManifest.testRuntimeMatrix[2],
        ],
      },
    },
  });
  assert.ok(broadWorkerGlob.score < 1);
  assert.match(broadWorkerGlob.reason ?? '', /broad Worker globs/);

  const frameworkDrift = await deliveryVanillaFrontendComplianceScorer.run({
    input: {},
    output: {
      ...scaffoldOutput,
      taskPlan: {
        tasks: [{ deliverable: 'Add React dashboard', owned_surfaces: ['src/App.tsx'] }],
      },
    },
  });
  assert.equal(frameworkDrift.score, 0);
  assert.match(frameworkDrift.reason ?? '', /framework/);
});

test('local evidence and model spend scorers expose release readiness and cost per task', async () => {
  const ready = await deliveryLocalEvidenceReadinessScorer.run({ input: {}, output: completeOutput });
  assert.equal(ready.score, 1);
  assert.match(ready.reason ?? '', /passed/);

  const blocked = await deliveryLocalEvidenceReadinessScorer.run({
    input: {},
    output: { ...completeOutput, releaseGate: { decision: 'fail', blockers: ['npm test failed'] } },
  });
  assert.equal(blocked.score, 0);
  assert.match(blocked.reason ?? '', /npm test failed/);

  const spend = await deliveryModelSpendPerCompletedTaskScorer.run({
    input: {},
    output: {
      ...completeOutput,
      modelSpend: {
        totalTokens: 80_000,
        completedTasks: 4,
        maxTokensPerTask: 25_000,
        totalCostUsd: 8,
        maxCostPerTaskUsd: 3,
      },
    },
  });
  assert.equal(spend.score, 1);
  assert.match(spend.reason ?? '', /tokens\/task=20000/);

  const missing = await deliveryModelSpendPerCompletedTaskScorer.run({ input: {}, output: completeOutput });
  assert.equal(missing.score, 0);
  assert.match(missing.reason ?? '', /No model spend summary/);
});

test('cloudflareWorkerFirstTopologyScorer enforces Worker-first and explicit Pages exceptions', async () => {
  const worker = await cloudflareWorkerFirstTopologyScorer.run({
    input: {},
    output: {
      topology: 'single-worker',
      components: ['workers', 'd1'],
    },
    groundTruth: {
      expectedTopology: 'single-worker',
    },
  });
  assert.equal(worker.score, 1);

  const mixed = await cloudflareWorkerFirstTopologyScorer.run({
    input: {},
    output: {
      topology: 'mixed',
      components: ['pages-functions', 'workers'],
    },
    groundTruth: {
      expectedTopology: 'single-worker',
    },
  });
  assert.equal(mixed.score, 0);
  assert.match(mixed.reason ?? '', /forbidden/);

  const pagesWithoutEvidence = await cloudflareWorkerFirstTopologyScorer.run({
    input: {},
    output: {
      topology: 'pages-functions',
      components: ['pages-functions'],
    },
    groundTruth: {
      expectedTopology: 'pages-functions',
      requiredPagesExceptionEvidence: true,
    },
  });
  assert.equal(pagesWithoutEvidence.score, 0);
  assert.match(pagesWithoutEvidence.reason ?? '', /explicit/);
});

test('cloudflareStorageFitScorer scores native service selection', async () => {
  const fit = await cloudflareStorageFitScorer.run({
    input: {},
    output: {
      topology: 'single-worker',
      components: ['workers', 'r2', 'd1'],
    },
    groundTruth: {
      requiredComponents: ['workers', 'r2', 'd1'],
      forbiddenComponents: ['kv-as-file-store'],
    },
  });
  assert.equal(fit.score, 1);

  const mismatch = await cloudflareStorageFitScorer.run({
    input: {},
    output: {
      topology: 'single-worker',
      components: ['workers', 'kv-as-source-of-truth'],
    },
    groundTruth: {
      requiredComponents: ['workers', 'd1'],
      forbiddenComponents: ['kv-as-source-of-truth'],
    },
  });
  assert.equal(mismatch.score, 0.333);
  assert.match(mismatch.reason ?? '', /d1/);
});

test('cloudflareBindingsHygieneScorer catches missing required bindings', async () => {
  const score = await cloudflareBindingsHygieneScorer.run({
    input: {},
    output: {
      topology: 'single-worker',
      bindings: ['DB'],
    },
    groundTruth: {
      requiredBindings: ['AI', 'DB'],
    },
  });
  assert.equal(score.score, 0.5);
  assert.match(score.reason ?? '', /AI/);
});

test('cloudflareTaskSequencingScorer scores ordered Cloudflare implementation plans', async () => {
  const score = await cloudflareTaskSequencingScorer.run({
    input: {},
    output: {
      topology: 'single-worker',
      taskOrder: ['root-scaffold', 'worker-routes', 'd1-migration'],
    },
    groundTruth: {
      requiredTaskOrder: ['root-scaffold', 'd1-migration', 'storage-adapter', 'worker-routes', 'release-gate'],
    },
  });
  assert.equal(score.score, 0.4);
  assert.match(score.reason ?? '', /storage-adapter/);
});

test('cloudflareDeploymentHygieneScorer prefers direct Wrangler deployment over GitHub Actions deploys', async () => {
  const score = await cloudflareDeploymentHygieneScorer.run({
    input: {},
    output: {
      topology: 'single-worker',
      deployment: ['github-actions-deploy'],
    },
    groundTruth: {
      requiredDeploymentSignals: ['wrangler-dev-staging', 'wrangler-deploy-production'],
      forbiddenDeploymentSignals: ['github-actions-deploy'],
    },
  });
  assert.equal(score.score, 0);
  assert.match(score.reason ?? '', /github-actions-deploy/);
});
