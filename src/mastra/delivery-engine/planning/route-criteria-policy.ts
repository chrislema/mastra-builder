import {
  taskOwnsCandidateRoute,
  taskOwnsGenericRouteModule,
  taskOwnsIndexSurface,
  taskOwnsLatestRoute,
  taskOwnsManualRunRoute,
  taskOwnsProfileRoute,
  taskOwnsRegenerationRoute,
  taskOwnsRouteModule,
  taskOwnsRouterSurface,
  taskOwnsRunRoute,
  taskOwnsSchedulerSurface,
  taskOwnsSessionRoute,
  taskOwnsWorkflowExecutionSurface,
} from '../task-plan-surface-policy';
import type { Task } from '../workflow-schemas';
import { taskHasRouteIntegrationContract } from './route-boundary-policy';
import { taskIsRootScaffold } from './scaffold-policy';

type CriterionPredicate = (criterion: string) => boolean;

function withoutMatchingCriteria(task: Task, predicate: CriterionPredicate) {
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !predicate(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter((criterion) => !predicate(criterion));

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

export function routeEndpointContractCriterion(criterion: string) {
  return (
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./:{}*-]+/i.test(criterion) ||
    /\b(?:endpoint|route)\b[\s\S]{0,80}\b(?:auth|session|protect|persist|store|return|delegate|transcript|candidate|regenerat)/i.test(
      criterion,
    )
  );
}

export function routeEndpointCriterionBelongsToTask(task: Task, criterion: string) {
  if (/\/api\//i.test(criterion)) return taskOwnsGenericRouteModule(task) || taskOwnsRouterSurface(task) || taskOwnsIndexSurface(task);
  if (/\/profiles?(?:\b|\/|:)/i.test(criterion)) return taskOwnsProfileRoute(task);
  if (/\/latest\b/i.test(criterion)) return taskOwnsLatestRoute(task);
  if (/(?:\/runs\/:id\/regenerate|regenerat)/i.test(criterion)) return taskOwnsRegenerationRoute(task);
  if (/(?:\/runs\/:id\/candidates?|candidates?)\b/i.test(criterion)) return taskOwnsCandidateRoute(task);
  if (/\/runs(?:\b|\/:id\b)/i.test(criterion)) return taskOwnsManualRunRoute(task);
  if (/\b(?:session|login|logout)\b/i.test(criterion)) return taskOwnsSessionRoute(task);
  if (/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//i.test(criterion)) return false;
  return true;
}

export function taskRouteEndpointSourceCriteria(task: Task) {
  if (!taskOwnsRouteModule(task) || !task.source_acceptance_criteria?.length) return [];
  return task.source_acceptance_criteria.filter(
    (criterion) => routeEndpointContractCriterion(criterion) && routeEndpointCriterionBelongsToTask(task, criterion),
  );
}

function routeOwnershipDriftCriterion(task: Task, criterion: string) {
  if (taskOwnsRouterSurface(task) && !taskHasRouteIntegrationContract(task)) {
    if (
      /router surface explicitly registers the browser session endpoint/i.test(criterion) ||
      /Route integration defines and enforces the protection matrix/i.test(criterion)
    ) {
      return true;
    }
  }

  if (!taskOwnsRouteModule(task)) return false;
  if (routeEndpointContractCriterion(criterion) && !routeEndpointCriterionBelongsToTask(task, criterion)) return true;

  if (taskOwnsRunRoute(task)) {
    if (/^Run, latest, candidate, and regeneration routes delegate/i.test(criterion)) return true;
    if (!taskOwnsRegenerationRoute(task) && /Transcript regeneration inserts/i.test(criterion)) return true;
  }

  return false;
}

export function withoutRouteOwnershipDriftCriteria(task: Task) {
  return withoutMatchingCriteria(task, (criterion) => routeOwnershipDriftCriterion(task, criterion));
}

function schedulerWorkflowExecutionCriterion(criterion: string) {
  return (
    /^Scheduled triggers and manual run routes create queued run records only/i.test(criterion) ||
    /^Workflow treats an empty (?:[\w/-]+\s+){0,4}list as a completed_empty terminal run/i.test(criterion) ||
    /^Workflow execution receives or resumes a queued run/i.test(criterion) ||
    /^Workflow profile-loading steps call the profile summary service boundary/i.test(criterion)
  );
}

export function withoutSchedulerWorkflowExecutionCriteria(task: Task) {
  if (!taskOwnsSchedulerSurface(task) || taskOwnsWorkflowExecutionSurface(task)) return task;
  return withoutMatchingCriteria(task, schedulerWorkflowExecutionCriterion);
}

function finalWorkerEntrypointCriterion(criterion: string) {
  return (
    /^src\/index\.js is the final Worker module entrypoint/i.test(criterion) ||
    /^src\/index\.js delegates fetch handling to src\/(?:router|http)\.[cm]?[jt]s/i.test(criterion) ||
    /^src\/index\.js delegates scheduled handling to src\/scheduler\.js/i.test(criterion) ||
    /^src\/index\.js exports the real WeeklyWorkflow implementation/i.test(criterion)
  );
}

export function withoutFinalWorkerEntrypointCriteria(task: Task) {
  if (!taskOwnsIndexSurface(task) || taskIsRootScaffold(task)) return task;
  return withoutMatchingCriteria(task, finalWorkerEntrypointCriterion);
}

export function withoutFinalWorkerEntrypointDrift(task: Task, finalDependencyIds: Set<string>) {
  if (!taskOwnsIndexSurface(task) || taskIsRootScaffold(task)) return task;
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !finalWorkerEntrypointCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !finalWorkerEntrypointCriterion(criterion),
  );
  const depends_on = task.depends_on.filter((dependency) => !finalDependencyIds.has(dependency));

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    depends_on.length === task.depends_on.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    depends_on,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}
