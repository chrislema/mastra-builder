import type { Task, TaskPlan } from '../workflow-schemas';

export function uniqueTaskId(taskPlan: TaskPlan, baseId: string) {
  return uniqueTaskIdFromTasks(taskPlan.tasks, baseId);
}

export function uniqueTaskIdFromTasks(tasks: Task[], baseId: string) {
  const existingIds = new Set(tasks.map((task) => task.id));
  if (!existingIds.has(baseId)) return baseId;

  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}
