import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  deliveryMemoryResourceId,
  deliveryMemoryRolePolicies,
  deliveryRunMemory,
} from '../../src/mastra/delivery-engine/memory.ts';

test('delivery memory identity is stable per repo and run-scoped per delivery run', () => {
  const repoPath = '/tmp/delivery-memory-project';
  const memory = deliveryRunMemory({ repoPath, runId: 'run-123', role: 'planner' });

  assert.equal(memory.resource, deliveryMemoryResourceId(repoPath));
  assert.equal(memory.resource, deliveryMemoryResourceId(resolve(repoPath)));
  assert.deepEqual(memory.thread, {
    id: 'run-123',
    title: 'Delivery run-123',
    metadata: {
      deliveryEngine: true,
      repoPath: resolve(repoPath),
      runId: 'run-123',
    },
  });
  assert.deepEqual(memory.options, { readOnly: false });
});

test('delivery memory role policy makes judge read-only and builders writable', () => {
  assert.equal(deliveryMemoryRolePolicies.judge.readOnly, true);
  assert.equal(deliveryMemoryRolePolicies.planner.readOnly, false);
  assert.equal(deliveryMemoryRolePolicies.engineer.readOnly, false);
  assert.equal(deliveryMemoryRolePolicies.tester.readOnly, false);

  assert.deepEqual(deliveryRunMemory({ repoPath: '/tmp/repo', runId: 'run-judge', role: 'judge' }).options, {
    readOnly: true,
  });
});
