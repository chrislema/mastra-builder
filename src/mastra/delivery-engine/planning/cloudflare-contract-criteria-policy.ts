import {
  taskD1MigrationSurface,
  taskOwnsIndexSurface,
  taskOwnsManualRunRoute,
  taskOwnsSchedulerSurface,
  taskOwnsSessionRoute,
  taskOwnsWorkflowSurface,
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

function publicUiRawAdminTokenCriterion(criterion: string) {
  return (
    /\bpublic\/app\.js\b/i.test(criterion) &&
    /\b(?:ADMIN_TOKEN|admin[-_\s]?token)\b/i.test(criterion) &&
    /\b(collects?|sends?|stores?|storage|persist|Authorization:\s*Bearer|raw|handling|entry|entering)\b/i.test(criterion) &&
    !/\b(browser-safe|session|cookie|HttpOnly)\b/i.test(criterion)
  );
}

export function withoutPublicUiRawAdminTokenCriteria(task: Task) {
  return withoutMatchingCriteria(task, publicUiRawAdminTokenCriterion);
}

function sessionSecretFallbackCriterion(criterion: string) {
  return (
    /\bSESSION_SECRET when configured\b/i.test(criterion) ||
    /\bADMIN_TOKEN\b[\s\S]{0,120}\bfallback(?: signing| secret| signing behavior)?\b/i.test(criterion) ||
    /\bfallback(?: signing| secret| signing behavior)?\b[\s\S]{0,120}\bADMIN_TOKEN\b/i.test(criterion)
  );
}

export function withoutSessionSecretFallbackCriteria(task: Task) {
  return withoutMatchingCriteria(task, sessionSecretFallbackCriterion);
}

function rootScaffoldWorkflowExecutionCriterion(criterion: string) {
  return /\bWorkflow execution receives or resumes a queued run\b/i.test(criterion);
}

function rootScaffoldFuturePreservationCriterion(criterion: string) {
  return /\bchanges preserve the existing default fetch handler\b/i.test(criterion);
}

export function withoutRootScaffoldWorkflowExecutionCriteria(task: Task) {
  if (!taskIsRootScaffold(task)) return task;
  return withoutMatchingCriteria(
    task,
    (criterion) => rootScaffoldWorkflowExecutionCriterion(criterion) || rootScaffoldFuturePreservationCriterion(criterion),
  );
}

function sessionRouteCrossSurfaceCriterion(criterion: string) {
  return /^Protected profile, run, latest, and regeneration routes validate/i.test(criterion);
}

export function withoutSessionRouteCrossSurfaceCriteria(task: Task) {
  if (!taskOwnsSessionRoute(task)) return task;
  return withoutMatchingCriteria(task, sessionRouteCrossSurfaceCriterion);
}

function aiOutputValidationCriterion(criterion: string) {
  return /\bAI output validation treats model JSON as untrusted input\b/i.test(criterion);
}

export function withoutAiOutputValidationCriteria(task: Task) {
  return withoutMatchingCriteria(task, aiOutputValidationCriterion);
}

function runLifecycleWithoutEmptyTerminalCriterion(criterion: string) {
  return (
    /\bRun lifecycle contract defines\b/i.test(criterion) &&
    /\bqueued\s*->\s*running\s*->\s*completed\|failed\b/i.test(criterion) &&
    !/\bcompleted_empty\b/i.test(criterion)
  );
}

function workflowCreatesRunningRunCriterion(criterion: string) {
  return /\b(?:WeeklyWorkflow|Workflow)\b[\s\S]{0,80}\bcreates or loads (?:a|the) run\b[\s\S]{0,80}\bmarks it running\b/i.test(
    criterion,
  );
}

function workflowCreateRunStepCriterion(criterion: string) {
  if (/\b(?:manual run routes?|scheduled triggers?)\b[\s\S]{0,80}\bcreate queued run records? only\b/i.test(criterion)) {
    return false;
  }

  return (
    /\b(?:WeeklyWorkflow|weeklyWorkflow\.js|Workflow|workflow steps?)\b[\s\S]{0,120}\b(?:steps?\s+including\s+)?["']?create run["']?/i.test(
      criterion,
    ) || /\b["']?create run["']?\b[\s\S]{0,120}\b(?:Workflow|workflow|weeklyWorkflow\.js)\b/i.test(criterion)
  );
}

function workflowEmptyInputCompletedCriterion(criterion: string) {
  return /\bempty (?:[\w/-]+\s+){0,4}list\b[\s\S]{0,120}\bcompleted run with no (?:transcript|output|artifact|content)\b/i.test(
    criterion,
  );
}

function emptyInputCompletesWithoutOutputCriterion(criterion: string) {
  return /\bempty (?:[\w/-]+\s+){0,4}list\b[\s\S]{0,120}\bcompletes? (?:the )?run\b[\s\S]{0,120}\bwithout (?:a )?(?:transcript|output|artifact|content)\b/i.test(
    criterion,
  );
}

function emptyInputCompletedNoContentCriterion(criterion: string) {
  return /\bempty (?:[\w/-]+\s+){0,4}list\b[\s\S]{0,120}\b(?:completed\/no_content|completed_empty)\b[\s\S]{0,120}\bwithout (?:transcript|output|artifact|content)\b/i.test(
    criterion,
  );
}

export function withoutLifecycleDriftCriteria(task: Task) {
  return withoutMatchingCriteria(
    task,
    (criterion) =>
      runLifecycleWithoutEmptyTerminalCriterion(criterion) ||
      workflowEmptyInputCompletedCriterion(criterion) ||
      emptyInputCompletesWithoutOutputCriterion(criterion) ||
      emptyInputCompletedNoContentCriterion(criterion) ||
      (taskOwnsWorkflowSurface(task) &&
        (workflowCreatesRunningRunCriterion(criterion) || workflowCreateRunStepCriterion(criterion))),
  );
}

function persistentRunLifecycleCriterion(criterion: string) {
  return (
    /\bRun lifecycle contract defines\b/i.test(criterion) ||
    /\bScheduled trigger handling creates or reuses queued run records\b/i.test(criterion) ||
    /\bWorkflow treats an empty (?:[\w/-]+\s+){0,4}list as a completed_empty terminal run\b/i.test(criterion) ||
    /\broute handlers delegate[\s\S]{0,140}\b(?:latest transcript|transcript versioning|D1 state)\b/i.test(criterion) ||
    /\bTranscript regeneration inserts a new transcript row\b/i.test(criterion)
  );
}

export function withoutPersistentRunLifecycleCriteria(task: Task) {
  return withoutMatchingCriteria(task, persistentRunLifecycleCriterion);
}

function workflowExportDriftCriterion(criterion: string) {
  return (
    /\bminimal WorkflowEntrypoint class\b/i.test(criterion) ||
    /\blater workflow code may delegate to src\/weeklyWorkflow\.js\b/i.test(criterion) ||
    /\bsrc\/weeklyWorkflow\.js\b[\s\S]{0,100}\bexports? (?:the )?WeeklyWorkflow class referenced by wrangler\.jsonc\b/i.test(
      criterion,
    )
  );
}

export function withoutWorkflowExportDriftCriteria(task: Task) {
  return withoutMatchingCriteria(task, workflowExportDriftCriterion);
}

function runCreationOutsideEnqueueBoundaryCriterion(task: Task, criterion: string) {
  if (taskOwnsManualRunRoute(task) || taskOwnsSchedulerSurface(task)) return false;
  return /\bcreates? (?:a|the) run\b[\s\S]{0,120}\b(?:default|previous|seven-day|window)\b/i.test(criterion);
}

function directApiDispatchInEntrypointCriterion(task: Task, criterion: string) {
  if (!taskOwnsIndexSurface(task) || taskHasRouteIntegrationContract(task)) return false;
  return /\bsrc\/index\.js\b[\s\S]{0,120}\bdispatch(?:es)? API routes\b/i.test(criterion);
}

export function withoutBoundaryAuthorityDriftCriteria(task: Task) {
  return withoutMatchingCriteria(
    task,
    (criterion) => runCreationOutsideEnqueueBoundaryCriterion(task, criterion) || directApiDispatchInEntrypointCriterion(task, criterion),
  );
}

function canonicalizeCompletedEmptyStatusText(criterion: string) {
  return criterion
    .replace(/\bcompleted\/no_content\b/gi, 'completed_empty')
    .replace(/\bcompleted_no_[a-z0-9_]+\b/gi, 'completed_empty')
    .replace(/\bno_[a-z0-9_]+\b/gi, 'completed_empty');
}

export function withCanonicalCompletedEmptyStatus(task: Task) {
  const acceptance_criteria = task.acceptance_criteria.map(canonicalizeCompletedEmptyStatusText);
  const source_acceptance_criteria = task.source_acceptance_criteria?.map(canonicalizeCompletedEmptyStatusText);

  if (
    acceptance_criteria.every((criterion, index) => criterion === task.acceptance_criteria[index]) &&
    (source_acceptance_criteria ?? []).every((criterion, index) => criterion === task.source_acceptance_criteria?.[index])
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

export function canonicalizeProfileMigrationCriterionSurface(task: Task) {
  const migrationSurface = taskD1MigrationSurface(task);
  if (!migrationSurface) return task;

  const canonicalize = (criterion: string) =>
    criterion.replace(
      /\bmigrations\/[A-Za-z0-9_.-]+\.sql(?= enforces at most one active profile_artifacts row)/g,
      migrationSurface,
    );
  const acceptance_criteria = task.acceptance_criteria.map(canonicalize);
  const source_acceptance_criteria = task.source_acceptance_criteria?.map(canonicalize);

  if (
    acceptance_criteria.every((criterion, index) => criterion === task.acceptance_criteria[index]) &&
    (source_acceptance_criteria ?? []).every((criterion, index) => criterion === task.source_acceptance_criteria?.[index])
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}
