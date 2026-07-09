import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkflowErrorCallbackInfo } from '@mastra/core/workflows';
import { markDeliveryRunFailedOnWorkflowError } from '../../src/mastra/delivery-engine/workflow-support/errors.ts';
import { initializeDeliveryRun, readDeliveryRun } from '../../src/mastra/delivery-engine/state.ts';

const createRepo = () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workflow-error-'));
  writeFileSync(join(repoPath, 'vision.md'), '# Vision\n');
  return repoPath;
};

function workflowErrorInfo({
  repoPath,
  deliveryRunId,
  warnings,
}: {
  repoPath: string;
  deliveryRunId?: string;
  warnings: unknown[][];
}) {
  return {
    status: 'failed',
    error: { name: 'Error', message: 'rubric asset missing' },
    steps: {},
    runId: 'mastra-workflow-run',
    workflowId: 'delivery-workflow',
    getInitData: () => ({ repoPath }),
    requestContext: {},
    logger: {
      warn(message: string, ...args: unknown[]) {
        warnings.push([message, ...args]);
      },
    },
    state: deliveryRunId ? { repoPath, runId: deliveryRunId } : { repoPath },
  } as unknown as WorkflowErrorCallbackInfo;
}

test('delivery workflow onError marks an initialized delivery run failed', async () => {
  const repoPath = createRepo();
  const run = initializeDeliveryRun({ repoPath, visionPath: 'vision.md' });
  const warnings: unknown[][] = [];

  await markDeliveryRunFailedOnWorkflowError(workflowErrorInfo({ repoPath, deliveryRunId: run.run_id, warnings }));

  const failedRun = readDeliveryRun(repoPath);
  assert.equal(failedRun.run_id, run.run_id);
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.stage, 'done');
  assert.equal(failedRun.failure?.message, 'rubric asset missing');
  assert.equal(warnings.length, 0);
});

test('delivery workflow onError does not close a run when the failure happened before initialization', async () => {
  const repoPath = createRepo();
  const run = initializeDeliveryRun({ repoPath, visionPath: 'vision.md' });
  const warnings: unknown[][] = [];

  await markDeliveryRunFailedOnWorkflowError(workflowErrorInfo({ repoPath, warnings }));

  const activeRun = readDeliveryRun(repoPath);
  assert.equal(activeRun.run_id, run.run_id);
  assert.equal(activeRun.status, 'running');
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /before an initialized delivery run/);
});
