import { taskOwnedBoundaryPaths } from '../task-plan-surface-policy';
import type { TaskPlan } from '../workflow-schemas';
import { uniqueTaskId } from './task-ids';

function taskPlanHasOperatorDocumentation(taskPlan: TaskPlan) {
  return taskPlan.tasks.some((task) => taskOwnedBoundaryPaths(task).includes('README.md'));
}

export function normalizeTaskPlanOperatorDocumentation(taskPlan: TaskPlan): TaskPlan {
  if (taskPlanHasOperatorDocumentation(taskPlan)) return taskPlan;

  const id = uniqueTaskId(taskPlan, 'E99-operator-documentation');
  return {
    ...taskPlan,
    tasks: [
      ...taskPlan.tasks,
      {
        id,
        owner: 'engineer',
        deliverable: "Document local Worker validation, required Cloudflare resources, and Chris's human-approved Wrangler deployment flow.",
        depends_on: taskPlan.tasks.map((task) => task.id),
        acceptance_criteria: [
          'README.md documents local development and validation with Wrangler CLI, including npm scripts and expected ports.',
          'README.md lists required Cloudflare resources, bindings, secrets, and Workers AI binding expectations.',
          'README.md explains source-control expectations: local git checkpoints are allowed, while pushes/PRs through gh require explicit human direction, and production deploy waits for human approval before running wrangler deploy --env production.',
        ],
        owned_surfaces: ['README.md'],
      },
    ],
  };
}

export function operatorDocumentationHygiene(taskPlan: TaskPlan) {
  if (taskPlanHasOperatorDocumentation(taskPlan)) return { passed: true, reason: 'ok' };

  return {
    passed: false,
    reason:
      'Task plan does not include README.md operator documentation. Add an engineer-owned README.md task that captures local Wrangler validation, required Cloudflare resources/bindings, local git checkpoints, explicit human direction before gh push/PR actions, and human-approved wrangler deploy --env production.',
  };
}
