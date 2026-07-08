import { taskCanSafelyDependOn } from '../task-plan-dependencies';
import {
  finalGeneratedSliceTaskId,
  generatedSliceDependencyHygiene as generatedSliceDependencyHygieneWithPolicy,
  normalizeTaskPlanGeneratedSliceDependencies as normalizeGeneratedSliceDependencies,
} from '../task-plan-generated-slices';
import {
  taskOwnsIndexSurface,
  taskOwnsPublicAppSurface,
  taskOwnsRouteModule,
} from '../task-plan-surface-policy';
import type { Task, TaskPlan } from '../workflow-schemas';
import { taskHasRouteIntegrationContract } from './route-boundary-policy';

export function preEntrypointBoundaryDependencyId(tasks: Task[], task: Task) {
  const finalTaskId = finalGeneratedSliceTaskId(tasks, task.id);
  const finalTask = tasks.find((candidate) => candidate.id === finalTaskId);
  if (!finalTask || finalTask.id === task.id) return task.id;
  if (taskOwnsRouteModule(finalTask) || taskOwnsPublicAppSurface(finalTask) || taskOwnsIndexSurface(finalTask)) {
    return task.id;
  }
  return finalTask.id;
}

export function routeIntegrationDependencyId(tasks: Task[], task: Task) {
  const finalTaskId = finalGeneratedSliceTaskId(tasks, task.id);
  const finalTask = tasks.find((candidate) => candidate.id === finalTaskId);
  if (!finalTask || finalTask.id === task.id) return task.id;
  if (taskOwnsRouteModule(finalTask)) return finalTask.id;
  if (taskOwnsPublicAppSurface(finalTask) || taskOwnsIndexSurface(finalTask)) return preEntrypointBoundaryDependencyId(tasks, task);
  return finalTask.id;
}

function canUsePreEntrypointGeneratedDependency(tasks: Task[], dependency: string, finalDependency: string) {
  const dependencyTask = tasks.find((candidate) => candidate.id === dependency);
  const finalTask = tasks.find((candidate) => candidate.id === finalDependency);
  if (!dependencyTask || !finalTask) return false;
  if (taskOwnsRouteModule(finalTask)) return false;
  if (!taskOwnsPublicAppSurface(finalTask) && !taskOwnsIndexSurface(finalTask)) return false;
  return preEntrypointBoundaryDependencyId(tasks, dependencyTask) === dependency;
}

function generatedSliceDependencyPolicy(taskPlan: TaskPlan) {
  return {
    canTaskDependOn: (taskId: string, dependencyId: string) => taskCanSafelyDependOn(taskPlan, taskId, dependencyId),
    canUsePreEntrypointGeneratedDependency: (dependencyId: string, finalDependencyId: string) =>
      canUsePreEntrypointGeneratedDependency(taskPlan.tasks, dependencyId, finalDependencyId),
  };
}

export function normalizeTaskPlanGeneratedSliceDependencies(taskPlan: TaskPlan): TaskPlan {
  return normalizeGeneratedSliceDependencies(taskPlan, generatedSliceDependencyPolicy(taskPlan));
}

export function generatedSliceDependencyHygiene(taskPlan: TaskPlan) {
  return generatedSliceDependencyHygieneWithPolicy(taskPlan, generatedSliceDependencyPolicy(taskPlan));
}
