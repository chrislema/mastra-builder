import { createStep, createWorkflow } from '@mastra/core/workflows';
import { safePersistDeliveryStateWithMastra } from '../observability';
import { deliveryWorkflowInputSchema } from '../run-input';
import { deliveryScaffoldStepScorers } from '../scorers';
import { executeDeliveryScaffold } from '../scaffold-workflow';
import { annotateTaskPlanWithTypedMetadata } from '../task-plan-metadata';
import { markDeliveryRunFailedOnWorkflowError } from '../workflow-support/errors';
import { syncDeliveryWorkflowState } from '../workflow-support/state-sync';
import {
  deliveryWorkflowStateSchema,
  planStageOutputSchema,
  workflowOutputSchema,
} from '../workflow-schemas';
import { deliveryBuildWorkflow } from './build.workflow';
import { deliveryDeploymentWorkflow } from './deployment.workflow';
import { deliveryPlanningWorkflow } from './planning.workflow';
import { deliveryReleaseGateWorkflow } from './release-gate.workflow';
import { deliveryReviewWorkflow } from './review.workflow';

const createScaffoldArtifactsStep = createStep({
  id: 'create-scaffold-artifacts',
  description: 'Generate deterministic Cloudflare Worker scaffold artifacts after planning and before agent implementation.',
  inputSchema: planStageOutputSchema,
  outputSchema: planStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  scorers: deliveryScaffoldStepScorers,
  execute: async ({ inputData, mastra, state, setState }) => {
    if (inputData.status !== 'planned') return inputData;

    const scaffold = await executeDeliveryScaffold(
      {
        repoPath: inputData.repoPath,
        runId: inputData.runId,
        sourcePolicy: inputData.sourcePolicy,
      },
      mastra,
    );
    const artifacts = [...new Set([...inputData.artifacts, scaffold.manifestPath])];
    const checks = [
      ...inputData.checks,
      ...scaffold.checks.map((check) => ({ check: check.check, passed: check.passed, reason: check.reason })),
    ];
    const failedScaffoldChecks = scaffold.checks.filter((check) => !check.passed);
    const taskPlan = inputData.taskPlan
      ? annotateTaskPlanWithTypedMetadata(inputData.taskPlan, scaffold.scaffoldManifest)
      : inputData.taskPlan;
    const nextSteps = [
      `Scaffold manifest generated at ${scaffold.manifestPath}.`,
      ...inputData.nextSteps.filter((step) => !/scaffold manifest generated/i.test(step)),
    ];
    const output = {
      ...inputData,
      status: failedScaffoldChecks.length ? ('stuck' as const) : inputData.status,
      summary: failedScaffoldChecks.length
        ? 'Scaffold deterministic checks failed before architect review.'
        : inputData.summary,
      artifacts,
      checks,
      taskPlan,
      scaffoldManifest: scaffold.scaffoldManifest,
      scaffoldManifestPath: scaffold.manifestPath,
      nextSteps: failedScaffoldChecks.length ? failedScaffoldChecks.map((check) => check.reason) : nextSteps,
    };

    await syncDeliveryWorkflowState({ state, setState, output });
    await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    return output;
  },
});

export const deliveryWorkflow = createWorkflow({
  id: 'delivery-workflow',
  description:
    'Native Delivery Engine workflow: initialize run state, plan, review, build, release-gate, deploy, and finish.',
  inputSchema: deliveryWorkflowInputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(deliveryPlanningWorkflow)
  .then(createScaffoldArtifactsStep)
  .then(deliveryReviewWorkflow)
  .then(deliveryBuildWorkflow)
  .then(deliveryReleaseGateWorkflow)
  .then(deliveryDeploymentWorkflow)
  .commit();
