import assert from 'node:assert/strict';
import test from 'node:test';
import { mastra } from '../../src/mastra/index.ts';

test('Mastra registers delivery workflow stage surfaces', () => {
  assert.deepEqual(
    [
      mastra.getWorkflow('deliveryStartWorkflow').id,
      mastra.getWorkflow('deliveryWorkflow').id,
      mastra.getWorkflow('deliveryPlanningWorkflow').id,
      mastra.getWorkflow('deliveryReviewWorkflow').id,
      mastra.getWorkflow('deliveryBuildWorkflow').id,
      mastra.getWorkflow('deliveryBuildTaskWorkflow').id,
      mastra.getWorkflow('deliveryReleaseGateWorkflow').id,
      mastra.getWorkflow('deliveryDeploymentWorkflow').id,
    ],
    [
      'delivery-start',
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
