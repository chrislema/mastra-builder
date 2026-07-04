import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryAgentRequestContextSchema,
  deliveryAgents,
  deliveryMemory,
  deliverySupervisorAgent,
  deliveryWorkingMemoryTemplate,
} from '../../src/mastra/delivery-engine/agents.ts';

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

test('delivery agents share a thread-scoped working memory contract', async () => {
  const memoryConfig = deliveryMemory.getMergedThreadConfig();

  assert.equal(memoryConfig.lastMessages, 12);
  assert.deepEqual(memoryConfig.workingMemory, {
    enabled: true,
    scope: 'thread',
    template: deliveryWorkingMemoryTemplate,
  });

  for (const agent of Object.values(deliveryAgents)) {
    assert.equal(agent.hasOwnMemory(), true);
    assert.equal(await agent.getMemory(), deliveryMemory);
  }
});
