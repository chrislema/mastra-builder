import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { createDeliveryRequestContext } from './context';
import { deliveryMemoryResourceId } from './memory';
import { finishDeliveryRunState } from './state-service';
import type { MastraLike } from './observability';
import { assertDeliveryModelEnvironment } from './models';
import { deliveryWorkflow } from './workflows';
import {
  deliveryWorkflowInputBaseSchema,
  normalizeDeliveryWorkflowInput,
  optionalNonEmptyStringSchema,
  type NormalizedDeliveryWorkflowInput,
} from './run-input';

export { createDeliveryRequestContext as createDeliveryWorkflowRequestContext } from './context';

export const deliveryWorkflowRunInputSchema = deliveryWorkflowInputBaseSchema
  .extend({
    visionContent: optionalNonEmptyStringSchema.describe('Optional vision markdown to write before starting the workflow.'),
    specContent: optionalNonEmptyStringSchema.describe('Optional spec markdown to write before starting the workflow.'),
    noSpec: z.boolean().default(false).describe('Run from vision only, even when spec.md exists.'),
    resourceId: z.string().min(1).optional().describe('Optional resource id for filtering persisted workflow runs.'),
    runId: z.string().min(1).optional().describe('Optional workflow run id for repeatable external orchestration.'),
    includeState: z.boolean().default(true).describe('Include native workflow state in the returned workflow result.'),
  })
  .superRefine((input, ctx) => {
    if (!input.projectFolder && !input.repoPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectFolder'],
        message: 'Project folder is required. Use projectFolder, or repoPath for compatibility.',
      });
    }
    if (input.projectFolder && input.repoPath && resolve(input.projectFolder) !== resolve(input.repoPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repoPath'],
        message: 'projectFolder and repoPath must refer to the same folder when both are provided.',
      });
    }
  });

export const deliveryWorkflowRunResponseSchema = z.object({
  workflowId: z.literal('delivery-workflow'),
  runId: z.string(),
  resourceId: z.string(),
  reportPath: z.string().optional(),
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

type PreparedDeliveryWorkflowRunOptions = NormalizedDeliveryWorkflowInput &
  Pick<DeliveryWorkflowRunOptions, 'resourceId' | 'runId' | 'includeState'>;

export function deliveryWorkflowResourceId(repoPath: string) {
  return deliveryMemoryResourceId(repoPath);
}

function hasDocumentContent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function ensureTrailingNewline(content: string) {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function repoRelativeWritableFile({ repoPath, path, label }: { repoPath: string; path: string; label: string }) {
  const repo = resolve(repoPath);
  const fullPath = isAbsolute(path) ? resolve(path) : resolve(repo, path);
  const rel = relative(repo, fullPath).replaceAll('\\', '/');

  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`${label} file must be inside repoPath: ${path}`);
  }

  return { fullPath, path: rel };
}

function writeSourceDocument({
  repoPath,
  path,
  content,
  label,
}: {
  repoPath: string;
  path: string;
  content: string;
  label: string;
}) {
  const target = repoRelativeWritableFile({ repoPath, path, label });
  mkdirSync(dirname(target.fullPath), { recursive: true });
  writeFileSync(target.fullPath, ensureTrailingNewline(content));
  return target.path;
}

function prepareDeliveryWorkflowRunOptions(parsed: DeliveryWorkflowRunOptions): PreparedDeliveryWorkflowRunOptions {
  const normalized = normalizeDeliveryWorkflowInput(parsed, { inferSpecPath: !parsed.noSpec });
  const repoPath = normalized.repoPath;
  const visionPath = normalized.visionPath;
  const specPath = normalized.specPath ?? (hasDocumentContent(parsed.specContent) ? 'spec.md' : undefined);

  if (hasDocumentContent(parsed.visionContent) || hasDocumentContent(parsed.specContent)) {
    mkdirSync(repoPath, { recursive: true });
  }

  const preparedVisionPath = hasDocumentContent(parsed.visionContent)
    ? writeSourceDocument({
        repoPath,
        path: visionPath,
        content: parsed.visionContent,
        label: 'vision',
      })
    : visionPath;

  const preparedSpecPath =
    specPath && hasDocumentContent(parsed.specContent)
      ? writeSourceDocument({
          repoPath,
          path: specPath,
          content: parsed.specContent,
          label: 'spec',
        })
      : specPath;

  return {
    repoPath,
    visionPath: preparedVisionPath,
    specPath: preparedSpecPath,
    maxRetries: normalized.maxRetries,
    deployMode: normalized.deployMode,
    reviewMode: normalized.reviewMode,
    resourceId: parsed.resourceId,
    runId: parsed.runId,
    includeState: parsed.includeState,
  };
}

function serializeError(error: unknown) {
  if (error instanceof z.ZodError) {
    return {
      name: error.name,
      message: error.message,
      issues: error.issues,
      stack: error.stack,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

function compactRunFailure(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  if (error && typeof error === 'object') {
    const maybe = error as { name?: unknown; message?: unknown };
    return {
      name: typeof maybe.name === 'string' ? maybe.name : 'Error',
      message: typeof maybe.message === 'string' ? maybe.message : String(error),
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

function workflowFailureFromResult(result: unknown) {
  const resultRecord = result as { error?: unknown; steps?: Record<string, { error?: unknown }> } | undefined;
  if (!resultRecord || typeof resultRecord !== 'object') return undefined;

  const direct = resultRecord.error;
  if (direct) return compactRunFailure(direct);

  for (const step of Object.values(resultRecord.steps ?? {})) {
    if (step?.error) return compactRunFailure(step.error);
  }

  return undefined;
}

function readLocalDeliveryRunForReport(repoPath: string) {
  const path = join(resolve(repoPath), '.delivery', 'run.json');
  if (!existsSync(path)) return undefined;

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function writeDeliveryWorkflowRunReport({
  repoPath,
  runId,
  resourceId,
  result,
  error,
}: {
  repoPath: string;
  runId: string;
  resourceId: string;
  result?: unknown;
  error?: unknown;
}) {
  const resultRecord = result as { status?: unknown; state?: Record<string, unknown> } | undefined;
  const localDeliveryState = readLocalDeliveryRunForReport(repoPath);
  const preferLocalState = error !== undefined || resultRecord?.status === 'failed';
  const deliveryState = preferLocalState
    ? (localDeliveryState ?? resultRecord?.state)
    : (resultRecord?.state ?? localDeliveryState);
  const runsDir = join(resolve(repoPath), '.delivery', 'runs');
  const reportPath = join(runsDir, `${runId}.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    workflowId: 'delivery-workflow',
    runId,
    resourceId,
    repoPath: resolve(repoPath),
    status: error ? 'threw' : resultRecord?.status ?? 'unknown',
    ...(deliveryState?.status === undefined ? {} : { deliveryStatus: deliveryState.status }),
    ...(deliveryState?.summary === undefined ? {} : { summary: deliveryState.summary }),
    ...(deliveryState?.deployMode === undefined ? {} : { deployMode: deliveryState.deployMode }),
    ...(deliveryState?.nextSteps === undefined ? {} : { nextSteps: deliveryState.nextSteps }),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error: serializeError(error) }),
  };

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(runsDir, 'latest.json'), JSON.stringify(report, null, 2));

  return reportPath;
}

function tryWriteDeliveryWorkflowRunReport(args: Parameters<typeof writeDeliveryWorkflowRunReport>[0], host?: MastraLike) {
  try {
    return writeDeliveryWorkflowRunReport(args);
  } catch (error) {
    host?.getLogger?.().warn('Failed to write delivery workflow run report', {
      repoPath: args.repoPath,
      runId: args.runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function prepareDeliveryWorkflowRun(host: DeliveryWorkflowHost, input: DeliveryWorkflowRunInput) {
  const parsed = deliveryWorkflowRunInputSchema.parse(input);
  const prepared = prepareDeliveryWorkflowRunOptions(parsed);
  const repoPath = prepared.repoPath;
  const resourceId = parsed.resourceId ?? deliveryWorkflowResourceId(repoPath);
  const workflow = host.getWorkflow('deliveryWorkflow');
  const run = await workflow.createRun({
    ...(prepared.runId ? { runId: prepared.runId } : {}),
    resourceId,
  });
  const startOptions = {
    inputData: {
      projectFolder: repoPath,
      repoPath,
      visionPath: prepared.visionPath,
      specPath: prepared.specPath,
      maxRetries: prepared.maxRetries,
      deployMode: prepared.deployMode,
      reviewMode: prepared.reviewMode,
    },
    requestContext: createDeliveryRequestContext(repoPath),
    tracingOptions: {
      metadata: {
        deliveryEngine: true,
        repoPath,
        visionPath: prepared.visionPath,
        specPath: prepared.specPath,
        deployMode: prepared.deployMode,
        reviewMode: prepared.reviewMode,
        resourceId,
      },
      requestContextKeys: ['repoPath'],
      tags: ['delivery-engine', `deploy:${prepared.deployMode}`, `review:${prepared.reviewMode}`],
    },
    outputOptions: {
      includeState: prepared.includeState,
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
  tryWriteDeliveryWorkflowRunReport({
    repoPath,
    runId: run.runId,
    resourceId,
    result: {
      status: 'running',
      state: {
        status: 'running',
        repoPath,
      },
    },
  }, host);

  try {
    const result = await run.start(startOptions);
    if ((result as { status?: unknown }).status === 'failed') {
      await closeFailedDeliveryRun({ host, repoPath, failure: workflowFailureFromResult(result) });
    }
    const reportPath = tryWriteDeliveryWorkflowRunReport({ repoPath, runId: run.runId, resourceId, result }, host);

    return {
      workflowId: 'delivery-workflow' as const,
      runId: run.runId,
      resourceId,
      reportPath,
      result,
    };
  } catch (error) {
    await closeFailedDeliveryRun({ host, repoPath, failure: compactRunFailure(error) });
    const reportPath = tryWriteDeliveryWorkflowRunReport({ repoPath, runId: run.runId, resourceId, error }, host);
    if (error instanceof Error && reportPath) {
      (error as Error & { deliveryReportPath?: string }).deliveryReportPath = reportPath;
    }
    throw error;
  }
}

async function closeFailedDeliveryRun({
  host,
  repoPath,
  failure,
}: {
  host: MastraLike;
  repoPath: string;
  failure?: { name: string; message: string };
}) {
  try {
    await finishDeliveryRunState({
      repoPath,
      status: 'failed',
      summary: failure?.message,
      failure,
      mastra: host,
    });
  } catch (error) {
    host.getLogger?.().warn('Failed to mark delivery run failed after workflow failure', {
      repoPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function markDeliveryWorkflowRunFailed(host: MastraLike, repoPath: string) {
  await closeFailedDeliveryRun({ host, repoPath: resolve(repoPath) });
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
