import {
  appendDependencies,
  insertTaskAfterDependencies,
  moveTaskAfterDependencies,
  taskCanDependOnTaskList,
  taskCanSafelyDependOn,
  taskListDependsOn,
  withoutCyclicDependencies as withoutCyclicTaskDependencies,
} from '../task-plan-dependencies';
import {
  finalGeneratedSliceTaskId,
  generatedSliceFamilyId,
  generatedSliceFamilyTasks,
} from '../task-plan-generated-slices';
import {
  routeIntegrationCriterion,
  sessionRouteCriteria,
  type SourceScopedDeliveryContracts,
} from '../task-plan-source-contracts';
import {
  taskOwnedBoundaryPaths,
  taskOwnsAiPipelineSurface,
  taskOwnsAiValidationSurface,
  taskOwnsCandidateRoute,
  taskOwnsIndexSurface,
  taskOwnsLatestRoute,
  taskOwnsManualRunRoute,
  taskOwnsOperatorAuthBoundary,
  taskOwnsPathMatching,
  taskOwnsProfileRepositorySurface,
  taskOwnsProfileRoute,
  taskOwnsProfileSummarySurface,
  taskOwnsPublicAppSurface,
  taskOwnsRegenerationRoute,
  taskOwnsRouteModule,
  taskOwnsRouterSurface,
  taskOwnsSchedulerSurface,
  taskOwnsSessionRoute,
  taskOwnsWorkflowExecutionSurface,
} from '../task-plan-surface-policy';
import type { Task, TaskPlan } from '../workflow-schemas';
import {
  routeIntegrationDependencyId,
  preEntrypointBoundaryDependencyId,
} from './generated-slice-policy';
import {
  taskHasFinalWorkerEntrypointContract,
  taskHasRouteIntegrationContract,
  taskRouterBoundarySurface,
} from './route-boundary-policy';
import {
  withoutFinalWorkerEntrypointCriteria,
  withoutFinalWorkerEntrypointDrift,
} from './route-criteria-policy';
import { taskIsRootScaffold } from './scaffold-policy';
import { appendTaskAcceptanceCriteria } from './task-criteria-policy';
import { uniqueTaskId } from './task-ids';

function taskOwnsStaticAssetWiringSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/staticAssets\.[cm]?[jt]s$/) || taskOwnedBoundaryPaths(task).includes('wrangler.jsonc');
}

function routeReachabilityNames(tasks: Task[], routeTasks: Task[], contractScope: SourceScopedDeliveryContracts) {
  return [
    tasks.some(taskOwnsSessionRoute) ? 'browser session' : undefined,
    contractScope.profileState && routeTasks.some(taskOwnsProfileRoute) ? 'profile' : undefined,
    contractScope.latestTranscript && routeTasks.some(taskOwnsManualRunRoute) ? 'run' : undefined,
    contractScope.latestTranscript && routeTasks.some(taskOwnsLatestRoute) ? 'latest' : undefined,
    contractScope.latestTranscript && routeTasks.some(taskOwnsRegenerationRoute) ? 'regenerate' : undefined,
    contractScope.latestTranscript && routeTasks.some(taskOwnsCandidateRoute) ? 'candidate' : undefined,
    'health',
    'static asset fallback',
  ].filter(Boolean);
}

function routeReachabilityCriterion(criterion: string) {
  return /\bmakes? .+ routes reachable through the Worker fetch path\b/i.test(criterion);
}

function dedupeRouteIntegrationTasks(tasks: Task[]) {
  const integrationTasks = tasks.filter(taskHasRouteIntegrationContract);
  if (integrationTasks.length <= 1) return { tasks, changed: false };

  const [primary, ...duplicates] = integrationTasks;
  const integrationIds = new Set(integrationTasks.map((task) => task.id));
  const duplicateIds = new Set(duplicates.map((task) => task.id));
  const primaryTask = {
    ...primary,
    depends_on: Array.from(
      new Set(integrationTasks.flatMap((task) => task.depends_on).filter((dependency) => !integrationIds.has(dependency))),
    ),
    acceptance_criteria: Array.from(new Set(integrationTasks.flatMap((task) => task.acceptance_criteria))),
    owned_surfaces: Array.from(new Set(integrationTasks.flatMap((task) => task.owned_surfaces))),
  };

  return {
    tasks: tasks
      .filter((task) => !duplicateIds.has(task.id))
      .map((task) => {
        if (task.id === primary.id) return primaryTask;
        const depends_on = Array.from(
          new Set(task.depends_on.map((dependency) => (duplicateIds.has(dependency) ? primary.id : dependency))),
        );
        return depends_on.length === task.depends_on.length &&
          depends_on.every((dependency, index) => dependency === task.depends_on[index])
          ? task
          : { ...task, depends_on };
      }),
    changed: true,
  };
}

function routeModuleStyle(tasks: Task[]) {
  return tasks.some((task) => taskOwnedBoundaryPaths(task).some((path) => path.startsWith('src/routes/'))) ? 'nested' : 'flat';
}

function taskFamilyIncludesWorkflowEntrypointWork(tasks: Task[], task: Task) {
  return generatedSliceFamilyTasks(tasks, task).some(
    (candidate) => taskOwnsWorkflowExecutionSurface(candidate) || taskOwnsSchedulerSurface(candidate),
  );
}

function taskCanOwnFinalWorkerEntrypoint(tasks: Task[], task: Task) {
  if (!taskOwnsIndexSurface(task) || taskIsRootScaffold(task)) return false;
  return task.id.startsWith('E99-worker-entrypoint-integration') || taskFamilyIncludesWorkflowEntrypointWork(tasks, task);
}

function routerBoundaryProviderTasks(tasks: Task[]) {
  return tasks.filter(
    (task) =>
      taskOwnsRouterSurface(task) &&
      !taskOwnsRouteModule(task) &&
      !taskHasRouteIntegrationContract(task) &&
      !taskOwnsStaticAssetWiringSurface(task),
  );
}

export function withAuthSessionTask(taskPlan: TaskPlan, tasks: Task[]) {
  const hasPublicApp = tasks.some(taskOwnsPublicAppSurface);
  const authTasks = tasks.filter(taskOwnsOperatorAuthBoundary);
  const routerTasks = routerBoundaryProviderTasks(tasks);
  const sessionTasks = tasks.filter(taskOwnsSessionRoute);
  if (!hasPublicApp || !authTasks.length) return { tasks, changed: false };

  const scaffoldRootTasks = tasks.filter((task) => taskIsRootScaffold(task));
  const routeTasks = tasks.filter(taskOwnsRouteModule);
  const safeAuthTasks = authTasks.filter(
    (authTask) =>
      !taskOwnsRouteModule(authTask) &&
      !routeTasks.some((routeTask) => routeTask.id !== authTask.id && taskListDependsOn(tasks, authTask.id, routeTask.id)),
  );
  const safeRouterTasks = routerTasks.filter(
    (routerTask) =>
      !taskOwnsIndexSurface(routerTask) &&
      !routeTasks.some((routeTask) => routerTask.id !== routeTask.id && taskListDependsOn(tasks, routerTask.id, routeTask.id)),
  );
  const sessionDependencyTasks = safeAuthTasks.length
    ? [...scaffoldRootTasks, ...safeAuthTasks, ...safeRouterTasks]
    : [...scaffoldRootTasks, ...safeRouterTasks];
  const sessionDependencyIds = Array.from(
    new Set(sessionDependencyTasks.map((task) => preEntrypointBoundaryDependencyId(tasks, task))),
  );

  if (sessionTasks.length) {
    let changed = false;
    const expectedDependencies = sessionDependencyIds;
    let nextTasks = tasks.map((task) => {
      if (!taskOwnsSessionRoute(task)) return task;
      const surface = taskOwnedBoundaryPaths(task).find((path) =>
        /^src\/(?:routes\/session|sessionRoutes)\.[cm]?[jt]s$/i.test(path),
      ) ?? 'src/sessionRoutes.js';
      const depends_on = expectedDependencies.filter((dependency) => dependency !== task.id);
      const withCriteria = appendTaskAcceptanceCriteria(task, sessionRouteCriteria(surface));
      const dependenciesUnchanged =
        depends_on.length === task.depends_on.length && depends_on.every((dependency, index) => dependency === task.depends_on[index]);
      if (dependenciesUnchanged && withCriteria === task) {
        return task;
      }
      changed = true;
      return { ...withCriteria, depends_on };
    });
    for (const task of sessionTasks) {
      const moved = moveTaskAfterDependencies(nextTasks, task.id);
      if (moved.changed) changed = true;
      nextTasks = moved.tasks;
    }
    return {
      tasks: nextTasks,
      changed,
    };
  }

  const surface = routeModuleStyle(tasks) === 'nested' ? 'src/routes/session.js' : 'src/sessionRoutes.js';
  const sessionTask = {
    id: uniqueTaskId({ ...taskPlan, tasks }, 'E20-auth-session'),
    owner: 'engineer' as const,
    deliverable: 'Implement the browser-safe auth/session route boundary before protected feature routes and UI work.',
    depends_on: sessionDependencyIds,
    acceptance_criteria: sessionRouteCriteria(surface),
    owned_surfaces: [surface],
  };

  return {
    tasks: insertTaskAfterDependencies(tasks, sessionTask),
    changed: true,
  };
}

export function withRouteIntegrationTask(taskPlan: TaskPlan, tasks: Task[], contractScope: SourceScopedDeliveryContracts) {
  const deduped = dedupeRouteIntegrationTasks(tasks);
  tasks = deduped.tasks;

  const routeTasks = tasks.filter(taskOwnsRouteModule);
  const routerTasks = routerBoundaryProviderTasks(tasks);
  if (!routeTasks.length || !routerTasks.length) return { tasks, changed: deduped.changed };

  const alreadyHasIntegration = tasks.some(taskHasRouteIntegrationContract);
  if (alreadyHasIntegration) {
    let changed = deduped.changed;
    const expectedDependencies = Array.from(
      new Set([...routerTasks, ...routeTasks].map((task) => preEntrypointBoundaryDependencyId(tasks, task))),
    );
    tasks = tasks.map((task) => {
      if (!taskHasRouteIntegrationContract(task)) return task;
      const depends_on = expectedDependencies.filter((dependency) => dependency !== task.id);
      const routerSurface = taskOwnedBoundaryPaths(task).find((path) =>
        /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/.test(path),
      ) ?? 'src/router.js';
      const expectedRouteCriterion = routeIntegrationCriterion(routerSurface, routeReachabilityNames(tasks, routeTasks, contractScope));
      let replacedReachability = false;
      const acceptance_criteria = task.acceptance_criteria.map((criterion) => {
        if (!routeReachabilityCriterion(criterion)) return criterion;
        replacedReachability = true;
        return expectedRouteCriterion;
      });
      if (!replacedReachability) acceptance_criteria.push(expectedRouteCriterion);
      const withCriteria = { ...task, acceptance_criteria: Array.from(new Set(acceptance_criteria)) };
      const dependenciesUnchanged =
        depends_on.length === task.depends_on.length && depends_on.every((dependency, index) => dependency === task.depends_on[index]);
      const criteriaUnchanged =
        withCriteria.acceptance_criteria.length === task.acceptance_criteria.length &&
        withCriteria.acceptance_criteria.every((criterion, index) => criterion === task.acceptance_criteria[index]);
      if (dependenciesUnchanged && criteriaUnchanged) {
        return task;
      }
      changed = true;
      return { ...withCriteria, depends_on };
    });
    for (const task of tasks.filter(taskHasRouteIntegrationContract)) {
      const moved = moveTaskAfterDependencies(tasks, task.id);
      if (moved.changed) changed = true;
      tasks = moved.tasks;
    }
    return { tasks, changed };
  }

  const routerSurface = taskOwnedBoundaryPaths(routerTasks[routerTasks.length - 1]).find((path) =>
    /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/.test(path),
  ) ?? 'src/router.js';
  const depends_on = Array.from(
    new Set([...routerTasks, ...routeTasks].map((task) => preEntrypointBoundaryDependencyId(tasks, task))),
  );
  const routeNames = routeReachabilityNames(tasks, routeTasks, contractScope);
  const needsProtectedFeatureMatrix = contractScope.profileState || contractScope.latestTranscript;

  const integrationTask = {
    id: uniqueTaskId({ ...taskPlan, tasks }, 'E98-route-integration'),
    owner: 'engineer' as const,
    deliverable: 'Wire generated API route modules through the Worker router after all route modules exist.',
    depends_on,
    acceptance_criteria: [
      `${routerSurface} is the single API route registration boundary after feature route modules exist.`,
      routeIntegrationCriterion(routerSurface, routeNames),
      'Every declared API endpoint is reachable through the router after this task completes.',
      ...(needsProtectedFeatureMatrix
        ? [
            'Route integration defines and enforces the protection matrix: profile upload, profile activation, GET /profiles, manual runs, regeneration, and run detail endpoints are operator/session protected; GET /latest may be public only when it returns generated transcript fields and never raw profile markdown, profile history, or fetched source content.',
          ]
        : []),
    ],
    owned_surfaces: [routerSurface],
  };

  return {
    tasks: insertTaskAfterDependencies(tasks, integrationTask),
    changed: true,
  };
}

export function withWorkerEntrypointIntegrationTask(taskPlan: TaskPlan, tasks: Task[]) {
  const rootScaffoldIndexTask = tasks.find((task) => taskIsRootScaffold(task) && taskOwnsIndexSurface(task));
  const nonRootIndexTasks = tasks.filter((task) => taskOwnsIndexSurface(task) && !taskIsRootScaffold(task));
  const integrationTask = tasks.find(taskHasRouteIntegrationContract);
  const workflowTasks = tasks.filter(taskOwnsWorkflowExecutionSurface);
  const schedulerTasks = tasks.filter(taskOwnsSchedulerSurface);
  if (!integrationTask || !workflowTasks.length || !schedulerTasks.length) return { tasks, changed: false };

  const dependencies = Array.from(
    new Set([
      integrationTask.id,
      ...workflowTasks.map((task) => preEntrypointBoundaryDependencyId(tasks, task)),
      ...schedulerTasks.map((task) => preEntrypointBoundaryDependencyId(tasks, task)),
    ]),
  );
  const routerSurface = taskRouterBoundarySurface(integrationTask);
  const criteria = [
    'src/index.js is the final Worker module entrypoint after route, scheduler, and workflow modules exist.',
    `src/index.js delegates fetch handling to ${routerSurface} and keeps static asset fallback reachable through the ${routerSurface} fetch path.`,
    'src/index.js delegates scheduled handling to src/scheduler.js so scheduled triggers create queued run records and start WEEKLY_WORKFLOW without duplicating workflow execution logic.',
    'src/index.js exports the real WeeklyWorkflow implementation with the configured class name "WeeklyWorkflow" and delegates execution to the workflow module rather than leaving the scaffold stub in place.',
  ];
  const finalDependencyIds = new Set(dependencies);
  const finalIndexTasks = nonRootIndexTasks.filter((task) => taskCanOwnFinalWorkerEntrypoint(tasks, task));

  if (nonRootIndexTasks.length) {
    let changed = false;
    let nextTasks = tasks.map((task) => {
      if (!nonRootIndexTasks.some((indexTask) => indexTask.id === task.id)) return task;
      if (!finalIndexTasks.some((indexTask) => indexTask.id === task.id)) {
        const sanitized = withoutFinalWorkerEntrypointDrift(task, finalDependencyIds);
        if (sanitized !== task) changed = true;
        return sanitized;
      }
      const sanitized = withoutFinalWorkerEntrypointCriteria(task);
      const withDependencies = appendDependencies(sanitized, dependencies);
      const withCriteria = appendTaskAcceptanceCriteria(withDependencies, criteria);
      if (withCriteria !== task) changed = true;
      return withCriteria;
    });
    for (const task of finalIndexTasks) {
      const moved = moveTaskAfterDependencies(nextTasks, task.id);
      if (moved.changed) changed = true;
      nextTasks = moved.tasks;
    }
    if (finalIndexTasks.length) return { tasks: nextTasks, changed };
    tasks = nextTasks;
  }

  if (!rootScaffoldIndexTask) return { tasks, changed: false };

  const entryTask = {
    id: uniqueTaskId({ ...taskPlan, tasks }, 'E99-worker-entrypoint-integration'),
    owner: 'engineer' as const,
    deliverable: 'Wire the final Worker entrypoint after routes, scheduler, and workflow implementation exist.',
    depends_on: dependencies,
    acceptance_criteria: criteria,
    owned_surfaces: ['src/index.js'],
  };

  return {
    tasks: insertTaskAfterDependencies(tasks, entryTask),
    changed: true,
  };
}

export function withProfileSummaryTask(taskPlan: TaskPlan, tasks: Task[]) {
  if (tasks.some(taskOwnsProfileSummarySurface)) return { tasks, changed: false };

  const hasProfileState = tasks.some((task) => taskOwnsProfileRoute(task) || taskOwnsProfileRepositorySurface(task));
  const hasAiPipeline = tasks.some((task) => taskOwnsAiPipelineSurface(task) || taskOwnsAiValidationSurface(task));
  if (!hasProfileState || !hasAiPipeline) return { tasks, changed: false };

  const profileDependencies = tasks
    .filter((task) => taskOwnsProfileRepositorySurface(task) || taskOwnsAiPipelineSurface(task) || taskOwnsAiValidationSurface(task))
    .map((task) => finalGeneratedSliceTaskId(tasks, task.id));
  const summaryTask = {
    id: uniqueTaskId({ ...taskPlan, tasks }, 'E21-profile-summary'),
    owner: 'engineer' as const,
    deliverable: 'Implement profile summary creation and persistence as the single derived-profile state boundary.',
    depends_on: Array.from(new Set(profileDependencies)),
    acceptance_criteria: [
      'src/profileSummaryService.js creates or loads compact derived summaries for audience_segments and voice_profile profile artifacts before workflow prompt assembly.',
      'src/profileSummaryService.js stores derived summaries in R2, updates profile_artifacts.derived_summary_r2_key in D1, preserves original markdown as the source of truth, and is safe to call from profile upload or workflow profile-loading code without duplicating summary state logic.',
    ],
    owned_surfaces: ['src/profileSummaryService.js'],
  };

  return {
    tasks: insertTaskAfterDependencies(tasks, summaryTask),
    changed: true,
  };
}

function taskDependsOnAny(task: Task, ids: Set<string>) {
  return task.depends_on.some((dependency) => ids.has(dependency));
}

export function withPreEntrypointGeneratedSliceDependencies(taskPlan: TaskPlan, tasks: Task[]) {
  const plan = { ...taskPlan, tasks };
  let changed = false;
  const nextTasks = tasks.map((task) => {
    const taskFamilyId = generatedSliceFamilyId(task.id);
    const depends_on = Array.from(
      new Set(
        task.depends_on.map((dependency) => {
          const dependencyTask = tasks.find((candidate) => candidate.id === dependency);
          if (!dependencyTask) return dependency;
          const replacement = taskHasRouteIntegrationContract(task)
            ? routeIntegrationDependencyId(tasks, dependencyTask)
            : preEntrypointBoundaryDependencyId(tasks, dependencyTask);
          if (replacement === dependency) return dependency;
          if (generatedSliceFamilyId(dependency) === taskFamilyId) return dependency;
          if (!taskCanSafelyDependOn(plan, task.id, replacement)) return dependency;

          changed = true;
          return replacement;
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

  return { tasks: nextTasks, changed };
}

export function withCloudflareWorkerDependencyContracts(tasks: Task[]) {
  const sanitized = withoutCyclicTaskDependencies(tasks, {
    preserveTask: (task) => taskHasRouteIntegrationContract(task) || taskOwnsSessionRoute(task),
  });
  tasks = sanitized.tasks;
  const routerTaskIds = new Set(routerBoundaryProviderTasks(tasks).map((task) => preEntrypointBoundaryDependencyId(tasks, task)));
  const sessionTaskIds = new Set(tasks.filter(taskOwnsSessionRoute).map((task) => preEntrypointBoundaryDependencyId(tasks, task)));
  const profileSummaryTaskIds = new Set(tasks.filter(taskOwnsProfileSummarySurface).map((task) => finalGeneratedSliceTaskId(tasks, task.id)));
  const integrationTask = tasks.find(taskHasRouteIntegrationContract);
  let changed = sanitized.changed;

  const next = tasks.map((task) => {
    const dependencies: string[] = [];

    if (taskOwnsRouteModule(task) && !taskOwnsSessionRoute(task)) {
      dependencies.push(...routerTaskIds);
      dependencies.push(...sessionTaskIds);
    }

    if ((taskOwnsProfileRoute(task) || taskOwnsWorkflowExecutionSurface(task)) && !taskOwnsProfileSummarySurface(task)) {
      dependencies.push(...profileSummaryTaskIds);
    }

    if (taskOwnsPublicAppSurface(task)) {
      dependencies.push(...sessionTaskIds);
      if (integrationTask) dependencies.push(integrationTask.id);
    }

    if (
      !taskIsRootScaffold(task) &&
      taskOwnsIndexSurface(task) &&
      !taskOwnsRouterSurface(task) &&
      taskHasFinalWorkerEntrypointContract(task) &&
      integrationTask &&
      task.id !== integrationTask.id
    ) {
      dependencies.push(integrationTask.id);
    }

    const filtered = dependencies.filter(
      (dependency) => dependency !== task.id && taskCanDependOnTaskList(tasks, task.id, dependency),
    );
    if (!filtered.length || taskDependsOnAny(task, new Set(filtered))) {
      const appended = appendDependencies(task, filtered);
      if (appended !== task) changed = true;
      return appended;
    }

    const appended = appendDependencies(task, filtered);
    if (appended !== task) changed = true;
    return appended;
  });

  return { tasks: next, changed };
}
