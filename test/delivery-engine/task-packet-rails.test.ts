import assert from 'node:assert/strict';
import test from 'node:test';
import { renderProjectScaffold } from '../../src/mastra/delivery-engine/project-factory/index.ts';
import { annotateTaskPlanWithTypedMetadata } from '../../src/mastra/delivery-engine/task-plan-metadata.ts';
import {
  taskPacketRailsForTask,
  verificationCommandClassForTask,
} from '../../src/mastra/delivery-engine/task-packet-rails.ts';
import type { TaskPlan } from '../../src/mastra/delivery-engine/workflow-schemas.ts';

function taskPlan(ownedSurfaces: string[]): TaskPlan {
  return {
    artifact_type: 'task-plan',
    scope: 'task rails fixture',
    tasks: ownedSurfaces.map((surface, index) => ({
      id: `T${index + 1}`,
      owner: surface.startsWith('public/') ? 'designer' : 'engineer',
      deliverable: `Implement ${surface}`,
      depends_on: index === 0 ? [] : [`T${index}`],
      acceptance_criteria: ['verified'],
      owned_surfaces: [surface],
      source_acceptance_criteria: [`source contract for ${surface}`],
    })),
    technology_decisions: [],
    open_decisions: [],
    risks: [],
  };
}

test('task packet rails classify test verification by typed runtime metadata', () => {
  const annotated = annotateTaskPlanWithTypedMetadata(
    taskPlan(['test/contracts.test.ts', 'test/api-routes.test.ts', 'test/frontend-behavior.test.js']),
  );

  assert.deepEqual(
    annotated.tasks.map((task) => verificationCommandClassForTask(task)),
    ['node-unit', 'worker-unit', 'frontend-dom'],
  );
});

test('task packet rails keep scaffold-owned files read-only unless task-owned', () => {
  const scaffold = renderProjectScaffold({ projectName: 'Rails Worker' });
  const annotated = annotateTaskPlanWithTypedMetadata(taskPlan(['src/index.js', 'public/app.js']), scaffold.manifest);
  const workerTask = annotated.tasks[0];

  const rails = taskPacketRailsForTask({
    taskPlan: annotated,
    task: workerTask,
    scaffoldManifest: scaffold.manifest,
    boundarySurfaces: ['src/index.js'],
    sourceContracts: workerTask.source_acceptance_criteria,
    maxAttempts: 3,
    maxToolStepsPerAttempt: 8,
  });

  assert.deepEqual(rails.allowed_surfaces, ['src/index.js']);
  assert.deepEqual(rails.scaffold_owned_allowed_surfaces, ['src/index.js']);
  assert.equal(rails.scaffold_owned_readonly_surfaces.includes('public/app.js'), true);
  assert.equal(rails.edit_policy.may_edit_scaffold_owned_files, true);
  assert.equal(rails.verification_command_class, 'typecheck');
  assert.deepEqual(rails.model_budget, {
    stage: 'build',
    max_attempts: 3,
    max_model_calls: 3,
    max_tool_steps_per_attempt: 8,
  });
});

test('task packet rails carry direct dependency surfaces without granting edit ownership', () => {
  const annotated = annotateTaskPlanWithTypedMetadata(taskPlan(['src/contracts.ts', 'src/routes/profiles.ts']));
  const routeTask = annotated.tasks[1];

  const rails = taskPacketRailsForTask({
    taskPlan: annotated,
    task: routeTask,
    boundarySurfaces: ['src/routes/profiles.ts'],
    sourceContracts: routeTask.source_acceptance_criteria,
    maxAttempts: 2,
  });

  assert.deepEqual(rails.allowed_surfaces, ['src/routes/profiles.ts']);
  assert.deepEqual(rails.direct_dependency_surfaces, ['src/contracts.ts']);
  assert.equal(rails.direct_dependency_surfaces.includes('src/routes/profiles.ts'), false);
  assert.equal(rails.edit_policy.may_edit_scaffold_owned_files, false);
  assert.equal(rails.verification_command_class, 'typecheck');
});
