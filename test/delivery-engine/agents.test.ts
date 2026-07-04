import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryAgents, deliverySupervisorAgent } from '../../src/mastra/delivery-engine/agents.ts';

test('delivery agents include a native supervisor surface', () => {
  assert.equal(deliveryAgents.deliverySupervisor, deliverySupervisorAgent);
  assert.equal(deliverySupervisorAgent.id, 'delivery-supervisor');
  assert.equal(Object.keys(deliveryAgents).includes('planner'), true);
  assert.equal(Object.keys(deliveryAgents).includes('judge'), true);
});
