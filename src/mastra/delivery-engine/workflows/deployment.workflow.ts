import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  finishDeliveryRunState,
  readDeliveryEventsState,
  recordDeliveryArtifactState,
  startDeliveryStageState,
} from '../state-service';
import { writeDeliveryArtifact, type DeliveryRunStatus } from '../state';
import type { DeterministicGateResult } from '../judgment';
import { deliveryDeploymentStepScorers } from '../scorers';
import { safePersistDeliveryStateWithMastra } from '../observability';
import { markDeliveryRunFailedOnWorkflowError } from '../workflow-support/errors';
import {
  syncDeploymentReportStateStep,
  syncFinalDeliveryStateStep,
} from '../workflow-support/state-sync';
import {
  deliveryStageOutputSchema,
  deliveryWorkflowStateSchema,
  deploymentApprovalResumeSchema,
  deploymentApprovalSuspendSchema,
  deploymentReportStageSchema,
  workflowOutputSchema,
  type CheckSummary,
} from '../workflow-schemas';
import {
  deploymentReportSuccessNextSteps,
  latestArtifactPath,
  latestReleaseGateEvidencePath,
  localDeploymentReportFromReleaseGateEvidence,
  readReleaseGateEvidenceArtifact,
} from '../deployment/local-report';
import {
  deploymentDeterministicResults,
  deploymentGateFailureNextSteps,
} from '../deployment/deployment-gate';
import { runProductionWranglerDeployment } from '../deployment/production-wrangler';

const checkSummaries = (results: DeterministicGateResult[], suffix?: string): CheckSummary[] =>
  results.map((check) => ({
    check: `${check.check ?? check.id ?? 'unknown'}${suffix ? `:${suffix}` : ''}`,
    passed: check.passed,
    reason: check.reason ?? 'deterministic check',
  }));

const createDeploymentReportStep = createStep({
  id: 'create-deployment-report',
  description: 'Run the native deployment stage from a passing release gate and write the deployment report artifact.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deploymentReportStageSchema,
  resumeSchema: deploymentApprovalResumeSchema,
  suspendSchema: deploymentApprovalSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend }) => {
    if (inputData.status !== 'release_ready') return inputData;
    if (!inputData.releaseGate) throw new Error('release gate stage did not provide a gate for deployment');

    const artifacts = [...inputData.artifacts];
    const stage = 'deploy';
    const releaseGatePath = latestArtifactPath(artifacts, 'release-gate', '.delivery/artifacts/release-gate.json');
    const evidencePath = latestReleaseGateEvidencePath(artifacts);

    if (inputData.deployMode === 'production' && !resumeData) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'human_input_required',
          stage: 'deploy:approval',
          artifact_type: 'release-gate',
          path: releaseGatePath,
        },
      });

      return await suspend(
        {
          reason: 'Production deployment requires human approval before the native Wrangler deploy command runs.',
          deployMode: 'production' as const,
          releaseGatePath,
          releaseGateSummary: inputData.releaseGate.summary,
          blockers: inputData.releaseGate.blockers,
          nextSteps: inputData.nextSteps,
        },
        { resumeLabel: 'approve-production-deployment' },
      );
    }

    if (inputData.deployMode === 'production' && resumeData?.approved === false) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'human_approval',
          stage: 'deploy:approval',
          approved: false,
          approver: resumeData.approver,
          note: resumeData.notes,
        },
      });

      return {
        ...inputData,
        status: 'failed' as const,
        summary: 'Production deployment was rejected by human approval.',
        nextSteps: resumeData.notes ? [resumeData.notes] : ['Deployment rejected before any production deploy command ran.'],
      };
    }

    if (inputData.deployMode === 'production' && resumeData?.approved) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'human_approval',
          stage: 'deploy:approval',
          approved: true,
          approver: resumeData.approver,
          note: resumeData.notes,
        },
      });
    }

    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      role: 'deployer',
      mastra,
    });
    await appendDeliveryEventState({
      repoPath: inputData.repoPath,
      mastra,
      event: {
        type: 'artifact_read',
        stage,
        artifact_type: 'release-gate',
        path: releaseGatePath,
      },
    });

    if (inputData.deployMode === 'local') {
      const evidence = readReleaseGateEvidenceArtifact(inputData.repoPath, artifacts);
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'deploy',
          stage,
          target: 'local',
          revision: `local:${inputData.runId}`,
          command: 'local release gate accepted; no production Wrangler deploy executed',
          ok: true,
        },
      });
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'live_verify',
          stage,
          target: 'local',
          revision: `local:${inputData.runId}`,
          artifact_type: 'test-evidence',
          path: evidencePath,
          ok: inputData.releaseGate.decision === 'pass' && inputData.releaseGate.blockers.length === 0,
          output_summary: evidencePath
            ? `Local verification reused passing release-gate evidence from ${evidencePath}.`
            : 'Local verification reused the passing release gate; no separate evidence artifact was found.',
        },
      });

      const report = localDeploymentReportFromReleaseGateEvidence({
        runId: inputData.runId,
        releaseGate: inputData.releaseGate,
        evidence,
        releaseGatePath,
        evidencePath,
      });
      const reportPath = '.delivery/artifacts/deployment-report.json';
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: reportPath,
        artifact: report,
      });
      await recordDeliveryArtifactState({
        repoPath: inputData.repoPath,
        type: 'deployment-report',
        path: reportPath,
        mastra,
      });
      artifacts.push(reportPath);

      await endDeliveryStageState({
        repoPath: inputData.repoPath,
        stage,
        reason: 'complete_stage',
        mastra,
      });

      return {
        ...inputData,
        artifacts,
        deploymentReport: report,
        deploymentReportPath: reportPath,
      };
    }

    const evidence = readReleaseGateEvidenceArtifact(inputData.repoPath, artifacts);
    const report = await runProductionWranglerDeployment({
      repoPath: inputData.repoPath,
      mastra,
      stage,
      runId: inputData.runId,
      releaseGate: inputData.releaseGate,
      releaseGatePath,
      evidence,
      evidencePath,
    });
    const reportPath = '.delivery/artifacts/deployment-report.json';
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: reportPath,
      artifact: report,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'deployment-report',
      path: reportPath,
      mastra,
    });
    artifacts.push(reportPath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      reason: 'complete_stage',
      mastra,
    });

    return {
      ...inputData,
      artifacts,
      deploymentReport: report,
      deploymentReportPath: reportPath,
    };
  },
});

const createDeploymentCompletionGateStep = createStep({
  id: 'gate-deployment-report',
  description: 'Run deterministic deployment completion gates, then finish the delivery run.',
  inputSchema: deploymentReportStageSchema,
  outputSchema: workflowOutputSchema,
  scorers: deliveryDeploymentStepScorers,
  execute: async ({ inputData, mastra }) => {
    const finishRun = async (status: DeliveryRunStatus) => {
      await finishDeliveryRunState({ repoPath: inputData.repoPath, status, mastra });
      await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    };

    const baseOutput = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
    });

    if (inputData.status === 'gate_failed') {
      await finishRun('failed');
      return {
        ...baseOutput(),
        status: 'failed' as const,
        nextSteps: inputData.nextSteps.length ? inputData.nextSteps : ['Fix release gate blockers before deployment.'],
      };
    }

    if (inputData.status === 'stuck') {
      await finishRun('stuck');
      return baseOutput();
    }

    if (inputData.status === 'failed') {
      await finishRun('failed');
      return baseOutput();
    }

    if (inputData.status !== 'release_ready') return baseOutput();
    if (!inputData.releaseGate) throw new Error('release gate stage did not provide a gate for deployment completion');
    if (!inputData.deploymentReport || !inputData.deploymentReportPath) {
      throw new Error('deployment report stage did not provide a deployment report for completion');
    }

    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];
    const stage = 'deploy';
    const deliveryEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const deterministicResults = deploymentDeterministicResults({
      stage,
      releaseGate: inputData.releaseGate,
      events: deliveryEvents,
    });
    checks.push(...checkSummaries(deterministicResults, 'deployment'));

    const failedDeploymentChecks = deterministicResults.filter((result) => !result.passed);
    const complete = inputData.deploymentReport.result === 'success' && failedDeploymentChecks.length === 0;
    await appendDeliveryEventState({
      repoPath: inputData.repoPath,
      mastra,
      event: {
        type: 'deployment_gate_result',
        stage,
        gate: 'deployment',
        artifact_type: 'deployment-report',
        path: inputData.deploymentReportPath,
        result: inputData.deploymentReport.result,
        passed: complete,
        checks: deterministicResults.map((result) => ({
          id: result.id,
          check: result.check,
          passed: result.passed,
          reason: result.reason,
        })),
      },
    }).catch(() => undefined);

    await finishRun(complete ? 'complete' : 'failed');

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      status: complete ? ('complete' as const) : ('failed' as const),
      runId: inputData.runId,
      summary: complete
        ? `Deployment complete: ${inputData.deploymentReport.environment} ${inputData.deploymentReport.revision}`
        : 'Deployment failed deterministic completion gates or reported failure.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: complete
        ? deploymentReportSuccessNextSteps(inputData.deploymentReport, inputData.repoPath)
        : deploymentGateFailureNextSteps({
            report: inputData.deploymentReport,
            failedChecks: failedDeploymentChecks,
          }),
    };
  },
});

export const deliveryDeploymentWorkflow = createWorkflow({
  id: 'delivery-deployment',
  description: 'Run local or approved production deployment, gate deployment evidence, and finish the run.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(createDeploymentReportStep)
  .then(syncDeploymentReportStateStep)
  .then(createDeploymentCompletionGateStep)
  .then(syncFinalDeliveryStateStep)
  .commit();
