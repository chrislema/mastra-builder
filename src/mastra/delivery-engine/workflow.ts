import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  readDeliveryEventsState,
  initializeDeliveryRunState,
  readDeliveryRunState,
  recordDeliveryArtifactState,
  recordDeliveryJudgmentState,
  startDeliveryStageState,
  updateDeliveryTaskState,
  finishDeliveryRunState,
} from './state-service';
import { readDeliveryEvents, writeDeliveryArtifact, type DeliveryRunStatus } from './state';
import {
  normalizeDeliveryPathReference,
  runDeterministicCheck,
  type DeliveryEvent,
} from './checks';
import { createDeliveryControlRequestContext, createDeliveryRequestContext } from './context';
import { deliveryRunMemory } from './memory';
import type { AggregatedJudgment, DeterministicGateResult } from './judgment';
import {
  deliveryBuildStepScorers,
  deliveryDeploymentStepScorers,
  deliveryPlanStepScorers,
  deliveryReleaseGateStepScorers,
  deliveryReviewStepScorers,
  deliveryScaffoldStepScorers,
} from './scorers';
import { safePersistDeliveryStateWithMastra } from './observability';
import { deliveryStructuredOutputOptions } from './models';
import { parseDeliveryStructuredOutput } from './structured-output';
import {
  deliveryWorkflowInputSchema,
  normalizeDeliveryWorkflowInput,
} from './run-input';
import { markDeliveryRunFailedOnWorkflowError } from './workflow-support/errors';
import {
  syncBuildStateStep,
  syncDeliveryWorkflowState,
  syncDeploymentReportStateStep,
  syncFinalDeliveryStateStep,
  syncPlanStateStep,
  syncReleaseGateStateStep,
  syncReviewStateStep,
} from './workflow-support/state-sync';
import { compactDiagnostic } from './agent-runtime/diagnostics';
import {
  judgeDeliveryArtifact,
  judgeProviderErrorDetails,
  judgeUnavailableOutputForRubric,
  judgeUnavailableRemediation,
} from './agent-runtime/judge-runtime';
import {
  deliveryAgentTimeouts,
  requiredAgent,
  structuredNoToolOptions,
} from './agent-runtime/options';
import {
  latestSuccessfulWorkspaceWriteEventTimestamp,
  readBudgetBlockedToolCount,
  runWithDeliveryStageTimeout,
} from './agent-runtime/stage-timeout';
import {
  normalizeReadoutSafeAdapterAmbiguities,
  openDecisionHygiene,
  shouldSuspendForPlannerQuestions,
} from './planning/readout-policy';
import {
  preserveTaskPlanAcceptanceContracts,
  taskPlanAcceptanceContractRegression,
} from './planning/acceptance-contract-preservation';
import { generatedSliceDependencyHygiene } from './planning/generated-slice-policy';
import { taskPlanDeterministicResults } from './planning/task-plan-gates';
import { pagesFunctionsExceptionHygiene } from './planning/pages-policy';
import { ownedSurfaceHygiene } from './planning/owned-surface-policy';
import { taskOwnedSurfaceRoleHygiene } from './planning/role-boundary-policy';
import { routeBoundaryConsistencyHygiene } from './planning/route-boundary-policy';
import { configSchemaTaskSplitHygiene } from './planning/config-schema-policy';
import { operatorDocumentationHygiene } from './planning/operator-documentation-policy';
import { profileContractDependencyHygiene } from './planning/profile-contract-policy';
import { normalizeTaskPlanForDelivery } from './planning/task-plan-normalizer';
import { parsePlannerRevisionResponse, planGateRevisionRemediation } from './planning/task-plan-revision';
import {
  legacyProjectScaffoldHygiene,
  projectScaffoldHygiene,
} from './planning/scaffold-policy';
import {
  currentWorkerCompatibilityDate,
} from './implementation/task-boundaries';
import {
  lifecycleStatusSchemaGaps,
  profileKindContractGaps,
  profileKindTaskPacketPolicy,
  routeMiddlewareBypassGaps,
  workflowEntrypointImportGaps,
  workflowStepIntegrationGaps,
} from './implementation/deterministic-gates';
import {
  deliveryBuildResumePlan,
  deliveryBuildResumeReason,
  implementationFilesTouched,
  priorStoppedBuildTaskIds,
  reusableImplementationArtifactForTask,
} from './implementation/reusable-artifacts';
import {
  implementationActionableJudgmentRemediation,
  implementationWeakDimensionRemediation,
  shouldProceedAfterNonActionableImplementationJudgment,
} from './implementation/judgment-policy';
import {
  acceptanceContractsForTask,
  verificationWithAcceptanceGaps,
} from './implementation/evidence';
import {
  implementationFailureClass,
  implementationRetryMode,
  implementationToolChoiceForRetryMode,
  outOfPlanVerificationFailurePaths,
  repairStaleDownstreamVerificationSurfaces,
  repairStaleOutOfPlanVerificationSurfaces,
  repairUnknownNumberIntegerNarrowing,
  staleDownstreamVerificationSurfacePaths,
  staleOutOfPlanVerificationSurfacePaths,
  typeScriptDiagnosticsFromRemediation,
  typeScriptDiagnosticsFromText,
} from './implementation/retry-runtime';
import { runBuildTaskAttempt } from './implementation/build-task-runner';
import { repoFileContents } from './repo-files';
import { annotateTaskPlanWithTypedMetadata } from './task-plan-metadata';
import { taskPacketRailsForTask } from './task-packet-rails';
import {
  buildTaskAttemptStateSchema,
  buildTaskResultSchema,
  buildTaskResultsSchema,
  buildTaskWorkItemsSchema,
  buildTaskWorkItemSchema,
  deliveryStageOutputSchema,
  deliveryWorkflowStateSchema,
  deploymentApprovalResumeSchema,
  deploymentApprovalSuspendSchema,
  deploymentReportStageSchema,
  initializedSchema,
  plannerArtifactsSchema,
  plannerCacheSchema,
  plannerOutputSchema,
  plannerQuestionsResumeSchema,
  plannerQuestionsSuspendSchema,
  plannerRevisionOutputSchema,
  planStageOutputSchema,
  readoutSchema,
  releaseGateLoopStateSchema,
  releaseGateSchema,
  reviewFindingsSchema,
  reviewLoopStateSchema,
  reviewReportSchema,
  taskPlanSchema,
  workflowOutputSchema,
  type CheckSummary,
  type DeliveryWorkflowState,
  type JudgmentRef,
  type Readout,
  type ReleaseGate,
  type ReviewReport,
  type SourcePolicy,
  type Task,
  type TaskPlan,
} from './workflow-schemas';
import { synthesizeReleaseGateFromEvidence } from './release-gate-synthesis';
import { releaseGateDeterministicResults } from './release-gate-policy';
import {
  deploymentReportSuccessNextSteps,
  latestArtifactPath,
  latestReleaseGateEvidencePath,
  localDeploymentReportFromReleaseGateEvidence,
  readReleaseGateEvidenceArtifact,
} from './deployment/local-report';
import { deploymentDeterministicResults, deploymentGateFailureNextSteps } from './deployment/deployment-gate';
import { runBuildVerification } from './evidence/build-verification';
import {
  collectReleaseGateEvidence,
  releaseGateRequiredEvidencePassed,
  type ReleaseGateEvidence,
} from './evidence/release-gate-evidence';
import { runProductionWranglerDeployment } from './deployment/production-wrangler';
import { concreteOwnedSurfacePath } from './task-plan-surface-policy';
import { topoOrderTasks } from './task-plan-dependencies';
import {
  sourceDocumentsDeclareExternalServiceBindings,
  sourceDocumentsDeclareLatestTranscriptContract,
  sourceDocumentsDeclarePages,
  sourceDocumentsDeclareShortLinkLifecycle,
  sourceDocumentsFromRepo,
  sourceDocumentsRequiredProfileKinds,
  sourcePolicyFromDocuments,
  sourcePolicyFromRepo,
} from './source-policy';
import { executeDeliveryScaffold } from './scaffold-workflow';
import {
  architectBouncePlannerRevisionPrompt,
  initialPlannerPrompt,
  planGateRevisionPrompt,
} from './planner-prompt-policy';

export {
  sourceDocumentsDeclareExternalServiceBindings,
  sourceDocumentsDeclareLatestTranscriptContract,
  sourceDocumentsDeclarePages,
  sourceDocumentsDeclareShortLinkLifecycle,
  sourceDocumentsRequiredProfileKinds,
  sourcePolicyFromDocuments,
} from './source-policy';
export { markDeliveryRunFailedOnWorkflowError } from './workflow-support/errors';
export {
  latestSuccessfulWorkspaceWriteEventTimestamp,
  readBudgetBlockedToolCount,
} from './agent-runtime/stage-timeout';
export {
  judgeProviderErrorDetails,
  judgeUnavailableOutputForRubric,
  judgeUnavailableRemediation,
} from './agent-runtime/judge-runtime';
export {
  hasExecutableRootTask,
  isTrueBlockingAmbiguity,
  normalizeReadoutSafeAdapterAmbiguities,
  openDecisionHygiene,
  shouldSuspendForPlannerQuestions,
} from './planning/readout-policy';
export { pagesFunctionsExceptionHygiene } from './planning/pages-policy';
export { ownedSurfaceHygiene } from './planning/owned-surface-policy';
export {
  normalizeTaskPlanRoleBoundaries,
  taskOwnedSurfaceRoleHygiene,
} from './planning/role-boundary-policy';
export { normalizeTaskPlanLargeStorageTasks } from './planning/large-task-policy';
export {
  configSchemaTaskSplitHygiene,
  normalizeTaskPlanConfigSchemaTasks,
} from './planning/config-schema-policy';
export {
  normalizeTaskPlanOperatorDocumentation,
  operatorDocumentationHygiene,
} from './planning/operator-documentation-policy';
export {
  normalizeTaskPlanProfileContractDependencies,
  profileContractDependencyHygiene,
} from './planning/profile-contract-policy';
export {
  legacyProjectScaffoldHygiene,
  normalizeTaskPlanScaffoldDependencies,
  projectScaffoldHygiene,
} from './planning/scaffold-policy';
export {
  preserveTaskPlanAcceptanceContracts,
  taskPlanAcceptanceContractRegression,
} from './planning/acceptance-contract-preservation';
export {
  generatedSliceDependencyHygiene,
  normalizeTaskPlanGeneratedSliceDependencies,
} from './planning/generated-slice-policy';
export { taskPlanDeterministicResults } from './planning/task-plan-gates';
export { routeBoundaryConsistencyHygiene } from './planning/route-boundary-policy';
export { normalizeTaskPlanCloudflareWorkerContracts } from './planning/cloudflare-worker-contracts-policy';
export { normalizeTaskPlanForDelivery } from './planning/task-plan-normalizer';
export { parsePlannerRevisionResponse, planGateRevisionRemediation } from './planning/task-plan-revision';
export {
  generatedTaskSurfacePaths,
  missingInstalledPackageNames,
  missingOwnedSurfacePaths,
  taskBoundaryAllowsRepairPath,
  taskBoundarySurfaces,
  taskSourceBoundarySurfaces,
  createMissingOwnedSurfaceStubs,
  unreplacedPreflightStubPaths,
  workerConfigHygieneGaps,
  workerConfigTaskPacketPolicy,
  workerConfigTaskPacketPolicyForTask,
  workerEnvBindingAlignmentGaps,
  workerPackageScaffoldGaps,
  workersAiBindingGaps,
  wranglerConfigHasWorkersAiBinding,
} from './implementation/task-boundaries';
export { directDependencySurfacePaths } from './implementation/task-packet';
export {
  lifecycleStatusSchemaGaps,
  profileKindContractGaps,
  profileKindTaskPacketPolicy,
  profileKindTaskPacketPolicyForTask,
  routeMiddlewareBypassGaps,
  workflowEntrypointImportGaps,
  workflowStepIntegrationGaps,
} from './implementation/deterministic-gates';
export {
  deliveryBuildResumePlan,
  implementationFilesTouched,
  priorStoppedBuildTaskIds,
  reusableImplementationArtifactForTask,
} from './implementation/reusable-artifacts';
export {
  implementationActionableJudgmentRemediation,
  implementationJudgmentCanComplete,
  implementationWeakDimensionRemediation,
  shouldProceedAfterNonActionableImplementationJudgment,
} from './implementation/judgment-policy';
export {
  acceptanceContractsForTask,
  implementationDeterministicRemediation,
  implementationDeterministicResults,
  verificationWithAcceptanceGaps,
} from './implementation/evidence';
export {
  buildTimeoutRemediation,
  canSalvageTimedOutBuildAttempt,
  implementationEnginePolicyMismatch,
  implementationFailureClass,
  implementationRetryMode,
  implementationToolChoiceForRetryMode,
  outOfPlanVerificationFailurePaths,
  repairStaleDownstreamVerificationSurfaces,
  repairStaleOutOfPlanVerificationSurfaces,
  repairUnknownNumberIntegerNarrowing,
  staleDownstreamVerificationSurfacePaths,
  staleOutOfPlanVerificationSurfacePaths,
  typeScriptDiagnosticsFromRemediation,
  typeScriptDiagnosticsFromText,
  type TypeScriptDiagnostic,
} from './implementation/retry-runtime';
export {
  buildVerificationCommandPlan,
  buildVerificationCommandPlans,
} from './evidence/build-verification';
export { releaseGateLocalAdminSecretPath } from './evidence/local-admin-secret';
export {
  releaseGateForInvalidTesterOutput,
} from './release-gate-policy';
export {
  releaseGateEvidenceCommandPlan,
  releaseGateLocalD1DatabaseName,
  releaseGateRequiredEvidencePassed,
  releaseGateRequiredStaticEvidenceFailures,
  releaseGateRuntimeProbePlan,
  releaseGateRuntimeProbePlanRequiresAdminSecret,
  releaseGateStaticEvidenceResults,
  releaseGateTranscriptFixtureSchemaGaps,
  releaseGateWorkerDeployDryRunCommand,
  releaseGateWorkerDevCommand,
  releaseGateWorkerStartupCheckCommand,
  releaseGateWorkerTypesCheckCommand,
} from './evidence/release-gate-evidence';
export {
  deploymentReportSuccessNextSteps,
  localDeploymentReportFromReleaseGateEvidence,
} from './deployment/local-report';
export {
  productionDeploymentReportFromWranglerResult,
  productionWranglerDeployCommand,
} from './deployment/production-wrangler';

function parseReviewReportResponse(response: unknown, label: string) {
  try {
    return {
      report: parseDeliveryStructuredOutput(reviewReportSchema, response, label),
      repairedFromBareFindings: false,
    };
  } catch (error) {
    const findings = parseDeliveryStructuredOutput(reviewFindingsSchema, response, `${label} findings`);
    return {
      report: {
        artifact_type: 'review-report' as const,
        verdict: findings.length ? ('blocked' as const) : ('approved' as const),
        findings,
        conditions: [],
        residual_risks: [],
        recommended_next_step: findings.length
          ? 'Revise the task plan to resolve the listed findings before implementation begins.'
          : 'Run the delivery build loop against the approved task plan.',
      },
      repairedFromBareFindings: true,
      repairReason: compactDiagnostic(error),
    };
  }
}

const plannerPolicyVersion = 'worker-first-local-v17';

function plannerSourceFingerprint(sourceDocuments: Array<{ path: string; content: string }>) {
  return createHash('sha256').update(JSON.stringify(sourceDocuments)).digest('hex');
}

function readJsonArtifact(repoPath: string, artifactPath: string) {
  const fullPath = resolve(repoPath, artifactPath);
  if (!existsSync(fullPath)) return undefined;
  return JSON.parse(readFileSync(fullPath, 'utf8')) as unknown;
}

function readCachedPlannerOutput({
  repoPath,
  sourceFingerprint,
  sourcePolicy,
}: {
  repoPath: string;
  sourceFingerprint: string;
  sourcePolicy: SourcePolicy;
}) {
  if (process.env.DELIVERY_REUSE_PLAN_CACHE === '0') return undefined;

  const readout = readoutSchema.safeParse(readJsonArtifact(repoPath, '.delivery/artifacts/readout.json'));
  const taskPlan = taskPlanSchema.safeParse(readJsonArtifact(repoPath, '.delivery/artifacts/task-plan.json'));
  if (!readout.success || !taskPlan.success) return undefined;

  const cache = plannerCacheSchema.safeParse(readJsonArtifact(repoPath, '.delivery/artifacts/plan-cache.json'));
  if (cache.success && cache.data.sourceFingerprint !== sourceFingerprint) return undefined;
  if (cache.success && cache.data.policyVersion !== plannerPolicyVersion) return undefined;
  if (!openDecisionHygiene(taskPlan.data).passed) return undefined;
  if (!ownedSurfaceHygiene(taskPlan.data).passed) return undefined;
  if (!taskOwnedSurfaceRoleHygiene(taskPlan.data).passed) return undefined;
  if (!pagesFunctionsExceptionHygiene(taskPlan.data, sourcePolicy).passed) return undefined;
  if (!projectScaffoldHygiene(repoPath, taskPlan.data).passed) return undefined;
  if (!configSchemaTaskSplitHygiene(taskPlan.data).passed) return undefined;
  if (!operatorDocumentationHygiene(taskPlan.data).passed) return undefined;
  if (!generatedSliceDependencyHygiene(taskPlan.data).passed) return undefined;

  return { readout: readout.data, taskPlan: taskPlan.data, cacheValidated: cache.success };
}

function scaffoldStageFields(input: Partial<DeliveryWorkflowState>) {
  return {
    ...(input.scaffoldManifest ? { scaffoldManifest: input.scaffoldManifest } : {}),
    ...(input.scaffoldManifestPath ? { scaffoldManifestPath: input.scaffoldManifestPath } : {}),
  };
}

function scaffoldManifestPromptSummary(manifest: DeliveryWorkflowState['scaffoldManifest'] | undefined) {
  if (!manifest) return null;
  return {
    profiles: manifest.profileList,
    language: manifest.language,
    main: manifest.main,
    generated_files: manifest.generatedFiles,
    binding_map: manifest.bindingMap,
    package_scripts: manifest.packageScripts,
    validation_commands: manifest.validationCommands,
    test_runtime_matrix: manifest.testRuntimeMatrix,
  };
}

const checkSummaries = (results: DeterministicGateResult[], suffix?: string): CheckSummary[] =>
  results.map((check) => ({
    check: `${check.check ?? check.id ?? 'unknown'}${suffix ? `:${suffix}` : ''}`,
    passed: check.passed,
    reason: check.reason ?? 'deterministic check',
  }));

const buildRoleForTask = (task: Task) => (task.owner === 'designer' ? 'designer' : 'engineer') as 'designer' | 'engineer';

const taskStatusSummary = (state: Record<string, 'complete' | 'stuck' | 'blocked'>) =>
  Object.entries(state).map(([id, status]) => `${id}:${status}`);

const initializeRunStep = createStep({
  id: 'initialize-delivery-run',
  description: 'Create delivery run state, export .delivery files, and persist the initial snapshot.',
  inputSchema: deliveryWorkflowInputSchema,
  outputSchema: initializedSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state, setState, mastra }) => {
    const workflowInput = normalizeDeliveryWorkflowInput(inputData);
    const run = await initializeDeliveryRunState({ ...workflowInput, mastra });
    const repoPath = resolve(workflowInput.repoPath);
    await syncDeliveryWorkflowState({
      state,
      setState,
      output: {
        repoPath,
        runId: run.run_id,
        maxRetries: workflowInput.maxRetries,
        deployMode: workflowInput.deployMode,
        reviewMode: workflowInput.reviewMode,
        artifacts: [],
        checks: [],
        judgments: [],
        questions: [],
        nextSteps: [],
      },
    });
    await safePersistDeliveryStateWithMastra({ repoPath, mastra });

    return {
      ...workflowInput,
      repoPath,
      visionPath: run.vision,
      specPath: run.spec,
      runId: run.run_id,
      reviewMode: workflowInput.reviewMode,
    };
  },
});

const createPlannerArtifactsStep = createStep({
  id: 'create-planner-artifacts',
  description: 'Use the planner agent to create readout and task-plan artifacts.',
  inputSchema: initializedSchema,
  outputSchema: plannerArtifactsSchema,
  stateSchema: deliveryWorkflowStateSchema,
  resumeSchema: plannerQuestionsResumeSchema,
  suspendSchema: plannerQuestionsSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend, state, setState }) => {
    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: 'plan',
      role: 'planner',
      mastra,
    });

    const planner = requiredAgent(mastra, 'planner');
    const humanAnswers = resumeData
      ? `\nHuman answers to prior blocking questions:\n${resumeData.answers
          .map((answer) => `- Q: ${answer.question}\n  A: ${answer.answer}`)
          .join('\n')}${resumeData.notes ? `\nAdditional notes: ${resumeData.notes}` : ''}\n`
      : '';
    const sourceDocuments = repoFileContents(inputData.repoPath, [inputData.visionPath, inputData.specPath]);
    const loadedVision = sourceDocuments.some(
      (document) => document.path === normalizeDeliveryPathReference(inputData.visionPath),
    );
    const normalizedSpecPath = inputData.specPath ? normalizeDeliveryPathReference(inputData.specPath) : undefined;
    const loadedSpec =
      !inputData.specPath ||
      sourceDocuments.some((document) => document.path === normalizedSpecPath);
    if (!loadedVision) {
      throw new Error(`planner could not load required vision document ${inputData.visionPath}`);
    }
    if (!loadedSpec) {
      throw new Error(`planner could not load spec document ${inputData.specPath}`);
    }
    const repoScaffoldState = {
      packageJson: existsSync(join(inputData.repoPath, 'package.json')) ? 'present' : 'missing',
      tsconfigJson: existsSync(join(inputData.repoPath, 'tsconfig.json')) ? 'present' : 'missing',
    } as const;
    const sourceFingerprint = plannerSourceFingerprint(sourceDocuments);
    const sourcePolicy = sourcePolicyFromDocuments(sourceDocuments);
    const cachedOutput = readCachedPlannerOutput({
      repoPath: inputData.repoPath,
      sourceFingerprint,
      sourcePolicy,
    });

    const output = cachedOutput
      ? { readout: cachedOutput.readout, taskPlan: cachedOutput.taskPlan }
      : parseDeliveryStructuredOutput(
          plannerOutputSchema,
          await runWithDeliveryStageTimeout({
            repoPath: inputData.repoPath,
            mastra,
            stage: 'plan',
            timeoutMs: deliveryAgentTimeouts.standard,
            operation: (abortSignal) =>
              planner.generate(
                initialPlannerPrompt({
                  sourceDocuments,
                  sourcePolicy,
                  repoScaffoldState,
                  compatibilityDate: currentWorkerCompatibilityDate(),
                  hasSpecPath: Boolean(inputData.specPath),
                  humanAnswers,
                }),
                {
                  ...structuredNoToolOptions,
                  abortSignal,
                  memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: 'planner' }),
                  requestContext: createDeliveryRequestContext(inputData.repoPath),
                  structuredOutput: {
                    schema: plannerOutputSchema,
                    ...deliveryStructuredOutputOptions,
                    instructions: 'Return only the structured readout and taskPlan objects.',
                  },
                },
              ),
          }),
          'planner',
        );
    output.readout = normalizeReadoutSafeAdapterAmbiguities(output.readout);
    output.taskPlan = normalizeTaskPlanForDelivery(inputData.repoPath, output.taskPlan);

    if (cachedOutput) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'planner_cache_reused',
          stage: 'plan',
          cache_validated: cachedOutput.cacheValidated,
        },
      });
    } else {
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: '.delivery/artifacts/readout.json',
        artifact: output.readout,
      });
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: '.delivery/artifacts/task-plan.json',
        artifact: output.taskPlan,
      });
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: '.delivery/artifacts/plan-cache.json',
        artifact: {
          sourceFingerprint,
          policyVersion: plannerPolicyVersion,
          createdAt: new Date().toISOString(),
        },
      });
    }

    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'readout',
      path: '.delivery/artifacts/readout.json',
      mastra,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'task-plan',
      path: '.delivery/artifacts/task-plan.json',
      mastra,
    });

    const suspendForQuestions = shouldSuspendForPlannerQuestions(output.readout, output.taskPlan);
    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: 'plan',
      reason: suspendForQuestions ? 'escalation' : 'complete_stage',
      mastra,
    });

    if (output.readout.blocking_ambiguities.length) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: suspendForQuestions ? 'human_input_required' : 'planning_questions_deferred',
          stage: 'plan',
          questions: output.readout.blocking_ambiguities,
        },
      });
    }

    if (suspendForQuestions) {
      await syncDeliveryWorkflowState({
        state,
        setState,
        output: {
          repoPath: inputData.repoPath,
          runId: inputData.runId,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          status: 'blocked_on_questions',
          summary: output.readout.recommended_next_step,
          artifacts: ['.delivery/artifacts/readout.json', '.delivery/artifacts/task-plan.json'],
          sourcePolicy,
          questions: output.readout.blocking_ambiguities,
          nextSteps: ['Answer the blocking questions, then resume delivery planning.'],
          taskPlan: output.taskPlan,
        },
      });

      return await suspend(
        {
          reason: 'Planner found blocking ambiguities that require human answers before plan judgment.',
          questions: output.readout.blocking_ambiguities,
          recommendedNextStep: output.readout.recommended_next_step,
          readoutPath: '.delivery/artifacts/readout.json',
          taskPlanPath: '.delivery/artifacts/task-plan.json',
        },
        { resumeLabel: 'answer-planner-questions' },
      );
    }

    const plannerOutput = {
      ...inputData,
      readout: output.readout,
      taskPlan: output.taskPlan,
      artifacts: ['.delivery/artifacts/readout.json', '.delivery/artifacts/task-plan.json'],
      sourcePolicy,
    };
    await syncDeliveryWorkflowState({
      state,
      setState,
      output: {
        repoPath: plannerOutput.repoPath,
        runId: plannerOutput.runId,
        maxRetries: plannerOutput.maxRetries,
        deployMode: plannerOutput.deployMode,
        reviewMode: plannerOutput.reviewMode,
        artifacts: plannerOutput.artifacts,
        sourcePolicy: plannerOutput.sourcePolicy,
        taskPlan: plannerOutput.taskPlan,
        questions: output.readout.blocking_ambiguities,
      },
    });

    return plannerOutput;
  },
});

async function reviseTaskPlanFromPlanGate({
  mastra,
  repoPath,
  runId,
  taskPlan,
  deterministicResults,
  judgment,
  revisionNumber,
}: {
  mastra: any;
  repoPath: string;
  runId: string;
  taskPlan: TaskPlan;
  deterministicResults: DeterministicGateResult[];
  judgment: AggregatedJudgment;
  revisionNumber: number;
}) {
  const stage = `plan:gate-repair-${revisionNumber}`;
  const revisionPath = `.delivery/artifacts/task-plan.plan-gate-revision-${revisionNumber}.json`;
  const remediation = planGateRevisionRemediation({ deterministicResults, judgment });
  const sourcePolicy = sourcePolicyFromRepo(repoPath);

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'plan_gate_revision_requested',
      stage,
      revision: String(revisionNumber),
      remediation,
    },
  });
  await startDeliveryStageState({
    repoPath,
    stage,
    role: 'planner',
    mastra,
  });

  const planner = requiredAgent(mastra, 'planner');
  let response: unknown;
  try {
    response = await runWithDeliveryStageTimeout({
      repoPath,
      mastra,
      stage,
      timeoutMs: deliveryAgentTimeouts.standard,
      operation: (abortSignal) =>
        planner.generate(
          planGateRevisionPrompt({
            taskPlan,
            deterministicResults,
            judgment,
            remediation,
            sourcePolicy,
            compatibilityDate: currentWorkerCompatibilityDate(),
          }),
          {
            ...structuredNoToolOptions,
            abortSignal,
            memory: deliveryRunMemory({ repoPath, runId, role: 'planner' }),
            requestContext: createDeliveryControlRequestContext(repoPath),
            structuredOutput: {
              schema: plannerRevisionOutputSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only the revised taskPlan object wrapped as { "taskPlan": ... }.',
            },
          },
        ),
    });
  } catch (error) {
    await endDeliveryStageState({ repoPath, stage, reason: 'failed', mastra }).catch(() => undefined);
    throw error;
  }

  let parsedRevision: ReturnType<typeof parsePlannerRevisionResponse>;
  try {
    parsedRevision = parsePlannerRevisionResponse(response, `plan gate revision ${revisionNumber}`);
  } catch (error) {
    await endDeliveryStageState({ repoPath, stage, reason: 'failed', mastra }).catch(() => undefined);
    throw error;
  }
  if (parsedRevision.repairedFromBareTaskPlan) {
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'structured_output_repaired',
        stage,
        target: 'task-plan',
        reason: parsedRevision.repairReason,
      },
    });
  }

  const { taskPlan: revisedTaskPlan } = preserveTaskPlanAcceptanceContracts(
    taskPlan,
    normalizeTaskPlanForDelivery(repoPath, parsedRevision.revision.taskPlan),
  );
  writeDeliveryArtifact({
    repoPath,
    artifactPath: revisionPath,
    artifact: revisedTaskPlan,
  });
  writeDeliveryArtifact({
    repoPath,
    artifactPath: '.delivery/artifacts/task-plan.json',
    artifact: revisedTaskPlan,
  });
  await recordDeliveryArtifactState({
    repoPath,
    type: `task-plan:plan-gate-revision-${revisionNumber}`,
    path: revisionPath,
    mastra,
  });
  await recordDeliveryArtifactState({
    repoPath,
    type: 'task-plan',
    path: '.delivery/artifacts/task-plan.json',
    mastra,
  });
  await endDeliveryStageState({ repoPath, stage, reason: 'complete_stage', mastra });

  return {
    taskPlan: revisedTaskPlan,
    path: revisionPath,
  };
}

const createPlanGateStep = createStep({
  id: 'judge-task-plan',
  description: 'Run deterministic plan gates and rubric judgment before architect handoff.',
  inputSchema: plannerArtifactsSchema,
  outputSchema: planStageOutputSchema,
  scorers: deliveryPlanStepScorers,
  execute: async ({ inputData, mastra }) => {
    const artifacts = [...inputData.artifacts];
    const checks: CheckSummary[] = [];
    const judgments: JudgmentRef[] = [];
    let taskPlan = inputData.taskPlan;
    let subjectName = '.delivery/artifacts/task-plan.json';

    for (let attempt = 0; attempt <= inputData.maxRetries; attempt += 1) {
      const suffix = attempt === 0 ? undefined : `plan-gate-revision-${attempt}`;
      const deterministicResults = taskPlanDeterministicResults({
        repoPath: inputData.repoPath,
        taskPlan,
        sourcePolicy: inputData.sourcePolicy,
      });
      checks.push(...checkSummaries(deterministicResults, suffix));
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'deterministic_gate_result',
          stage: suffix ? `plan-gate:${suffix}` : 'plan-gate',
          gate: 'task-plan',
          passed: deterministicResults.every((result) => result.passed),
          checks: deterministicResults.map((result) => ({
            id: result.id,
            check: result.check,
            passed: result.passed,
            reason: result.reason,
          })),
        },
      }).catch(() => undefined);
      const taskPlanJudge = await judgeDeliveryArtifact({
        mastra,
        repoPath: inputData.repoPath,
        runId: inputData.runId,
        rubricName: 'task-plan',
        subjectName,
        subject: taskPlan,
        deterministicResults,
        slug: attempt === 0 ? 'task-plan' : `task-plan-plan-gate-revision-${attempt}`,
      });
      const taskPlanJudgment = taskPlanJudge.judgment;
      artifacts.push(taskPlanJudge.judgeOutputPath, taskPlanJudge.judgmentPath);
      judgments.push(taskPlanJudge.ref);

      const planContext = {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        sourcePolicy: inputData.sourcePolicy,
        taskPlan,
      };

      if (shouldSuspendForPlannerQuestions(inputData.readout, taskPlan)) {
        return {
          ...planContext,
          status: 'blocked_on_questions' as const,
          runId: inputData.runId,
          summary: inputData.readout.recommended_next_step,
          artifacts,
          checks,
          judgments,
          questions: inputData.readout.blocking_ambiguities,
          nextSteps: ['Answer the blocking questions, then rerun or resume delivery planning.'],
        };
      }

      const remediation = planGateRevisionRemediation({ deterministicResults, judgment: taskPlanJudgment });
      if (!remediation.length) {
        return {
          ...planContext,
          status: 'planned' as const,
          runId: inputData.runId,
          summary: taskPlan.scope,
          artifacts,
          checks,
          judgments,
          questions: inputData.readout.blocking_ambiguities,
          nextSteps: [
            ...inputData.readout.blocking_ambiguities.map((question) => `Deferred question: ${question}`),
            `Run architecture review against ${subjectName}.`,
            'Continue through the native architect review, build, release-gate, and deployment stages.',
          ],
        };
      }

      if (attempt >= inputData.maxRetries) {
        const deterministicFailed = deterministicResults.some((check) => !check.passed);
        return {
          ...planContext,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: deterministicFailed
            ? 'Planner produced artifacts, but deterministic plan checks failed after repair attempts.'
            : 'Planner produced artifacts, but the task-plan rubric judgment failed after repair attempts.',
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: remediation,
        };
      }

      const revision = await reviseTaskPlanFromPlanGate({
        mastra,
        repoPath: inputData.repoPath,
        runId: inputData.runId,
        taskPlan,
        deterministicResults,
        judgment: taskPlanJudgment,
        revisionNumber: attempt + 1,
      });
      const regression = taskPlanAcceptanceContractRegression(taskPlan, revision.taskPlan);
      checks.push(...checkSummaries([{ id: 'acceptance_contracts_preserved', check: 'task_plan_acceptance_contract_regression', ...regression }], `plan-gate-revision-${attempt + 1}`));
      if (!regression.passed) {
        return {
          ...planContext,
          taskPlan: revision.taskPlan,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: 'Planner revision dropped acceptance criteria from the prior task plan.',
          artifacts: [...artifacts, revision.path],
          checks,
          judgments,
          questions: [],
          nextSteps: [regression.reason],
        };
      }
      taskPlan = revision.taskPlan;
      subjectName = revision.path;
      artifacts.push(revision.path);
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan,
      status: 'stuck' as const,
      runId: inputData.runId,
      summary: 'Planner could not produce a task plan before the retry budget ended.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Inspect the plan-gate judgments and task-plan revision artifacts.'],
    };
  },
});

export const deliveryPlanningWorkflow = createWorkflow({
  id: 'delivery-planning',
  description: 'Plan a delivery run, repair the task plan, and persist the plan-stage state.',
  inputSchema: deliveryWorkflowInputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(initializeRunStep)
  .then(createPlannerArtifactsStep)
  .then(createPlanGateStep)
  .then(syncPlanStateStep)
  .commit();

const createScaffoldArtifactsStep = createStep({
  id: 'create-scaffold-artifacts',
  description: 'Generate deterministic Cloudflare Worker scaffold artifacts after planning and before agent implementation.',
  inputSchema: planStageOutputSchema,
  outputSchema: planStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  scorers: deliveryScaffoldStepScorers,
  execute: async ({ inputData, mastra, state, setState }) => {
    if (inputData.status !== 'planned') return inputData;

    const scaffold = await executeDeliveryScaffold(
      {
        repoPath: inputData.repoPath,
        runId: inputData.runId,
        sourcePolicy: inputData.sourcePolicy,
      },
      mastra,
    );
    const artifacts = [...new Set([...inputData.artifacts, scaffold.manifestPath])];
    const checks = [
      ...inputData.checks,
      ...scaffold.checks.map((check) => ({ check: check.check, passed: check.passed, reason: check.reason })),
    ];
    const failedScaffoldChecks = scaffold.checks.filter((check) => !check.passed);
    const taskPlan = inputData.taskPlan
      ? annotateTaskPlanWithTypedMetadata(inputData.taskPlan, scaffold.scaffoldManifest)
      : inputData.taskPlan;
    const nextSteps = [
      `Scaffold manifest generated at ${scaffold.manifestPath}.`,
      ...inputData.nextSteps.filter((step) => !/scaffold manifest generated/i.test(step)),
    ];
    const output = {
      ...inputData,
      status: failedScaffoldChecks.length ? ('stuck' as const) : inputData.status,
      summary: failedScaffoldChecks.length
        ? 'Scaffold deterministic checks failed before architect review.'
        : inputData.summary,
      artifacts,
      checks,
      taskPlan,
      scaffoldManifest: scaffold.scaffoldManifest,
      scaffoldManifestPath: scaffold.manifestPath,
      nextSteps: failedScaffoldChecks.length ? failedScaffoldChecks.map((check) => check.reason) : nextSteps,
    };

    await syncDeliveryWorkflowState({ state, setState, output });
    await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    return output;
  },
});

const prepareReviewLoopStep = createStep({
  id: 'prepare-review-loop',
  description: 'Prepare architect review retry state for the native workflow loop.',
  inputSchema: planStageOutputSchema,
  outputSchema: reviewLoopStateSchema,
  execute: async ({ inputData, mastra }) => {
    const passThrough = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      attempt: 0,
      terminal: true,
    });

    if (inputData.status !== 'planned') return passThrough();
    if (!inputData.taskPlan) throw new Error('plan stage did not provide a task plan for architect review');
    if (inputData.reviewMode === 'fast') {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'review_skipped',
          stage: 'review:fast',
          reason: 'Fast review mode: task plan passed deterministic and rubric gates; architect loop is available with reviewMode=thorough.',
        },
      });

      return {
        ...passThrough(),
        status: 'reviewed' as const,
        summary: `${inputData.summary} Fast review mode accepted the scored task plan for implementation.`,
        nextSteps: ['Run the delivery build loop against the scored task plan.'],
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      attempt: 0,
      terminal: false,
    };
  },
});

const executeReviewAttemptStep = createStep({
  id: 'architect-review-attempt',
  description: 'Run one architect review attempt and optionally revise the task plan before the next loop iteration.',
  inputSchema: reviewLoopStateSchema,
  outputSchema: reviewLoopStateSchema,
  execute: async ({ inputData, mastra }) => {
    if (inputData.terminal || inputData.status !== 'planned') {
      return { ...inputData, terminal: true };
    }
    if (!inputData.taskPlan) throw new Error('review loop did not provide a task plan for architect review');

    const architect = requiredAgent(mastra, 'architect');
    const planner = requiredAgent(mastra, 'planner');
    const taskPlan = inputData.taskPlan;
    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];
    const attempt = inputData.attempt;
    const stageContext = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
    });

    const suffix = attempt === 0 ? 'initial' : `retry-${attempt}`;
    const reviewPath =
      attempt === 0 ? '.delivery/artifacts/review-report.json' : `.delivery/artifacts/review-report.${suffix}.json`;

    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: `review:${suffix}`,
      role: 'architect',
      mastra,
    });

    const reviewResponse = await runWithDeliveryStageTimeout({
      repoPath: inputData.repoPath,
      mastra,
      stage: `review:${suffix}`,
      timeoutMs: deliveryAgentTimeouts.standard,
      operation: (abortSignal) =>
        architect.generate(
          `Review the task plan below for structural readiness before implementation.

Evaluate granularity, error handling, trust boundaries, state authority, fail-fast behavior, data flow, security, and complexity.
Approve only when build can safely begin. Block when planner changes are required before implementation.
Use verdict "blocked" when any high-severity finding, auth/state-integrity finding, missing owner, or dependency defect must be fixed before implementation begins.
Every finding must be specific, evidenced, and remediable by an owning role.
Return exactly one JSON object, not a bare findings array, with this shape:
{
  "artifact_type": "review-report",
  "verdict": "approved" | "approved_with_conditions" | "blocked",
  "findings": [{ "severity": "high" | "medium" | "low", "title": "...", "location": "...", "evidence": "...", "why_it_matters": "...", "required_remediation": "..." }],
  "conditions": [],
  "residual_risks": [],
  "recommended_next_step": "..."
}

Task plan:
${JSON.stringify(taskPlan, null, 2)}

Scaffold manifest:
${JSON.stringify(scaffoldManifestPromptSummary(inputData.scaffoldManifest), null, 2)}`,
          {
            ...structuredNoToolOptions,
            abortSignal,
            memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: 'architect' }),
            requestContext: createDeliveryControlRequestContext(inputData.repoPath),
            structuredOutput: {
              schema: reviewReportSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only one review-report object. Do not return a bare array.',
            },
          },
        ),
    });

    const parsedReview = parseReviewReportResponse(reviewResponse, 'architect review');
    const reviewReport = parsedReview.report;
    if (parsedReview.repairedFromBareFindings) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'structured_output_repaired',
          stage: `review:${suffix}`,
          target: 'review-report',
          reason: parsedReview.repairReason,
        },
      });
    }
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: reviewPath,
      artifact: reviewReport,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: attempt === 0 ? 'review-report' : `review-report:${suffix}`,
      path: reviewPath,
      mastra,
    });
    artifacts.push(reviewPath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: `review:${suffix}`,
      reason: reviewReport.verdict === 'blocked' ? 'escalation' : 'complete_stage',
      mastra,
    });

    const reviewJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      runId: inputData.runId,
      rubricName: 'review-report',
      subjectName: reviewPath,
      subject: reviewReport,
      slug: attempt === 0 ? 'review-report' : `review-report-${suffix}`,
    });
    artifacts.push(reviewJudge.judgeOutputPath, reviewJudge.judgmentPath);
    judgments.push(reviewJudge.ref);

    const reviewNeedsRevision = reviewReport.verdict === 'blocked' || !reviewJudge.judgment.passed;
    const revisionRemediation = reviewJudge.judgment.passed
      ? reviewReport.findings.map(
          (finding) => `${finding.severity.toUpperCase()}: ${finding.title} - ${finding.required_remediation}`,
        )
      : reviewJudge.judgment.remediation;

    if (!reviewNeedsRevision) {
      return {
        ...stageContext(),
        status: 'reviewed' as const,
        runId: inputData.runId,
        summary: `Architect ${reviewReport.verdict}: ${reviewReport.recommended_next_step}`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: [
          ...reviewReport.conditions.map((condition) => `Condition: ${condition}`),
          ...reviewReport.residual_risks.map((risk) => `Watch: ${risk}`),
          'Run the delivery build loop against the approved task plan.',
        ],
        attempt,
        terminal: true,
      };
    }

    if (attempt >= inputData.maxRetries) {
      return {
        ...stageContext(),
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: !reviewJudge.judgment.passed
          ? 'Architect review report failed rubric judgment after bounded planner retries.'
          : 'Architect review blocked the plan after bounded planner retries.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: [reviewReport.recommended_next_step, ...revisionRemediation],
        attempt,
        terminal: true,
      };
    }

    const revisionNumber = attempt + 1;
    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: `plan:architect-bounce-${revisionNumber}`,
      role: 'planner',
      mastra,
    });

    const revisionResponse = await runWithDeliveryStageTimeout({
      repoPath: inputData.repoPath,
      mastra,
      stage: `plan:architect-bounce-${revisionNumber}`,
      timeoutMs: deliveryAgentTimeouts.standard,
      operation: (abortSignal) =>
        planner.generate(
          architectBouncePlannerRevisionPrompt({
            taskPlan,
            reviewReport,
            revisionRemediation,
          }),
          {
            ...structuredNoToolOptions,
            abortSignal,
            memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: 'planner' }),
            requestContext: createDeliveryControlRequestContext(inputData.repoPath),
            structuredOutput: {
              schema: plannerRevisionOutputSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only the revised taskPlan object wrapped as { "taskPlan": ... }.',
            },
          },
        ),
    });

    const parsedRevision = parsePlannerRevisionResponse(revisionResponse, 'planner revision');
    if (parsedRevision.repairedFromBareTaskPlan) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'structured_output_repaired',
          stage: `plan:architect-bounce-${revisionNumber}`,
          target: 'task-plan',
          reason: parsedRevision.repairReason,
        },
      });
    }
    const revision = parsedRevision.revision;
    const { taskPlan: revisedTaskPlan } = preserveTaskPlanAcceptanceContracts(
      taskPlan,
      normalizeTaskPlanForDelivery(inputData.repoPath, revision.taskPlan),
    );
    const revisionPath = `.delivery/artifacts/task-plan.revision-${revisionNumber}.json`;
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: revisionPath,
      artifact: revisedTaskPlan,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: `task-plan:revision-${revisionNumber}`,
      path: revisionPath,
      mastra,
    });
    artifacts.push(revisionPath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: `plan:architect-bounce-${revisionNumber}`,
      reason: 'complete_stage',
      mastra,
    });

    const revisedDeterministicResults = taskPlanDeterministicResults({
      repoPath: inputData.repoPath,
      taskPlan: revisedTaskPlan,
      sourcePolicy: inputData.sourcePolicy,
    });
    const contractRegression = taskPlanAcceptanceContractRegression(taskPlan, revisedTaskPlan);
    const revisedResultsWithContracts = [
      ...revisedDeterministicResults,
      {
        id: 'acceptance_contracts_preserved',
        check: 'task_plan_acceptance_contract_regression',
        ...contractRegression,
      },
    ];
    checks.push(...checkSummaries(revisedResultsWithContracts, `revision-${revisionNumber}`));
    const failedRevisedChecks = revisedResultsWithContracts.filter((check) => !check.passed);
    if (failedRevisedChecks.length) {
      return {
        ...stageContext(),
        taskPlan: revisedTaskPlan,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: 'Planner revision failed deterministic task-plan gates.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: failedRevisedChecks.map((check) => check.reason ?? 'deterministic check failed'),
        attempt,
        terminal: true,
      };
    }

    const revisedPlanJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      runId: inputData.runId,
      rubricName: 'task-plan',
      subjectName: revisionPath,
      subject: revisedTaskPlan,
      deterministicResults: revisedResultsWithContracts,
      slug: `task-plan-revision-${revisionNumber}`,
    });
    artifacts.push(revisedPlanJudge.judgeOutputPath, revisedPlanJudge.judgmentPath);
    judgments.push(revisedPlanJudge.ref);

    if (!revisedPlanJudge.judgment.passed) {
      return {
        ...stageContext(),
        taskPlan: revisedTaskPlan,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: 'Planner revision failed task-plan rubric judgment.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: revisedPlanJudge.judgment.remediation,
        attempt,
        terminal: true,
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: revisedTaskPlan,
      releaseGate: inputData.releaseGate,
      status: 'reviewed' as const,
      runId: inputData.runId,
      summary: 'Planner revised the task plan after architect review; revised plan passed judgment.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Run the delivery build loop against the revised task plan.'],
      attempt: revisionNumber,
      terminal: true,
    };
  },
});

const finalizeReviewLoopStep = createStep({
  id: 'architect-review',
  description: 'Finalize architect review loop output for delivery workflow handoff.',
  inputSchema: reviewLoopStateSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  scorers: deliveryReviewStepScorers,
  execute: async ({ inputData, state }) => ({
    repoPath: inputData.repoPath,
    maxRetries: inputData.maxRetries,
    deployMode: inputData.deployMode,
    reviewMode: inputData.reviewMode,
    taskPlan: inputData.taskPlan,
    releaseGate: inputData.releaseGate,
    ...scaffoldStageFields(inputData.scaffoldManifest ? inputData : state),
    status: inputData.status,
    runId: inputData.runId,
    summary: inputData.summary,
    artifacts: inputData.artifacts,
    checks: inputData.checks,
    judgments: inputData.judgments,
    questions: inputData.questions,
    nextSteps: inputData.nextSteps,
  }),
});

export const deliveryReviewWorkflow = createWorkflow({
  id: 'delivery-review',
  description: 'Run the architect review loop and persist the reviewed delivery state.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(prepareReviewLoopStep)
  .dountil(executeReviewAttemptStep, async ({ inputData }) => inputData.terminal)
  .then(finalizeReviewLoopStep)
  .then(syncReviewStateStep)
  .commit();

const prepareBuildTasksStep = createStep({
  id: 'prepare-build-tasks',
  description: 'Expand the reviewed task plan into workflow-native build work items.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: buildTaskWorkItemsSchema,
  execute: async ({ inputData, mastra }) => {
    const passThrough = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      taskIndex: 0,
      skipped: true,
    });

    if (inputData.status !== 'reviewed') return [passThrough()];
    if (!inputData.taskPlan) throw new Error('review stage did not provide a task plan for the build loop');

    const orderedTasks = topoOrderTasks(inputData.taskPlan.tasks);
    if (!orderedTasks.length) {
      return [
        {
          ...passThrough(),
          status: 'built' as const,
          summary: 'Build loop completed: no implementation tasks were present.',
          nextSteps: ['Run the release gate stage against the reviewed task plan.'],
        },
      ];
    }
    const taskPlan = inputData.taskPlan;

    const resumePlan = deliveryBuildResumePlan(inputData.repoPath, taskPlan);
    const resumeReason = deliveryBuildResumeReason(resumePlan);
    const checks = resumeReason
      ? [...inputData.checks, { check: 'build_resume_cursor', passed: true, reason: resumeReason }]
      : inputData.checks;

    if (resumeReason) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'build_resume_cursor',
          stage: 'build',
          ok: true,
          reusable_task_ids: resumePlan.reusableTaskIds,
          resume_after_task: resumePlan.resumeAfterTaskId,
          next_task: resumePlan.nextTaskId,
          total_tasks: resumePlan.totalTasks,
        },
      }).catch(() => undefined);
    }

    await appendDeliveryEventState({
      repoPath: inputData.repoPath,
      mastra,
      event: {
        type: 'task_packets_emitted',
        stage: 'build',
        total_tasks: orderedTasks.length,
        tasks: orderedTasks.map((task) => {
          const rails = taskPacketRailsForTask({
            taskPlan,
            task,
            scaffoldManifest: inputData.scaffoldManifest,
            maxAttempts: inputData.maxRetries + 1,
          });

          return {
            id: task.id,
            owner: task.owner,
            task_kind: rails.task_kind,
            surface_kind: rails.surface_kind,
            evidence_kind: rails.evidence_kind,
            runtime_kind: rails.runtime_class,
            verification_command_class: rails.verification_command_class,
            allowed_surfaces: rails.allowed_surfaces,
            scaffold_owned_allowed_surfaces: rails.scaffold_owned_allowed_surfaces,
            model_budget: rails.model_budget,
          };
        }),
      },
    }).catch(() => undefined);

    return orderedTasks.map((task, taskIndex) => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      task,
      taskIndex,
      skipped: false,
    }));
  },
});

const prepareBuildTaskAttemptLoopStep = createStep({
  id: 'prepare-build-task-attempt-loop',
  description: 'Prepare one build task for native retry attempts.',
  inputSchema: buildTaskWorkItemSchema,
  outputSchema: buildTaskAttemptStateSchema,
  execute: async ({ inputData, mastra }) => {
    const passThrough = (taskStatus: 'complete' | 'stuck' | 'blocked' | 'skipped' = 'skipped') => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      taskId: inputData.task?.id,
      taskIndex: inputData.taskIndex,
      skipped: inputData.skipped,
      taskStatus,
      attempt: 0,
      terminal: true,
      remediation: [],
    });

    if (inputData.skipped) return passThrough();
    if (inputData.status !== 'reviewed') return passThrough();
    if (!inputData.taskPlan) throw new Error('review stage did not provide a task plan for the build task');
    if (!inputData.task) throw new Error('build task work item did not include a task');

    const taskPlan = inputData.taskPlan;
    const task = inputData.task;
    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];

    const run = await readDeliveryRunState({ repoPath: inputData.repoPath, mastra });
    const priorStopped = priorStoppedBuildTaskIds({
      taskPlan,
      taskIndex: inputData.taskIndex,
      taskStatuses: run.tasks,
    });
    if (priorStopped.length) {
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'blocked',
        owner: task.owner,
        note: `paused by earlier stopped task ${priorStopped.join(', ')}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} paused because earlier build tasks stopped.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: priorStopped.map((dependency) => `${task.id} paused by earlier stopped task ${dependency}`),
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: 'blocked' as const,
        attempt: 0,
        terminal: true,
        remediation: [],
      };
    }

    const blockedBy = task.depends_on.filter((dependency) => run.tasks[dependency]?.status !== 'complete');
    if (blockedBy.length) {
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'blocked',
        owner: task.owner,
        note: `blocked by dependency ${blockedBy.join(', ')}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} blocked by dependencies.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: blockedBy.map((dependency) => `${task.id} blocked by ${dependency}`),
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: 'blocked' as const,
        attempt: 0,
        terminal: true,
        remediation: [],
      };
    }

    const reusable = reusableImplementationArtifactForTask(inputData.repoPath, task);
    if (reusable) {
      const judgmentRef: JudgmentRef = {
        subject: reusable.notePath,
        rubric: reusable.judgment.rubric ?? 'implementation',
        path: reusable.judgmentPath,
        overall: reusable.judgment.overall ?? 0,
        passed: true,
      };
      const reusedArtifacts = [
        reusable.notePath,
        reusable.judgmentPath,
        ...(reusable.judgeOutputPath ? [reusable.judgeOutputPath] : []),
      ];
      artifacts.push(...reusedArtifacts);
      checks.push({
        check: `reused_implementation_artifact:${task.id}`,
        passed: true,
        reason: `Reused passing implementation judgment ${reusable.judgmentPath} after owned surfaces were present.`,
      });
      judgments.push(judgmentRef);

      await recordDeliveryArtifactState({
        repoPath: inputData.repoPath,
        type: `note-${task.id}`,
        path: reusable.notePath,
        mastra,
      });
      await recordDeliveryJudgmentState({
        repoPath: inputData.repoPath,
        subject: reusable.notePath,
        rubric: judgmentRef.rubric,
        path: judgmentRef.path,
        overall: judgmentRef.overall,
        passed: judgmentRef.passed,
        mastra,
      });
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'implementation_artifact_reused',
          stage: `build:${task.id}`,
          ok: true,
          task: task.id,
          attempt: reusable.attempt,
          notePath: reusable.notePath,
          judgmentPath: reusable.judgmentPath,
        },
      });
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'complete',
        owner: task.owner,
        note: `reused passing judgment ${reusable.judgment.overall}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'built' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} reused a prior passing implementation artifact.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: ['Continue the delivery build loop.'],
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: 'complete' as const,
        attempt: 0,
        terminal: true,
        remediation: [],
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan,
      releaseGate: inputData.releaseGate,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts,
      checks,
      judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      task,
      taskIndex: inputData.taskIndex,
      skipped: false,
      taskId: task.id,
      taskStatus: undefined,
      attempt: 0,
      terminal: false,
      remediation: [],
    };
  },
});

const executeBuildTaskAttemptStep = createStep({
  id: 'execute-build-task-attempt',
  description: 'Run one implementation attempt for a build task and decide whether another attempt is needed.',
  inputSchema: buildTaskAttemptStateSchema,
  outputSchema: buildTaskAttemptStateSchema,
  execute: async ({ inputData, mastra }) =>
    runBuildTaskAttempt({
      inputData,
      mastra,
      scaffoldManifestSummary: scaffoldManifestPromptSummary(inputData.scaffoldManifest),
    }),
});

const finalizeBuildTaskAttemptLoopStep = createStep({
  id: 'execute-build-task',
  description: 'Finalize native build task attempt loop output.',
  inputSchema: buildTaskAttemptStateSchema,
  outputSchema: buildTaskResultSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state }) => ({
    repoPath: inputData.repoPath,
    maxRetries: inputData.maxRetries,
    deployMode: inputData.deployMode,
    reviewMode: inputData.reviewMode,
    taskPlan: inputData.taskPlan,
    releaseGate: inputData.releaseGate,
    ...scaffoldStageFields(inputData.scaffoldManifest ? inputData : state),
    status: inputData.status === 'reviewed' ? ('stuck' as const) : inputData.status,
    runId: inputData.runId,
    summary:
      inputData.status === 'reviewed' ? 'Build task attempt loop ended before a terminal result.' : inputData.summary,
    artifacts: inputData.artifacts,
    checks: inputData.checks,
    judgments: inputData.judgments,
    questions: inputData.questions,
    nextSteps:
      inputData.status === 'reviewed'
        ? inputData.remediation.length
          ? inputData.remediation
          : ['Inspect build task attempt state and rerun the build loop.']
        : inputData.nextSteps,
    taskId: inputData.taskId,
    taskStatus: inputData.taskStatus ?? (inputData.status === 'reviewed' ? ('stuck' as const) : undefined),
  }),
});

export const deliveryBuildTaskWorkflow = createWorkflow({
  id: 'delivery-build-task',
  description: 'Nested workflow that executes one implementation task with role boundary and judgment gates.',
  inputSchema: buildTaskWorkItemSchema,
  outputSchema: buildTaskResultSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(prepareBuildTaskAttemptLoopStep)
  .dountil(executeBuildTaskAttemptStep, async ({ inputData }) => inputData.terminal)
  .then(finalizeBuildTaskAttemptLoopStep)
  .commit();

const aggregateBuildTaskResultsStep = createStep({
  id: 'delivery-build-loop',
  description: 'Aggregate workflow-native build task results into the delivery stage output.',
  inputSchema: buildTaskResultsSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  scorers: deliveryBuildStepScorers,
  execute: async ({ inputData, state }) => {
    const first = inputData[0];
    if (!first) throw new Error('build loop did not receive any task results');
    const scaffoldFields = scaffoldStageFields(first.scaffoldManifest ? first : state);

    const uniqueArtifacts = Array.from(new Set(inputData.flatMap((result) => result.artifacts)));
    const checkKeys = new Set<string>();
    const checks = inputData
      .flatMap((result) => result.checks)
      .filter((check) => {
        const key = `${check.check}:${check.passed}:${check.reason}`;
        if (checkKeys.has(key)) return false;
        checkKeys.add(key);
        return true;
      });
    const judgmentKeys = new Set<string>();
    const judgments = inputData
      .flatMap((result) => result.judgments)
      .filter((judgment) => {
        if (judgmentKeys.has(judgment.path)) return false;
        judgmentKeys.add(judgment.path);
        return true;
      });
    const taskState = Object.fromEntries(
      inputData
        .filter((result) => result.taskId && result.taskStatus && result.taskStatus !== 'skipped')
        .map((result) => [result.taskId, result.taskStatus]),
    ) as Record<string, 'complete' | 'stuck' | 'blocked'>;

    const allSkipped = inputData.every((result) => result.taskStatus === 'skipped' || !result.taskId);
    if (allSkipped) {
      return {
        repoPath: first.repoPath,
        maxRetries: first.maxRetries,
        deployMode: first.deployMode,
        reviewMode: first.reviewMode,
        taskPlan: first.taskPlan,
        releaseGate: first.releaseGate,
        ...scaffoldFields,
        status: first.status,
        runId: first.runId,
        summary: first.summary,
        artifacts: uniqueArtifacts,
        checks,
        judgments,
        questions: first.questions,
        nextSteps: first.nextSteps,
      };
    }

    const blockedOrStuck = Object.entries(taskState).filter(([, status]) => status !== 'complete');
    if (blockedOrStuck.length) {
      return {
        repoPath: first.repoPath,
        maxRetries: first.maxRetries,
        deployMode: first.deployMode,
        reviewMode: first.reviewMode,
        taskPlan: first.taskPlan,
        releaseGate: first.releaseGate,
        ...scaffoldFields,
        status: 'stuck' as const,
        runId: first.runId,
        summary: 'Build loop stopped with stuck or blocked tasks.',
        artifacts: uniqueArtifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: blockedOrStuck.map(([id, status]) => `${id}:${status}`),
      };
    }

    return {
      repoPath: first.repoPath,
      maxRetries: first.maxRetries,
      deployMode: first.deployMode,
      reviewMode: first.reviewMode,
      taskPlan: first.taskPlan,
      releaseGate: first.releaseGate,
      ...scaffoldFields,
      status: 'built' as const,
      runId: first.runId,
      summary: `Build loop completed: ${taskStatusSummary(taskState).join(', ')}`,
      artifacts: uniqueArtifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Run the release gate stage against implementation notes and changed code.'],
    };
  },
});

export const deliveryBuildWorkflow = createWorkflow({
  id: 'delivery-build',
  description: 'Prepare implementation tasks, run the nested build-task workflow, and persist build-stage state.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(prepareBuildTasksStep)
  .foreach(deliveryBuildTaskWorkflow, { concurrency: 1 })
  .then(aggregateBuildTaskResultsStep)
  .then(syncBuildStateStep)
  .commit();

const prepareReleaseGateLoopStep = createStep({
  id: 'prepare-release-gate-loop',
  description: 'Prepare tester release gate retry state for the native workflow loop.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: releaseGateLoopStateSchema,
  execute: async ({ inputData }) => {
    const passThrough = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      attempt: 0,
      terminal: true,
      remediation: [],
    });

    if (inputData.status !== 'built') return passThrough();
    if (!inputData.taskPlan) throw new Error('build stage did not provide a task plan for release gating');

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      ...scaffoldStageFields(inputData),
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      attempt: 0,
      terminal: false,
      remediation: [],
    };
  },
});

const executeReleaseGateAttemptStep = createStep({
  id: 'release-gate-attempt',
  description: 'Run one release gate attempt and decide whether another tester attempt is needed.',
  inputSchema: releaseGateLoopStateSchema,
  outputSchema: releaseGateLoopStateSchema,
  execute: async ({ inputData, mastra }) => {
    if (inputData.terminal || inputData.status !== 'built') {
      return { ...inputData, terminal: true };
    }
    if (!inputData.taskPlan) throw new Error('release gate loop did not provide a task plan');

    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];
    const attempt = inputData.attempt;
    const attemptNumber = attempt + 1;
    const stage = `test:a${attemptNumber}`;
    const gatePath =
      attempt === 0 ? '.delivery/artifacts/release-gate.json' : `.delivery/artifacts/release-gate.a${attemptNumber}.json`;
    const evidencePath = `.delivery/artifacts/test-evidence.a${attemptNumber}.json`;

    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      role: 'tester',
      mastra,
    });

    const evidence = await collectReleaseGateEvidence({
      repoPath: inputData.repoPath,
      mastra,
      stage,
    });
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: evidencePath,
      artifact: evidence,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: `test-evidence:a${attemptNumber}`,
      path: evidencePath,
      mastra,
    });
    artifacts.push(evidencePath);

    const gate = synthesizeReleaseGateFromEvidence({ evidence, evidencePath });
    await appendDeliveryEventState({
      repoPath: inputData.repoPath,
      mastra,
      event: {
        type: 'release_gate_synthesized',
        stage,
        ok: gate.decision === 'pass',
        artifact_type: 'release-gate',
        path: gatePath,
        decision: gate.decision,
        blockers: gate.blockers,
      },
    });

    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: gatePath,
      artifact: gate,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: attempt === 0 ? 'release-gate' : `release-gate:a${attemptNumber}`,
      path: gatePath,
      mastra,
    });
    artifacts.push(gatePath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      reason: 'complete_stage',
      mastra,
    });

    const deliveryEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const deterministicResults = releaseGateDeterministicResults({
      stage,
      gate,
      events: deliveryEvents,
      evidence,
    });
    checks.push(...checkSummaries(deterministicResults, `release-gate.a${attemptNumber}`));

    const failedDeterministicResults = deterministicResults.filter((result) => !result.passed);
    const remediation = [
      ...gate.blockers,
      ...failedDeterministicResults.map((result) => `DETERMINISTIC ${result.id ?? result.check} failed: ${result.reason}`),
    ];
    if (gate.decision === 'pass' && failedDeterministicResults.length === 0) {
      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        taskPlan: inputData.taskPlan,
        releaseGate: gate,
        status: 'release_ready' as const,
        runId: inputData.runId,
        summary: gate.summary,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: ['Run deployment stage using the passing release gate.'],
        attempt,
        terminal: true,
        remediation: [],
      };
    }

    if (attempt < inputData.maxRetries) {
      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        taskPlan: inputData.taskPlan,
        releaseGate: gate,
        status: 'built' as const,
        runId: inputData.runId,
        summary: 'Release gate needs another tester attempt.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: remediation.length ? remediation : ['Retry release gate with stronger evidence.'],
        attempt: attempt + 1,
        terminal: false,
        remediation,
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: gate,
      status: 'gate_failed' as const,
      runId: inputData.runId,
      summary: 'Release gate failed; deployment is stopped.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: remediation.length ? remediation : ['Fix release-gate blockers and rerun test stage.'],
      attempt,
      terminal: true,
      remediation,
    };
  },
});

const finalizeReleaseGateLoopStep = createStep({
  id: 'release-gate',
  description: 'Finalize native release gate retry loop output.',
  inputSchema: releaseGateLoopStateSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  scorers: deliveryReleaseGateStepScorers,
  execute: async ({ inputData, state }) => ({
    repoPath: inputData.repoPath,
    maxRetries: inputData.maxRetries,
    deployMode: inputData.deployMode,
    reviewMode: inputData.reviewMode,
    taskPlan: inputData.taskPlan,
    releaseGate: inputData.releaseGate,
    ...scaffoldStageFields(inputData.scaffoldManifest ? inputData : state),
    status: inputData.status,
    runId: inputData.runId,
    summary: inputData.summary,
    artifacts: inputData.artifacts,
    checks: inputData.checks,
    judgments: inputData.judgments,
    questions: inputData.questions,
    nextSteps: inputData.nextSteps,
  }),
});

export const deliveryReleaseGateWorkflow = createWorkflow({
  id: 'delivery-release-gate',
  description: 'Collect release evidence, run tester release-gate retries, and persist release readiness state.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(prepareReleaseGateLoopStep)
  .dountil(executeReleaseGateAttemptStep, async ({ inputData }) => inputData.terminal)
  .then(finalizeReleaseGateLoopStep)
  .then(syncReleaseGateStateStep)
  .commit();

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

export const deliveryWorkflow = createWorkflow({
  id: 'delivery-workflow',
  description:
    'Native Delivery Engine workflow: initialize run state, plan, review, build, release-gate, deploy, and finish.',
  inputSchema: deliveryWorkflowInputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(deliveryPlanningWorkflow)
  .then(createScaffoldArtifactsStep)
  .then(deliveryReviewWorkflow)
  .then(deliveryBuildWorkflow)
  .then(deliveryReleaseGateWorkflow)
  .then(deliveryDeploymentWorkflow)
  .commit();
