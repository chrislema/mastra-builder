import type { Task, TaskPlan } from './workflow-schemas';

export function generatedSliceFamilyId(taskId: string) {
  return taskId.replace(/-part-\d+$/, '');
}

function generatedSliceRank(taskId: string) {
  const match = taskId.match(/-part-(\d+)$/);
  return match ? Number(match[1]) : 1;
}

export function generatedSliceFamilyTasks(tasks: Task[], task: Task) {
  const familyId = generatedSliceFamilyId(task.id);
  return tasks.filter((candidate) => generatedSliceFamilyId(candidate.id) === familyId);
}

export function finalGeneratedSliceTaskId(tasks: Task[], taskId: string) {
  const familyId = generatedSliceFamilyId(taskId);
  const family = tasks.filter((task) => generatedSliceFamilyId(task.id) === familyId);
  if (!family.some((task) => task.id !== familyId)) return taskId;
  return [...family].sort((left, right) => generatedSliceRank(right.id) - generatedSliceRank(left.id))[0]?.id ?? taskId;
}

function generatedSliceFinalByMember(taskPlan: TaskPlan) {
  const families = new Map<string, Task[]>();
  for (const task of taskPlan.tasks) {
    const familyId = generatedSliceFamilyId(task.id);
    const tasks = families.get(familyId) ?? [];
    tasks.push(task);
    families.set(familyId, tasks);
  }

  const finalByMember = new Map<string, string>();
  for (const [familyId, tasks] of families.entries()) {
    if (!tasks.some((task) => task.id !== familyId)) continue;
    const finalTask = [...tasks].sort((left, right) => generatedSliceRank(right.id) - generatedSliceRank(left.id))[0];
    if (!finalTask) continue;
    for (const task of tasks) finalByMember.set(task.id, finalTask.id);
  }

  return finalByMember;
}

export function generatedSliceAcceptanceCriterion(criterion: string) {
  const normalized = criterion.trim();
  return (
    /^Implement delivery slice \d+\/\d+:/i.test(normalized) ||
    /^Replace any preflight stubs for this slice with real implementation code before returning\.?$/i.test(normalized) ||
    /^Keep this slice compatible with previously completed delivery slices and npm run typecheck\.?$/i.test(normalized)
  );
}

export type GeneratedSliceDependencyPolicy = {
  canTaskDependOn: (taskId: string, dependencyId: string) => boolean;
  canUsePreEntrypointGeneratedDependency: (dependencyId: string, finalDependencyId: string) => boolean;
};

export function normalizeTaskPlanGeneratedSliceDependencies(
  taskPlan: TaskPlan,
  policy: GeneratedSliceDependencyPolicy,
): TaskPlan {
  const finalByMember = generatedSliceFinalByMember(taskPlan);
  if (!finalByMember.size) return taskPlan;

  let changed = false;
  const tasks = taskPlan.tasks.map((task) => {
    const taskFamilyId = generatedSliceFamilyId(task.id);
    const depends_on = Array.from(
      new Set(
        task.depends_on.map((dependency) => {
          const finalDependency = finalByMember.get(dependency);
          if (!finalDependency || finalDependency === dependency) return dependency;
          if (generatedSliceFamilyId(dependency) === taskFamilyId) return dependency;
          if (!policy.canTaskDependOn(task.id, finalDependency)) return dependency;
          if (policy.canUsePreEntrypointGeneratedDependency(dependency, finalDependency)) return dependency;

          changed = true;
          return finalDependency;
        }),
      ),
    );

    if (
      depends_on.length === task.depends_on.length &&
      depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ) {
      return task;
    }

    return { ...task, depends_on };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

export function generatedSliceDependencyHygiene(taskPlan: TaskPlan, policy: GeneratedSliceDependencyPolicy) {
  const finalByMember = generatedSliceFinalByMember(taskPlan);
  if (!finalByMember.size) return { passed: true, reason: 'ok' };

  for (const task of taskPlan.tasks) {
    const taskFamilyId = generatedSliceFamilyId(task.id);
    for (const dependency of task.depends_on) {
      const finalDependency = finalByMember.get(dependency);
      if (!finalDependency || finalDependency === dependency) continue;
      if (generatedSliceFamilyId(dependency) === taskFamilyId) continue;
      if (!policy.canTaskDependOn(task.id, finalDependency)) continue;
      if (policy.canUsePreEntrypointGeneratedDependency(dependency, finalDependency)) continue;

      return {
        passed: false,
        reason: `${task.id} depends_on ${dependency}, but ${dependency} is an intermediate generated slice. Depend on ${finalDependency} so downstream work waits for the complete slice family before consuming it.`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}
