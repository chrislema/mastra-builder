import assert from 'node:assert/strict';
import test from 'node:test';
import { mastra } from '../../src/mastra/index.ts';
import { deliveryAgents, deliveryMemory } from '../../src/mastra/delivery-engine/agents.ts';
import { deliveryProcessors } from '../../src/mastra/delivery-engine/processors.ts';
import { deliveryApiRoutes } from '../../src/mastra/delivery-engine/routes.ts';
import { deliveryScorers } from '../../src/mastra/delivery-engine/scorers.ts';
import { deliveryStateTools } from '../../src/mastra/delivery-engine/tools.ts';
import { deliveryWorkspace } from '../../src/mastra/delivery-engine/workspace.ts';
import { deliveryStartWorkflow } from '../../src/mastra/delivery-engine/launcher-workflow.ts';
import { deliveryScaffoldWorkflow } from '../../src/mastra/delivery-engine/scaffold-workflow.ts';
import {
  deliveryBuildTaskWorkflow,
  deliveryBuildWorkflow,
  deliveryDeploymentWorkflow,
  deliveryPlanningWorkflow,
  deliveryReleaseGateWorkflow,
  deliveryReviewWorkflow,
  deliveryWorkflow,
} from '../../src/mastra/delivery-engine/workflows/index.ts';

const registeredWorkflows = {
  deliveryStartWorkflow,
  deliveryWorkflow,
  deliveryPlanningWorkflow,
  deliveryScaffoldWorkflow,
  deliveryReviewWorkflow,
  deliveryBuildWorkflow,
  deliveryBuildTaskWorkflow,
  deliveryReleaseGateWorkflow,
  deliveryDeploymentWorkflow,
};

const entriesOf = <T extends Record<string, unknown>>(value: T) =>
  Object.entries(value) as Array<{ [K in keyof T]: [K, T[K]] }[keyof T]>;

test('Mastra registers delivery workflow stage surfaces', () => {
  assert.deepEqual(
    [
      mastra.getWorkflow('deliveryStartWorkflow').id,
      mastra.getWorkflow('deliveryWorkflow').id,
      mastra.getWorkflow('deliveryPlanningWorkflow').id,
      mastra.getWorkflow('deliveryScaffoldWorkflow').id,
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
      'delivery-scaffold',
      'delivery-review',
      'delivery-build',
      'delivery-build-task',
      'delivery-release-gate',
      'delivery-deployment',
    ],
  );
});

test('Mastra registers every Delivery Engine first-class surface', () => {
  assert.deepEqual(Object.keys(mastra.listAgents()).sort(), Object.keys(deliveryAgents).sort());
  for (const [key, agent] of entriesOf(deliveryAgents)) {
    assert.equal(mastra.getAgent(key), agent);
    assert.equal(mastra.getAgentById(agent.id), agent);
  }

  const registeredWorkflowKeys = new Set(Object.keys(mastra.listWorkflows()));
  for (const key of Object.keys(registeredWorkflows)) {
    assert.equal(registeredWorkflowKeys.has(key), true);
  }
  for (const agent of Object.values(deliveryAgents)) {
    assert.equal(registeredWorkflowKeys.has(`${agent.id}-input-processor`), true);
    assert.equal(registeredWorkflowKeys.has(`${agent.id}-output-processor`), true);
  }
  for (const [key, workflow] of entriesOf(registeredWorkflows)) {
    assert.equal(mastra.getWorkflow(key), workflow);
    assert.equal(mastra.getWorkflowById(workflow.id), workflow);
  }

  const registeredToolKeys = new Set(Object.keys(mastra.listTools() ?? {}));
  for (const [key, tool] of entriesOf(deliveryStateTools)) {
    assert.equal(mastra.getTool(key), tool);
    assert.equal(mastra.getToolById(tool.id), tool);
    assert.equal(registeredToolKeys.has(key), true);
    assert.equal(registeredToolKeys.has(tool.id), true);
  }

  const registeredScorerKeys = new Set(Object.keys(mastra.listScorers() ?? {}));
  for (const [key, scorer] of entriesOf(deliveryScorers)) {
    const scorerId = scorer.config.id;
    assert.equal(mastra.getScorer(key), scorer);
    assert.equal(mastra.getScorerById(scorerId), scorer);
    assert.equal(registeredScorerKeys.has(key), true);
  }

  const registeredProcessorKeys = new Set(Object.keys(mastra.listProcessors() ?? {}));
  for (const [key, processor] of entriesOf(deliveryProcessors)) {
    assert.equal(mastra.getProcessor(key), processor);
    assert.equal(mastra.getProcessorById(processor.id), processor);
    assert.equal(registeredProcessorKeys.has(key), true);
    assert.equal(registeredProcessorKeys.has(processor.id), true);
  }

  assert.deepEqual(Object.keys(mastra.listMemory() ?? {}), ['deliveryMemory']);
  assert.equal(mastra.getMemory('deliveryMemory'), deliveryMemory);

  assert.deepEqual(Object.keys(mastra.listWorkspaces()), [deliveryWorkspace.id]);
  assert.equal(mastra.getWorkspace(), deliveryWorkspace);
  assert.equal(mastra.getWorkspaceById(deliveryWorkspace.id), deliveryWorkspace);

  assert.deepEqual(
    deliveryApiRoutes.map((route) => `${route.method} ${route.path}`).sort(),
    ['GET /delivery/launcher', 'POST /delivery/launcher', 'POST /delivery/run'],
  );
  for (const route of deliveryApiRoutes) {
    assert.equal(Boolean(route.openapi?.summary), true);
  }
});
