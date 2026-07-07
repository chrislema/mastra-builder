import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryAgentRequestContextSchema,
  deliveryAgents,
  deliveryMemory,
  deliverySupervisorAgent,
  deliveryWorkingMemorySchema,
} from '../../src/mastra/delivery-engine/agents.ts';
import {
  architectModel,
  deliveryModel,
  designerModel,
  engineerModel,
  judgeModel,
  plannerModel,
  testerModel,
} from '../../src/mastra/delivery-engine/models.ts';

test('delivery agents include a native supervisor surface', () => {
  assert.equal(deliveryAgents.deliverySupervisor, deliverySupervisorAgent);
  assert.equal(deliverySupervisorAgent.id, 'delivery-supervisor');
  assert.equal(Object.keys(deliveryAgents).includes('planner'), true);
  assert.equal(Object.keys(deliveryAgents).includes('judge'), true);
});

test('delivery agents publish a typed repoPath request context contract', () => {
  assert.equal(deliveryAgentRequestContextSchema.safeParse({ repoPath: '/tmp/example' }).success, true);
  assert.equal(deliveryAgentRequestContextSchema.safeParse({}).success, false);
  for (const agent of Object.values(deliveryAgents)) {
    assert.equal(agent.requestContextSchema, deliveryAgentRequestContextSchema);
  }
});

test('delivery agents use role-specific model slots', () => {
  assert.equal((deliveryAgents.planner as any).model, plannerModel);
  assert.equal((deliveryAgents.architect as any).model, architectModel);
  assert.equal((deliveryAgents.engineer as any).model, engineerModel);
  assert.equal((deliveryAgents.designer as any).model, designerModel);
  assert.equal((deliveryAgents.tester as any).model, testerModel);
  assert.equal((deliveryAgents.deployer as any).model, deliveryModel);
  assert.equal((deliveryAgents.deliverySupervisor as any).model, deliveryModel);
  assert.equal((deliveryAgents.judge as any).model, judgeModel);
});

test('delivery agents share a thread-scoped working memory contract', async () => {
  const memoryConfig = deliveryMemory.getMergedThreadConfig();

  assert.equal(memoryConfig.lastMessages, 12);
  assert.equal(memoryConfig.workingMemory?.enabled, true);
  assert.equal(memoryConfig.workingMemory?.scope, 'thread');
  assert.equal(memoryConfig.workingMemory?.schema, deliveryWorkingMemorySchema);

  for (const agent of Object.values(deliveryAgents)) {
    assert.equal(agent.hasOwnMemory(), true);
    assert.equal(await agent.getMemory(), deliveryMemory);
  }
});
