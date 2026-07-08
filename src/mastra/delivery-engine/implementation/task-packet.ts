import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  concreteOwnedSurfacePath,
  normalizedOwnedSurfaces,
  taskOwnedBoundaryPaths,
} from '../task-plan-surface-policy';
import type { Task, TaskPlan } from '../workflow-schemas';
import { taskBoundarySurfaces } from './task-boundaries';

function concreteTaskSurfacePaths(task: Task) {
  return normalizedOwnedSurfaces(task)
    .filter((surface) => !surface.includes('*'))
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => typeof path === 'string' && !/^unknown:/i.test(path));
}

export function directDependencySurfacePaths(taskPlan: TaskPlan, task: Task) {
  const byId = new Map(taskPlan.tasks.map((candidate) => [candidate.id, candidate]));
  const paths = task.depends_on.flatMap((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return dependency ? concreteTaskSurfacePaths(dependency) : [];
  });
  return Array.from(new Set(paths.filter((path) => !taskOwnedBoundaryPaths(task).includes(path))));
}

export function focusedRepairContextPaths(taskPlan: TaskPlan, task: Task, boundarySurfaces: string[]) {
  const boundaryPaths = boundarySurfaces
    .filter((surface) => !surface.includes('*'))
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path));
  const dependencyPaths = directDependencySurfacePaths(taskPlan, task).filter(
    (path) => path.startsWith('src/') || path.startsWith('migrations/'),
  );
  return Array.from(new Set([...boundaryPaths, ...dependencyPaths]));
}

export function existingOwnedFiles(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task).filter((surface) => {
    if (surface.includes('*')) return false;
    const path = concreteOwnedSurfacePath(surface);
    return path ? existsSync(join(resolve(repoPath), path)) : false;
  });
}
