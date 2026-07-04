import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  buildDeliveryRegressionGateReport,
  runDeliveryRegressionExperiment,
  type DeliveryRegressionGateReport,
} from '../src/mastra/delivery-engine/evals';
import { deliveryScorers } from '../src/mastra/delivery-engine/scorers';

function readPreviousReport(path?: string): DeliveryRegressionGateReport | undefined {
  if (!path || !existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as DeliveryRegressionGateReport;
}

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

try {
  const { dataset, summary, mismatches } = await runDeliveryRegressionExperiment(mastra, {
    name: process.env.DELIVERY_EVAL_NAME ?? `delivery-scorecard-ci-gate-${new Date().toISOString()}`,
    description: 'CI gate for delivery scorecard scorers.',
    failOnMismatch: false,
    maxConcurrency: 1,
    itemTimeout: Number(process.env.DELIVERY_EVAL_ITEM_TIMEOUT_MS ?? 10_000),
    metadata: { suite: 'delivery-engine', gate: 'ci' },
  });
  const report = buildDeliveryRegressionGateReport({
    datasetId: dataset.id,
    summary,
    mismatches,
    previousReport: readPreviousReport(process.env.DELIVERY_EVAL_BASELINE),
  });
  const json = JSON.stringify(report, null, 2);

  if (process.env.DELIVERY_EVAL_REPORT) {
    mkdirSync(dirname(process.env.DELIVERY_EVAL_REPORT), { recursive: true });
    writeFileSync(process.env.DELIVERY_EVAL_REPORT, json);
  }

  console.log(json);
  if (!report.gate.passed) process.exitCode = 1;
} finally {
  await mastra.shutdown();
  await storage.close();
  rmSync(storageDir, { recursive: true, force: true });
}
