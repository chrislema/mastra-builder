import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  buildDeliveryRegressionGateReport,
  collectDeliveryRegressionScoreMismatches,
  deliveryRegressionDatasetItems,
  deliveryRegressionDatasetName,
  deliveryRegressionGateThresholds,
  runDeliveryRegressionExperiment,
} from '../../src/mastra/delivery-engine/evals.ts';
import { deliveryScorers } from '../../src/mastra/delivery-engine/scorers.ts';

test('delivery regression fixtures carry expected score labels', () => {
  assert.equal(deliveryRegressionDatasetItems.length >= 4, true);
  assert.equal(deliveryRegressionDatasetItems.every((item) => item.groundTruth.caseId === item.metadata.caseId), true);
});

test('delivery regression mismatch collector compares experiment scores to ground truth', () => {
  const item = deliveryRegressionDatasetItems[0];
  const summary = {
    results: [
      {
        itemId: 'item-1',
        input: item.input,
        groundTruth: item.groundTruth,
        scores: [
          {
            scorerId: 'delivery-workflow-completion',
            scorerName: 'Delivery Workflow Completion',
            score: 1,
            reason: 'ok',
            error: null,
          },
          {
            scorerId: 'delivery-rubric-floor',
            scorerName: 'Delivery Rubric Floor',
            score: 0.5,
            reason: 'too low',
            error: null,
          },
          {
            scorerId: 'delivery-judgment-pass-rate',
            scorerName: 'Delivery Judgment Pass Rate',
            score: 1,
            reason: 'ok',
            error: null,
          },
          {
            scorerId: 'delivery-deterministic-checks',
            scorerName: 'Delivery Deterministic Checks',
            score: 1,
            reason: 'ok',
            error: null,
          },
        ],
      },
    ],
  };

  const mismatches = collectDeliveryRegressionScoreMismatches(summary as never);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].caseId, 'complete-delivery');
  assert.equal(mismatches[0].scorerId, 'delivery-rubric-floor');
  assert.equal(mismatches[0].expected, 0.84);
  assert.equal(mismatches[0].actual, 0.5);
});

test('delivery regression gate report exposes thresholds and trend deltas', () => {
  const item = deliveryRegressionDatasetItems[0];
  const summary = {
    experimentId: 'exp-current',
    status: 'completed',
    totalItems: 1,
    succeededCount: 1,
    failedCount: 0,
    results: [
      {
        itemId: 'item-1',
        input: item.input,
        groundTruth: item.groundTruth,
        scores: [
          {
            scorerId: 'delivery-workflow-completion',
            scorerName: 'Delivery Workflow Completion',
            score: 1,
            reason: 'ok',
            error: null,
          },
        ],
      },
    ],
  };
  const previousReport = {
    generatedAt: '2026-07-04T00:00:00.000Z',
    datasetId: 'dataset-1',
    experimentId: 'exp-previous',
    status: 'completed',
    totalItems: 1,
    succeededCount: 1,
    failedCount: 0,
    succeededRate: 0.5,
    scorerAverages: { 'delivery-workflow-completion': 0.5 },
    thresholds: deliveryRegressionGateThresholds,
    mismatches: [{ itemId: 'old', caseId: 'old', scorerId: 'old', expected: 1, actual: 0 }],
    gate: { passed: false, reasons: ['previous mismatch'] },
  };

  const report = buildDeliveryRegressionGateReport({
    datasetId: 'dataset-1',
    summary: summary as never,
    mismatches: [],
    thresholds: { ...deliveryRegressionGateThresholds, minTotalItems: 1 },
    previousReport,
  });

  assert.equal(report.gate.passed, true);
  assert.equal(report.experimentId, 'exp-current');
  assert.deepEqual(report.gate.reasons, []);
  assert.equal(report.trend?.previousExperimentId, 'exp-previous');
  assert.equal(report.trend?.mismatchDelta, -1);
  assert.equal(report.trend?.succeededRateDelta, 0.5);
  assert.equal(report.trend?.scorerAverageDelta['delivery-workflow-completion'], 0.5);
});

test('delivery regression experiment gates scorers through isolated Mastra storage', async (t) => {
  const storageDir = mkdtempSync(join(tmpdir(), 'delivery-eval-gate-'));
  const storage = new LibSQLStore({
    id: 'delivery-eval-gate-storage',
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

  const { dataset, summary, mismatches } = await runDeliveryRegressionExperiment(mastra, {
    name: 'delivery-scorecard-ci-gate',
    description: 'CI gate for delivery scorecard scorers.',
    maxConcurrency: 1,
    itemTimeout: 10_000,
    metadata: { suite: 'delivery-engine', gate: 'ci' },
  });

  assert.equal(summary.status, 'completed');
  assert.equal(summary.totalItems, deliveryRegressionDatasetItems.length);
  assert.equal(summary.succeededCount, deliveryRegressionDatasetItems.length);
  assert.equal(summary.failedCount, 0);
  assert.deepEqual(mismatches, []);
  const report = buildDeliveryRegressionGateReport({ datasetId: dataset.id, summary, mismatches });
  assert.equal(report.gate.passed, true);
  assert.equal(report.thresholds.maxMismatches, 0);
  assert.equal(report.mismatches.length, 0);

  const listed = await mastra.datasets.list({
    filters: { name: deliveryRegressionDatasetName, targetType: 'scorer' },
    perPage: 10,
  });
  assert.equal(listed.datasets.some((dataset) => dataset.name === deliveryRegressionDatasetName), true);
});
