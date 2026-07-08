import assert from 'node:assert/strict';
import test from 'node:test';
import {
  taskOwnsCandidateRoute,
  taskOwnsLatestRoute,
  taskOwnsManualRunRoute,
  taskOwnsProfileRoute,
  taskOwnsRegenerationRoute,
  taskOwnsRouteModule,
} from '../../src/mastra/delivery-engine/task-plan-surface-policy.ts';
import type { Task } from '../../src/mastra/delivery-engine/workflow-schemas.ts';

const task = (overrides: Partial<Task>): Task => ({
  id: 'T01',
  owner: 'engineer',
  deliverable: 'Implement route surface',
  depends_on: [],
  acceptance_criteria: [],
  owned_surfaces: [],
  ...overrides,
});

test('route surface policy classifies split route files by family', () => {
  assert.equal(taskOwnsRouteModule(task({ owned_surfaces: ['src/routes/latest.ts'] })), true);
  assert.equal(taskOwnsLatestRoute(task({ owned_surfaces: ['src/routes/latest.ts'] })), true);
  assert.equal(taskOwnsProfileRoute(task({ owned_surfaces: ['src/routes/profiles.ts'] })), true);
  assert.equal(taskOwnsManualRunRoute(task({ owned_surfaces: ['src/routes/runs.ts'] })), true);
  assert.equal(taskOwnsRegenerationRoute(task({ owned_surfaces: ['src/routes/regeneration.ts'] })), true);
  assert.equal(taskOwnsCandidateRoute(task({ owned_surfaces: ['src/routes/candidates.ts'] })), true);
});

test('route surface policy classifies generic route barrels from positive task contracts only', () => {
  const genericRoutes = task({
    owned_surfaces: ['src/routes.ts'],
    acceptance_criteria: [
      'GET /latest returns the latest completed transcript.',
      'POST /runs creates a queued manual run record.',
      'Candidate routes return candidate metadata.',
    ],
  });

  assert.equal(taskOwnsLatestRoute(genericRoutes), true);
  assert.equal(taskOwnsManualRunRoute(genericRoutes), true);
  assert.equal(taskOwnsCandidateRoute(genericRoutes), true);
});

test('route surface policy ignores negated product route wording', () => {
  const genericRoutes = task({
    owned_surfaces: ['src/routes.ts'],
    acceptance_criteria: [
      'It does not introduce profile routes.',
      'Must not include latest transcript endpoints.',
      'No database, auth, server state, D1, Durable Objects, Queues, Workflows, server-side file uploads, or run routes.',
    ],
  });

  assert.equal(taskOwnsProfileRoute(genericRoutes), false);
  assert.equal(taskOwnsLatestRoute(genericRoutes), false);
  assert.equal(taskOwnsManualRunRoute(genericRoutes), false);
});
