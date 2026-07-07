import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  buildCloudflareArchitectureCoverageReport,
  buildCloudflareArchitectureGateReport,
  cloudflareArchitectureDatasetItems,
  cloudflareArchitectureDatasetName,
  cloudflareArchitectureGateThresholds,
  cloudflareArchitectureScorerIds,
  collectCloudflareArchitectureScoreMismatches,
  runCloudflareArchitectureExperiment,
} from '../../src/mastra/delivery-engine/cloudflare-evals.ts';
import { deliveryScorers } from '../../src/mastra/delivery-engine/scorers.ts';

test('cloudflare architecture fixtures carry expected score labels', () => {
  assert.equal(cloudflareArchitectureDatasetItems.length >= 10, true);
  assert.equal(
    cloudflareArchitectureDatasetItems.every((item) => item.groundTruth.caseId === item.metadata.caseId),
    true,
  );
  assert.equal(
    cloudflareArchitectureDatasetItems.every((item) =>
      cloudflareArchitectureScorerIds.every((scorerId) => typeof item.groundTruth.expectedScores[scorerId] === 'number'),
    ),
    true,
  );
  assert.ok(cloudflareArchitectureDatasetItems.some((item) => item.groundTruth.expectedTopology === 'multi-worker'));
  assert.ok(cloudflareArchitectureDatasetItems.some((item) => item.groundTruth.expectedTopology === 'pages-functions'));
});

test('cloudflare architecture fixtures cover every scorer with positive and negative examples', () => {
  const summary = {
    results: cloudflareArchitectureDatasetItems.map((item, index) => ({
      itemId: `item-${index}`,
      input: item.input,
      groundTruth: item.groundTruth,
      scores: cloudflareArchitectureScorerIds.map((scorerId) => ({
        scorerId,
        scorerName: scorerId,
        score: item.groundTruth.expectedScores[scorerId],
        reason: 'fixture',
        error: null,
      })),
    })),
  };

  const coverage = buildCloudflareArchitectureCoverageReport(summary as never);

  assert.equal(coverage.totalScorers, cloudflareArchitectureScorerIds.length);
  assert.equal(coverage.coveredScorers, cloudflareArchitectureScorerIds.length);
  assert.deepEqual(coverage.missingScorers, []);
  assert.equal(coverage.totalExpectations, cloudflareArchitectureDatasetItems.length * cloudflareArchitectureScorerIds.length);
  assert.equal(coverage.scorerCoverage.every((item) => item.positiveExamples > 0 && item.negativeExamples > 0), true);
});

test('cloudflare architecture mismatch collector compares scores to ground truth', () => {
  const item = cloudflareArchitectureDatasetItems.find((fixture) => fixture.metadata.caseId === 'worker-d1-auth-sessions');
  assert.ok(item);
  const summary = {
    results: [
      {
        itemId: 'item-1',
        input: item.input,
        groundTruth: item.groundTruth,
        scores: cloudflareArchitectureScorerIds.map((scorerId) => ({
          scorerId,
          scorerName: scorerId,
          score: scorerId === 'cloudflare-storage-fit' ? 0 : item.groundTruth.expectedScores[scorerId],
          reason: scorerId === 'cloudflare-storage-fit' ? 'missing d1' : 'ok',
          error: null,
        })),
      },
    ],
  };

  const mismatches = collectCloudflareArchitectureScoreMismatches(summary as never);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].caseId, 'worker-d1-auth-sessions');
  assert.equal(mismatches[0].scorerId, 'cloudflare-storage-fit');
  assert.equal(mismatches[0].expected, 1);
  assert.equal(mismatches[0].actual, 0);
});

test('cloudflare architecture gate report exposes coverage, thresholds, and trend deltas', () => {
  const summary = {
    experimentId: 'exp-current',
    status: 'completed',
    totalItems: cloudflareArchitectureDatasetItems.length,
    succeededCount: cloudflareArchitectureDatasetItems.length,
    failedCount: 0,
    persistenceFailures: 0,
    results: cloudflareArchitectureDatasetItems.map((fixture, index) => ({
      itemId: `item-${index}`,
      input: fixture.input,
      groundTruth: fixture.groundTruth,
      scores: cloudflareArchitectureScorerIds.map((scorerId) => ({
        scorerId,
        scorerName: scorerId,
        score: fixture.groundTruth.expectedScores[scorerId],
        reason: 'ok',
        error: null,
      })),
    })),
  };
  const previousReport = {
    generatedAt: '2026-07-04T00:00:00.000Z',
    suiteVersion: 1,
    datasetId: 'dataset-1',
    experimentId: 'exp-previous',
    status: 'completed',
    totalItems: 1,
    succeededCount: 1,
    failedCount: 0,
    persistenceFailures: 0,
    succeededRate: 0.5,
    scorerAverages: { 'cloudflare-storage-fit': 0 },
    coverage: {
      totalScorers: 1,
      coveredScorers: 1,
      missingScorers: [],
      totalExpectations: 1,
      scorerCoverage: [
        {
          scorerId: 'cloudflare-storage-fit',
          expectedItems: 1,
          scoredItems: 1,
          positiveExamples: 1,
          negativeExamples: 1,
          missingScoreCaseIds: [],
        },
      ],
    },
    thresholds: cloudflareArchitectureGateThresholds,
    gateResults: [],
    thresholdResults: [],
    verdict: 'scored' as const,
    mismatches: [{ itemId: 'old', caseId: 'old', scorerId: 'old', expected: 1, actual: 0 }],
    gate: { passed: false, reasons: ['previous mismatch'] },
  };

  const report = buildCloudflareArchitectureGateReport({
    datasetId: 'dataset-1',
    summary: summary as never,
    mismatches: [],
    thresholds: cloudflareArchitectureGateThresholds,
    previousReport,
  });

  assert.equal(report.gate.passed, true);
  assert.equal(report.verdict, 'passed');
  assert.equal(report.coverage.coveredScorers, cloudflareArchitectureScorerIds.length);
  assert.equal(report.gateResults.every((result) => result.passed), true);
  assert.equal(report.thresholdResults.every((result) => result.passed), true);
  assert.equal(report.trend?.previousExperimentId, 'exp-previous');
  assert.equal(report.trend?.mismatchDelta, -1);
  assert.equal(report.trend?.succeededRateDelta, 0.5);
  assert.ok((report.trend?.scorerAverageDelta['cloudflare-storage-fit'] ?? 0) > 0);
});

test('cloudflare architecture experiment gates scorers through isolated Mastra storage', async (t) => {
  const storageDir = mkdtempSync(join(tmpdir(), 'cloudflare-eval-gate-'));
  const storage = new LibSQLStore({
    id: 'cloudflare-eval-gate-storage',
    url: `file:${join(storageDir, 'mastra.db')}`,
  });
  const mastra = new Mastra({
    scorers: deliveryScorers,
    storage,
    logger: false,
  });

  t.after(async () => {
    await mastra.shutdown();
    await storage.close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  const { dataset, summary, mismatches } = await runCloudflareArchitectureExperiment(mastra, {
    name: 'cloudflare-architecture-ci-gate',
    description: 'CI gate for Cloudflare architecture scorers.',
    maxConcurrency: 1,
    itemTimeout: 10_000,
    metadata: { suite: 'delivery-engine', gate: 'ci' },
  });

  assert.equal(summary.status, 'completed');
  assert.equal(summary.totalItems, cloudflareArchitectureDatasetItems.length);
  assert.equal(summary.succeededCount, cloudflareArchitectureDatasetItems.length);
  assert.equal(summary.failedCount, 0);
  assert.deepEqual(mismatches, []);
  const report = buildCloudflareArchitectureGateReport({ datasetId: dataset.id, summary, mismatches });
  assert.equal(report.gate.passed, true);
  assert.equal(report.verdict, 'passed');
  assert.equal(report.thresholds.maxMismatches, 0);
  assert.equal(report.mismatches.length, 0);
  assert.equal(report.coverage.missingScorers.length, 0);
  assert.equal(report.gateResults.every((result) => result.passed), true);
  assert.equal(report.thresholdResults.every((result) => result.passed), true);

  const listed = await mastra.datasets.list({
    filters: { name: cloudflareArchitectureDatasetName, targetType: 'scorer' },
    perPage: 10,
  });
  assert.equal(listed.datasets.some((dataset) => dataset.name === cloudflareArchitectureDatasetName), true);
});
