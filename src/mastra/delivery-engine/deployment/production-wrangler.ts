import { resolve } from 'node:path';
import { compactDiagnostic } from '../agent-runtime/diagnostics';
import {
  productionDeploymentReportFromWranglerResult as productionDeploymentReportFromWranglerResultBase,
  productionWranglerDeployCommand as productionWranglerDeployCommandBase,
  wranglerDeployRevision,
  wranglerDeployUrls,
} from '../build-deployment-policy';
import { commandFailureSummary, execFileAsync, recordRunCodeStart } from '../evidence/command-runner';
import type { ReleaseGateEvidence } from '../evidence/release-gate-evidence';
import type { ReleaseGateProcessCommand } from '../release-gate-probes';
import { appendDeliveryEventState } from '../state-service';
import type { DeploymentReport, ReleaseGate } from '../workflow-schemas';

export function productionWranglerDeployCommand(repoPath: string): ReleaseGateProcessCommand {
  return productionWranglerDeployCommandBase(repoPath);
}

async function productionLiveVerification(urls: string[]): Promise<DeploymentReport['verification'][number]> {
  const url = urls[0];
  if (!url) {
    return {
      check: 'production live URL',
      expected: 'Wrangler deploy completes and emits a live URL when available.',
      actual: 'Wrangler deploy completed; no live URL was parsed from output.',
      passed: true,
    };
  }

  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    const body = compactDiagnostic(await response.text(), 300);
    return {
      check: `GET ${url}`,
      expected: 'Production Worker responds with an HTTP status below 500.',
      actual: `HTTP ${response.status}${body ? `; body ${body}` : ''}`,
      passed: response.status < 500,
    };
  } catch (error) {
    return {
      check: `GET ${url}`,
      expected: 'Production Worker responds with an HTTP status below 500.',
      actual: compactDiagnostic(error, 500),
      passed: false,
    };
  }
}

export function productionDeploymentReportFromWranglerResult({
  runId,
  releaseGate,
  evidence,
  releaseGatePath,
  evidencePath,
  deployCommand,
  deployOk,
  deployOutput,
  deployError,
  liveVerification,
  revision,
}: {
  runId: string;
  releaseGate: ReleaseGate;
  evidence?: ReleaseGateEvidence;
  releaseGatePath: string;
  evidencePath?: string;
  deployCommand: string;
  deployOk: boolean;
  deployOutput?: string;
  deployError?: string;
  liveVerification: DeploymentReport['verification'][number];
  revision?: string;
}): DeploymentReport {
  return productionDeploymentReportFromWranglerResultBase({
    runId,
    releaseGate,
    evidence,
    releaseGatePath,
    evidencePath,
    deployCommand,
    deployOk,
    deployOutput,
    deployError,
    liveVerification,
    revision,
  });
}

export async function runProductionWranglerDeployment({
  repoPath,
  mastra,
  stage,
  runId,
  releaseGate,
  releaseGatePath,
  evidence,
  evidencePath,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  runId: string;
  releaseGate: ReleaseGate;
  releaseGatePath: string;
  evidence?: ReleaseGateEvidence;
  evidencePath?: string;
}) {
  const command = productionWranglerDeployCommand(repoPath);
  await recordRunCodeStart({ repoPath, mastra, stage, command: command.command, timeoutMs: 300_000 });

  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd: resolve(repoPath),
      timeout: 300_000,
      maxBuffer: 2_000_000,
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
        NO_COLOR: '1',
        WRANGLER_SEND_METRICS: 'false',
      },
    });
    const rawOutput = `${result.stdout}\n${result.stderr}`;
    const outputSummary = compactDiagnostic(rawOutput.trim() || 'Wrangler deploy completed.', 1_200);
    const revision = wranglerDeployRevision(rawOutput, runId);
    const urls = wranglerDeployUrls(rawOutput);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'deploy',
        stage,
        target: 'production',
        revision,
        command: command.command,
        ok: true,
        output_summary: outputSummary,
        urls,
      },
    });

    const liveVerification = await productionLiveVerification(urls);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'live_verify',
        stage,
        target: 'production',
        revision,
        command: liveVerification.check,
        ok: liveVerification.passed !== false,
        output_summary: liveVerification.actual,
        urls,
      },
    });

    return productionDeploymentReportFromWranglerResult({
      runId,
      releaseGate,
      evidence,
      releaseGatePath,
      evidencePath,
      deployCommand: command.command,
      deployOk: true,
      deployOutput: outputSummary,
      liveVerification,
      revision,
    });
  } catch (error) {
    const failure = commandFailureSummary(error, 1_200);
    const revision = `production:${runId}`;
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'deploy',
        stage,
        target: 'production',
        revision,
        command: command.command,
        ok: false,
        error: failure,
      },
    });

    const liveVerification: DeploymentReport['verification'][number] = {
      check: 'production live verification',
      expected: 'Production live verification runs after a successful Wrangler deploy.',
      actual: 'Skipped because the Wrangler deploy command failed.',
      passed: false,
    };

    return productionDeploymentReportFromWranglerResult({
      runId,
      releaseGate,
      evidence,
      releaseGatePath,
      evidencePath,
      deployCommand: command.command,
      deployOk: false,
      deployError: failure,
      liveVerification,
      revision,
    });
  }
}
