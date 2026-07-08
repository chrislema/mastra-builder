import assert from 'node:assert/strict';
import test from 'node:test';
import { renderProjectScaffold } from '../../src/mastra/delivery-engine/project-factory/index.ts';
import { annotateTaskPlanWithTypedMetadata } from '../../src/mastra/delivery-engine/task-plan-metadata.ts';
import type { TaskPlan } from '../../src/mastra/delivery-engine/workflow-schemas.ts';

function taskPlan(ownedSurfaces: string[]): TaskPlan {
  return {
    artifact_type: 'task-plan',
    scope: 'metadata fixture',
    tasks: ownedSurfaces.map((surface, index) => ({
      id: `T${index + 1}`,
      owner: surface.startsWith('public/') ? 'designer' : 'engineer',
      deliverable: `Implement ${surface}`,
      depends_on: index === 0 ? [] : [`T${index}`],
      acceptance_criteria: ['verified'],
      owned_surfaces: [surface],
    })),
    technology_decisions: [],
    open_decisions: [],
    risks: [],
  };
}

test('task plan metadata classifies evidence tasks by runtime without planner-authored fields', () => {
  const annotated = annotateTaskPlanWithTypedMetadata(
    taskPlan(['test/contracts.test.ts', 'test/api-routes.test.ts', 'test/frontend-behavior.test.js']),
  );

  assert.deepEqual(
    annotated.tasks.map((task) => ({
      evidence: task.metadata?.evidence?.kind,
      runtime: task.metadata?.runtime?.kind,
      task: task.metadata?.task?.kind,
    })),
    [
      { evidence: 'contract', runtime: 'node', task: 'evidence' },
      { evidence: 'api-route', runtime: 'worker', task: 'evidence' },
      { evidence: 'frontend', runtime: 'jsdom', task: 'evidence' },
    ],
  );
});

test('task plan metadata references factory-owned scaffold surfaces from the manifest', () => {
  const scaffold = renderProjectScaffold({ projectName: 'Metadata Worker', requestedProfiles: ['worker-d1'] });
  const annotated = annotateTaskPlanWithTypedMetadata(
    taskPlan(['src/index.ts', 'migrations/0001_app_events.sql', 'public/app.js']),
    scaffold.manifest,
  );

  assert.deepEqual(
    annotated.tasks.map((task) => ({
      task: task.metadata?.task?.kind,
      surface: task.metadata?.surface?.kind,
      scaffold: task.metadata?.scaffold,
    })),
    [
      {
        task: 'worker',
        surface: 'worker',
        scaffold: { owned_by_factory: true, generated_files: ['src/index.ts'] },
      },
      {
        task: 'storage',
        surface: 'migration',
        scaffold: { owned_by_factory: true, generated_files: ['migrations/0001_app_events.sql'] },
      },
      {
        task: 'frontend',
        surface: 'frontend',
        scaffold: { owned_by_factory: true, generated_files: ['public/app.js'] },
      },
    ],
  );
});
