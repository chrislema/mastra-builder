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
import { deliveryScaffoldWorkflow } from '../../src/mastra/delivery-engine/scaffold-workflow.ts';

const workflowSource = () => readFileSync('src/mastra/delivery-engine/workflow.ts', 'utf8');

test('delivery workflow is split into native stage workflows', () => {
  assert.deepEqual(
    [
      deliveryWorkflow.id,
      deliveryPlanningWorkflow.id,
      deliveryScaffoldWorkflow.id,
      deliveryReviewWorkflow.id,
      deliveryBuildWorkflow.id,
      deliveryBuildTaskWorkflow.id,
      deliveryReleaseGateWorkflow.id,
      deliveryDeploymentWorkflow.id,
    ],
    [
      'delivery-workflow',
      'delivery-planning',
      'delivery-scaffold',
      'delivery-review',
      'delivery-build',
      'delivery-build-task',
      'delivery-release-gate',
      'delivery-deployment',
    ],
  );
});

test('delivery workflow scaffolds deterministically between planning and review', () => {
  const source = workflowSource();
  assert.match(source, /\.then\(deliveryPlanningWorkflow\)\s+\.then\(createScaffoldArtifactsStep\)\s+\.then\(deliveryReviewWorkflow\)/);
  assert.match(source, /id: 'create-scaffold-artifacts'/);
  assert.match(source, /executeDeliveryScaffold/);
  assert.match(source, /scaffold_manifest: scaffoldManifestPromptSummary/);
});

test('workflow agent calls use run-scoped Mastra memory', () => {
  const source = workflowSource();
  const requestContextCount = source.match(/requestContext: createDeliveryRequestContext/g)?.length ?? 0;
  const controlRequestContextCount = source.match(/requestContext: createDeliveryControlRequestContext/g)?.length ?? 0;
  const memoryCount = source.match(/memory: deliveryRunMemory/g)?.length ?? 0;

  assert.equal(requestContextCount, 1);
  assert.equal(controlRequestContextCount, 5);
  assert.equal(memoryCount, requestContextCount + controlRequestContextCount);
  assert.match(source, /memory: deliveryRunMemory\(\{ repoPath, runId, role: 'judge' \}\)/);
  assert.match(source, /memory: deliveryRunMemory\(\{ repoPath: inputData\.repoPath, runId: inputData\.runId, role: task\.owner \}\)/);
});

test('delivery workflow records structured gate and task packet observability events', () => {
  const source = workflowSource();
  assert.match(source, /type: 'deterministic_gate_result'/);
  assert.match(source, /gate: 'task-plan'/);
  assert.match(source, /type: 'task_packets_emitted'/);
  assert.match(source, /taskPacketRailsForTask/);
  assert.match(source, /verification_command_class: rails\.verification_command_class/);
  assert.match(source, /allowed_surfaces: rails\.allowed_surfaces/);
  assert.match(source, /task_rails: taskRails/);
});

test('release gate is synthesized deterministically from evidence', () => {
  const source = workflowSource();
  const releaseGateAttempt = source.slice(
    source.indexOf("id: 'release-gate-attempt'"),
    source.indexOf("const finalizeReleaseGateLoopStep"),
  );

  assert.match(releaseGateAttempt, /synthesizeReleaseGateFromEvidence/);
  assert.doesNotMatch(releaseGateAttempt, /tester\.generate/);
  assert.doesNotMatch(releaseGateAttempt, /rubricName: 'release-gate'/);
});

test('deployment completion is gated deterministically from evidence', () => {
  const source = workflowSource();
  const deploymentGate = source.slice(
    source.indexOf("id: 'gate-deployment-report'"),
    source.indexOf('export const deliveryDeploymentWorkflow'),
  );

  assert.match(deploymentGate, /type: 'deployment_gate_result'/);
  assert.match(deploymentGate, /deploymentDeterministicResults/);
  assert.match(deploymentGate, /failedDeploymentChecks\.length === 0/);
  assert.doesNotMatch(deploymentGate, /deploymentJudge/);
  assert.doesNotMatch(deploymentGate, /rubricName: 'deployment-report'/);
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
  assert.equal(typeof deliveryScaffoldWorkflow.options.onError, 'function', 'delivery-scaffold missing onError cleanup');
});
