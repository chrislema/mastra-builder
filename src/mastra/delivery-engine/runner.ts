import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createDeliveryRequestContext } from './context';
import { finishDeliveryRunState } from './state-service';
import type { MastraLike } from './observability';
import { assertDeliveryModelEnvironment } from './models';
import { deliveryWorkflow } from './workflow';

export { createDeliveryRequestContext as createDeliveryWorkflowRequestContext } from './context';

export const deliveryWorkflowRunInputSchema = z.object({
  repoPath: z.string().min(1).describe('Absolute path to the target repository workspace.'),
  visionPath: z.string().min(1).default('vision.md').describe('Path to vision.md inside repoPath.'),
  specPath: z.string().min(1).default('spec.md').describe('Path to spec.md inside repoPath.'),
  maxRetries: z.coerce.number().int().min(0).default(2),
  deployMode: z.enum(['mock', 'real']).default('mock'),
  resourceId: z.string().min(1).optional().describe('Optional resource id for filtering persisted workflow runs.'),
  runId: z.string().min(1).optional().describe('Optional workflow run id for repeatable external orchestration.'),
  includeState: z.boolean().default(true).describe('Include native workflow state in the returned workflow result.'),
});

export const deliveryWorkflowRunResponseSchema = z.object({
  workflowId: z.literal('delivery-workflow'),
  runId: z.string(),
  resourceId: z.string(),
  result: z.any(),
});

export const deliveryWorkflowRunAsyncResponseSchema = z.object({
  workflowId: z.literal('delivery-workflow'),
  runId: z.string(),
  resourceId: z.string(),
  status: z.literal('started'),
});

export type DeliveryWorkflowRunInput = z.input<typeof deliveryWorkflowRunInputSchema>;
export type DeliveryWorkflowRunOptions = z.output<typeof deliveryWorkflowRunInputSchema>;

type DeliveryWorkflowHost = {
  getWorkflow: (id: 'deliveryWorkflow') => typeof deliveryWorkflow;
} & MastraLike;

export function deliveryWorkflowResourceId(repoPath: string) {
  const repo = resolve(repoPath);
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 16);
  return `delivery:${hash}`;
}

async function prepareDeliveryWorkflowRun(host: DeliveryWorkflowHost, input: DeliveryWorkflowRunInput) {
  const parsed = deliveryWorkflowRunInputSchema.parse(input);
  const repoPath = resolve(parsed.repoPath);
  const resourceId = parsed.resourceId ?? deliveryWorkflowResourceId(repoPath);
  const workflow = host.getWorkflow('deliveryWorkflow');
  const run = await workflow.createRun({
    ...(parsed.runId ? { runId: parsed.runId } : {}),
    resourceId,
  });
  const startOptions = {
    inputData: {
      repoPath,
      visionPath: parsed.visionPath,
      specPath: parsed.specPath,
      maxRetries: parsed.maxRetries,
      deployMode: parsed.deployMode,
    },
    requestContext: createDeliveryRequestContext(repoPath),
    tracingOptions: {
      metadata: {
        deliveryEngine: true,
        repoPath,
        visionPath: parsed.visionPath,
        specPath: parsed.specPath,
        deployMode: parsed.deployMode,
        resourceId,
      },
      requestContextKeys: ['repoPath'],
      tags: ['delivery-engine', `deploy:${parsed.deployMode}`],
    },
    outputOptions: {
      includeState: parsed.includeState,
    },
  };

  return {
    run,
    repoPath,
    resourceId,
    startOptions,
  };
}

export async function startDeliveryWorkflowRun(host: DeliveryWorkflowHost, input: DeliveryWorkflowRunInput) {
  assertDeliveryModelEnvironment();
  const { run, repoPath, resourceId, startOptions } = await prepareDeliveryWorkflowRun(host, input);

  const result = await run.start(startOptions);
  if ((result as { status?: unknown }).status === 'failed') {
    await closeFailedDeliveryRun({ host, repoPath });
  }

  return {
    workflowId: 'delivery-workflow' as const,
    runId: run.runId,
    resourceId,
    result,
  };
}

async function closeFailedDeliveryRun({ host, repoPath }: { host: DeliveryWorkflowHost; repoPath: string }) {
  try {
    await finishDeliveryRunState({ repoPath, status: 'failed', mastra: host });
  } catch (error) {
    host.getLogger?.().warn('Failed to mark delivery run failed after workflow failure', {
      repoPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startDeliveryWorkflowRunAsync(host: DeliveryWorkflowHost, input: DeliveryWorkflowRunInput) {
  assertDeliveryModelEnvironment();
  const { run, resourceId, startOptions } = await prepareDeliveryWorkflowRun(host, input);
  const started = await run.startAsync(startOptions);

  return {
    workflowId: 'delivery-workflow' as const,
    runId: started.runId,
    resourceId,
    status: 'started' as const,
  };
}
