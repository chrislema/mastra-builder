import { fileOwnership } from '../checks';
import { concreteOwnedSurfacePath, taskOwnedBoundaryPaths } from '../task-plan-surface-policy';
import type { TaskPlan } from '../workflow-schemas';

export function taskOwnedSurfaceRoleHygiene(taskPlan: TaskPlan) {
  for (const task of taskPlan.tasks) {
    const paths = taskOwnedBoundaryPaths(task);
    if (!paths.length) continue;

    const ownership = fileOwnership({ role: task.owner, paths });
    if (!ownership.passed) {
      return {
        passed: false,
        reason: `${task.id} owner ${task.owner} cannot own one or more surfaces: ${ownership.reason}`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

function designerCanOwnSurface(path: string) {
  return fileOwnership({ role: 'designer', paths: [path] }).passed;
}

function engineerCanOwnSurface(path: string) {
  return fileOwnership({ role: 'engineer', paths: [path] }).passed;
}

export function normalizeTaskPlanRoleBoundaries(taskPlan: TaskPlan): TaskPlan {
  const designerOwnedPaths = new Set(
    taskPlan.tasks
      .filter((task) => task.owner === 'designer')
      .flatMap(taskOwnedBoundaryPaths),
  );

  let changed = false;
  const tasks = taskPlan.tasks.map((task) => {
    if (task.owner !== 'engineer') return task;

    const boundaryPaths = taskOwnedBoundaryPaths(task);
    if (
      boundaryPaths.length > 0 &&
      boundaryPaths.every((path) => !engineerCanOwnSurface(path) && designerCanOwnSurface(path))
    ) {
      changed = true;
      return {
        ...task,
        owner: 'designer' as const,
      };
    }

    const misplacedPaths = new Set(
      boundaryPaths.filter(
        (path) => !engineerCanOwnSurface(path) && designerCanOwnSurface(path) && designerOwnedPaths.has(path),
      ),
    );
    if (!misplacedPaths.size) return task;

    const owned_surfaces = task.owned_surfaces.filter((surface) => {
      const path = concreteOwnedSurfacePath(surface);
      return !path || !misplacedPaths.has(path);
    });
    if (!owned_surfaces.length) return task;

    const acceptance_criteria = task.acceptance_criteria.filter(
      (criterion) => !Array.from(misplacedPaths).some((path) => criterion.includes(path)),
    );

    changed = true;
    return {
      ...task,
      owned_surfaces,
      acceptance_criteria: acceptance_criteria.length ? acceptance_criteria : task.acceptance_criteria,
    };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}
