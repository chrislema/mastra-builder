import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { SaveScorePayload, ScoreRowData } from '@mastra/core/evals';
import { getDeliveryRunStatus, readDeliveryEvents, readDeliveryRun, type DeliveryRun } from './state';
import type { DeliveryEvent } from './checks';

type DeliveryObservabilityLog = Record<string, unknown>;
type DeliveryObservabilityScore = Record<string, unknown>;

export type DeliveryObservabilityStore = {
  batchCreateLogs(args: { logs: DeliveryObservabilityLog[] }): Promise<void>;
  batchCreateScores?(args: { scores: DeliveryObservabilityScore[] }): Promise<void>;
  listLogs(args: {
    filters?: Record<string, unknown>;
    pagination?: { page: number; perPage: number };
    orderBy?: { field: 'timestamp'; direction: 'ASC' | 'DESC' };
  }): Promise<{ logs: DeliveryObservabilityLog[]; pagination?: Record<string, unknown> }>;
};

export type DeliveryScoresStore = {
  saveScore(score: SaveScorePayload): Promise<{ score: ScoreRowData }>;
  listScoresByRunId?(args: {
    runId: string;
    pagination: { page: number; perPage: number };
  }): Promise<{ scores: ScoreRowData[]; pagination?: Record<string, unknown> }>;
};

export type MastraLike = {
  getStorage?: () =>
    | {
        getStore(storeName: string): Promise<unknown>;
      }
    | undefined;
  getLogger?: () => { warn(message: string, ...args: unknown[]): void };
};

export type DeliveryStatePersistenceSummary = {
  ok: boolean;
  runId: string;
  status: DeliveryRun['status'];
  stage: string;
  eventCount: number;
  logsSubmitted: number;
};

export type DeliveryStateMirrorSummary = DeliveryStatePersistenceSummary;

export type DeliveryJudgmentScorePersistenceSummary = {
  ok: boolean;
  runId: string;
  judgmentCount: number;
  scoresSubmitted: number;
  scoresSkipped: number;
  observabilityScoresSubmitted: number;
};

export type DeliveryJudgmentScoreMirrorSummary = DeliveryJudgmentScorePersistenceSummary;

export type DeliveryRunStatusSummary = ReturnType<typeof getDeliveryRunStatus>;

export type DeliveryStateSnapshot = {
  run: DeliveryRun;
  events: DeliveryEvent[];
};

const deliverySource = 'delivery-engine';
const deliveryExecutionSource = 'mastra-delivery';
const deliveryServiceName = 'builders';
const deliveryWorkflowEntity = 'delivery-workflow';
const deliveryScoreSource = 'delivery-rubric-judge';

const stableHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

const toDate = (value: unknown, fallback: string) => {
  const date = new Date(typeof value === 'string' ? value : fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
};

function statusFromRun(run: DeliveryRun): DeliveryRunStatusSummary {
  return {
    run_id: run.run_id,
    status: run.status,
    stage: run.stage,
    tasks: Object.entries(run.tasks).map(
      ([id, task]) => `${id}:${task.status}${task.retries ? `(r${task.retries})` : ''}`,
    ),
    stuck: run.stuck,
    judgments: run.judgments.length,
    artifacts: Object.keys(run.artifacts),
  };
}

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
    stateSource: 'mastra-storage',
    projectionSource: '.delivery',
    projectionVersion: 1,
  },
});

export function buildDeliveryStateLogsFromSnapshot({ repoPath, run, events }: DeliveryStateSnapshot & { repoPath: string }) {
  const status = statusFromRun(run);
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
      events,
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

export function buildDeliveryStatePersistenceLogs(repoPath: string) {
  return buildDeliveryStateLogsFromSnapshot({
    repoPath,
    run: readDeliveryRun(repoPath),
    events: readDeliveryEvents(repoPath),
  });
}

export const buildDeliveryStateMirrorLogs = buildDeliveryStatePersistenceLogs;

const deliveryRubricScorerId = (rubric: string) => `delivery-rubric:${rubric}`;
const deliveryJudgmentScoreKey = (scorerId: string, path: unknown) => `${scorerId}:${String(path ?? '')}`;

export function buildDeliveryJudgmentScorePayloads(repoPath: string): SaveScorePayload[] {
  const run = readDeliveryRun(repoPath);
  const resourceId = resolve(repoPath);

  return run.judgments.map((judgment) => {
    const scorerId = deliveryRubricScorerId(judgment.rubric);
    const score = judgment.overall ?? 0;
    const reason = `${judgment.rubric} judgment ${judgment.passed ? 'passed' : 'failed'} with score ${score}.`;

    return {
      runId: run.run_id,
      entityId: run.run_id,
      entityType: 'WORKFLOW',
      entity: {
        id: deliveryWorkflowEntity,
        type: 'workflow',
        runId: run.run_id,
      },
      scorerId,
      scorer: {
        id: scorerId,
        name: `Delivery Rubric: ${judgment.rubric}`,
        description: 'Persisted Delivery Engine rubric judgment.',
      },
      source: 'LIVE',
      score,
      reason,
      input: {
        subject: judgment.subject,
        rubric: judgment.rubric,
      },
      output: judgment,
      additionalContext: {
        repoPath: resourceId,
        deliveryRunStatus: run.status,
        deliveryStage: run.stage,
      },
      metadata: {
        repoPath: resourceId,
        stateSource: 'mastra-storage',
        projectionSource: '.delivery',
        projectionVersion: 1,
        deliveryJudgmentPath: judgment.path,
        deliveryJudgmentSubject: judgment.subject,
        deliveryRubric: judgment.rubric,
        deliveryPassed: judgment.passed,
      },
      resourceId,
      structuredOutput: true,
    };
  });
}

export function buildDeliveryJudgmentScoreEvents(repoPath: string): DeliveryObservabilityScore[] {
  const run = readDeliveryRun(repoPath);
  const resourceId = resolve(repoPath);

  return run.judgments.map((judgment) => {
    const scorerId = deliveryRubricScorerId(judgment.rubric);
    const scoreId = `delivery:${run.run_id}:score:${stableHash({
      scorerId,
      subject: judgment.subject,
      path: judgment.path,
    })}`;
    const score = judgment.overall ?? 0;

    return {
      scoreId,
      timestamp: toDate(run.finished_at ?? run.started_at, new Date().toISOString()),
      entityType: 'workflow_run',
      entityId: run.run_id,
      entityName: deliveryWorkflowEntity,
      rootEntityType: 'workflow_run',
      rootEntityId: run.run_id,
      rootEntityName: deliveryWorkflowEntity,
      resourceId,
      runId: run.run_id,
      executionSource: deliveryExecutionSource,
      serviceName: deliveryServiceName,
      scorerId,
      scorerName: `Delivery Rubric: ${judgment.rubric}`,
      source: deliverySource,
      scoreSource: deliveryScoreSource,
      score,
      reason: `${judgment.rubric} judgment ${judgment.passed ? 'passed' : 'failed'} with score ${score}.`,
      tags: ['delivery-judgment', `rubric:${judgment.rubric}`, judgment.passed ? 'passed' : 'failed'],
      metadata: {
        repoPath: resourceId,
        stateSource: 'mastra-storage',
        projectionSource: '.delivery',
        projectionVersion: 1,
        deliveryJudgmentPath: judgment.path,
        deliveryJudgmentSubject: judgment.subject,
        deliveryRubric: judgment.rubric,
        deliveryPassed: judgment.passed,
      },
      scope: {
        subject: judgment.subject,
        path: judgment.path,
      },
    };
  });
}

export async function persistDeliveryStateToObservability({
  repoPath,
  store,
}: {
  repoPath: string;
  store: DeliveryObservabilityStore;
}): Promise<DeliveryStatePersistenceSummary> {
  const { run, events, logs } = buildDeliveryStatePersistenceLogs(repoPath);
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

export const mirrorDeliveryStateToObservability = persistDeliveryStateToObservability;
export const persistDeliveryStateToMastraStorage = persistDeliveryStateToObservability;

export async function persistDeliverySnapshotToMastraStorage({
  repoPath,
  run,
  events,
  store,
}: DeliveryStateSnapshot & {
  repoPath: string;
  store: DeliveryObservabilityStore;
}): Promise<DeliveryStatePersistenceSummary> {
  const { logs } = buildDeliveryStateLogsFromSnapshot({ repoPath, run, events });
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

function statusFromSnapshotLog(log: DeliveryObservabilityLog): DeliveryRunStatusSummary | undefined {
  const data = log.data as Record<string, unknown> | undefined;
  if (data?.kind !== 'snapshot') return undefined;

  const status = data.status as DeliveryRunStatusSummary | undefined;
  if (status?.run_id && status.status && status.stage) return status;

  const run = data.run as DeliveryRun | undefined;
  if (!run?.run_id) return undefined;

  return statusFromRun(run);
}

function isDeliveryStateLog(log: DeliveryObservabilityLog, runId?: string) {
  const metadata = log.metadata as Record<string, unknown> | undefined;
  const data = log.data as Record<string, unknown> | undefined;

  if (runId && log.runId !== runId) return false;
  if (log.source && log.source !== deliverySource) return false;
  if (metadata?.stateSource !== 'mastra-storage') return false;
  if (metadata?.projectionSource !== '.delivery') return false;
  return data?.kind === 'snapshot' || data?.kind === 'event';
}

export async function readDeliverySnapshotFromMastraStorage({
  store,
  repoPath,
  runId,
}: {
  store: DeliveryObservabilityStore;
  repoPath?: string;
  runId?: string;
}): Promise<DeliveryStateSnapshot | undefined> {
  const listed = await listDeliveryStateRecords({
    store,
    repoPath,
    runId,
    page: 0,
    perPage: 1000,
  });
  const snapshotLog = listed.logs.find((log) => (log.data as Record<string, unknown> | undefined)?.kind === 'snapshot');
  const data = snapshotLog?.data as Record<string, unknown> | undefined;
  const run = data?.run as DeliveryRun | undefined;
  if (!run?.run_id) return undefined;

  const embeddedEvents = data.events as DeliveryEvent[] | undefined;
  if (Array.isArray(embeddedEvents)) return { run, events: embeddedEvents };

  const events = listed.logs
    .flatMap((log) => {
      const eventData = log.data as Record<string, unknown> | undefined;
      if (eventData?.kind !== 'event') return [];
      return [
        {
          index: typeof eventData.index === 'number' ? eventData.index : Number.MAX_SAFE_INTEGER,
          event: eventData.event as DeliveryEvent,
        },
      ];
    })
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.event);

  return { run, events };
}

export async function readDeliveryRunStatusFromMastraStorage({
  store,
  repoPath,
  runId,
}: {
  store: DeliveryObservabilityStore;
  repoPath?: string;
  runId?: string;
}): Promise<DeliveryRunStatusSummary | undefined> {
  const listed = await listDeliveryStateRecords({
    store,
    repoPath,
    runId,
    page: 0,
    perPage: 100,
  });

  for (const log of listed.logs) {
    const status = statusFromSnapshotLog(log);
    if (status) return status;
  }

  return undefined;
}

async function existingDeliveryJudgmentScoreKeys(store: DeliveryScoresStore, runId: string) {
  if (!store.listScoresByRunId) return new Set<string>();
  const listed = await store.listScoresByRunId({
    runId,
    pagination: { page: 0, perPage: 1000 },
  });

  return new Set(
    listed.scores.map((score) =>
      deliveryJudgmentScoreKey(score.scorerId, (score.metadata as Record<string, unknown> | undefined)?.deliveryJudgmentPath),
    ),
  );
}

export async function persistDeliveryJudgmentScoresToStores({
  repoPath,
  scoresStore,
  observabilityStore,
}: {
  repoPath: string;
  scoresStore: DeliveryScoresStore;
  observabilityStore?: DeliveryObservabilityStore;
}): Promise<DeliveryJudgmentScorePersistenceSummary> {
  const run = readDeliveryRun(repoPath);
  const payloads = buildDeliveryJudgmentScorePayloads(repoPath);
  const existingKeys = await existingDeliveryJudgmentScoreKeys(scoresStore, run.run_id);
  let scoresSubmitted = 0;
  let scoresSkipped = 0;

  for (const payload of payloads) {
    const key = deliveryJudgmentScoreKey(
      payload.scorerId,
      (payload.metadata as Record<string, unknown> | undefined)?.deliveryJudgmentPath,
    );
    if (existingKeys.has(key)) {
      scoresSkipped += 1;
      continue;
    }

    await scoresStore.saveScore(payload);
    existingKeys.add(key);
    scoresSubmitted += 1;
  }

  const scoreEvents = buildDeliveryJudgmentScoreEvents(repoPath);
  if (observabilityStore?.batchCreateScores && scoreEvents.length) {
    await observabilityStore.batchCreateScores({ scores: scoreEvents });
  }

  return {
    ok: true,
    runId: run.run_id,
    judgmentCount: payloads.length,
    scoresSubmitted,
    scoresSkipped,
    observabilityScoresSubmitted: observabilityStore?.batchCreateScores ? scoreEvents.length : 0,
  };
}

export const mirrorDeliveryJudgmentScoresToStores = persistDeliveryJudgmentScoresToStores;

export async function getDeliveryObservabilityStore(mastra?: MastraLike) {
  const storage = mastra?.getStorage?.();
  return (await storage?.getStore('observability')) as DeliveryObservabilityStore | undefined;
}

export async function getDeliveryScoresStore(mastra?: MastraLike) {
  const storage = mastra?.getStorage?.();
  return (await storage?.getStore('scores')) as DeliveryScoresStore | undefined;
}

export async function persistDeliveryStateWithMastra({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}) {
  const store = await getDeliveryObservabilityStore(mastra);
  if (!store) throw new Error('Mastra observability storage is not configured');
  return persistDeliveryStateToMastraStorage({ repoPath, store });
}

export const mirrorDeliveryStateWithMastra = persistDeliveryStateWithMastra;

export async function readDeliveryRunStatusWithMastra({
  repoPath,
  runId,
  mastra,
}: {
  repoPath?: string;
  runId?: string;
  mastra?: MastraLike;
}) {
  const store = await getDeliveryObservabilityStore(mastra);
  if (!store) return undefined;
  return readDeliveryRunStatusFromMastraStorage({ store, repoPath, runId });
}

export async function persistDeliveryJudgmentScoresWithMastra({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}) {
  const [scoresStore, observabilityStore] = await Promise.all([
    getDeliveryScoresStore(mastra),
    getDeliveryObservabilityStore(mastra),
  ]);
  if (!scoresStore) throw new Error('Mastra scores storage is not configured');
  return persistDeliveryJudgmentScoresToStores({ repoPath, scoresStore, observabilityStore });
}

export const mirrorDeliveryJudgmentScoresWithMastra = persistDeliveryJudgmentScoresWithMastra;

export async function safePersistDeliveryJudgmentScoresWithMastra({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}) {
  try {
    return await persistDeliveryJudgmentScoresWithMastra({ repoPath, mastra });
  } catch (error) {
    mastra?.getLogger?.().warn('Failed to persist delivery judgments to Mastra scores', {
      repoPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      runId: '',
      judgmentCount: 0,
      scoresSubmitted: 0,
      scoresSkipped: 0,
      observabilityScoresSubmitted: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const safeMirrorDeliveryJudgmentScoresWithMastra = safePersistDeliveryJudgmentScoresWithMastra;

export async function safePersistDeliveryStateWithMastra({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}) {
  try {
    const summary = await persistDeliveryStateWithMastra({ repoPath, mastra });
    await safePersistDeliveryJudgmentScoresWithMastra({ repoPath, mastra });
    return summary;
  } catch (error) {
    mastra?.getLogger?.().warn('Failed to persist delivery state to Mastra storage', {
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

export const safeMirrorDeliveryStateWithMastra = safePersistDeliveryStateWithMastra;

export async function listDeliveryStateRecords({
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
  const listed = await store.listLogs({
    filters: {
      // DuckDB's current observability log table accepts `source` in the input schema
      // but does not persist it as a queryable log_events column. Keep source-specific
      // filtering in memory and query only durable columns.
      serviceName: deliveryServiceName,
      ...(repoPath ? { resourceId: resolve(repoPath) } : {}),
    },
    pagination: { page, perPage },
    orderBy: { field: 'timestamp', direction: 'DESC' },
  });
  return {
    ...listed,
    logs: listed.logs.filter((log) => isDeliveryStateLog(log, runId)),
  };
}

export const listDeliveryStateMirrorLogs = listDeliveryStateRecords;
