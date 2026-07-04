import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getDeliveryRunStatus, readDeliveryEvents, readDeliveryRun, type DeliveryRun } from './state';

type DeliveryObservabilityLog = Record<string, unknown>;

export type DeliveryObservabilityStore = {
  batchCreateLogs(args: { logs: DeliveryObservabilityLog[] }): Promise<void>;
  listLogs(args: {
    filters?: Record<string, unknown>;
    pagination?: { page: number; perPage: number };
    orderBy?: { field: 'timestamp'; direction: 'ASC' | 'DESC' };
  }): Promise<{ logs: DeliveryObservabilityLog[]; pagination?: Record<string, unknown> }>;
};

type MastraLike = {
  getStorage?: () =>
    | {
        getStore(storeName: 'observability'): Promise<DeliveryObservabilityStore | undefined>;
      }
    | undefined;
  getLogger?: () => { warn(message: string, ...args: unknown[]): void };
};

export type DeliveryStateMirrorSummary = {
  ok: boolean;
  runId: string;
  status: DeliveryRun['status'];
  stage: string;
  eventCount: number;
  logsSubmitted: number;
};

const deliverySource = 'delivery-engine';
const deliveryExecutionSource = 'mastra-delivery';
const deliveryServiceName = 'builders';
const deliveryWorkflowEntity = 'delivery-workflow';

const stableHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

const toDate = (value: unknown, fallback: string) => {
  const date = new Date(typeof value === 'string' ? value : fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
};

const baseDeliveryLog = ({
  run,
  repoPath,
  timestamp,
  logId,
  message,
  tags,
  data,
}: {
  run: DeliveryRun;
  repoPath: string;
  timestamp: Date;
  logId: string;
  message: string;
  tags: string[];
  data: Record<string, unknown>;
}): DeliveryObservabilityLog => ({
  logId,
  timestamp,
  level: 'info',
  message,
  data,
  source: deliverySource,
  executionSource: deliveryExecutionSource,
  serviceName: deliveryServiceName,
  entityType: 'workflow_run',
  entityId: run.run_id,
  entityName: deliveryWorkflowEntity,
  rootEntityType: 'workflow_run',
  rootEntityId: run.run_id,
  rootEntityName: deliveryWorkflowEntity,
  resourceId: resolve(repoPath),
  runId: run.run_id,
  tags,
  metadata: {
    repoPath: resolve(repoPath),
    stateSource: '.delivery',
    mirrorVersion: 1,
  },
});

export function buildDeliveryStateMirrorLogs(repoPath: string) {
  const run = readDeliveryRun(repoPath);
  const events = readDeliveryEvents(repoPath);
  const status = getDeliveryRunStatus(repoPath);
  const snapshotFingerprint = stableHash({
    status: run.status,
    stage: run.stage,
    tasks: run.tasks,
    artifacts: run.artifacts,
    judgments: run.judgments,
    stuck: run.stuck,
    eventCount: events.length,
  });

  const snapshot = baseDeliveryLog({
    run,
    repoPath,
    timestamp: toDate(run.finished_at ?? run.started_at, new Date().toISOString()),
    logId: `delivery:${run.run_id}:snapshot:${snapshotFingerprint}`,
    message: `Delivery run ${run.status} at ${run.stage}`,
    tags: ['delivery-state', 'delivery-snapshot', `status:${run.status}`, `stage:${run.stage}`],
    data: {
      kind: 'snapshot',
      run,
      status,
      eventCount: events.length,
    },
  });

  const eventLogs = events.map((event, index) =>
    baseDeliveryLog({
      run,
      repoPath,
      timestamp: toDate((event as { ts?: unknown }).ts, run.started_at),
      logId: `delivery:${run.run_id}:event:${index}:${stableHash(event)}`,
      message: `Delivery event: ${String((event as { type?: unknown }).type ?? 'unknown')}`,
      tags: ['delivery-state', 'delivery-event', `status:${run.status}`, `stage:${run.stage}`],
      data: {
        kind: 'event',
        index,
        event,
      },
    }),
  );

  return {
    run,
    events,
    logs: [snapshot, ...eventLogs],
  };
}

export async function mirrorDeliveryStateToObservability({
  repoPath,
  store,
}: {
  repoPath: string;
  store: DeliveryObservabilityStore;
}): Promise<DeliveryStateMirrorSummary> {
  const { run, events, logs } = buildDeliveryStateMirrorLogs(repoPath);
  await store.batchCreateLogs({ logs });

  return {
    ok: true,
    runId: run.run_id,
    status: run.status,
    stage: run.stage,
    eventCount: events.length,
    logsSubmitted: logs.length,
  };
}

export async function getDeliveryObservabilityStore(mastra?: MastraLike) {
  const storage = mastra?.getStorage?.();
  return storage?.getStore('observability');
}

export async function mirrorDeliveryStateWithMastra({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}) {
  const store = await getDeliveryObservabilityStore(mastra);
  if (!store) throw new Error('Mastra observability storage is not configured');
  return mirrorDeliveryStateToObservability({ repoPath, store });
}

export async function safeMirrorDeliveryStateWithMastra({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}) {
  try {
    return await mirrorDeliveryStateWithMastra({ repoPath, mastra });
  } catch (error) {
    mastra?.getLogger?.().warn('Failed to mirror delivery state to Mastra observability', {
      repoPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      runId: '',
      status: 'failed' as const,
      stage: '',
      eventCount: 0,
      logsSubmitted: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listDeliveryStateMirrorLogs({
  store,
  repoPath,
  runId,
  page = 0,
  perPage = 25,
}: {
  store: DeliveryObservabilityStore;
  repoPath?: string;
  runId?: string;
  page?: number;
  perPage?: number;
}) {
  return store.listLogs({
    filters: {
      source: deliverySource,
      ...(repoPath ? { resourceId: resolve(repoPath) } : {}),
      ...(runId ? { runId } : {}),
    },
    pagination: { page, perPage },
    orderBy: { field: 'timestamp', direction: 'DESC' },
  });
}
