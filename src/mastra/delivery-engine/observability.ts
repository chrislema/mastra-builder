import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { SaveScorePayload, ScoreRowData } from '@mastra/core/evals';
import { EntityType, SpanType } from '@mastra/core/observability';
import { getDeliveryRunStatus, readDeliveryEvents, readDeliveryRun, type DeliveryRun } from './state';
import type { DeliveryEvent } from './checks';

type DeliveryObservabilityLog = Record<string, unknown>;
type DeliveryObservabilityScore = Record<string, unknown>;
type DeliveryObservabilitySpan = Record<string, unknown>;

export type DeliveryObservabilityStore = {
  batchCreateLogs?(args: { logs: DeliveryObservabilityLog[] }): Promise<void>;
  batchCreateSpans?(args: { records: DeliveryObservabilitySpan[] }): Promise<void>;
  batchCreateScores?(args: { scores: DeliveryObservabilityScore[] }): Promise<void>;
  listLogs?(args: {
    filters?: Record<string, unknown>;
    pagination?: { page: number; perPage: number };
    orderBy?: { field: 'timestamp'; direction: 'ASC' | 'DESC' };
  }): Promise<{ logs: DeliveryObservabilityLog[]; pagination?: Record<string, unknown> }>;
  listTraces?(args: {
    filters?: Record<string, unknown>;
    pagination?: { page: number; perPage: number };
    orderBy?: { field: 'startedAt' | 'endedAt'; direction: 'ASC' | 'DESC' };
  }): Promise<{ spans: DeliveryObservabilitySpan[]; pagination?: Record<string, unknown> }>;
  getTrace?(args: {
    traceId: string;
  }): Promise<{ traceId: string; spans: DeliveryObservabilitySpan[] } | null>;
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
const mastraStorageMaxPageSize = 100;
const maxDeliveryStateReadPages = 100;
const maxDeliveryScoreReadPages = 100;

const stableHash = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length);

const toDate = (value: unknown, fallback: string) => {
  const date = new Date(typeof value === 'string' ? value : fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
};

const normalizePage = (page: number) => (Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0);

const normalizePageSize = (perPage: number) => {
  const normalized = Number.isFinite(perPage) ? Math.max(1, Math.trunc(perPage)) : mastraStorageMaxPageSize;
  return Math.min(normalized, mastraStorageMaxPageSize);
};

const hasMorePages = (pagination?: Record<string, unknown>) => pagination?.hasMore === true;

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
    timestamp: new Date(),
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

function traceIdForDeliveryRun(run: DeliveryRun, repoPath: string) {
  return stableHash({ repoPath: resolve(repoPath), runId: run.run_id }, 32);
}

function spanIdForDeliveryLog(log: DeliveryObservabilityLog) {
  return stableHash(log.logId ?? log, 16);
}

function buildDeliveryStateSpansFromLogs({
  repoPath,
  run,
  logs,
}: {
  repoPath: string;
  run: DeliveryRun;
  logs: DeliveryObservabilityLog[];
}) {
  const traceId = traceIdForDeliveryRun(run, repoPath);
  const snapshotLog = logs.find((log) => (log.data as Record<string, unknown> | undefined)?.kind === 'snapshot') ?? logs[0];
  const rootSpanId = spanIdForDeliveryLog(snapshotLog);

  return logs.map((log) => {
    const data = log.data as Record<string, unknown> | undefined;
    const isSnapshot = data?.kind === 'snapshot';
    const startedAt = toDate(log.timestamp, run.started_at);

    return {
      traceId,
      spanId: spanIdForDeliveryLog(log),
      parentSpanId: isSnapshot ? undefined : rootSpanId,
      name: String(log.message ?? `Delivery ${String(data?.kind ?? 'state')}`),
      spanType: isSnapshot ? SpanType.WORKFLOW_RUN : SpanType.WORKFLOW_STEP,
      isEvent: !isSnapshot,
      startedAt,
      endedAt: startedAt,
      source: log.source ?? deliverySource,
      entityType: isSnapshot ? EntityType.WORKFLOW_RUN : EntityType.WORKFLOW_STEP,
      entityId: log.entityId ?? run.run_id,
      entityName: log.entityName ?? deliveryWorkflowEntity,
      parentEntityType: isSnapshot ? undefined : EntityType.WORKFLOW_RUN,
      parentEntityId: isSnapshot ? undefined : run.run_id,
      parentEntityName: isSnapshot ? undefined : deliveryWorkflowEntity,
      rootEntityType: EntityType.WORKFLOW_RUN,
      rootEntityId: run.run_id,
      rootEntityName: deliveryWorkflowEntity,
      resourceId: log.resourceId ?? resolve(repoPath),
      runId: log.runId ?? run.run_id,
      serviceName: log.serviceName ?? deliveryServiceName,
      tags: log.tags,
      metadata: log.metadata,
      attributes: {
        deliveryLogId: log.logId,
        deliveryRecordKind: data?.kind,
      },
      scope: {
        deliverySource,
        recordKind: data?.kind,
      },
      output: data,
    };
  });
}

function spanToDeliveryStateLog(span: DeliveryObservabilitySpan): DeliveryObservabilityLog {
  const output = span.output as Record<string, unknown> | undefined;
  const attributes = span.attributes as Record<string, unknown> | undefined;

  return {
    logId: attributes?.deliveryLogId ?? span.spanId,
    timestamp: span.startedAt,
    level: 'info',
    message: span.name,
    data: output,
    source: span.source,
    serviceName: span.serviceName,
    entityType: span.entityType,
    entityId: span.entityId,
    entityName: span.entityName,
    rootEntityType: span.rootEntityType,
    rootEntityId: span.rootEntityId,
    rootEntityName: span.rootEntityName,
    resourceId: span.resourceId,
    runId: span.runId,
    tags: span.tags,
    metadata: span.metadata,
  };
}

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
  if (store.batchCreateSpans) {
    await store.batchCreateSpans({ records: buildDeliveryStateSpansFromLogs({ repoPath, run, logs }) });
  } else if (store.batchCreateLogs) {
    await store.batchCreateLogs({ logs });
  } else {
    throw new Error('Mastra observability storage does not support delivery state persistence');
  }

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
  if (store.batchCreateSpans) {
    await store.batchCreateSpans({ records: buildDeliveryStateSpansFromLogs({ repoPath, run, logs }) });
  } else if (store.batchCreateLogs) {
    await store.batchCreateLogs({ logs });
  } else {
    throw new Error('Mastra observability storage does not support delivery state persistence');
  }

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

function isUnsupportedObservabilityFeature(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /does not support|not implemented/i.test(message);
}

async function listDeliveryStateRecordsUntilSnapshot({
  store,
  repoPath,
  runId,
  collectLegacyEvents = false,
}: {
  store: DeliveryObservabilityStore;
  repoPath?: string;
  runId?: string;
  collectLegacyEvents?: boolean;
}) {
  const logs: DeliveryObservabilityLog[] = [];
  let snapshotLog: DeliveryObservabilityLog | undefined;

  for (let page = 0; page < maxDeliveryStateReadPages; page += 1) {
    const listed = await listDeliveryStateRecords({
      store,
      repoPath,
      runId,
      page,
      perPage: mastraStorageMaxPageSize,
    });
    logs.push(...listed.logs);
    snapshotLog ??= logs.find((log) => (log.data as Record<string, unknown> | undefined)?.kind === 'snapshot');

    const snapshotData = snapshotLog?.data as Record<string, unknown> | undefined;
    if (snapshotLog && (!collectLegacyEvents || Array.isArray(snapshotData?.events))) break;
    if (!hasMorePages(listed.pagination)) break;
  }

  return { logs, snapshotLog };
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
  const { logs, snapshotLog } = await listDeliveryStateRecordsUntilSnapshot({
    store,
    repoPath,
    runId,
    collectLegacyEvents: true,
  });
  const data = snapshotLog?.data as Record<string, unknown> | undefined;
  const run = data?.run as DeliveryRun | undefined;
  if (!run?.run_id) return undefined;

  const embeddedEvents = data.events as DeliveryEvent[] | undefined;
  if (Array.isArray(embeddedEvents)) return { run, events: embeddedEvents };

  const events = logs
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
  const { snapshotLog } = await listDeliveryStateRecordsUntilSnapshot({
    store,
    repoPath,
    runId,
  });
  return snapshotLog ? statusFromSnapshotLog(snapshotLog) : undefined;
}

async function existingDeliveryJudgmentScoreKeys(store: DeliveryScoresStore, runId: string) {
  if (!store.listScoresByRunId) return new Set<string>();
  const scores: ScoreRowData[] = [];

  for (let page = 0; page < maxDeliveryScoreReadPages; page += 1) {
    const listed = await store.listScoresByRunId({
      runId,
      pagination: { page, perPage: mastraStorageMaxPageSize },
    });
    scores.push(...listed.scores);
    if (!hasMorePages(listed.pagination)) break;
  }

  return new Set(
    scores.map((score) =>
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
  let observabilityScoresSubmitted = 0;
  if (observabilityStore?.batchCreateScores && scoreEvents.length) {
    try {
      await observabilityStore.batchCreateScores({ scores: scoreEvents });
      observabilityScoresSubmitted = scoreEvents.length;
    } catch (error) {
      if (!isUnsupportedObservabilityFeature(error)) throw error;
    }
  }

  return {
    ok: true,
    runId: run.run_id,
    judgmentCount: payloads.length,
    scoresSubmitted,
    scoresSkipped,
    observabilityScoresSubmitted,
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
  const normalizedPage = normalizePage(page);
  const normalizedPerPage = normalizePageSize(perPage);

  if (!store.listTraces && store.listLogs) {
    const listed = await store.listLogs({
      filters: {
        // Query only durable cross-store columns; delivery-specific source checks happen in memory.
        serviceName: deliveryServiceName,
        ...(repoPath ? { resourceId: resolve(repoPath) } : {}),
      },
      pagination: { page: normalizedPage, perPage: normalizedPerPage },
      orderBy: { field: 'timestamp', direction: 'DESC' },
    });
    return {
      ...listed,
      logs: listed.logs.filter((log) => isDeliveryStateLog(log, runId)),
    };
  }

  if (!store.listTraces) {
    throw new Error('Mastra observability storage does not support delivery state listing');
  }

  const listed = await store.listTraces({
    filters: {
      source: deliverySource,
      serviceName: deliveryServiceName,
      entityType: EntityType.WORKFLOW_RUN,
      ...(repoPath ? { resourceId: resolve(repoPath) } : {}),
      ...(runId ? { runId } : {}),
    },
    pagination: { page: normalizedPage, perPage: normalizedPerPage },
    orderBy: { field: 'startedAt', direction: 'DESC' },
  });
  const spans = (
    await Promise.all(
      listed.spans.map(async (span) => {
        const traceId = typeof span.traceId === 'string' ? span.traceId : undefined;
        if (!traceId || !store.getTrace) return [span];
        return (await store.getTrace({ traceId }))?.spans ?? [span];
      }),
    )
  ).flat();
  const logs = spans
    .map(spanToDeliveryStateLog)
    .filter((log) => isDeliveryStateLog(log, runId))
    .sort((left, right) => toDate(right.timestamp, new Date().toISOString()).getTime() - toDate(left.timestamp, new Date().toISOString()).getTime());

  return {
    pagination: listed.pagination,
    logs,
  };
}

export const listDeliveryStateMirrorLogs = listDeliveryStateRecords;
