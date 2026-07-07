import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  deliveryMastraObservabilityServiceName,
  legacyDeliveryMastraObservabilityServiceName,
} from '../../src/mastra/config.ts';
import type { DeliveryObservabilityStore, MastraLike } from '../../src/mastra/delivery-engine/observability.ts';
import {
  getDeliveryRunStatusState,
  initializeDeliveryRunState,
  readDeliveryEventsState,
  readDeliveryRunState,
  updateDeliveryTaskState,
} from '../../src/mastra/delivery-engine/state-service.ts';
import {
  finishDeliveryRun,
  initializeDeliveryRun,
  readDeliveryRun,
  recordDeliveryArtifact,
  updateDeliveryTask,
} from '../../src/mastra/delivery-engine/state.ts';

const createRepo = () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-state-service-'));
  writeFileSync(join(repoPath, 'vision.md'), '# Vision\n');
  writeFileSync(join(repoPath, 'spec.md'), '# Spec\n');
  return repoPath;
};

const createMastra = (store: DeliveryObservabilityStore): MastraLike => ({
  getStorage: () => ({
    async getStore(storeName: string) {
      return storeName === 'observability' ? store : undefined;
    },
  }),
});

const readableServiceNames = new Set([
  deliveryMastraObservabilityServiceName,
  legacyDeliveryMastraObservabilityServiceName,
]);

const createMemoryObservabilityStore = () => {
  let order = 0;
  const written: Record<string, any>[] = [];
  const store: DeliveryObservabilityStore = {
    async batchCreateLogs({ logs }) {
      written.push(...(logs as Record<string, any>[]).map((log) => ({ ...log, __order: order++ })));
    },
    async listLogs({ filters, pagination }) {
      assert.equal(filters?.source, undefined);
      assert.equal(readableServiceNames.has(String(filters?.serviceName)), true);
      const page = pagination?.page ?? 0;
      const perPage = pagination?.perPage ?? 25;
      const filtered = written
        .filter((log) => {
          if (filters?.serviceName && log.serviceName !== filters.serviceName) return false;
          if (filters?.resourceId && log.resourceId !== filters.resourceId) return false;
          if (filters?.runId && log.runId !== filters.runId) return false;
          return true;
        })
        .sort((left, right) => {
          const leftTime = new Date(left.timestamp as Date).getTime();
          const rightTime = new Date(right.timestamp as Date).getTime();
          return rightTime - leftTime || right.__order - left.__order;
        });

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

  return { store, written };
};

test('delivery state service prefers Mastra storage snapshots over stale local projections', async () => {
  const repoPath = createRepo();
  const { store, written } = createMemoryObservabilityStore();
  const mastra = createMastra(store);

  await initializeDeliveryRunState({ repoPath, visionPath: 'vision.md', specPath: 'spec.md', mastra });
  await updateDeliveryTaskState({ repoPath, id: 'T1', status: 'complete', owner: 'engineer', mastra });
  updateDeliveryTask({ repoPath, id: 'T1', status: 'stuck', owner: 'engineer' });

  const status = await getDeliveryRunStatusState({ repoPath, mastra });
  const run = await readDeliveryRunState({ repoPath, mastra });
  const events = await readDeliveryEventsState({ repoPath, mastra });

  assert.equal(status.run_id, run.run_id);
  assert.deepEqual(status.tasks, ['T1:complete']);
  assert.equal(run.tasks.T1.status, 'complete');
  assert.equal(readDeliveryRun(repoPath).tasks.T1.status, 'stuck');
  assert.equal(events.some((event) => event.type === 'run_init'), true);
  assert.equal(written.some((log) => log.resourceId === resolve(repoPath) && log.data?.kind === 'snapshot'), true);
});

test('delivery state initialization tolerates report dirs without a run projection', async () => {
  const repoPath = createRepo();
  mkdirSync(join(repoPath, '.delivery', 'runs'), { recursive: true });

  const run = await initializeDeliveryRunState({ repoPath, visionPath: 'vision.md', specPath: 'spec.md' });

  assert.equal(run.status, 'running');
  assert.equal(readDeliveryRun(repoPath).run_id, run.run_id);
});

test('delivery state initialization repairs stale running Mastra snapshots from terminal local projection', async () => {
  const repoPath = createRepo();
  const { store, written } = createMemoryObservabilityStore();
  const mastra = createMastra(store);

  const staleRun = await initializeDeliveryRunState({ repoPath, visionPath: 'vision.md', specPath: 'spec.md', mastra });
  finishDeliveryRun({ repoPath, status: 'failed' });

  const nextRun = await initializeDeliveryRunState({ repoPath, visionPath: 'vision.md', specPath: 'spec.md', mastra });

  assert.notEqual(nextRun.run_id, staleRun.run_id);
  assert.equal(nextRun.status, 'running');
  assert.equal(readDeliveryRun(repoPath).run_id, nextRun.run_id);
  assert.equal(
    written.some((log) => log.runId === staleRun.run_id && log.data?.kind === 'snapshot' && log.data.run.status === 'failed'),
    true,
  );
  assert.equal(
    written.some((log) => log.runId === nextRun.run_id && log.data?.kind === 'snapshot' && log.data.run.status === 'running'),
    true,
  );
});

test('delivery state initialization proceeds when stale Mastra repair write fails', async () => {
  const repoPath = createRepo();
  const memory = createMemoryObservabilityStore();
  let failNextWrite = false;
  const store: DeliveryObservabilityStore = {
    ...memory.store,
    async batchCreateLogs(args) {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('storage client closed');
      }
      await memory.store.batchCreateLogs?.(args);
    },
  };
  const mastra = createMastra(store);

  const staleRun = await initializeDeliveryRunState({ repoPath, visionPath: 'vision.md', specPath: 'spec.md', mastra });
  finishDeliveryRun({ repoPath, status: 'failed' });
  failNextWrite = true;

  const nextRun = await initializeDeliveryRunState({ repoPath, visionPath: 'vision.md', specPath: 'spec.md', mastra });

  assert.notEqual(nextRun.run_id, staleRun.run_id);
  assert.equal(nextRun.status, 'running');
  assert.equal(readDeliveryRun(repoPath).run_id, nextRun.run_id);
});

test('delivery state service keeps richer local projection when Mastra snapshot is stale', async () => {
  const repoPath = createRepo();
  const { store } = createMemoryObservabilityStore();
  const mastra = createMastra(store);

  await initializeDeliveryRunState({ repoPath, visionPath: 'vision.md', specPath: 'spec.md', mastra });
  recordDeliveryArtifact({ repoPath, type: 'readout', path: '.delivery/artifacts/readout.json' });

  const run = await readDeliveryRunState({ repoPath, mastra });
  const events = await readDeliveryEventsState({ repoPath, mastra });

  assert.equal(run.artifacts.readout, '.delivery/artifacts/readout.json');
  assert.equal(events.some((event) => event.type === 'artifact_write'), true);
});

test('delivery state service writes Mastra storage before refreshing the local projection', async () => {
  const repoPath = createRepo();
  initializeDeliveryRun({ repoPath, visionPath: 'vision.md', specPath: 'spec.md' });

  const failingStore: DeliveryObservabilityStore = {
    async batchCreateLogs() {
      throw new Error('storage unavailable');
    },
    async listLogs() {
      return { logs: [] };
    },
  };

  await assert.rejects(
    updateDeliveryTaskState({
      repoPath,
      id: 'T2',
      status: 'complete',
      owner: 'engineer',
      mastra: createMastra(failingStore),
    }),
    /storage unavailable/,
  );
  assert.equal(readDeliveryRun(repoPath).tasks.T2, undefined);
});

test('delivery state service stores normalized repo-relative document paths', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-state-service-paths-'));
  mkdirSync(join(repoPath, 'docs'));
  writeFileSync(join(repoPath, 'docs', 'vision.md'), '# Vision\n');
  writeFileSync(join(repoPath, 'docs', 'spec.md'), '# Spec\n');

  const run = await initializeDeliveryRunState({
    repoPath,
    visionPath: join(repoPath, 'docs', 'vision.md'),
    specPath: 'docs/spec.md',
  });

  assert.equal(run.vision, 'docs/vision.md');
  assert.equal(run.spec, 'docs/spec.md');
});
