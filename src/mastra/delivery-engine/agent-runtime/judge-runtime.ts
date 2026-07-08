import { createDeliveryControlRequestContext } from '../context';
import {
  aggregateJudgment,
  buildJudgeArtifactPrompt,
  deterministicCheckNameForGate,
  judgeOutputSchemaForRubric,
  loadDeliveryEngineRubric,
  type DeterministicGateResult,
  type JudgeOutput,
  type Rubric,
} from '../judgment';
import { deliveryRunMemory } from '../memory';
import { deliveryStructuredOutputOptions } from '../models';
import { writeDeliveryArtifact } from '../state';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  recordDeliveryJudgmentState,
  startDeliveryStageState,
} from '../state-service';
import { parseDeliveryStructuredOutput } from '../structured-output';
import type { JudgmentRef } from '../workflow-schemas';
import { compactDiagnostic } from './diagnostics';
import { deliveryAgentTimeouts, requiredAgent, structuredNoToolOptions } from './options';
import { DeliveryStageTimeoutError, runWithDeliveryStageTimeout } from './stage-timeout';
import { serializeAgentResponse, writeStageTraceArtifact } from './trace-artifacts';

export type JudgeProviderErrorDetails = {
  name: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
  code?: string;
  url?: string;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function stringProperty(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberProperty(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function judgeProviderErrorDetails(error: unknown): JudgeProviderErrorDetails | undefined {
  if (error instanceof DeliveryStageTimeoutError) return undefined;

  const record = objectValue(error);
  const dataError = objectValue(objectValue(record?.data)?.error);
  const name = error instanceof Error ? error.name : stringProperty(record, 'name') ?? 'Error';
  const message = compactDiagnostic(error, 300);
  const statusCode = numberProperty(record, 'statusCode') ?? numberProperty(record, 'status');
  const code = stringProperty(dataError, 'code') ?? stringProperty(record, 'code');
  const url = stringProperty(record, 'url');
  const retryable =
    record?.isRetryable === true ||
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 425 ||
    statusCode === 429 ||
    (typeof statusCode === 'number' && statusCode >= 500) ||
    /\b(overloaded|temporarily unavailable|try again later|rate.?limit|timeout|timed out)\b/i.test(message);
  const providerShaped =
    /\bAI_?APICallError\b|\bAPICallError\b/i.test(name) ||
    typeof statusCode === 'number' ||
    Boolean(url && /\/chat\/completions\b/.test(url));

  if (!providerShaped) return undefined;
  return { name, message, retryable, statusCode, code, url };
}

function judgeProviderEvidence(stage: string, details: JudgeProviderErrorDetails) {
  const status = details.statusCode ? ` status ${details.statusCode}` : '';
  const code = details.code ? ` code ${details.code}` : '';
  const retry = details.retryable ? 'retryable provider error' : 'provider error';
  return `${stage} unavailable: ${details.name}${status}${code}; ${retry}; ${details.message}`;
}

export function judgeUnavailableRemediation(stage: string, details: JudgeProviderErrorDetails) {
  const action = details.retryable
    ? 'Retry the delivery run; no target-code change is implied by this judge outage.'
    : 'Fix the judge model configuration or provider access, then rerun delivery.';
  return `JUDGE_UNAVAILABLE ${stage}: ${judgeProviderEvidence(stage, details)}. ${action}`;
}

export function judgeUnavailableOutputForRubric({
  rubric,
  details,
  stage,
}: {
  rubric: Rubric;
  details: JudgeProviderErrorDetails;
  stage: string;
}): JudgeOutput {
  const evidence = judgeProviderEvidence(stage, details);
  return {
    gates: (rubric.gates ?? [])
      .filter((gate) => !deterministicCheckNameForGate(gate))
      .map((gate) => ({
        id: gate.id,
        passed: false,
        evidence,
      })),
    dimensions: (rubric.dimensions ?? []).map((dimension) => ({
      id: dimension.id,
      score: null,
      evidence,
      not_scored_reason: details.retryable ? 'retryable_judge_provider_error' : 'judge_provider_error',
    })),
  };
}

export async function judgeDeliveryArtifact({
  mastra,
  repoPath,
  runId,
  rubricName,
  subjectName,
  subject,
  deterministicResults = [],
  slug,
}: {
  mastra: any;
  repoPath: string;
  runId: string;
  rubricName: string;
  subjectName: string;
  subject: unknown;
  deterministicResults?: DeterministicGateResult[];
  slug: string;
}) {
  await startDeliveryStageState({
    repoPath,
    stage: `judge:${slug}`,
    role: 'judge',
    mastra,
  });

  const judge = requiredAgent(mastra, 'judge');
  const rubric = loadDeliveryEngineRubric(rubricName);
  const rubricJudgeOutputSchema = judgeOutputSchemaForRubric(rubric);
  const prompt = buildJudgeArtifactPrompt({
    rubric,
    subjectName,
    subject,
    deterministicResults,
  });
  const stage = `judge:${slug}`;
  let response: unknown;
  let judgeOutput: JudgeOutput;
  let providerFailureRemediation: string | undefined;

  try {
    response = await runWithDeliveryStageTimeout({
      repoPath,
      mastra,
      stage,
      timeoutMs: deliveryAgentTimeouts.judge,
      operation: (abortSignal) =>
        judge.generate(
          prompt,
          {
            ...structuredNoToolOptions,
            abortSignal,
            memory: deliveryRunMemory({ repoPath, runId, role: 'judge' }),
            requestContext: createDeliveryControlRequestContext(repoPath),
            structuredOutput: {
              schema: rubricJudgeOutputSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only the judge gates and dimensions. Do not compute aggregate scores.',
            },
          },
        ),
    });
    judgeOutput = parseDeliveryStructuredOutput(rubricJudgeOutputSchema, response, `${subjectName} judge`);
  } catch (error) {
    const details = judgeProviderErrorDetails(error);
    if (!details) throw error;

    providerFailureRemediation = judgeUnavailableRemediation(stage, details);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'judge_unavailable',
        stage,
        role: 'judge',
        ok: false,
        retryable: details.retryable,
        status_code: details.statusCode,
        code: details.code,
        error: details.message,
      },
    }).catch(() => undefined);

    response = {
      object: { judgeUnavailable: details },
      finishReason: 'error',
    };
    judgeOutput = judgeUnavailableOutputForRubric({ rubric, details, stage });
  }

  const parsedJudgeOutput = rubricJudgeOutputSchema.parse(judgeOutput);
  if (providerFailureRemediation) {
    parsedJudgeOutput.gates = parsedJudgeOutput.gates.map((gate) => ({
      ...gate,
      evidence: providerFailureRemediation,
    }));
    parsedJudgeOutput.dimensions = parsedJudgeOutput.dimensions.map((dimension) => ({
      ...dimension,
      evidence: providerFailureRemediation,
    }));
  }
  const judgeOutputPath = `.delivery/artifacts/judgments/${slug}.judge.json`;
  writeDeliveryArtifact({
    repoPath,
    artifactPath: judgeOutputPath,
    artifact: parsedJudgeOutput,
  });

  const judgment = aggregateJudgment({
    rubric,
    judgeOutput: parsedJudgeOutput,
    deterministicResults,
  });
  if (providerFailureRemediation) {
    judgment.remediation = [
      providerFailureRemediation,
      ...judgment.remediation.filter((item) => item !== providerFailureRemediation),
    ];
  }
  const judgmentPath = `.delivery/artifacts/judgments/${slug}.judgment.json`;
  writeDeliveryArtifact({
    repoPath,
    artifactPath: judgmentPath,
    artifact: judgment,
  });
  const tracePath = await writeStageTraceArtifact({
    repoPath,
    mastra,
    artifactType: `trace-judge-${slug}`,
    artifactPath: `.delivery/artifacts/traces/judge-${slug}.json`,
    trace: {
      artifact_type: 'agent-turn-trace',
      stage: `judge:${slug}`,
      role: 'judge',
      subject: subjectName,
      prompt,
      response: serializeAgentResponse(response),
      deterministicResults,
      judgeOutputPath,
      judgmentPath,
      judgment,
    },
  });
  await recordDeliveryJudgmentState({
    repoPath,
    subject: subjectName,
    rubric: judgment.rubric,
    path: judgmentPath,
    overall: judgment.overall,
    passed: judgment.passed,
    mastra,
  });

  await endDeliveryStageState({
    repoPath,
    stage: `judge:${slug}`,
    reason: judgment.passed ? 'complete_stage' : 'escalation',
    mastra,
  });

  const ref: JudgmentRef = {
    subject: subjectName,
    rubric: judgment.rubric,
    path: judgmentPath,
    overall: judgment.overall,
    passed: judgment.passed,
  };

  return {
    judgeOutputPath,
    judgmentPath,
    tracePath,
    judgment,
    ref,
  };
}
