import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryBuildTaskWorkflow,
  deliveryBuildWorkflow,
  deliveryDeploymentWorkflow,
  deliveryPlanningWorkflow,
  deliveryReleaseGateWorkflow,
  deliveryReviewWorkflow,
  deliveryWorkflow,
} from '../../src/mastra/delivery-engine/workflow.ts';

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
