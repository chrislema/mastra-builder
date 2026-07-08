import type { WorkflowErrorCallbackInfo } from '@mastra/core/workflows';
import { safePersistDeliveryStateWithMastra } from '../observability';
import { finishDeliveryRun, readDeliveryRun } from '../state';
import { finishDeliveryRunState } from '../state-service';

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function workflowErrorFailure(error: WorkflowErrorCallbackInfo['error']) {
  const name = stringField(error?.name) ?? 'WorkflowError';
  const message = stringField(error?.message) ?? 'Delivery workflow failed without a serialized error message.';
  return { name, message };
}

function initializedDeliveryRunFailureTarget(errorInfo: WorkflowErrorCallbackInfo) {
  const state = errorInfo.state as Record<string, unknown> | undefined;
  const initData = errorInfo.getInitData?.() as Record<string, unknown> | undefined;
  const repoPath =
    stringField(state?.repoPath) ??
    stringField(state?.projectFolder) ??
    stringField(initData?.repoPath) ??
    stringField(initData?.projectFolder);
  const runId = stringField(state?.runId);

  if (!repoPath || !runId) return undefined;
  return { repoPath, runId };
}

export async function markDeliveryRunFailedOnWorkflowError(errorInfo: WorkflowErrorCallbackInfo) {
  const target = initializedDeliveryRunFailureTarget(errorInfo);
  if (!target) {
    errorInfo.logger.warn('Delivery workflow failed before an initialized delivery run was available', {
      workflowId: errorInfo.workflowId,
      runId: errorInfo.runId,
      resourceId: errorInfo.resourceId,
      error: errorInfo.error?.message,
    });
    return;
  }

  const currentRun = readDeliveryRun(target.repoPath);
  if (currentRun.run_id !== target.runId) {
    errorInfo.logger.warn('Delivery workflow failure did not match the active local delivery run', {
      workflowId: errorInfo.workflowId,
      workflowRunId: errorInfo.runId,
      deliveryRunId: target.runId,
      activeDeliveryRunId: currentRun.run_id,
      repoPath: target.repoPath,
    });
    return;
  }

  const failure = workflowErrorFailure(errorInfo.error);
  try {
    await finishDeliveryRunState({
      repoPath: target.repoPath,
      status: 'failed',
      summary: `Delivery workflow failed: ${failure.message}`,
      failure,
      mastra: errorInfo.mastra,
    });
  } catch (stateError) {
    errorInfo.logger.warn('Failed to mark delivery run failed through Mastra-backed state service; falling back locally', {
      repoPath: target.repoPath,
      deliveryRunId: target.runId,
      error: stateError instanceof Error ? stateError.message : String(stateError),
    });
    finishDeliveryRun({
      repoPath: target.repoPath,
      status: 'failed',
      summary: `Delivery workflow failed: ${failure.message}`,
      failure,
    });
  }

  await safePersistDeliveryStateWithMastra({ repoPath: target.repoPath, mastra: errorInfo.mastra });
}
