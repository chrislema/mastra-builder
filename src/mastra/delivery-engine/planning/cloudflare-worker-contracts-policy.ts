import { acceptanceContractReferences } from '../acceptance-contracts';
import { isBehaviorLikeAcceptanceCriterion } from '../acceptance-evidence-policy';
import { normalizeDeliveryPathReference } from '../checks';
import { generatedSliceAcceptanceCriterion } from '../task-plan-generated-slices';
import {
  sourceScopedDeliveryContracts,
  taskPlanSourceContractCriteria as sourceTaskPlanContractCriteria,
  type SourceScopedDeliveryContracts,
} from '../task-plan-source-contracts';
import {
  normalizedOwnedSurfaces,
  taskAcceptanceText,
  taskAuthBoundarySurface,
  taskD1MigrationSurface,
  taskOwnedBoundaryPaths,
  taskOwnsAiPipelineSurface,
  taskOwnsAiValidationSurface,
  taskOwnsAuthSurface,
  taskOwnsCandidateRoute,
  taskOwnsContractSurface,
  taskOwnsD1MigrationFile,
  taskOwnsIndexSurface,
  taskOwnsLatestRoute,
  taskOwnsManualRunRoute,
  taskOwnsOperatorAuthBoundary,
  taskOwnsProfileRepositorySurface,
  taskOwnsProfileRoute,
  taskOwnsPublicAppSurface,
  taskOwnsReadme,
  taskOwnsRegenerationRoute,
  taskOwnsRouterSurface,
  taskOwnsRunRepositorySurface,
  taskOwnsRunRoute,
  taskOwnsSchedulerSurface,
  taskOwnsSessionRoute,
  taskOwnsTranscriptRepositorySurface,
  taskOwnsWorkerConfigFile,
  taskOwnsWorkflowExecutionSurface,
  taskOwnsWorkflowSurface,
} from '../task-plan-surface-policy';
import { workerConfigTaskPacketPolicy } from '../worker-hygiene';
import type { SourcePolicy, Task, TaskPlan } from '../workflow-schemas';
import {
  generatedWorkerTypeOwnershipCriterion,
} from './acceptance-contract-preservation';
import {
  withApiRouteBehaviorTestTasks,
  withFrontendBehaviorTestTasks,
  withModelCatalogBehaviorTestTasks,
  withProviderAdapterBehaviorTestTasks,
  withValidationBehaviorTestTasks,
} from './behavior-evidence-task-policy';
import {
  canonicalizeProfileMigrationCriterionSurface,
  withCanonicalCompletedEmptyStatus,
  withoutAiOutputValidationCriteria,
  withoutBoundaryAuthorityDriftCriteria,
  withoutLifecycleDriftCriteria,
  withoutPersistentRunLifecycleCriteria,
  withoutPublicUiRawAdminTokenCriteria,
  withoutRootScaffoldWorkflowExecutionCriteria,
  withoutSessionRouteCrossSurfaceCriteria,
  withoutSessionSecretFallbackCriteria,
  withoutWorkflowExportDriftCriteria,
} from './cloudflare-contract-criteria-policy';
import {
  routeEndpointContractCriterion,
  routeEndpointCriterionBelongsToTask,
  taskRouteEndpointSourceCriteria,
  withoutRouteOwnershipDriftCriteria,
  withoutSchedulerWorkflowExecutionCriteria,
} from './route-criteria-policy';
import {
  withAuthSessionTask,
  withCloudflareWorkerDependencyContracts,
  withPreEntrypointGeneratedSliceDependencies,
  withProfileSummaryTask,
  withRouteIntegrationTask,
  withWorkerEntrypointIntegrationTask,
} from './route-task-policy';
import { taskHasRouteIntegrationContract } from './route-boundary-policy';
import { taskIsRootScaffold } from './scaffold-policy';
import { appendTaskAcceptanceCriteria } from './task-criteria-policy';

function withoutGeneratedWorkerTypeOwnership(task: Task) {
  const owned_surfaces = task.owned_surfaces.filter(
    (surface) => normalizeDeliveryPathReference(surface) !== workerConfigTaskPacketPolicy().generated_types.output,
  );
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !generatedWorkerTypeOwnershipCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !generatedWorkerTypeOwnershipCriterion(criterion),
  );

  const unchanged =
    owned_surfaces.length === task.owned_surfaces.length &&
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0);

  if (unchanged) return task;

  return {
    ...task,
    owned_surfaces,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function sourceAcceptanceCriterionBelongsToTask(task: Task, criterion: string) {
  if (generatedSliceAcceptanceCriterion(criterion)) return false;
  if (routeEndpointContractCriterion(criterion)) return routeEndpointCriterionBelongsToTask(task, criterion);

  const references = acceptanceContractReferences(criterion).map(normalizeDeliveryPathReference);
  if (!references.length) return false;

  const owned = new Set(normalizedOwnedSurfaces(task));
  return references.every((reference) => owned.has(reference));
}

function taskBaseVerificationAcceptanceContractCriteria(task: Task) {
  return Array.from(
    new Set([
      ...(task.source_acceptance_criteria ?? []).filter((criterion) => sourceAcceptanceCriterionBelongsToTask(task, criterion)),
      ...task.acceptance_criteria.filter((criterion) => !generatedSliceAcceptanceCriterion(criterion)),
    ]),
  );
}

function taskIsEvidenceTask(task: Task) {
  const evidenceKind = task.metadata?.evidence?.kind;
  return (
    (evidenceKind !== undefined && evidenceKind !== 'none') ||
    taskOwnedBoundaryPaths(task).some((path) => /^test\/.+\.test\.[cm]?[jt]s$/i.test(path))
  );
}

function sourceCriterionCoveredByEvidenceTask({
  taskPlan,
  sourceTask,
  criterion,
}: {
  taskPlan: TaskPlan;
  sourceTask: Task;
  criterion: string;
}) {
  return taskPlan.tasks.some(
    (task) =>
      task.id !== sourceTask.id &&
      taskIsEvidenceTask(task) &&
      task.depends_on.includes(sourceTask.id) &&
      (task.source_acceptance_criteria ?? []).includes(criterion),
  );
}

function criterionNeedsDownstreamEvidenceTask(criterion: string) {
  return (
    isBehaviorLikeAcceptanceCriterion(criterion) ||
    /\b(?:400-level|client-safe|consumed\s+by|without\s+duplicat|normalization|normalize|redaction|prevent(?:s|ing)?|timeout|network\s+failure|provider\s+failure|unknown\s+model|unconfigured\s+model|single-model\s+request|frontend)\b/i.test(
      criterion,
    )
  );
}

export function taskDeferredAcceptanceContractCriteria(taskPlan: TaskPlan | undefined, task: Task) {
  if (!taskPlan || taskIsEvidenceTask(task)) return [];

  return taskBaseVerificationAcceptanceContractCriteria(task).filter(
    (criterion) =>
      criterionNeedsDownstreamEvidenceTask(criterion) &&
      sourceCriterionCoveredByEvidenceTask({ taskPlan, sourceTask: task, criterion }),
  );
}

export function taskVerificationAcceptanceContractCriteria(task: Task, taskPlan?: TaskPlan) {
  const deferred = new Set(taskDeferredAcceptanceContractCriteria(taskPlan, task));
  return taskBaseVerificationAcceptanceContractCriteria(task).filter((criterion) => !deferred.has(criterion));
}

function taskPlanDeclaresWorkerWorkflow(tasks: Task[]) {
  return tasks.some(
    (task) =>
      taskOwnsWorkflowSurface(task) ||
      /\b(?:WorkflowEntrypoint|WeeklyWorkflow|WEEKLY_WORKFLOW|workflows\.class_name|Workers Workflows?)\b/i.test(
        taskAcceptanceText(task),
      ),
  );
}

function taskPlanHasPersistentRunLifecycle(tasks: Task[]) {
  return tasks.some(
    (task) =>
      taskOwnsWorkflowSurface(task) ||
      taskOwnsD1MigrationFile(task) ||
      taskOwnsRunRepositorySurface(task) ||
      taskOwnsTranscriptRepositorySurface(task),
  );
}

function taskWorkflowImplementationSurface(task: Task) {
  return (
    taskOwnedBoundaryPaths(task).find((path) =>
      /^src\/(?:(?:workflows\/)?weeklyWorkflow|workflow)\.[cm]?[jt]s$/i.test(path),
    ) ?? 'src/workflow.js'
  );
}

function sourceContractCriteriaForTask(
  task: Task,
  context: {
    contractScope: SourceScopedDeliveryContracts;
    hasAuthBoundary: boolean;
    hasProfileState: boolean;
    hasAiValidationSurface: boolean;
    hasWorkerWorkflow: boolean;
    hasPersistentRunLifecycle: boolean;
    indexOwnerCount: number;
  },
) {
  const authSurface = taskAuthBoundarySurface(task);
  return sourceTaskPlanContractCriteria({
    contractScope: context.contractScope,
    hasAuthBoundary: context.hasAuthBoundary,
    hasProfileState: context.hasProfileState,
    hasAiValidationSurface: context.hasAiValidationSurface,
    hasWorkerWorkflow: context.hasWorkerWorkflow,
    hasPersistentRunLifecycle: context.hasPersistentRunLifecycle,
    indexOwnerCount: context.indexOwnerCount,
    ownsOperatorAuthBoundary: taskOwnsOperatorAuthBoundary(task),
    authSurface,
    authBoundaryIsInternalHelper: !taskOwnsAuthSurface(task) || /\/adminAuth\.[cm]?[jt]s$/i.test(authSurface),
    ownsPublicAppSurface: taskOwnsPublicAppSurface(task),
    ownsD1MigrationFile: taskOwnsD1MigrationFile(task),
    migrationSurface: taskD1MigrationSurface(task) ?? 'migrations/0001_schema.sql',
    ownsProfileRoute: taskOwnsProfileRoute(task),
    ownsManualRunRoute: taskOwnsManualRunRoute(task),
    ownsLatestRoute: taskOwnsLatestRoute(task),
    ownsRegenerationRoute: taskOwnsRegenerationRoute(task),
    ownsCandidateRoute: taskOwnsCandidateRoute(task),
    ownsProfileRepositorySurface: taskOwnsProfileRepositorySurface(task),
    ownsContractSurface: taskOwnsContractSurface(task),
    ownsRunRepositorySurface: taskOwnsRunRepositorySurface(task),
    ownsSchedulerSurface: taskOwnsSchedulerSurface(task),
    ownsWorkflowExecutionSurface: taskOwnsWorkflowExecutionSurface(task),
    isRootScaffold: taskIsRootScaffold(task),
    workflowSurface: taskWorkflowImplementationSurface(task),
    ownsRunRoute: taskOwnsRunRoute(task),
    ownsTranscriptRepositorySurface: taskOwnsTranscriptRepositorySurface(task),
    ownsAiValidationSurface: taskOwnsAiValidationSurface(task),
    ownsAiPipelineSurface: taskOwnsAiPipelineSurface(task),
    ownsRouterSurface: taskOwnsRouterSurface(task),
    hasRouteIntegrationContract: taskHasRouteIntegrationContract(task),
    ownsWorkerConfigFile: taskOwnsWorkerConfigFile(task),
    ownsIndexSurface: taskOwnsIndexSurface(task),
    ownsReadme: taskOwnsReadme(task),
    sourceRouteEndpointCriteria: taskRouteEndpointSourceCriteria(task),
  });
}

export function normalizeTaskPlanCloudflareWorkerContracts(taskPlan: TaskPlan, sourcePolicy?: SourcePolicy): TaskPlan {
  let changed = false;
  const contractScope = sourceScopedDeliveryContracts(sourcePolicy);
  const indexOwnerCount = taskPlan.tasks.filter(taskOwnsIndexSurface).length;
  const hasAuthBoundary = taskPlan.tasks.some(taskOwnsOperatorAuthBoundary);
  const hasProfileState =
    contractScope.profileState &&
    taskPlan.tasks.some((task) => taskOwnsProfileRoute(task) || taskOwnsProfileRepositorySurface(task));
  const hasAiValidationSurface = taskPlan.tasks.some(taskOwnsAiValidationSurface);
  const hasWorkerWorkflow = taskPlanDeclaresWorkerWorkflow(taskPlan.tasks);
  const hasPersistentRunLifecycle = contractScope.latestTranscript && taskPlanHasPersistentRunLifecycle(taskPlan.tasks);

  let tasks = taskPlan.tasks.map((task) => {
    const statusCanonicalized = withCanonicalCompletedEmptyStatus(task);
    if (statusCanonicalized !== task) {
      changed = true;
      task = statusCanonicalized;
    }

    if (!hasPersistentRunLifecycle) {
      const lifecycleSanitized = withoutPersistentRunLifecycleCriteria(task);
      if (lifecycleSanitized !== task) {
        changed = true;
        task = lifecycleSanitized;
      }
    }

    const sessionSecretSanitized = withoutSessionSecretFallbackCriteria(task);
    if (sessionSecretSanitized !== task) {
      changed = true;
      task = sessionSecretSanitized;
    }

    const rootSanitized = withoutRootScaffoldWorkflowExecutionCriteria(task);
    if (rootSanitized !== task) {
      changed = true;
      task = rootSanitized;
    }

    const generatedTypeSanitized = withoutGeneratedWorkerTypeOwnership(task);
    if (generatedTypeSanitized !== task) {
      changed = true;
      task = generatedTypeSanitized;
    }

    if (taskOwnsPublicAppSurface(task)) {
      const sanitized = withoutPublicUiRawAdminTokenCriteria(task);
      if (sanitized !== task) {
        changed = true;
        task = sanitized;
      }
    }

    if (taskOwnsSessionRoute(task)) {
      const sanitized = withoutSessionRouteCrossSurfaceCriteria(task);
      if (sanitized !== task) {
        changed = true;
        task = sanitized;
      }
    }

    const lifecycleSanitized = withoutLifecycleDriftCriteria(task);
    if (lifecycleSanitized !== task) {
      changed = true;
      task = lifecycleSanitized;
    }

    const workflowExportSanitized = withoutWorkflowExportDriftCriteria(task);
    if (workflowExportSanitized !== task) {
      changed = true;
      task = workflowExportSanitized;
    }

    const boundaryAuthoritySanitized = withoutBoundaryAuthorityDriftCriteria(task);
    if (boundaryAuthoritySanitized !== task) {
      changed = true;
      task = boundaryAuthoritySanitized;
    }

    const schedulerSanitized = withoutSchedulerWorkflowExecutionCriteria(task);
    if (schedulerSanitized !== task) {
      changed = true;
      task = schedulerSanitized;
    }

    const routeOwnershipSanitized = withoutRouteOwnershipDriftCriteria(task);
    if (routeOwnershipSanitized !== task) {
      changed = true;
      task = routeOwnershipSanitized;
    }

    const migrationCanonicalized = canonicalizeProfileMigrationCriterionSurface(task);
    if (migrationCanonicalized !== task) {
      changed = true;
      task = migrationCanonicalized;
    }

    if (hasAiValidationSurface && !taskOwnsAiValidationSurface(task)) {
      const sanitized = withoutAiOutputValidationCriteria(task);
      if (sanitized !== task) {
        changed = true;
        task = sanitized;
      }
    }

    const criteria = sourceContractCriteriaForTask(task, {
      contractScope,
      hasAuthBoundary,
      hasProfileState,
      hasAiValidationSurface,
      hasWorkerWorkflow,
      hasPersistentRunLifecycle,
      indexOwnerCount,
    });

    if (!criteria.length) return task;
    const next = appendTaskAcceptanceCriteria(task, criteria);
    if (next !== task) changed = true;
    return next;
  });

  const withSession = withAuthSessionTask(taskPlan, tasks);
  if (withSession.changed) {
    changed = true;
    tasks = withSession.tasks;
  }

  const withIntegration = withRouteIntegrationTask(taskPlan, tasks, contractScope);
  if (withIntegration.changed) {
    changed = true;
    tasks = withIntegration.tasks;
  }

  if (contractScope.profileState) {
    const withSummary = withProfileSummaryTask(taskPlan, tasks);
    if (withSummary.changed) {
      changed = true;
      tasks = withSummary.tasks;
    }
  }

  if (contractScope.latestTranscript) {
    const withEntrypoint = withWorkerEntrypointIntegrationTask(taskPlan, tasks);
    if (withEntrypoint.changed) {
      changed = true;
      tasks = withEntrypoint.tasks;
    }
  }

  const withProviderBehaviorTests = withProviderAdapterBehaviorTestTasks(tasks);
  if (withProviderBehaviorTests.changed) {
    changed = true;
    tasks = withProviderBehaviorTests.tasks;
  }

  const withApiRouteBehaviorTests = withApiRouteBehaviorTestTasks(tasks);
  if (withApiRouteBehaviorTests.changed) {
    changed = true;
    tasks = withApiRouteBehaviorTests.tasks;
  }

  const withFrontendBehaviorTests = withFrontendBehaviorTestTasks(tasks);
  if (withFrontendBehaviorTests.changed) {
    changed = true;
    tasks = withFrontendBehaviorTests.tasks;
  }

  const withValidationBehaviorTests = withValidationBehaviorTestTasks(tasks);
  if (withValidationBehaviorTests.changed) {
    changed = true;
    tasks = withValidationBehaviorTests.tasks;
  }

  const withModelCatalogBehaviorTests = withModelCatalogBehaviorTestTasks(tasks);
  if (withModelCatalogBehaviorTests.changed) {
    changed = true;
    tasks = withModelCatalogBehaviorTests.tasks;
  }

  const withDependencies = withCloudflareWorkerDependencyContracts(tasks);
  if (withDependencies.changed) {
    changed = true;
    tasks = withDependencies.tasks;
  }

  const withPreEntrypointDependencies = withPreEntrypointGeneratedSliceDependencies(taskPlan, tasks);
  if (withPreEntrypointDependencies.changed) {
    changed = true;
    tasks = withPreEntrypointDependencies.tasks;
  }

  return changed ? { ...taskPlan, tasks } : taskPlan;
}
