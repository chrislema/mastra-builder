import { normalizeDeliveryPathReference } from '../checks';
import { taskAcceptanceContractCriteria } from './task-contracts';
import {
  taskOwnedBoundaryPaths,
  taskOwnsIndexSurface,
  taskOwnsRouterSurface,
} from '../task-plan-surface-policy';
import type { Task, TaskPlan } from '../workflow-schemas';

export function taskRouterBoundarySurface(task: Task) {
  return (
    taskOwnedBoundaryPaths(task).find((path) => /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/.test(path)) ??
    'src/router.js'
  );
}

export function taskHasRouteIntegrationContract(task: Task) {
  return (
    taskOwnsRouterSurface(task) &&
    task.acceptance_criteria.some((criterion) =>
      /reachable through (?:the )?(?:src\/)?router|all declared (?:api )?endpoints?|routes? reachable through the Worker fetch path/i.test(
        criterion,
      ),
    )
  );
}

export function taskHasFinalWorkerEntrypointContract(task: Task) {
  return task.acceptance_criteria.some((criterion) => /^src\/index\.js is the final Worker module entrypoint/i.test(criterion));
}

function entrypointFetchDelegationSurfaces(criteria: string[]) {
  const surfaces = new Set<string>();
  for (const criterion of criteria) {
    for (const match of criterion.matchAll(/\bsrc\/index\.js delegates fetch handling to (src\/(?:router|http)\.[cm]?[jt]s)\b/gi)) {
      if (match[1]) surfaces.add(normalizeDeliveryPathReference(match[1]));
    }
  }
  return surfaces;
}

export function routeBoundaryConsistencyHygiene(taskPlan: TaskPlan) {
  const routeIntegrationSurfaces = new Set(
    taskPlan.tasks.filter(taskHasRouteIntegrationContract).map((task) => taskRouterBoundarySurface(task)),
  );
  const expectedIntegrationSurface = routeIntegrationSurfaces.size === 1 ? [...routeIntegrationSurfaces][0] : undefined;

  for (const task of taskPlan.tasks) {
    const criteria = taskAcceptanceContractCriteria(task);
    const delegatedSurfaces = entrypointFetchDelegationSurfaces(criteria);
    if (delegatedSurfaces.size > 1) {
      return {
        passed: false,
        reason: `${task.id} has contradictory final entrypoint fetch delegation surfaces: ${[...delegatedSurfaces].join(', ')}. Choose the same route boundary used by route integration.`,
      };
    }

    if (
      criteria.some((criterion) => /\bsrc\/index\.js does not reference src\/router\.js\b/i.test(criterion)) &&
      criteria.some((criterion) => /\bsrc\/index\.js delegates fetch handling to src\/router\.js\b/i.test(criterion))
    ) {
      return {
        passed: false,
        reason: `${task.id} says src/index.js must not reference src/router.js while also delegating fetch handling to src/router.js.`,
      };
    }

    const [delegatedSurface] = [...delegatedSurfaces];
    if (
      expectedIntegrationSurface &&
      delegatedSurface &&
      taskHasFinalWorkerEntrypointContract(task) &&
      delegatedSurface !== expectedIntegrationSurface
    ) {
      return {
        passed: false,
        reason: `${task.id} delegates fetch handling to ${delegatedSurface}, but route integration owns ${expectedIntegrationSurface}. Use one route boundary.`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}
