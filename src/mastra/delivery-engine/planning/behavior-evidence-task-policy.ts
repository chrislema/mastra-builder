import {
  isApiRouteBehaviorAcceptanceCriterion,
  isBehaviorLikeAcceptanceCriterion,
} from '../acceptance-evidence-policy';
import { appendDependencies, taskCanDependOnTaskList } from '../task-plan-dependencies';
import {
  taskOwnedBoundaryPaths,
  taskOwnsIndexSurface,
  taskOwnsPathMatching,
  taskOwnsProviderAdapterSurface,
  taskOwnsRouteModule,
  taskOwnsRouterSurface,
} from '../task-plan-surface-policy';
import type { Task } from '../workflow-schemas';
import { taskIsRootScaffold } from './scaffold-policy';
import { uniqueTaskIdFromTasks } from './task-ids';

function appendTaskSourceAcceptanceCriteria(task: Task, criteria: string[]) {
  const sourceCriteria = criteria.filter(Boolean);
  if (!sourceCriteria.length) return task;

  const sourceCriterionSet = new Set(sourceCriteria);
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !sourceCriterionSet.has(criterion));
  const source_acceptance_criteria = Array.from(new Set([...(task.source_acceptance_criteria ?? []), ...sourceCriteria]));
  const unchanged =
    acceptance_criteria.length === task.acceptance_criteria.length &&
    source_acceptance_criteria.length === (task.source_acceptance_criteria?.length ?? 0);

  if (unchanged) return task;

  return {
    ...task,
    acceptance_criteria,
    source_acceptance_criteria,
  };
}

function providerAdapterSurfaceExtension(task: Task) {
  const providerSurface = taskOwnedBoundaryPaths(task).find((path) => /^src\/providers\.[cm]?[jt]s$/i.test(path));
  return providerSurface && /\.(?:ts|mts|cts)$/.test(providerSurface) ? 'ts' : 'js';
}

function taskLooksLikeProviderAdapterBehaviorTest(task: Task, providerTaskId: string) {
  return (
    task.owner === 'engineer' &&
    task.depends_on.includes(providerTaskId) &&
    taskOwnedBoundaryPaths(task).some((path) => /^test\/.*provider.*\.test\.[cm]?[jt]s$/i.test(path)) &&
    /\bprovider adapters?\b|\bsrc\/providers\.[cm]?[jt]s\b|\bprovider_error\b|\btimeout_or_network_error\b/i.test(
      [task.deliverable, ...task.acceptance_criteria, ...task.owned_surfaces].join('\n'),
    )
  );
}

function providerAdapterBehaviorTestTask(providerTask: Task, testId: string, criteria: string[]): Task {
  const extension = providerAdapterSurfaceExtension(providerTask);
  const testSurface = `test/provider-adapters.test.${extension}`;
  return {
    id: testId,
    owner: 'engineer',
    deliverable:
      'Add provider adapter behavior tests that prove failure normalization, secret handling, and Workers AI binding failures with fake provider environments.',
    depends_on: [providerTask.id],
    acceptance_criteria: Array.from(
      new Set([
        `${testSurface} uses fake Workers AI/fetch/provider inputs and does not call real provider APIs.`,
        `${testSurface} proves provider adapter failures normalize to provider_error and timeout_or_network_error RunResult values with client-safe messages from src/contracts.ts.`,
        `${testSurface} proves missing keyed secrets and missing Workers AI binding fail closed before external provider calls.`,
        'npm test passes and includes provider adapter behavior coverage.',
      ]),
    ),
    source_acceptance_criteria: Array.from(new Set(criteria)),
    owned_surfaces: [testSurface],
  };
}

export function withProviderAdapterBehaviorTestTasks(tasks: Task[]) {
  let changed = false;
  let next = [...tasks];

  for (const providerTask of tasks) {
    if (!taskOwnsProviderAdapterSurface(providerTask)) continue;
    const evidenceCriteria = Array.from(
      new Set([...providerTask.acceptance_criteria, ...(providerTask.source_acceptance_criteria ?? [])]),
    );
    if (!evidenceCriteria.length) continue;

    const existingTestTask = next.find((task) => taskLooksLikeProviderAdapterBehaviorTest(task, providerTask.id));
    const testId = existingTestTask?.id ?? uniqueTaskIdFromTasks(next, `${providerTask.id}-provider-behavior-tests`);

    if (!existingTestTask) {
      const providerIndex = next.findIndex((task) => task.id === providerTask.id);
      const insertionIndex = providerIndex < 0 ? next.length : providerIndex + 1;
      next = [
        ...next.slice(0, insertionIndex),
        providerAdapterBehaviorTestTask(providerTask, testId, evidenceCriteria),
        ...next.slice(insertionIndex),
      ];
      changed = true;
    }

    next = next.map((task) => {
      if (task.id === testId) {
        const updated = appendTaskSourceAcceptanceCriteria(task, evidenceCriteria);
        if (updated !== task) changed = true;
        return updated;
      }
      if (task.id === testId || !task.depends_on.includes(providerTask.id) || task.depends_on.includes(testId)) return task;
      if (!taskCanDependOnTaskList(next, task.id, testId)) return task;
      changed = true;
      return appendDependencies(task, [testId]);
    });
  }

  return { tasks: next, changed };
}

function taskTestSurfaceExtension(task: Task) {
  return taskOwnedBoundaryPaths(task).some((path) => /\.(?:ts|mts|cts)$/.test(path)) ? 'ts' : 'js';
}

function taskOwnsApiRouteBehaviorSurface(task: Task) {
  return taskOwnsRouteModule(task) || taskOwnsRouterSurface(task) || (!taskIsRootScaffold(task) && taskOwnsIndexSurface(task));
}

function taskLooksLikeApiRouteBehaviorTest(task: Task, routeTaskId: string) {
  return (
    task.owner === 'engineer' &&
    task.depends_on.includes(routeTaskId) &&
    taskOwnedBoundaryPaths(task).some((path) => /^test\/.*(?:api|route).*\.test\.[cm]?[jt]s$/i.test(path)) &&
    /\b(?:api route|route behavior|\/api\/health|\/api\/models|\/api\/run|validation_error)\b/i.test(
      [task.deliverable, ...task.acceptance_criteria, ...task.owned_surfaces].join('\n'),
    )
  );
}

function apiRouteBehaviorTestTask(routeTask: Task, testId: string, criteria: string[]): Task {
  const extension = taskTestSurfaceExtension(routeTask);
  const testSurface = `test/api-routes.test.${extension}`;
  return {
    id: testId,
    owner: 'engineer',
    deliverable:
      'Add API route behavior tests that prove Worker route status codes, JSON shapes, validation failures, and provider-failure response handling with fake bindings.',
    depends_on: [routeTask.id],
    acceptance_criteria: Array.from(
      new Set([
        `${testSurface} imports or exercises the Worker route surface with fake env bindings and no real provider calls.`,
        `${testSurface} proves /api/health, /api/models, and /api/run status codes and JSON response shapes, including validation_error and provider-failure paths when those routes exist.`,
        'npm test passes and includes API route behavior coverage.',
      ]),
    ),
    source_acceptance_criteria: Array.from(new Set(criteria)),
    owned_surfaces: [testSurface],
  };
}

function taskHasApiRouteBehaviorCriterion(task: Task) {
  return [...task.acceptance_criteria, ...(task.source_acceptance_criteria ?? [])].some(
    isApiRouteBehaviorAcceptanceCriterion,
  );
}

function routeTaskBehaviorEvidenceCriterion(task: Task, criterion: string) {
  return (
    isApiRouteBehaviorAcceptanceCriterion(criterion) ||
    (taskHasApiRouteBehaviorCriterion(task) && isBehaviorLikeAcceptanceCriterion(criterion))
  );
}

export function withApiRouteBehaviorTestTasks(tasks: Task[]) {
  let changed = false;
  let next = [...tasks];

  for (const routeTask of tasks) {
    if (!taskOwnsApiRouteBehaviorSurface(routeTask)) continue;
    const behaviorCriteria = Array.from(
      new Set(
        [...routeTask.acceptance_criteria, ...(routeTask.source_acceptance_criteria ?? [])].filter((criterion) =>
          routeTaskBehaviorEvidenceCriterion(routeTask, criterion),
        ),
      ),
    );
    if (!behaviorCriteria.length) continue;

    const existingTestTask = next.find((task) => taskLooksLikeApiRouteBehaviorTest(task, routeTask.id));
    const testId = existingTestTask?.id ?? uniqueTaskIdFromTasks(next, `${routeTask.id}-api-route-behavior-tests`);

    if (!existingTestTask) {
      const routeIndex = next.findIndex((task) => task.id === routeTask.id);
      const insertionIndex = routeIndex < 0 ? next.length : routeIndex + 1;
      next = [
        ...next.slice(0, insertionIndex),
        apiRouteBehaviorTestTask(routeTask, testId, behaviorCriteria),
        ...next.slice(insertionIndex),
      ];
      changed = true;
    }

    next = next.map((task) => {
      if (task.id === testId) {
        const updated = appendTaskSourceAcceptanceCriteria(task, behaviorCriteria);
        if (updated !== task) changed = true;
        return updated;
      }
      if (task.id === testId || !task.depends_on.includes(routeTask.id) || task.depends_on.includes(testId)) return task;
      if (!taskCanDependOnTaskList(next, task.id, testId)) return task;
      changed = true;
      return appendDependencies(task, [testId]);
    });
  }

  return { tasks: next, changed };
}

function taskOwnsFrontendBehaviorSurface(task: Task) {
  return taskOwnedBoundaryPaths(task).some((path) => /^public\/.+\.(?:html|css|js|mjs)$/i.test(path));
}

function taskLooksLikeFrontendBehaviorTest(task: Task, frontendTaskId: string) {
  return (
    task.owner === 'engineer' &&
    task.depends_on.includes(frontendTaskId) &&
    taskOwnedBoundaryPaths(task).some((path) => /^test\/.*(?:frontend|ui|dom|browser).*\.test\.[cm]?[jt]s$/i.test(path)) &&
    /\b(?:frontend behavior|frontend shell|ui behavior|ui shell|static shell|layout behavior|dom|browser|public\/app\.js|run controls?|result cards?)\b/i.test(
      [task.deliverable, ...task.acceptance_criteria, ...task.owned_surfaces].join('\n'),
    )
  );
}

function frontendBehaviorTestTask(frontendTask: Task, testId: string, criteria: string[]): Task {
  const extension = taskTestSurfaceExtension(frontendTask);
  const testSurface = `test/frontend-behavior.test.${extension}`;
  return {
    id: testId,
    owner: 'engineer',
    deliverable:
      'Add frontend behavior tests that exercise the vanilla public UI with DOM fixtures, fetch mocks, state changes, run controls, result rendering, sorting, and recovery messages.',
    depends_on: [frontendTask.id],
    acceptance_criteria: Array.from(
      new Set([
        `${testSurface} exercises the vanilla public UI with DOM fixtures and mocked fetch/FileReader behavior instead of a frontend framework build.`,
        `${testSurface} proves UI behavior contracts for state changes, run controls, result cards, sorting/highlighting, and visible recovery messages that exist in the source task.`,
        'npm test passes and includes frontend behavior coverage.',
      ]),
    ),
    source_acceptance_criteria: Array.from(new Set(criteria)),
    owned_surfaces: [testSurface],
  };
}

export function withFrontendBehaviorTestTasks(tasks: Task[]) {
  let changed = false;
  let next = [...tasks];

  for (const frontendTask of tasks) {
    if (!taskOwnsFrontendBehaviorSurface(frontendTask)) continue;
    const evidenceCriteria = Array.from(
      new Set([...frontendTask.acceptance_criteria, ...(frontendTask.source_acceptance_criteria ?? [])]),
    );
    if (!evidenceCriteria.length) continue;

    const existingTestTask = next.find((task) => taskLooksLikeFrontendBehaviorTest(task, frontendTask.id));
    const testId = existingTestTask?.id ?? uniqueTaskIdFromTasks(next, `${frontendTask.id}-frontend-behavior-tests`);

    if (!existingTestTask) {
      const frontendIndex = next.findIndex((task) => task.id === frontendTask.id);
      const insertionIndex = frontendIndex < 0 ? next.length : frontendIndex + 1;
      next = [
        ...next.slice(0, insertionIndex),
        frontendBehaviorTestTask(frontendTask, testId, evidenceCriteria),
        ...next.slice(insertionIndex),
      ];
      changed = true;
    }

    next = next.map((task) => {
      if (task.id === testId) {
        const updated = appendTaskSourceAcceptanceCriteria(task, evidenceCriteria);
        if (updated !== task) changed = true;
        return updated;
      }
      if (task.id === testId || !task.depends_on.includes(frontendTask.id) || task.depends_on.includes(testId)) return task;
      if (!taskCanDependOnTaskList(next, task.id, testId)) return task;
      changed = true;
      return appendDependencies(task, [testId]);
    });
  }

  return { tasks: next, changed };
}

function validationBehaviorTestSurface(task: Task) {
  const extension = taskTestSurfaceExtension(task);
  return taskOwnsPathMatching(task, /^src\/validation\.[cm]?[jt]s$/i)
    ? `test/validation.test.${extension}`
    : `test/contracts.test.${extension}`;
}

function taskOwnsValidationBehaviorSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:contracts|validation)\.[cm]?[jt]s$/i);
}

function taskLooksLikeValidationBehaviorTest(task: Task, sourceTaskId: string, testSurface: string) {
  return (
    task.owner === 'engineer' &&
    task.depends_on.includes(sourceTaskId) &&
    taskOwnedBoundaryPaths(task).includes(testSurface) &&
    /\b(?:validation|contract|error shape|single-model|client-safe)\b/i.test(
      [task.deliverable, ...task.acceptance_criteria, ...task.owned_surfaces].join('\n'),
    )
  );
}

function validationBehaviorTestTask(sourceTask: Task, testId: string, testSurface: string, criteria: string[]): Task {
  const isValidation = /\/validation\.test\./.test(testSurface);
  return {
    id: testId,
    owner: 'engineer',
    deliverable: isValidation
      ? 'Add validation behavior tests that prove malformed requests, model selection, size limits, and provider-dispatch prevention with no real provider calls.'
      : 'Add domain contract behavior tests that prove client-safe error shapes, redaction rules, and single-model request contracts.',
    depends_on: [sourceTask.id],
    acceptance_criteria: Array.from(
      new Set([
        `${testSurface} imports the source contract or validation helpers directly and uses fake inputs with no real provider calls.`,
        `${testSurface} proves validation, client-safe error, redaction, and single-model behavior contracts owned by the source task.`,
        'npm test passes and includes validation/domain contract behavior coverage.',
      ]),
    ),
    source_acceptance_criteria: Array.from(new Set(criteria)),
    owned_surfaces: [testSurface],
  };
}

export function withValidationBehaviorTestTasks(tasks: Task[]) {
  let changed = false;
  let next = [...tasks];

  for (const sourceTask of tasks) {
    if (!taskOwnsValidationBehaviorSurface(sourceTask)) continue;
    const evidenceCriteria = Array.from(
      new Set([...sourceTask.acceptance_criteria, ...(sourceTask.source_acceptance_criteria ?? [])]),
    );
    if (!evidenceCriteria.length) continue;

    const testSurface = validationBehaviorTestSurface(sourceTask);
    const baseId = /\/validation\.test\./.test(testSurface)
      ? `${sourceTask.id}-validation-behavior-tests`
      : `${sourceTask.id}-contract-behavior-tests`;
    const existingTestTask = next.find((task) => taskLooksLikeValidationBehaviorTest(task, sourceTask.id, testSurface));
    const testId = existingTestTask?.id ?? uniqueTaskIdFromTasks(next, baseId);

    if (!existingTestTask) {
      const sourceIndex = next.findIndex((task) => task.id === sourceTask.id);
      const insertionIndex = sourceIndex < 0 ? next.length : sourceIndex + 1;
      next = [
        ...next.slice(0, insertionIndex),
        validationBehaviorTestTask(sourceTask, testId, testSurface, evidenceCriteria),
        ...next.slice(insertionIndex),
      ];
      changed = true;
    }

    next = next.map((task) => {
      if (task.id === testId) {
        const updated = appendTaskSourceAcceptanceCriteria(task, evidenceCriteria);
        if (updated !== task) changed = true;
        return updated;
      }
      if (task.id === testId || !task.depends_on.includes(sourceTask.id) || task.depends_on.includes(testId)) return task;
      if (!taskCanDependOnTaskList(next, task.id, testId)) return task;
      changed = true;
      return appendDependencies(task, [testId]);
    });
  }

  return { tasks: next, changed };
}
