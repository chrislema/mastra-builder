import { createStep } from '@mastra/core/workflows';
import { safePersistDeliveryStateWithMastra } from '../observability';
import {
  deliveryStageOutputSchema,
  deliveryWorkflowStateSchema,
  deploymentReportStageSchema,
  workflowOutputSchema,
  type CheckSummary,
  type DeliveryWorkflowState,
  type JudgmentRef,
} from '../workflow-schemas';

export const normalizeDeliveryWorkflowState = (
  state?: Partial<DeliveryWorkflowState>,
): DeliveryWorkflowState => ({
  repoPath: state?.repoPath,
  runId: state?.runId,
  status: state?.status,
  summary: state?.summary,
  maxRetries: state?.maxRetries,
  deployMode: state?.deployMode,
  reviewMode: state?.reviewMode,
  artifacts: state?.artifacts ?? [],
  checks: state?.checks ?? [],
  judgments: state?.judgments ?? [],
  questions: state?.questions ?? [],
  nextSteps: state?.nextSteps ?? [],
  sourcePolicy: state?.sourcePolicy,
  scaffoldManifest: state?.scaffoldManifest,
  scaffoldManifestPath: state?.scaffoldManifestPath,
  taskPlan: state?.taskPlan,
  releaseGate: state?.releaseGate,
  deploymentReport: state?.deploymentReport,
  deploymentReportPath: state?.deploymentReportPath,
});

export async function syncDeliveryWorkflowState({
  state,
  setState,
  output,
}: {
  state?: Partial<DeliveryWorkflowState>;
  setState: (state: DeliveryWorkflowState) => Promise<void> | void;
  output: Partial<DeliveryWorkflowState> & {
    repoPath?: string;
    runId?: string;
    status?: DeliveryWorkflowState['status'];
    summary?: string;
    artifacts?: string[];
    checks?: CheckSummary[];
    judgments?: JudgmentRef[];
    questions?: string[];
    nextSteps?: string[];
  };
}) {
  const current = normalizeDeliveryWorkflowState(state);
  await setState({
    ...current,
    repoPath: output.repoPath ?? current.repoPath,
    runId: output.runId ?? current.runId,
    status: output.status ?? current.status,
    summary: output.summary ?? current.summary,
    maxRetries: output.maxRetries ?? current.maxRetries,
    deployMode: output.deployMode ?? current.deployMode,
    reviewMode: output.reviewMode ?? current.reviewMode,
    artifacts: output.artifacts ?? current.artifacts,
    checks: output.checks ?? current.checks,
    judgments: output.judgments ?? current.judgments,
    questions: output.questions ?? current.questions,
    nextSteps: output.nextSteps ?? current.nextSteps,
    sourcePolicy: output.sourcePolicy ?? current.sourcePolicy,
    scaffoldManifest: output.scaffoldManifest ?? current.scaffoldManifest,
    scaffoldManifestPath: output.scaffoldManifestPath ?? current.scaffoldManifestPath,
    taskPlan: output.taskPlan ?? current.taskPlan,
    releaseGate: output.releaseGate ?? current.releaseGate,
    deploymentReport: output.deploymentReport ?? current.deploymentReport,
    deploymentReportPath: output.deploymentReportPath ?? current.deploymentReportPath,
  });
}

export const createSyncDeliveryStageStateStep = (id: string, description: string) =>
  createStep({
    id,
    description,
    inputSchema: deliveryStageOutputSchema,
    outputSchema: deliveryStageOutputSchema,
    stateSchema: deliveryWorkflowStateSchema,
    execute: async ({ inputData, state, setState, mastra }) => {
      await syncDeliveryWorkflowState({ state, setState, output: inputData });
      await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
      return inputData;
    },
  });

export const syncPlanStateStep = createSyncDeliveryStageStateStep(
  'sync-plan-state',
  'Persist plan gate output into the native workflow state snapshot.',
);

export const syncReviewStateStep = createSyncDeliveryStageStateStep(
  'sync-review-state',
  'Persist architect review output into the native workflow state snapshot.',
);

export const syncBuildStateStep = createSyncDeliveryStageStateStep(
  'sync-build-state',
  'Persist build aggregation output into the native workflow state snapshot.',
);

export const syncReleaseGateStateStep = createSyncDeliveryStageStateStep(
  'sync-release-gate-state',
  'Persist release gate output into the native workflow state snapshot.',
);

export const syncDeploymentReportStateStep = createStep({
  id: 'sync-deployment-report-state',
  description: 'Persist deployment report output into the native workflow state snapshot.',
  inputSchema: deploymentReportStageSchema,
  outputSchema: deploymentReportStageSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state, setState, mastra }) => {
    await syncDeliveryWorkflowState({ state, setState, output: inputData });
    if (inputData.repoPath) await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    return inputData;
  },
});

export const syncFinalDeliveryStateStep = createStep({
  id: 'sync-final-delivery-state',
  description: 'Persist final delivery workflow output into the native workflow state snapshot.',
  inputSchema: workflowOutputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state, setState, mastra }) => {
    await syncDeliveryWorkflowState({ state, setState, output: inputData });
    if (inputData.repoPath) await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    return inputData;
  },
});
