import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { LibSQLStore } from '@mastra/libsql';
import {
  buildDeliveryJudgmentScoreEvents,
  buildDeliveryJudgmentScorePayloads,
  buildDeliveryStatePersistenceLogs,
  listDeliveryStateRecords,
  persistDeliveryJudgmentScoresToStores,
  persistDeliveryStateToObservability,
  readDeliverySnapshotFromMastraStorage,
  readDeliveryRunStatusFromMastraStorage,
  type DeliveryObservabilityStore,
  type DeliveryScoresStore,
} from '../../src/mastra/delivery-engine/observability.ts';
import {
  finishDeliveryRun,
  initializeDeliveryRun,
  recordDeliveryArtifact,
  recordDeliveryJudgment,
  startDeliveryStage,
  updateDeliveryTask,
  writeDeliveryArtifact,
} from '../../src/mastra/delivery-engine/state.ts';

const createRepo = () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-observability-'));
  writeFileSync(join(repoPath, 'vision.md'), '# Vision\n');
  writeFileSync(join(repoPath, 'spec.md'), '# Spec\n');
  initializeDeliveryRun({ repoPath, visionPath: 'vision.md', specPath: 'spec.md' });
  startDeliveryStage({ repoPath, stage: 'build:T1', role: 'engineer', surfaces: ['src/app.ts'] });
  updateDeliveryTask({ repoPath, id: 'T1', status: 'complete', owner: 'engineer' });
  writeDeliveryArtifact({
    repoPath,
    artifactPath: '.delivery/artifacts/note-T1.json',
    artifact: { artifact_type: 'implementation-note', task: 'T1' },
  });
  recordDeliveryArtifact({ repoPath, type: 'note-T1', path: '.delivery/artifacts/note-T1.json' });
  finishDeliveryRun({ repoPath, status: 'complete' });
  return repoPath;
};

test('delivery state persistence logs include a snapshot plus append-only events', () => {
  const repoPath = createRepo();
  const { run, events, logs } = buildDeliveryStatePersistenceLogs(repoPath);

  assert.equal(logs.length, events.length + 1);

  const snapshot = logs[0] as Record<string, any>;
  assert.equal(snapshot.source, 'delivery-engine');
  assert.equal(snapshot.executionSource, 'mastra-delivery');
  assert.equal(snapshot.entityType, 'workflow_run');
  assert.equal(snapshot.entityName, 'delivery-workflow');
  assert.equal(snapshot.resourceId, resolve(repoPath));
  assert.equal(snapshot.runId, run.run_id);
  assert.equal(snapshot.metadata.stateSource, 'mastra-storage');
  assert.equal(snapshot.metadata.projectionSource, '.delivery');
  assert.deepEqual(snapshot.tags, ['delivery-state', 'delivery-snapshot', 'status:complete', 'stage:done']);
  assert.equal(snapshot.data.kind, 'snapshot');
  assert.deepEqual(snapshot.data.status.tasks, ['T1:complete']);
  assert.equal(snapshot.data.eventCount, events.length);

  const eventLog = logs.find((log) => (log as Record<string, any>).data.kind === 'event') as Record<string, any>;
  assert.equal(eventLog.runId, run.run_id);
  assert.equal(eventLog.tags.includes('delivery-event'), true);
});

test('delivery state persistence writes and lists through the observability store shape', async () => {
  const repoPath = createRepo();
  const written: Record<string, any>[] = [];
  const store: DeliveryObservabilityStore = {
    async batchCreateLogs({ logs }) {
      written.push(...(logs as Record<string, any>[]));
    },
    async listLogs({ filters, pagination, orderBy }) {
      assert.deepEqual(orderBy, { field: 'timestamp', direction: 'DESC' });
      assert.equal(filters?.source, undefined);
      assert.equal(filters?.serviceName, 'builders');
      return {
        logs: written.filter((log) => {
          if (filters?.serviceName && log.serviceName !== filters.serviceName) return false;
          if (filters?.resourceId && log.resourceId !== filters.resourceId) return false;
          if (filters?.runId && log.runId !== filters.runId) return false;
          return true;
        }),
        pagination: {
          total: written.length,
          page: pagination?.page ?? 0,
          perPage: pagination?.perPage ?? 25,
          hasMore: false,
        },
      };
    },
  };

  const summary = await persistDeliveryStateToObservability({ repoPath, store });
  written.push({
    serviceName: 'builders',
    resourceId: resolve(repoPath),
    runId: summary.runId,
    timestamp: new Date(),
    data: { kind: 'snapshot' },
    metadata: { stateSource: 'other', projectionSource: '.delivery' },
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.status, 'complete');
  assert.equal(summary.logsSubmitted, written.length - 1);

  const listed = await listDeliveryStateRecords({ store, repoPath, runId: summary.runId });
  assert.equal(listed.logs.length, summary.logsSubmitted);
});

test('delivery snapshot reads page past unrelated observability rows', async () => {
  const repoPath = createRepo();
  const written: Record<string, any>[] = [];
  const store: DeliveryObservabilityStore = {
    async batchCreateLogs({ logs }) {
      written.push(...(logs as Record<string, any>[]));
    },
    async listLogs({ filters, pagination, orderBy }) {
      assert.deepEqual(orderBy, { field: 'timestamp', direction: 'DESC' });
      assert.equal(filters?.source, undefined);
      assert.equal(filters?.serviceName, 'builders');
      assert.ok((pagination?.perPage ?? 0) <= 100);

      const page = pagination?.page ?? 0;
      const perPage = pagination?.perPage ?? 25;
      const filtered = written
        .filter((log) => {
          if (filters?.serviceName && log.serviceName !== filters.serviceName) return false;
          if (filters?.resourceId && log.resourceId !== filters.resourceId) return false;
          return true;
        })
        .sort((left, right) => new Date(right.timestamp as Date).getTime() - new Date(left.timestamp as Date).getTime());

      return {
        logs: filtered.slice(page * perPage, page * perPage + perPage),
        pagination: {
          total: filtered.length,
          page,
          perPage,
          hasMore: (page + 1) * perPage < filtered.length,
        },
      };
    },
  };

  const summary = await persistDeliveryStateToObservability({ repoPath, store });
  const now = Date.now();
  written.push(
    ...Array.from({ length: 125 }, (_, index) => ({
      serviceName: 'builders',
      resourceId: resolve(repoPath),
      runId: `noise-${index}`,
      timestamp: new Date(now + 1000 + index),
      data: { kind: 'snapshot' },
      metadata: { stateSource: 'other', projectionSource: '.delivery' },
    })),
  );

  const storedSnapshot = await readDeliverySnapshotFromMastraStorage({ store, repoPath, runId: summary.runId });
  assert.equal(storedSnapshot?.run.run_id, summary.runId);
  assert.equal(storedSnapshot?.run.status, 'complete');
  assert.equal(storedSnapshot?.events.some((event) => event.type === 'run_init'), true);
});

test('delivery status reads prefer Mastra storage snapshots over the local projection', async () => {
  const repoPath = createRepo();
  const written: Record<string, any>[] = [];
  const store: DeliveryObservabilityStore = {
    async batchCreateLogs({ logs }) {
      written.push(...(logs as Record<string, any>[]));
    },
    async listLogs({ filters }) {
      assert.equal(filters?.source, undefined);
      assert.equal(filters?.serviceName, 'builders');
      return {
        logs: written.filter((log) => {
          if (filters?.serviceName && log.serviceName !== filters.serviceName) return false;
          if (filters?.resourceId && log.resourceId !== filters.resourceId) return false;
          if (filters?.runId && log.runId !== filters.runId) return false;
          return true;
        }),
      };
    },
  };

  await persistDeliveryStateToObservability({ repoPath, store });
  updateDeliveryTask({ repoPath, id: 'T2', status: 'stuck', owner: 'engineer' });

  const storedStatus = await readDeliveryRunStatusFromMastraStorage({ store, repoPath });
  assert.deepEqual(storedStatus?.tasks, ['T1:complete']);
  assert.equal(storedStatus?.status, 'complete');
});

test('delivery state listing is compatible with real LibSQL observability storage', async () => {
  const repoPath = createRepo();
  const storageDir = mkdtempSync(join(tmpdir(), 'delivery-libsql-observability-'));
  const storage = new LibSQLStore({ id: 'test-libsql-observability', url: `file:${join(storageDir, 'observability.db')}` });

  try {
    const store = (await storage.getStore('observability')) as DeliveryObservabilityStore;
    await (store as DeliveryObservabilityStore & { init?: () => Promise<void> }).init?.();
    await persistDeliveryStateToObservability({ repoPath, store });

    const storedSnapshot = await readDeliverySnapshotFromMastraStorage({ store, repoPath });
    assert.equal(storedSnapshot?.run.status, 'complete');
    assert.equal(storedSnapshot?.events.some((event) => event.type === 'run_init'), true);

    const storedStatus = await readDeliveryRunStatusFromMastraStorage({ store, repoPath });
    assert.deepEqual(storedStatus?.tasks, ['T1:complete']);
    assert.equal(storedStatus?.status, 'complete');
  } finally {
    await storage.close();
  }
});

test('delivery judgment persistence writes rubric scores to Mastra score stores', async () => {
  const repoPath = createRepo();
  recordDeliveryJudgment({
    repoPath,
    subject: '.delivery/artifacts/task-plan.json',
    rubric: 'task-plan',
    path: '.delivery/artifacts/judgments/task-plan.judgment.json',
    overall: 0.91,
    passed: true,
  });
  recordDeliveryJudgment({
    repoPath,
    subject: '.delivery/artifacts/note-T1.json',
    rubric: 'implementation',
    path: '.delivery/artifacts/judgments/implementation-T1.judgment.json',
    overall: 0.42,
    passed: false,
  });

  const payloads = buildDeliveryJudgmentScorePayloads(repoPath);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].scorerId, 'delivery-rubric:task-plan');
  assert.equal(payloads[0].entityType, 'WORKFLOW');
  assert.equal(payloads[0].score, 0.91);
  assert.equal((payloads[0].metadata as Record<string, unknown>).deliveryJudgmentPath, '.delivery/artifacts/judgments/task-plan.judgment.json');

  const events = buildDeliveryJudgmentScoreEvents(repoPath);
  assert.equal(events.length, 2);
  assert.equal(events[0].entityType, 'workflow_run');
  assert.equal(events[0].scoreSource, 'delivery-rubric-judge');

  const savedScores: Record<string, any>[] = [];
  const scoreStore: DeliveryScoresStore = {
    async listScoresByRunId() {
      return { scores: [], pagination: { total: 0 } };
    },
    async saveScore(score) {
      savedScores.push(score as Record<string, any>);
      return {
        score: {
          ...score,
          id: `score-${savedScores.length}`,
          createdAt: new Date(),
          updatedAt: null,
        } as never,
      };
    },
  };
  const observabilityScores: Record<string, any>[] = [];
  const observabilityStore: DeliveryObservabilityStore = {
    async batchCreateLogs() {},
    async batchCreateScores({ scores }) {
      observabilityScores.push(...(scores as Record<string, any>[]));
    },
    async listLogs() {
      return { logs: [] };
    },
  };

  const summary = await persistDeliveryJudgmentScoresToStores({
    repoPath,
    scoresStore: scoreStore,
    observabilityStore,
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.judgmentCount, 2);
  assert.equal(summary.scoresSubmitted, 2);
  assert.equal(summary.observabilityScoresSubmitted, 2);
  assert.equal(savedScores[1].scorerId, 'delivery-rubric:implementation');
  assert.equal(savedScores[1].score, 0.42);
  assert.equal(observabilityScores[1].tags.includes('failed'), true);
});
