import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { deliveryApiRoutes } from '../../src/mastra/delivery-engine/routes.ts';
import {
  createDeliveryWorkflowRequestContext,
  deliveryWorkflowResourceId,
  type DeliveryWorkflowRunInput,
  startDeliveryWorkflowRun,
  startDeliveryWorkflowRunAsync,
} from '../../src/mastra/delivery-engine/runner.ts';
import { initializeDeliveryRun, readDeliveryRun } from '../../src/mastra/delivery-engine/state.ts';

const withOpenAIKey = async <T>(value: string | undefined, fn: () => Promise<T>) => {
  const previous = process.env.OPENAI_API_KEY;
  if (value === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = value;
  }

  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  }
};

const startDeliveryWorkflowRunWithKey = (host: Parameters<typeof startDeliveryWorkflowRun>[0], input: DeliveryWorkflowRunInput) =>
  withOpenAIKey('test-openai-key', () => startDeliveryWorkflowRun(host, input));

const startDeliveryWorkflowRunAsyncWithKey = (
  host: Parameters<typeof startDeliveryWorkflowRunAsync>[0],
  input: DeliveryWorkflowRunInput,
) => withOpenAIKey('test-openai-key', () => startDeliveryWorkflowRunAsync(host, input));

test('delivery workflow runner creates a resource-scoped workflow run', async () => {
  const captured: {
    workflowId?: string;
    createRunOptions?: Record<string, unknown>;
    startOptions?: Record<string, any>;
  } = {};
  const host = {
    getWorkflow: (id: 'deliveryWorkflow') => {
      captured.workflowId = id;
      return {
        createRun: async (options: Record<string, unknown>) => {
          captured.createRunOptions = options;
          return {
            runId: 'workflow-run-1',
            start: async (options: Record<string, any>) => {
              captured.startOptions = options;
              return { status: 'success' };
            },
          };
        },
      } as any;
    },
  };

  const response = await startDeliveryWorkflowRunWithKey(host, {
    repoPath: '/tmp/delivery-target',
    visionPath: 'docs/vision.md',
    specPath: 'docs/spec.md',
    maxRetries: 1,
    deployMode: 'mock',
  });

  const repoPath = resolve('/tmp/delivery-target');

  assert.equal(captured.workflowId, 'deliveryWorkflow');
  assert.deepEqual(captured.createRunOptions, {
    resourceId: deliveryWorkflowResourceId(repoPath),
  });
  assert.deepEqual(captured.startOptions?.inputData, {
    repoPath,
    visionPath: 'docs/vision.md',
    specPath: 'docs/spec.md',
    maxRetries: 1,
    deployMode: 'mock',
  });
  assert.equal(captured.startOptions?.requestContext.get('repoPath'), repoPath);
  assert.deepEqual(captured.startOptions?.outputOptions, { includeState: true });
  assert.equal(captured.startOptions?.tracingOptions.metadata.deliveryEngine, true);
  assert.deepEqual(captured.startOptions?.tracingOptions.requestContextKeys, ['repoPath']);
  assert.equal(response.workflowId, 'delivery-workflow');
  assert.equal(response.runId, 'workflow-run-1');
  assert.equal(response.resourceId, deliveryWorkflowResourceId(repoPath));
  assert.deepEqual(response.result, { status: 'success' });
});

test('delivery workflow runner honors explicit resource and run ids', async () => {
  let createRunOptions: Record<string, unknown> | undefined;
  const host = {
    getWorkflow: () =>
      ({
        createRun: async (options: Record<string, unknown>) => {
          createRunOptions = options;
          return {
            runId: 'external-run',
            start: async () => ({ status: 'success' }),
          };
        },
      }) as any,
  };

  await startDeliveryWorkflowRunWithKey(host, {
    repoPath: '/tmp/delivery-target',
    resourceId: 'delivery:external',
    runId: 'external-run',
  });

  assert.deepEqual(createRunOptions, {
    runId: 'external-run',
    resourceId: 'delivery:external',
  });
});

test('delivery workflow runner closes initialized delivery state after a failed workflow result', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-runner-failed-'));
  writeFileSync(join(repoPath, 'vision.md'), '# Vision\n');
  writeFileSync(join(repoPath, 'spec.md'), '# Spec\n');
  initializeDeliveryRun({ repoPath, visionPath: 'vision.md', specPath: 'spec.md' });

  const host = {
    getWorkflow: () =>
      ({
        createRun: async () => ({
          runId: 'failed-run',
          start: async () => ({ status: 'failed', error: { message: 'boom' } }),
        }),
      }) as any,
  };

  const response = await startDeliveryWorkflowRunWithKey(host, { repoPath });

  assert.equal((response.result as Record<string, unknown>).status, 'failed');
  const deliveryRun = readDeliveryRun(repoPath);
  assert.equal(deliveryRun.status, 'failed');
  assert.equal(deliveryRun.stage, 'done');
  assert.equal(typeof deliveryRun.finished_at, 'string');
});

test('delivery workflow runner fails preflight before creating a run without model credentials', async () => {
  let createRunCalled = false;
  const host = {
    getWorkflow: () =>
      ({
        createRun: async () => {
          createRunCalled = true;
          return {
            runId: 'should-not-exist',
            start: async () => ({ status: 'success' }),
          };
        },
      }) as any,
  };

  await withOpenAIKey(undefined, async () => {
    await assert.rejects(
      startDeliveryWorkflowRun(host, { repoPath: '/tmp/delivery-target' }),
      /Delivery workflow requires OPENAI_API_KEY/,
    );
  });
  assert.equal(createRunCalled, false);
});

test('delivery workflow async runner starts without waiting for completion', async () => {
  let startCalled = false;
  let startAsyncOptions: Record<string, any> | undefined;
  const host = {
    getWorkflow: () =>
      ({
        createRun: async () => ({
          runId: 'async-run',
          start: async () => {
            startCalled = true;
            return { status: 'should-not-run' };
          },
          startAsync: async (options: Record<string, any>) => {
            startAsyncOptions = options;
            return { runId: 'async-run' };
          },
        }),
      }) as any,
  };

  const response = await startDeliveryWorkflowRunAsyncWithKey(host, {
    repoPath: '/tmp/delivery-target',
    deployMode: 'mock',
  });

  assert.equal(startCalled, false);
  assert.equal(startAsyncOptions?.inputData.repoPath, resolve('/tmp/delivery-target'));
  assert.equal(startAsyncOptions?.requestContext.get('repoPath'), resolve('/tmp/delivery-target'));
  assert.equal(response.status, 'started');
  assert.equal(response.runId, 'async-run');
});

test('delivery workflow request context carries the resolved repo path', () => {
  const context = createDeliveryWorkflowRequestContext('/tmp/delivery-target');
  assert.equal(context.get('repoPath'), resolve('/tmp/delivery-target'));
});

test('delivery API routes expose the workflow launch route', () => {
  assert.equal(deliveryApiRoutes.length, 1);
  assert.equal(deliveryApiRoutes[0].path, '/delivery/run');
  assert.equal(deliveryApiRoutes[0].method, 'POST');
  assert.equal(deliveryApiRoutes[0].openapi?.tags?.includes('Delivery Engine'), true);
});
