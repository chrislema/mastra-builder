import type { Task } from '../workflow-schemas';

export function taskSourceTaskId(task: Task) {
  return task.source_task_id?.trim() || task.id;
}

export function taskAcceptanceContractCriteria(task: Task) {
  return Array.from(new Set([...(task.source_acceptance_criteria ?? []), ...task.acceptance_criteria].filter(Boolean)));
}
