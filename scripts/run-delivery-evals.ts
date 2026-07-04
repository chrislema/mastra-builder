import { mastra } from '../src/mastra/index';
import { runDeliveryRegressionExperiment } from '../src/mastra/delivery-engine/evals';

const { dataset, summary, mismatches } = await runDeliveryRegressionExperiment(mastra, {
  failOnMismatch: false,
});

console.log(
  JSON.stringify(
    {
      datasetId: dataset.id,
      experimentId: summary.experimentId,
      status: summary.status,
      totalItems: summary.totalItems,
      succeededCount: summary.succeededCount,
      failedCount: summary.failedCount,
      mismatches,
    },
    null,
    2,
  ),
);

if (mismatches.length) {
  process.exitCode = 1;
}
