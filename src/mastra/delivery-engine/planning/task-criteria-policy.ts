import type { Task } from '../workflow-schemas';

export function appendTaskAcceptanceCriteria(task: Task, criteria: string[]) {
  const acceptance_criteria = Array.from(new Set([...task.acceptance_criteria, ...criteria]));
  return acceptance_criteria.length === task.acceptance_criteria.length ? task : { ...task, acceptance_criteria };
}
