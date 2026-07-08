import { normalizeDeliveryPathReference } from '../checks';
import { looksLikeRepoPathReference } from '../task-plan-surface-policy';
import type { TaskPlan } from '../workflow-schemas';

function ownedSurfaceReferenceIsConcrete(surface: string) {
  const normalized = normalizeDeliveryPathReference(surface);
  if (/^unknown:\s*\S/i.test(normalized)) return true;
  return looksLikeRepoPathReference(normalized);
}

function ownedSurfaceReferenceIsWildcard(surface: string) {
  const normalized = normalizeDeliveryPathReference(surface);
  if (/^unknown:/i.test(normalized)) return false;
  return /[*?]/.test(normalized);
}

export function ownedSurfaceHygiene(taskPlan: TaskPlan) {
  for (const task of taskPlan.tasks) {
    for (const surface of task.owned_surfaces) {
      if (ownedSurfaceReferenceIsWildcard(surface)) {
        return {
          passed: false,
          reason: `${task.id} owned_surfaces contains wildcard surface "${surface}". Enumerate concrete file paths so missing files, boundaries, and handoffs can be verified deterministically; use "unknown: <why>" only when a path is genuinely unknowable.`,
        };
      }
      if (ownedSurfaceReferenceIsConcrete(surface)) continue;
      return {
        passed: false,
        reason: `${task.id} owned_surfaces contains conceptual surface "${surface}". Use concrete repo paths like wrangler.jsonc, src/index.ts, public/settings.html, migrations/0001_schema.sql, or "unknown: <reason>".`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}
