import { normalizeDeliveryPathReference } from '../checks';
import { effectiveOwnedSurfaces } from '../task-plan-surface-policy';
import type { SourcePolicy, TaskPlan } from '../workflow-schemas';

function taskPlanPagesFunctionSurfaces(taskPlan: TaskPlan) {
  return taskPlan.tasks.flatMap((task) =>
    effectiveOwnedSurfaces(task)
      .map(normalizeDeliveryPathReference)
      .filter((surface) => surface === 'functions' || surface.startsWith('functions/'))
      .map((surface) => `${task.id}:${surface}`),
  );
}

export function pagesFunctionsExceptionHygiene(taskPlan: TaskPlan, sourcePolicy?: SourcePolicy) {
  const pagesSurfaces = taskPlanPagesFunctionSurfaces(taskPlan);
  if (!pagesSurfaces.length) return { passed: true, reason: 'ok' };
  if (sourcePolicy?.pagesRequired) return { passed: true, reason: 'ok' };

  return {
    passed: false,
    reason: `Task plan owns Pages Functions surfaces (${pagesSurfaces.join(', ')}), but vision/spec did not declaratively require Cloudflare Pages. Use standalone Worker routes under src/ or workers/ unless the source docs explicitly say to use Pages.`,
  };
}
