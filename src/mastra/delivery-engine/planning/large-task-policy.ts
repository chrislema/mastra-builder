import { normalizeDeliveryPathReference } from '../checks';
import { concreteOwnedSurfacePath } from '../task-plan-surface-policy';
import type { Task, TaskPlan } from '../workflow-schemas';
import { taskAcceptanceContractCriteria, taskSourceTaskId } from './task-contracts';

const maxImplementationOwnedSurfacesPerTask = 2;
const minImplementationOwnedSurfacesToSplit = 3;

function splittableImplementationSurfacePath(surface: string) {
  const path = concreteOwnedSurfacePath(surface);
  if (!path) return undefined;
  if (path === 'src/index.ts') return undefined;
  if (path === 'package.json' || path === 'tsconfig.json' || path === 'wrangler.toml') return undefined;
  if (path.startsWith('migrations/')) return undefined;
  if (path.startsWith('src/') && /\.[cm]?[jt]s$/.test(path)) return path;
  return undefined;
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function taskIsLargeImplementationTask(task: Task) {
  const surfaces = task.owned_surfaces.map(splittableImplementationSurfacePath);
  return (
    task.owner === 'engineer' &&
    surfaces.length >= minImplementationOwnedSurfacesToSplit &&
    surfaces.every(Boolean)
  );
}

function implementationSliceAcceptanceCriteria(task: Task, surfaces: string[], sliceNumber: number, sliceCount: number) {
  const paths = surfaces.map(
    (surface) => splittableImplementationSurfacePath(surface) ?? normalizeDeliveryPathReference(surface),
  );
  return [
    `Implement delivery slice ${sliceNumber}/${sliceCount}: ${paths.join(', ')}.`,
    `Replace any preflight stubs for this slice with real implementation code before returning.`,
    `Keep this slice compatible with previously completed delivery slices and npm run typecheck.`,
    ...task.acceptance_criteria.filter((criterion) => paths.some((path) => criterion.includes(path))),
  ];
}

function splitLargeImplementationTask(task: Task) {
  if (!taskIsLargeImplementationTask(task)) return [task];

  const chunks = chunkItems(task.owned_surfaces, maxImplementationOwnedSurfacesPerTask);
  const sourceTaskId = taskSourceTaskId(task);
  const sourceAcceptanceCriteria = taskAcceptanceContractCriteria(task);
  return chunks.map((surfaces, index) => {
    const sliceNumber = index + 1;
    const previousSliceId = index === 1 ? task.id : `${task.id}-part-${index}`;
    return {
      ...task,
      id: index === 0 ? task.id : `${task.id}-part-${sliceNumber}`,
      deliverable: `${task.deliverable} (delivery slice ${sliceNumber}/${chunks.length})`,
      depends_on: index === 0 ? task.depends_on : [previousSliceId],
      acceptance_criteria: implementationSliceAcceptanceCriteria(task, surfaces, sliceNumber, chunks.length),
      owned_surfaces: surfaces,
      source_task_id: sourceTaskId,
      source_acceptance_criteria: sourceAcceptanceCriteria,
    };
  });
}

export function normalizeTaskPlanLargeStorageTasks(taskPlan: TaskPlan): TaskPlan {
  const expandedTasks: Task[] = [];
  const splitLastTaskId = new Map<string, string>();
  const splitTaskIds = new Set<string>();
  let changed = false;

  for (const task of taskPlan.tasks) {
    const slices = splitLargeImplementationTask(task);
    expandedTasks.push(...slices);
    if (slices.length > 1) {
      changed = true;
      splitLastTaskId.set(task.id, slices[slices.length - 1].id);
      for (const slice of slices) splitTaskIds.add(slice.id);
    }
  }

  if (!changed) return taskPlan;

  const tasks = expandedTasks.map((task) => {
    if (splitTaskIds.has(task.id)) return task;

    const depends_on = Array.from(new Set(task.depends_on.map((dependency) => splitLastTaskId.get(dependency) ?? dependency)));
    if (
      depends_on.length === task.depends_on.length &&
      depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ) {
      return task;
    }

    return { ...task, depends_on };
  });

  return { ...taskPlan, tasks };
}
