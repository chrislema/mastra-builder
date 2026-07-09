import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  buildDeliveryRegressionCoverageReport,
  buildDeliveryRegressionGateReport,
  collectDeliveryRegressionScoreMismatches,
  deliveryRegressionDatasetItems,
  deliveryRegressionDatasetName,
  deliveryRegressionGateThresholds,
  deliveryRegressionScorerIds,
  runDeliveryRegressionExperiment,
} from '../../src/mastra/delivery-engine/evals.ts';
import { deliveryScorers } from '../../src/mastra/delivery-engine/scorers.ts';

test('delivery regression fixtures carry expected score labels', () => {
  assert.equal(deliveryRegressionDatasetItems.length >= 8, true);
  assert.equal(deliveryRegressionDatasetItems.every((item) => item.groundTruth.caseId === item.metadata.caseId), true);
  assert.equal(
    deliveryRegressionDatasetItems.every((item) =>
      deliveryRegressionScorerIds.every((scorerId) => typeof item.groundTruth.expectedScores[scorerId] === 'number'),
    ),
    true,
  );
});

test('delivery regression fixtures cover every scorer with positive and negative examples', () => {
  const summary = {
    results: deliveryRegressionDatasetItems.map((item, index) => ({
      itemId: `item-${index}`,
      input: item.input,
      groundTruth: item.groundTruth,
      scores: deliveryRegressionScorerIds.map((scorerId) => ({
        scorerId,
        scorerName: scorerId,
        score: item.groundTruth.expectedScores[scorerId],
        reason: 'fixture',
        error: null,
      })),
    })),
  };

  const coverage = buildDeliveryRegressionCoverageReport(summary as never);

  assert.equal(coverage.totalScorers, deliveryRegressionScorerIds.length);
  assert.equal(coverage.coveredScorers, deliveryRegressionScorerIds.length);
  assert.deepEqual(coverage.missingScorers, []);
  assert.equal(coverage.totalExpectations, deliveryRegressionDatasetItems.length * deliveryRegressionScorerIds.length);
  assert.equal(coverage.scorerCoverage.every((item) => item.positiveExamples > 0 && item.negativeExamples > 0), true);
});

test('delivery regression mismatch collector compares experiment scores to ground truth', () => {
  const item = deliveryRegressionDatasetItems.find((fixture) => fixture.metadata.caseId === 'complete-delivery');
  assert.ok(item);
  const summary = {
    results: [
      {
        itemId: 'item-1',
        input: item.input,
        groundTruth: item.groundTruth,
        scores: deliveryRegressionScorerIds.map((scorerId) => ({
          scorerId,
          scorerName: scorerId,
          score: scorerId === 'delivery-rubric-floor' ? 0.5 : item.groundTruth.expectedScores[scorerId],
          reason: scorerId === 'delivery-rubric-floor' ? 'too low' : 'ok',
          error: null,
        })),
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
  const summary = {
    experimentId: 'exp-current',
    status: 'completed',
    totalItems: deliveryRegressionDatasetItems.length,
    succeededCount: deliveryRegressionDatasetItems.length,
    failedCount: 0,
    persistenceFailures: 0,
    results: deliveryRegressionDatasetItems.map((fixture, index) => ({
      itemId: `item-${index}`,
      input: fixture.input,
      groundTruth: fixture.groundTruth,
      scores: deliveryRegressionScorerIds.map((scorerId) => ({
        scorerId,
        scorerName: scorerId,
        score: fixture.groundTruth.expectedScores[scorerId],
        reason: 'ok',
        error: null,
      })),
    })),
  };
  const workflowCompletionAverage = Math.round((1 / deliveryRegressionDatasetItems.length) * 1000) / 1000;
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
    scorerAverages: { 'delivery-workflow-completion': 0 },
    coverage: {
      totalScorers: 1,
      coveredScorers: 1,
      missingScorers: [],
      totalExpectations: 1,
      scorerCoverage: [
        {
          scorerId: 'delivery-workflow-completion',
          expectedItems: 1,
          scoredItems: 1,
          positiveExamples: 1,
          negativeExamples: 1,
          missingScoreCaseIds: [],
        },
      ],
    },
    thresholds: deliveryRegressionGateThresholds,
    gateResults: [],
    thresholdResults: [],
    verdict: 'scored' as const,
    mismatches: [{ itemId: 'old', caseId: 'old', scorerId: 'old', expected: 1, actual: 0 }],
    gate: { passed: false, reasons: ['previous mismatch'] },
  };

  const report = buildDeliveryRegressionGateReport({
    datasetId: 'dataset-1',
    summary: summary as never,
    mismatches: [],
    thresholds: deliveryRegressionGateThresholds,
    previousReport,
  });

  assert.equal(report.gate.passed, true);
  assert.equal(report.verdict, 'passed');
  assert.equal(report.experimentId, 'exp-current');
  assert.deepEqual(report.gate.reasons, []);
  assert.equal(report.gateResults.every((result) => result.passed), true);
  assert.equal(report.thresholdResults.every((result) => result.passed), true);
  assert.equal(report.coverage.coveredScorers, deliveryRegressionScorerIds.length);
  assert.equal(report.trend?.previousExperimentId, 'exp-previous');
  assert.equal(report.trend?.mismatchDelta, -1);
  assert.equal(report.trend?.succeededRateDelta, 0.5);
  assert.equal(report.trend?.scorerAverageDelta['delivery-workflow-completion'], workflowCompletionAverage);
});

test('delivery regression gate report distinguishes failed gates from scored thresholds', () => {
  const item = deliveryRegressionDatasetItems[0];
  const baseSummary = {
    experimentId: 'exp-current',
    status: 'completed',
    totalItems: deliveryRegressionDatasetItems.length,
    succeededCount: deliveryRegressionDatasetItems.length,
    failedCount: 0,
    persistenceFailures: 0,
    results: deliveryRegressionDatasetItems.map((fixture, index) => ({
      itemId: `item-${index}`,
      input: fixture.input,
      groundTruth: fixture.groundTruth,
      scores: deliveryRegressionScorerIds.map((scorerId) => ({
        scorerId,
        scorerName: scorerId,
        score: fixture.groundTruth.expectedScores[scorerId],
        reason: 'ok',
        error: null,
      })),
    })),
  };

  const scoredReport = buildDeliveryRegressionGateReport({
    datasetId: 'dataset-1',
    summary: { ...baseSummary, succeededCount: deliveryRegressionDatasetItems.length - 1 } as never,
    mismatches: [],
    thresholds: deliveryRegressionGateThresholds,
  });
  assert.equal(scoredReport.verdict, 'scored');
  assert.equal(scoredReport.gate.passed, false);
  assert.equal(scoredReport.gateResults.every((result) => result.passed), true);
  assert.equal(scoredReport.thresholdResults.some((result) => !result.passed), true);

  const failedReport = buildDeliveryRegressionGateReport({
    datasetId: 'dataset-1',
    summary: { ...baseSummary, status: 'failed', results: [baseSummary.results[0]], totalItems: 1 } as never,
    mismatches: [{ itemId: 'item-1', caseId: item.groundTruth.caseId, scorerId: 'delivery-workflow-completion', expected: 1, actual: 0 }],
    thresholds: deliveryRegressionGateThresholds,
  });
  assert.equal(failedReport.verdict, 'failed');
  assert.equal(failedReport.gateResults.some((result) => !result.passed), true);
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
  assert.equal(report.verdict, 'passed');
  assert.equal(report.thresholds.maxMismatches, 0);
  assert.equal(report.mismatches.length, 0);
  assert.equal(report.coverage.missingScorers.length, 0);
  assert.equal(report.gateResults.every((result) => result.passed), true);
  assert.equal(report.thresholdResults.every((result) => result.passed), true);

  const listed = await mastra.datasets.list({
    filters: { name: deliveryRegressionDatasetName, targetType: 'scorer' },
    perPage: 10,
  });
  assert.equal(listed.datasets.some((dataset) => dataset.name === deliveryRegressionDatasetName), true);

  const scoresStore = await storage.getStore('scores');
  assert.ok(scoresStore, 'Mastra scores storage must be available for eval score read-back');
  for (const scorerId of deliveryRegressionScorerIds) {
    const listedScores = await scoresStore.listScoresByScorerId({
      scorerId,
      pagination: { page: 0, perPage: 100 },
    });
    assert.equal(listedScores.scores.length, deliveryRegressionDatasetItems.length, `${scorerId} score rows`);
    assert.equal(listedScores.scores.every((score) => score.source === 'TEST'), true);
    assert.equal(listedScores.scores.every((score) => score.scorerId === scorerId), true);
    assert.equal(listedScores.scores.every((score) => typeof score.reason === 'string' && score.reason.length > 0), true);
  }
});
