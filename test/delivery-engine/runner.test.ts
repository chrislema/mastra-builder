import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { initializeDeliveryRun, readDeliveryEvents, readDeliveryRun } from '../../src/mastra/delivery-engine/state.ts';

const withOpenAiKey = async <T>(value: string | undefined, fn: () => Promise<T>) => {
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
  withOpenAiKey('test-openai-key', () => startDeliveryWorkflowRun(host, input));

const startDeliveryWorkflowRunAsyncWithKey = (
  host: Parameters<typeof startDeliveryWorkflowRunAsync>[0],
  input: DeliveryWorkflowRunInput,
) => withOpenAiKey('test-openai-key', () => startDeliveryWorkflowRunAsync(host, input));

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

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
              return {
                status: 'success',
                state: {
                  status: 'complete',
                  summary: 'Local validation complete.',
                  deployMode: 'local',
                  nextSteps: ['proceed'],
                },
              };
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
    deployMode: 'local',
    reviewMode: 'fast',
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
    deployMode: 'local',
    reviewMode: 'fast',
  });
  assert.equal(captured.startOptions?.requestContext.get('repoPath'), repoPath);
  assert.deepEqual(captured.startOptions?.outputOptions, { includeState: true });
  assert.equal(captured.startOptions?.tracingOptions.metadata.deliveryEngine, true);
  assert.deepEqual(captured.startOptions?.tracingOptions.requestContextKeys, ['repoPath']);
  assert.equal(response.workflowId, 'delivery-workflow');
  assert.equal(response.runId, 'workflow-run-1');
  assert.equal(response.resourceId, deliveryWorkflowResourceId(repoPath));
  assert.equal(response.reportPath, join(repoPath, '.delivery', 'runs', 'workflow-run-1.json'));
  assert.equal(existsSync(response.reportPath), true);
  const latest = readJson(join(repoPath, '.delivery', 'runs', 'latest.json'));
  assert.equal(latest.status, 'success');
  assert.equal(latest.deliveryStatus, 'complete');
  assert.equal(latest.summary, 'Local validation complete.');
  assert.equal(latest.deployMode, 'local');
  assert.deepEqual(latest.nextSteps, ['proceed']);
  assert.deepEqual(response.result, {
    status: 'success',
    state: {
      status: 'complete',
      summary: 'Local validation complete.',
      deployMode: 'local',
      nextSteps: ['proceed'],
    },
  });
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

test('delivery workflow runner accepts local and production deploy aliases', async () => {
  const starts: Record<string, any>[] = [];
  const host = {
    getWorkflow: () =>
      ({
        createRun: async () => ({
          runId: `alias-run-${starts.length + 1}`,
          start: async (options: Record<string, any>) => {
            starts.push(options.inputData);
            return { status: 'success' };
          },
        }),
      }) as any,
  };

  await startDeliveryWorkflowRunWithKey(host, {
    repoPath: '/tmp/delivery-target',
    deployMode: 'mock',
  });
  await startDeliveryWorkflowRunWithKey(host, {
    repoPath: '/tmp/delivery-target',
    deployMode: 'real',
  });

  assert.equal(starts[0].deployMode, 'local');
  assert.equal(starts[1].deployMode, 'production');
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
  assert.equal(response.reportPath, join(repoPath, '.delivery', 'runs', 'failed-run.json'));
  const report = readJson(response.reportPath);
  assert.equal(report.status, 'failed');
  assert.equal(report.deliveryStatus, 'failed');
  assert.equal(report.summary, 'boom');
  assert.equal(report.result.error.message, 'boom');
  assert.deepEqual(readJson(join(repoPath, '.delivery', 'runs', 'latest.json')), report);
  const deliveryRun = readDeliveryRun(repoPath);
  assert.equal(deliveryRun.status, 'failed');
  assert.equal(deliveryRun.stage, 'done');
  assert.equal(deliveryRun.summary, 'boom');
  assert.deepEqual(deliveryRun.failure, { name: 'Error', message: 'boom' });
  assert.equal(typeof deliveryRun.finished_at, 'string');
  const events = readDeliveryEvents(repoPath);
  assert.equal(events.some((event) => event.type === 'run_failure' && event.reason === 'boom'), true);
});

test('delivery workflow runner writes a report when workflow start throws', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-runner-thrown-'));
  writeFileSync(join(repoPath, 'vision.md'), '# Vision\n');
  writeFileSync(join(repoPath, 'spec.md'), '# Spec\n');
  initializeDeliveryRun({ repoPath, visionPath: 'vision.md', specPath: 'spec.md' });

  const host = {
    getWorkflow: () =>
      ({
        createRun: async () => ({
          runId: 'thrown-run',
          start: async () => {
            throw new Error('structured output missing');
          },
        }),
      }) as any,
  };

  await assert.rejects(startDeliveryWorkflowRunWithKey(host, { repoPath }), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).message, 'structured output missing');
    assert.equal(
      (error as Error & { deliveryReportPath?: string }).deliveryReportPath,
      join(repoPath, '.delivery', 'runs', 'thrown-run.json'),
    );
    return true;
  });

  const report = readJson(join(repoPath, '.delivery', 'runs', 'thrown-run.json'));
  assert.equal(report.status, 'threw');
  assert.equal(report.deliveryStatus, 'failed');
  assert.equal(report.summary, 'structured output missing');
  assert.equal(report.error.message, 'structured output missing');
  assert.deepEqual(readJson(join(repoPath, '.delivery', 'runs', 'latest.json')), report);
  const deliveryRun = readDeliveryRun(repoPath);
  assert.equal(deliveryRun.status, 'failed');
  assert.equal(deliveryRun.summary, 'structured output missing');
  assert.deepEqual(deliveryRun.failure, { name: 'Error', message: 'structured output missing' });
  const events = readDeliveryEvents(repoPath);
  assert.equal(
    events.some((event) => event.type === 'run_failure' && event.reason === 'structured output missing'),
    true,
  );
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

  await withOpenAiKey(undefined, async () => {
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
    deployMode: 'local',
  });

  assert.equal(startCalled, false);
  assert.equal(startAsyncOptions?.inputData.repoPath, resolve('/tmp/delivery-target'));
  assert.equal(startAsyncOptions?.inputData.reviewMode, 'thorough');
  assert.equal(startAsyncOptions?.requestContext.get('repoPath'), resolve('/tmp/delivery-target'));
  assert.equal(startAsyncOptions?.tracingOptions.metadata.reviewMode, 'thorough');
  assert.equal(startAsyncOptions?.tracingOptions.tags.includes('review:thorough'), true);
  assert.equal(response.status, 'started');
  assert.equal(response.runId, 'async-run');
});

test('delivery workflow runner can write inline vision content without requiring a spec', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-runner-inline-'));
  let startOptions: Record<string, any> | undefined;
  const host = {
    getWorkflow: () =>
      ({
        createRun: async () => ({
          runId: 'inline-run',
          start: async (options: Record<string, any>) => {
            startOptions = options;
            return { status: 'success' };
          },
        }),
      }) as any,
  };

  await startDeliveryWorkflowRunWithKey(host, {
    repoPath,
    visionContent: '# Vision\nBuild a vanilla Worker app.\n',
    deployMode: 'local',
  });

  assert.equal(readFileSync(join(repoPath, 'vision.md'), 'utf8'), '# Vision\nBuild a vanilla Worker app.\n');
  assert.equal(existsSync(join(repoPath, 'spec.md')), false);
  assert.equal(startOptions?.inputData.visionPath, 'vision.md');
  assert.equal(startOptions?.inputData.specPath, undefined);
});

test('delivery workflow request context carries the resolved repo path', () => {
  const context = createDeliveryWorkflowRequestContext('/tmp/delivery-target');
  assert.equal(context.get('repoPath'), resolve('/tmp/delivery-target'));
});

test('delivery API routes expose the workflow launch route', () => {
  assert.deepEqual(
    deliveryApiRoutes.map((route) => `${route.method} ${route.path}`),
    ['GET /delivery/launcher', 'POST /delivery/launcher', 'POST /delivery/run'],
  );
  assert.equal(deliveryApiRoutes.every((route) => route.openapi?.tags?.includes('Delivery Engine')), true);
});
