import type { Task, TaskPlan } from './workflow-schemas';

export function taskDependsOn(taskPlan: TaskPlan, taskId: string, dependencyId: string, seen = new Set<string>()): boolean {
  if (taskId === dependencyId) return true;
  if (seen.has(taskId)) return false;
  seen.add(taskId);

  const task = taskPlan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return false;
  if (task.depends_on.includes(dependencyId)) return true;
  return task.depends_on.some((parentId) => taskDependsOn(taskPlan, parentId, dependencyId, seen));
}

export function taskCanSafelyDependOn(taskPlan: TaskPlan, taskId: string, dependencyId: string) {
  return taskId !== dependencyId && !taskDependsOn(taskPlan, dependencyId, taskId);
}

export function taskListDependsOn(tasks: Task[], taskId: string, dependencyId: string, seen = new Set<string>()): boolean {
  if (taskId === dependencyId) return true;
  if (seen.has(taskId)) return false;
  seen.add(taskId);

  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) return false;
  if (task.depends_on.includes(dependencyId)) return true;
  return task.depends_on.some((parentId) => taskListDependsOn(tasks, parentId, dependencyId, seen));
}

export function taskCanDependOnTaskList(tasks: Task[], taskId: string, dependencyId: string) {
  return taskId !== dependencyId && !taskListDependsOn(tasks, dependencyId, taskId);
}

export function topoOrderTasks(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      if (byId.has(dependency)) indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue = tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0);
  const ordered: Task[] = [];
  while (queue.length) {
    const task = queue.shift();
    if (!task) continue;
    ordered.push(task);
    for (const candidate of tasks) {
      if (candidate.depends_on.includes(task.id)) {
        indegree.set(candidate.id, (indegree.get(candidate.id) ?? 0) - 1);
        if (indegree.get(candidate.id) === 0) queue.push(candidate);
      }
    }
  }

  if (ordered.length !== tasks.length) {
    throw new Error('task dependency graph is cyclic or incomplete');
  }

  return ordered;
}

export function appendDependencies(task: Task, dependencies: string[]) {
  const depends_on = Array.from(new Set([...task.depends_on, ...dependencies.filter((dependency) => dependency !== task.id)]));
  return depends_on.length === task.depends_on.length &&
    depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ? task
    : { ...task, depends_on };
}

export function insertTaskAfterDependencies(tasks: Task[], task: Task) {
  const dependencyIndexes = task.depends_on
    .map((dependency) => tasks.findIndex((candidate) => candidate.id === dependency))
    .filter((index) => index >= 0);
  const insertAfter = dependencyIndexes.length ? Math.max(...dependencyIndexes) : -1;
  return [...tasks.slice(0, insertAfter + 1), task, ...tasks.slice(insertAfter + 1)];
}

export function moveTaskAfterDependencies(tasks: Task[], taskId: string) {
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return { tasks, changed: false };

  const task = tasks[index];
  const remaining = tasks.filter((_, candidateIndex) => candidateIndex !== index);
  const next = insertTaskAfterDependencies(remaining, task);
  const changed = next.some((task, candidateIndex) => task.id !== tasks[candidateIndex]?.id);
  return { tasks: next, changed };
}

export function withoutCyclicDependencies(
  tasks: Task[],
  options: { preserveTask?: (task: Task) => boolean } = {},
) {
  let changed = false;
  const next = tasks.map((task) => {
    if (options.preserveTask?.(task)) return task;
    const depends_on = task.depends_on.filter((dependency) => {
      if (!taskListDependsOn(tasks, dependency, task.id)) return true;
      changed = true;
      return false;
    });
    return depends_on.length === task.depends_on.length ? task : { ...task, depends_on };
  });

  return { tasks: next, changed };
}
