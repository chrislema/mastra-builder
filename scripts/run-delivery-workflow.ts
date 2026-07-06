import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mastra } from '../src/mastra/index';
import { markDeliveryWorkflowRunFailed, startDeliveryWorkflowRun } from '../src/mastra/delivery-engine/runner';
import {
  appendDeliveryEvent,
  readDeliveryRun,
  removeDeliveryBoundaryProjection,
  writeDeliveryRunProjection,
} from '../src/mastra/delivery-engine/state';

function usage() {
  return `Usage:
  npm run delivery:run -- --repo /absolute/path --vision vision.md --spec spec.md

Options:
  --repo, --repoPath       Target repository workspace. Required.
  --vision, --visionPath   Vision document path. Defaults to vision.md.
  --spec, --specPath       Spec document path. Defaults to spec.md.
  --deploy, --deployMode   local or production. Defaults to local. Aliases: mock, real.
  --review, --reviewMode   fast or thorough. Defaults to fast.
  --maxRetries             Bounded retry count. Defaults to 2.
  --resourceId             Optional Mastra workflow resource id.
  --runId                  Optional Mastra workflow run id.
  --no-includeState        Omit native workflow state from the result.
`;
}

type WorkflowResponse = Awaited<ReturnType<typeof startDeliveryWorkflowRun>>;

function readProjectedDeliveryStatus(repoPath: string) {
  try {
    const runPath = join(resolve(repoPath), '.delivery', 'run.json');
    return JSON.parse(readFileSync(runPath, 'utf8')) as { status?: string; summary?: string; stage?: string };
  } catch {
    return undefined;
  }
}

function markLatestReportInterrupted(repoPath: string, message: string) {
  try {
    const latestPath = join(resolve(repoPath), '.delivery', 'runs', 'latest.json');
    if (!existsSync(latestPath)) return;
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
    latest.generatedAt = new Date().toISOString();
    latest.status = 'interrupted';
    latest.error = { name: 'Error', message };
    writeFileSync(latestPath, JSON.stringify(latest, null, 2));
    if (typeof latest.runId === 'string') {
      writeFileSync(join(resolve(repoPath), '.delivery', 'runs', `${latest.runId}.json`), JSON.stringify(latest, null, 2));
    }
  } catch {
    // Best-effort only. The durable run state is marked separately.
  }
}

function markProjectedDeliveryInterrupted(repoPath: string, message: string) {
  try {
    const resolved = resolve(repoPath);
    const run = readDeliveryRun(resolved);
    if (run.status !== 'running') return;
    run.status = 'failed';
    run.stage = 'done';
    run.finished_at = new Date().toISOString();
    writeDeliveryRunProjection(resolved, run);
    appendDeliveryEvent(resolved, { type: 'run_finish', status: 'failed', reason: message });
    removeDeliveryBoundaryProjection(resolved);
  } catch {
    // Best-effort only. The normal failure path may not have initialized state yet.
  }
}

function compactResponse(response: WorkflowResponse, repoPath: string) {
  const result = response.result as { status?: unknown; state?: { status?: unknown; summary?: unknown; nextSteps?: unknown } };
  const projection = readProjectedDeliveryStatus(repoPath);
  return {
    workflowId: response.workflowId,
    runId: response.runId,
    resourceId: response.resourceId,
    reportPath: response.reportPath,
    workflowStatus: result.status,
    deliveryStatus: result.state?.status ?? projection?.status,
    stage: projection?.stage,
    summary: result.state?.summary ?? projection?.summary,
    nextSteps: result.state?.nextSteps,
  };
}

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    repoPath: { type: 'string' },
    vision: { type: 'string' },
    visionPath: { type: 'string' },
    spec: { type: 'string' },
    specPath: { type: 'string' },
    deploy: { type: 'string' },
    deployMode: { type: 'string' },
    review: { type: 'string' },
    reviewMode: { type: 'string' },
    maxRetries: { type: 'string' },
    resourceId: { type: 'string' },
    runId: { type: 'string' },
    includeState: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

try {
  if (values.help) {
    console.log(usage());
    process.exit(0);
  }

  const repoPath = values.repoPath ?? values.repo;
  if (!repoPath) {
    console.error(usage());
    process.exit(1);
  }
  const resolvedRepoPath = resolve(repoPath);
  let shuttingDown = false;
  const handleStop = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const message = `Delivery run interrupted by ${signal}.`;
    console.error(message);
    markProjectedDeliveryInterrupted(resolvedRepoPath, message);
    markLatestReportInterrupted(resolvedRepoPath, message);
    void markDeliveryWorkflowRunFailed(mastra, resolvedRepoPath)
      .catch(() => undefined)
      .finally(async () => {
        await mastra.shutdown().catch(() => undefined);
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };
  process.once('SIGINT', handleStop);
  process.once('SIGTERM', handleStop);

  const response = await startDeliveryWorkflowRun(mastra, {
    repoPath: resolvedRepoPath,
    visionPath: values.visionPath ?? values.vision,
    specPath: values.specPath ?? values.spec,
    deployMode: values.deployMode ?? values.deploy,
    reviewMode: values.reviewMode ?? values.review,
    maxRetries: values.maxRetries === undefined ? undefined : Number(values.maxRetries),
    resourceId: values.resourceId,
    runId: values.runId,
    includeState: values.includeState,
  });

  console.log(JSON.stringify(compactResponse(response, resolvedRepoPath), null, 2));
  const result = response.result as { status?: unknown; state?: { status?: unknown } };
  const deliveryStatus = result.state?.status ?? readProjectedDeliveryStatus(resolvedRepoPath)?.status;
  const didNotComplete =
    result.status === 'failed' ||
    deliveryStatus === 'failed' ||
    deliveryStatus === 'stuck' ||
    deliveryStatus === 'gate_failed' ||
    deliveryStatus === 'blocked_on_questions';

  if (didNotComplete) {
    if (response.reportPath) console.error(`Delivery run report: ${response.reportPath}`);
    process.exitCode = 1;
  }
} catch (error) {
  const reportPath = error instanceof Error ? (error as Error & { deliveryReportPath?: string }).deliveryReportPath : undefined;
  if (reportPath) console.error(`Delivery run report: ${reportPath}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await mastra.shutdown();
}
