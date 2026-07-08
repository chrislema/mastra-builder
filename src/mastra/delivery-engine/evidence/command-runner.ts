import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compactDiagnostic } from '../agent-runtime/diagnostics';
import { verificationFailureSummaryFromCommandError } from '../implementation-retry-policy';
import { appendDeliveryEventState } from '../state-service';

export const execFileAsync = promisify(execFile);

export function commandFailureSummary(error: unknown, limit = 1000) {
  return verificationFailureSummaryFromCommandError(error, limit);
}

export async function recordRunCodeStart({
  repoPath,
  mastra,
  stage,
  command,
  timeoutMs,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  command: string;
  timeoutMs?: number;
}) {
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'run_code_start',
      stage,
      command,
      timeout_ms: timeoutMs,
      output_summary: `Started ${command}.`,
    },
  });
}

export async function recordRunCodeResult({
  repoPath,
  mastra,
  stage,
  command,
  ok,
  output,
  error,
  outputLimit = 700,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  command: string;
  ok: boolean;
  output?: string;
  error?: string;
  outputLimit?: number;
}) {
  const outputSummary = output ? compactDiagnostic(output, outputLimit) : undefined;
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'run_code',
      stage,
      command,
      ok,
      output_summary: outputSummary,
      error,
    },
  });
  return outputSummary;
}
