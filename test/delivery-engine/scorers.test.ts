import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryArchitectToBuildHandoffScorer,
  deliveryBuildToTesterHandoffScorer,
  deliveryDeterministicChecksScorer,
  deliveryJudgmentPassRateScorer,
  deliveryPlanToArchitectHandoffScorer,
  deliveryRubricFloorScorer,
  deliveryTesterToDeployerHandoffScorer,
  deliveryWorkflowCompletionScorer,
} from '../../src/mastra/delivery-engine/scorers.ts';

const completeOutput = {
  status: 'complete',
  runId: 'run-test',
  summary: 'done',
  checks: [
    { check: 'plan_schema_complete', passed: true, reason: 'ok' },
    { check: 'tier_order', passed: true, reason: 'ok' },
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
