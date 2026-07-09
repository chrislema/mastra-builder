import { createStep, createWorkflow } from '@mastra/core/workflows';
import { appendDeliveryEventState } from '../state-service';
import { deliveryBuildStepScorers } from '../scorers';
import {
  deliveryBuildResumePlan,
  deliveryBuildResumeReason,
} from '../implementation/reusable-artifacts';
import { markDeliveryRunFailedOnWorkflowError } from '../workflow-support/errors';
import { syncBuildStateStep } from '../workflow-support/state-sync';
import { scaffoldStageFields } from '../workflow-support/stage-fields';
import {
  buildTaskResultsSchema,
  buildTaskWorkItemsSchema,
  deliveryStageOutputSchema,
  deliveryWorkflowStateSchema,
} from '../workflow-schemas';
import { taskPacketRailsForTask } from '../task-packet-rails';
import { topoOrderTasks } from '../task-plan-dependencies';
import { deliveryBuildTaskWorkflow } from './build-task.workflow';

const taskStatusSummary = (state: Record<string, 'complete' | 'stuck' | 'blocked'>) =>
  Object.entries(state).map(([id, status]) => `${id}:${status}`);

const prepareBuildTasksStep = createStep({
  id: 'prepare-build-tasks',
  description: 'Expand the reviewed task plan into workflow-native build work items.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: buildTaskWorkItemsSchema,
  execute: async ({ inputData, mastra }) => {
    const passThrough = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      taskIndex: 0,
      skipped: true,
    });

    if (inputData.status !== 'reviewed') return [passThrough()];
    if (!inputData.taskPlan) throw new Error('review stage did not provide a task plan for the build loop');

    const orderedTasks = topoOrderTasks(inputData.taskPlan.tasks);
    if (!orderedTasks.length) {
      return [
        {
          ...passThrough(),
          status: 'built' as const,
          summary: 'Build loop completed: no implementation tasks were present.',
          nextSteps: ['Run the release gate stage against the reviewed task plan.'],
        },
      ];
    }
    const taskPlan = inputData.taskPlan;

    const resumePlan = deliveryBuildResumePlan(inputData.repoPath, taskPlan);
    const resumeReason = deliveryBuildResumeReason(resumePlan);
    const checks = resumeReason
      ? [...inputData.checks, { check: 'build_resume_cursor', passed: true, reason: resumeReason }]
      : inputData.checks;

    if (resumeReason) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'build_resume_cursor',
          stage: 'build',
          ok: true,
          reusable_task_ids: resumePlan.reusableTaskIds,
          resume_after_task: resumePlan.resumeAfterTaskId,
          next_task: resumePlan.nextTaskId,
          total_tasks: resumePlan.totalTasks,
        },
      }).catch(() => undefined);
    }

    await appendDeliveryEventState({
      repoPath: inputData.repoPath,
      mastra,
      event: {
        type: 'task_packets_emitted',
        stage: 'build',
        total_tasks: orderedTasks.length,
        tasks: orderedTasks.map((task) => {
          const rails = taskPacketRailsForTask({
            taskPlan,
            task,
            scaffoldManifest: inputData.scaffoldManifest,
            maxAttempts: inputData.maxRetries + 1,
          });

          return {
            id: task.id,
            owner: task.owner,
            task_kind: rails.task_kind,
            surface_kind: rails.surface_kind,
            evidence_kind: rails.evidence_kind,
            runtime_kind: rails.runtime_class,
            verification_command_class: rails.verification_command_class,
            allowed_surfaces: rails.allowed_surfaces,
            scaffold_owned_allowed_surfaces: rails.scaffold_owned_allowed_surfaces,
            model_budget: rails.model_budget,
          };
        }),
      },
    }).catch(() => undefined);

    return orderedTasks.map((task, taskIndex) => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      task,
      taskIndex,
      skipped: false,
    }));
  },
});

const aggregateBuildTaskResultsStep = createStep({
  id: 'delivery-build-loop',
  description: 'Aggregate workflow-native build task results into the delivery stage output.',
  inputSchema: buildTaskResultsSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  scorers: deliveryBuildStepScorers,
  execute: async ({ inputData, state }) => {
    const first = inputData[0];
    if (!first) throw new Error('build loop did not receive any task results');
    const scaffoldFields = scaffoldStageFields(first.scaffoldManifest ? first : state);

    const uniqueArtifacts = Array.from(new Set(inputData.flatMap((result) => result.artifacts)));
    const checkKeys = new Set<string>();
    const checks = inputData
      .flatMap((result) => result.checks)
      .filter((check) => {
        const key = `${check.check}:${check.passed}:${check.reason}`;
        if (checkKeys.has(key)) return false;
        checkKeys.add(key);
        return true;
      });
    const judgmentKeys = new Set<string>();
    const judgments = inputData
      .flatMap((result) => result.judgments)
      .filter((judgment) => {
        if (judgmentKeys.has(judgment.path)) return false;
        judgmentKeys.add(judgment.path);
        return true;
      });
    const taskState = Object.fromEntries(
      inputData
        .filter((result) => result.taskId && result.taskStatus && result.taskStatus !== 'skipped')
        .map((result) => [result.taskId, result.taskStatus]),
    ) as Record<string, 'complete' | 'stuck' | 'blocked'>;

    const allSkipped = inputData.every((result) => result.taskStatus === 'skipped' || !result.taskId);
    if (allSkipped) {
      return {
        repoPath: first.repoPath,
        maxRetries: first.maxRetries,
        deployMode: first.deployMode,
        reviewMode: first.reviewMode,
        taskPlan: first.taskPlan,
        releaseGate: first.releaseGate,
        ...scaffoldFields,
        status: first.status,
        runId: first.runId,
        summary: first.summary,
        artifacts: uniqueArtifacts,
        checks,
        judgments,
        questions: first.questions,
        nextSteps: first.nextSteps,
      };
    }

    const blockedOrStuck = Object.entries(taskState).filter(([, status]) => status !== 'complete');
    if (blockedOrStuck.length) {
      return {
        repoPath: first.repoPath,
        maxRetries: first.maxRetries,
        deployMode: first.deployMode,
        reviewMode: first.reviewMode,
        taskPlan: first.taskPlan,
        releaseGate: first.releaseGate,
        ...scaffoldFields,
        status: 'stuck' as const,
        runId: first.runId,
        summary: 'Build loop stopped with stuck or blocked tasks.',
        artifacts: uniqueArtifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: blockedOrStuck.map(([id, status]) => `${id}:${status}`),
      };
    }

    return {
      repoPath: first.repoPath,
      maxRetries: first.maxRetries,
      deployMode: first.deployMode,
      reviewMode: first.reviewMode,
      taskPlan: first.taskPlan,
      releaseGate: first.releaseGate,
      ...scaffoldFields,
      status: 'built' as const,
      runId: first.runId,
      summary: `Build loop completed: ${taskStatusSummary(taskState).join(', ')}`,
      artifacts: uniqueArtifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Run the release gate stage against implementation notes and changed code.'],
    };
  },
});

export const deliveryBuildWorkflow = createWorkflow({
  id: 'delivery-build',
  description: 'Prepare implementation tasks, run the nested build-task workflow, and persist build-stage state.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(prepareBuildTasksStep)
  .foreach(deliveryBuildTaskWorkflow, { concurrency: 1 })
  .then(aggregateBuildTaskResultsStep)
  .then(syncBuildStateStep)
  .commit();
