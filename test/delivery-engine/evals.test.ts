import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectDeliveryRegressionScoreMismatches,
  deliveryRegressionDatasetItems,
} from '../../src/mastra/delivery-engine/evals.ts';

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
