import { workerScaffoldAcceptanceContractIdForCriterion } from '../acceptance-contracts';
import {
  generatedSliceAcceptanceCriterion,
  generatedSliceFamilyId,
} from '../task-plan-generated-slices';
import {
  taskAcceptanceContractCriteria,
  taskSourceTaskId,
} from './task-contracts';
import type { Task, TaskPlan } from '../workflow-schemas';

export function generatedWorkerTypeOwnershipCriterion(criterion: string) {
  return (
    /\bworker-configuration\.d\.ts\b/i.test(criterion) &&
    /\b(?:engineer-owned|owned generated|committed as part of the scaffold contract|concrete project file rather than relying on an unowned generated artifact)\b/i.test(
      criterion,
    )
  );
}

export function acceptanceContractId(task: Task, index: number, criterion?: string) {
  const registryId = criterion ? workerScaffoldAcceptanceContractIdForCriterion(criterion) : undefined;
  if (registryId) return `${taskSourceTaskId(task)}:${registryId}`;
  return `${taskSourceTaskId(task)}-AC${String(index + 1).padStart(2, '0')}`;
}

function allTaskAcceptanceContractCriteria(taskPlan: TaskPlan) {
  return taskPlan.tasks.flatMap((task) =>
    taskAcceptanceContractCriteria(task).map((criterion, index) => ({
      taskId: task.id,
      sourceTaskId: taskSourceTaskId(task),
      contractId: acceptanceContractId(task, index, criterion),
      criterion,
    })),
  );
}

function conditionalGeneratedPolicyAcceptanceCriterion(criterion: string) {
  return (
    generatedWorkerTypeOwnershipCriterion(criterion) ||
    /src\/index\.js exports a minimal class named WeeklyWorkflow that extends WorkflowEntrypoint when wrangler\.jsonc defines workflows\.class_name "WeeklyWorkflow"/i.test(
      criterion,
    ) ||
    /src\/index\.js changes preserve the existing default fetch handler[\s\S]*WeeklyWorkflow export/i.test(criterion) ||
    /src\/index\.js preserves a stable WeeklyWorkflow export/i.test(criterion) ||
    /README\.md documents direct Authorization: Bearer <ADMIN_TOKEN>[\s\S]*SESSION_SECRET/i.test(criterion) ||
    /^Profile (?:upload|storage|repository|upload, profile activation)/i.test(criterion) ||
    /^Cookie-authenticated (?:profile|run|regeneration)/i.test(criterion) ||
    /^POST \/profiles accepts multipart\/form-data uploads for audience_segments and voice_profile markdown/i.test(criterion) ||
    /^POST \/profiles\/:id\/activate atomically activates the selected profile/i.test(criterion) ||
    /^GET \/profiles returns profile metadata and active-state summaries/i.test(criterion) ||
    /^POST \/runs creates a queued manual run record with a default previous-seven-day window/i.test(criterion) ||
    /^GET \/runs\/:id returns run status, requested window, profile artifact IDs used/i.test(criterion) ||
    /^GET \/latest returns the latest completed transcript with title, hook, transcript, captions, sourceUrls/i.test(criterion) ||
    /^run, latest route handlers delegate/i.test(criterion) ||
    /^Route integration defines and enforces the protection matrix/i.test(criterion) ||
    /^The router surface explicitly registers the browser session endpoint/i.test(criterion)
  );
}

function allProductAcceptanceContractCriteria(taskPlan: TaskPlan) {
  return allTaskAcceptanceContractCriteria(taskPlan).filter(
    (contract) =>
      !generatedSliceAcceptanceCriterion(contract.criterion) &&
      !conditionalGeneratedPolicyAcceptanceCriterion(contract.criterion),
  );
}

function revisedPlanCarriesCriterion(taskPlan: TaskPlan, criterion: string) {
  return taskPlan.tasks.some((task) => taskAcceptanceContractCriteria(task).includes(criterion));
}

function revisedContractTargetIndex(tasks: Task[], contract: { taskId: string; sourceTaskId: string }) {
  const exact = tasks.findIndex((task) => task.id === contract.taskId);
  if (exact >= 0) return exact;

  const sourceMatch = tasks.findIndex((task) => taskSourceTaskId(task) === contract.sourceTaskId);
  if (sourceMatch >= 0) return sourceMatch;

  const familyId = generatedSliceFamilyId(contract.taskId);
  const generatedFamily = tasks.findIndex((task) => generatedSliceFamilyId(task.id) === familyId);
  if (generatedFamily >= 0) return generatedFamily;

  return revisedEvidenceTaskTargetIndex(tasks, contract);
}

function taskLineageRootId(taskId: string) {
  return taskId.match(/^(T\d+)(?:-|$)/i)?.[1] ?? taskId;
}

function taskIdLooksLikeEvidenceTask(taskId: string) {
  return /(?:test|tests|evidence|behavior)/i.test(taskId);
}

function taskOwnsTestSurface(task: Task) {
  return task.owned_surfaces.some((surface) => /^test\//i.test(surface));
}

function revisedEvidenceTaskTargetIndex(tasks: Task[], contract: { taskId: string; sourceTaskId: string }) {
  if (!taskIdLooksLikeEvidenceTask(contract.taskId) && !taskIdLooksLikeEvidenceTask(contract.sourceTaskId)) {
    return -1;
  }

  const contractRootIds = new Set([taskLineageRootId(contract.taskId), taskLineageRootId(contract.sourceTaskId)]);
  const evidenceCandidates = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => {
      const taskRootIds = new Set([taskLineageRootId(task.id), taskLineageRootId(taskSourceTaskId(task))]);
      return (
        task.owner === 'engineer' &&
        taskOwnsTestSurface(task) &&
        [...contractRootIds].some((rootId) => taskRootIds.has(rootId))
      );
    });

  if (evidenceCandidates.length === 1) return evidenceCandidates[0].index;

  const preferred = evidenceCandidates.find(({ task }) => taskIdLooksLikeEvidenceTask(task.id));
  return preferred?.index ?? -1;
}

export function preserveTaskPlanAcceptanceContracts(previousTaskPlan: TaskPlan, revisedTaskPlan: TaskPlan) {
  const missing = allProductAcceptanceContractCriteria(previousTaskPlan).filter(
    (contract) => !revisedPlanCarriesCriterion(revisedTaskPlan, contract.criterion),
  );
  if (!missing.length) return { taskPlan: revisedTaskPlan, carried: 0 };

  const tasks = revisedTaskPlan.tasks.map((task) => ({
    ...task,
    source_acceptance_criteria: task.source_acceptance_criteria ? [...task.source_acceptance_criteria] : undefined,
  }));
  let carried = 0;

  for (const contract of missing) {
    const targetIndex = revisedContractTargetIndex(tasks, contract);
    if (targetIndex < 0) continue;

    const target = tasks[targetIndex];
    if (taskAcceptanceContractCriteria(target).includes(contract.criterion)) continue;

    tasks[targetIndex] = {
      ...target,
      source_acceptance_criteria: Array.from(
        new Set([...(target.source_acceptance_criteria ?? []), contract.criterion]),
      ),
    };
    carried += 1;
  }

  return carried ? { taskPlan: { ...revisedTaskPlan, tasks }, carried } : { taskPlan: revisedTaskPlan, carried: 0 };
}

export function taskPlanAcceptanceContractRegression(previousTaskPlan: TaskPlan, revisedTaskPlan: TaskPlan) {
  const missing = allProductAcceptanceContractCriteria(previousTaskPlan).filter(
    (contract) => !revisedPlanCarriesCriterion(revisedTaskPlan, contract.criterion),
  );

  if (!missing.length) return { passed: true, reason: 'ok' };

  const examples = missing
    .slice(0, 5)
    .map((contract) => `${contract.taskId}/${contract.contractId}: ${contract.criterion}`)
    .join(' | ');
  const suffix = missing.length > 5 ? `; ${missing.length - 5} more contract(s) omitted` : '';
  return {
    passed: false,
    reason: `Task plan revision dropped acceptance contract(s) from the prior plan. Preserve each criterion verbatim in acceptance_criteria or source_acceptance_criteria when splitting/refining tasks: ${examples}${suffix}`,
  };
}
