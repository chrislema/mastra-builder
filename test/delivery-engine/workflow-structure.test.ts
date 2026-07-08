import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  deliveryBuildTaskWorkflow,
  deliveryBuildWorkflow,
  deliveryDeploymentWorkflow,
  deliveryPlanningWorkflow,
  deliveryReleaseGateWorkflow,
  deliveryReviewWorkflow,
  deliveryWorkflow,
  markDeliveryRunFailedOnWorkflowError,
} from '../../src/mastra/delivery-engine/workflow.ts';

const workflowSource = () => readFileSync('src/mastra/delivery-engine/workflow.ts', 'utf8');

test('delivery workflow is split into native stage workflows', () => {
  assert.deepEqual(
    [
      deliveryWorkflow.id,
      deliveryPlanningWorkflow.id,
      deliveryReviewWorkflow.id,
      deliveryBuildWorkflow.id,
      deliveryBuildTaskWorkflow.id,
      deliveryReleaseGateWorkflow.id,
      deliveryDeploymentWorkflow.id,
    ],
    [
      'delivery-workflow',
      'delivery-planning',
      'delivery-review',
      'delivery-build',
      'delivery-build-task',
      'delivery-release-gate',
      'delivery-deployment',
    ],
  );
});

test('workflow agent calls use run-scoped Mastra memory', () => {
  const source = workflowSource();
  const requestContextCount = source.match(/requestContext: createDeliveryRequestContext/g)?.length ?? 0;
  const controlRequestContextCount = source.match(/requestContext: createDeliveryControlRequestContext/g)?.length ?? 0;
  const memoryCount = source.match(/memory: deliveryRunMemory/g)?.length ?? 0;

  assert.equal(requestContextCount, 1);
  assert.equal(controlRequestContextCount, 6);
  assert.equal(memoryCount, requestContextCount + controlRequestContextCount);
  assert.match(source, /memory: deliveryRunMemory\(\{ repoPath, runId, role: 'judge' \}\)/);
  assert.match(source, /memory: deliveryRunMemory\(\{ repoPath: inputData\.repoPath, runId: inputData\.runId, role: task\.owner \}\)/);
});

test('delivery stage workflows close delivery state on workflow errors', () => {
  for (const workflow of [
    deliveryWorkflow,
    deliveryPlanningWorkflow,
    deliveryReviewWorkflow,
    deliveryBuildWorkflow,
    deliveryBuildTaskWorkflow,
    deliveryReleaseGateWorkflow,
    deliveryDeploymentWorkflow,
  ]) {
    assert.equal(workflow.options.onError, markDeliveryRunFailedOnWorkflowError, `${workflow.id} missing onError cleanup`);
  }
});
