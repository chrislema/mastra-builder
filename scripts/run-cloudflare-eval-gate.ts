import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  buildCloudflareArchitectureGateReport,
  runCloudflareArchitectureExperiment,
  type CloudflareArchitectureGateReport,
} from '../src/mastra/delivery-engine/cloudflare-evals';
import { deliveryScorers } from '../src/mastra/delivery-engine/scorers';

function readPreviousReport(path?: string): CloudflareArchitectureGateReport | undefined {
  if (!path || !existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as CloudflareArchitectureGateReport;
}

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

try {
  const { dataset, summary, mismatches } = await runCloudflareArchitectureExperiment(mastra, {
    name: process.env.CLOUDFLARE_EVAL_NAME ?? `cloudflare-architecture-ci-gate-${new Date().toISOString()}`,
    description: 'CI gate for Cloudflare architecture scorers.',
    failOnMismatch: false,
    maxConcurrency: 1,
    itemTimeout: Number(process.env.CLOUDFLARE_EVAL_ITEM_TIMEOUT_MS ?? 10_000),
    metadata: { suite: 'delivery-engine', gate: 'ci' },
  });
  const report = buildCloudflareArchitectureGateReport({
    datasetId: dataset.id,
    summary,
    mismatches,
    previousReport: readPreviousReport(process.env.CLOUDFLARE_EVAL_BASELINE),
  });
  const json = JSON.stringify(report, null, 2);

  if (process.env.CLOUDFLARE_EVAL_REPORT) {
    mkdirSync(dirname(process.env.CLOUDFLARE_EVAL_REPORT), { recursive: true });
    writeFileSync(process.env.CLOUDFLARE_EVAL_REPORT, json);
  }

  console.log(json);
  if (!report.gate.passed) process.exitCode = 1;
} finally {
  await mastra.shutdown();
  await storage.close();
  rmSync(storageDir, { recursive: true, force: true });
}
