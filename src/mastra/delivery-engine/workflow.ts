import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { createStep, createWorkflow, type WorkflowErrorCallbackInfo } from '@mastra/core/workflows';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  finishDeliveryRunState,
  readDeliveryEventsState,
  initializeDeliveryRunState,
  readDeliveryRunState,
  recordDeliveryArtifactState,
  recordDeliveryJudgmentState,
  startDeliveryStageState,
  updateDeliveryTaskState,
} from './state-service';
import { finishDeliveryRun, readDeliveryEvents, readDeliveryRun, writeDeliveryArtifact, type DeliveryRunStatus } from './state';
import {
  dependencyGraphAcyclic,
  fileOwnership,
  matchesAny,
  noBcryptWeakHash,
  normalizeDeliveryPathReference,
  planSchemaComplete,
  runDeterministicCheck,
  stageSlice,
  type DeliveryEvent,
} from './checks';
import { createDeliveryControlRequestContext, createDeliveryRequestContext } from './context';
import { deliveryRunMemory } from './memory';
import {
  aggregateJudgment,
  buildJudgeArtifactPrompt,
  deterministicCheckNameForGate,
  judgeOutputSchemaForRubric,
  loadDeliveryEngineRubric,
  type AggregatedJudgment,
  type DeterministicGateResult,
  type JudgeOutput,
  type Rubric,
} from './judgment';
import {
  deliveryBuildStepScorers,
  deliveryDeploymentStepScorers,
  deliveryPlanStepScorers,
  deliveryReleaseGateStepScorers,
  deliveryReviewStepScorers,
} from './scorers';
import { safePersistDeliveryStateWithMastra } from './observability';
import { deliveryStructuredOutputOptions } from './models';
import { parseDeliveryStructuredOutput } from './structured-output';
import {
  isApiRouteBehaviorAcceptanceCriterion,
  isBehaviorLikeAcceptanceCriterion,
} from './acceptance-evidence-policy';
import {
  deliveryWorkflowInputSchema,
  normalizeDeliveryWorkflowInput,
} from './run-input';
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
  implementationNoteSchema,
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
  testerOutputSchema,
  workflowOutputSchema,
  type CheckSummary,
  type DeliveryWorkflowState,
  type DeploymentReport,
  type ImplementationNote,
  type JudgmentRef,
  type Readout,
  type ReleaseGate,
  type ReviewReport,
  type SourcePolicy,
  type Task,
  type TaskPlan,
} from './workflow-schemas';
import {
  acceptanceContractReferences,
  acceptanceContractsForCriteria,
  canonicalRootWorkerScaffoldAcceptanceCriteria,
  verificationWithAcceptanceContractGaps,
  workerScaffoldAcceptanceContractIdForCriterion,
} from './acceptance-contracts';
import {
  runHttpProbe,
  type ReleaseGateHttpProbeResult,
  type ReleaseGateProcessCommand,
  type ReleaseGateRuntimeProbePlan,
} from './release-gate-probes';
import {
  releaseGateEvidenceCommandPlanFromOptions,
  releaseGateLocalD1DatabaseName as releaseGateLocalD1DatabaseNameBase,
  releaseGateMigrationText as releaseGateMigrationTextBase,
  releaseGateRequiredStaticEvidenceFailures as releaseGateRequiredStaticEvidenceFailuresBase,
  releaseGateStaticEvidenceResultsFromOptions,
  releaseGateWorkerDeployDryRunCommand as releaseGateWorkerDeployDryRunCommandBase,
  releaseGateWorkerDevCommand as releaseGateWorkerDevCommandBase,
  releaseGateWorkerStartupCheckCommand as releaseGateWorkerStartupCheckCommandBase,
  releaseGateWorkerTypesCheckCommand as releaseGateWorkerTypesCheckCommandBase,
  type ReleaseGateEvidence,
  type ReleaseGateEvidenceCommand,
  type ReleaseGateEvidenceResult,
} from './release-gate-command-plan';
import {
  buildVerificationCommandPlan as buildVerificationCommandPlanBase,
  buildVerificationCommandPlans as buildVerificationCommandPlansBase,
  deploymentReportSuccessNextSteps as deploymentReportSuccessNextStepsBase,
  localDeploymentReportFromReleaseGateEvidence as localDeploymentReportFromReleaseGateEvidenceBase,
  packageVerificationScripts,
  productionDeploymentReportFromWranglerResult as productionDeploymentReportFromWranglerResultBase,
  productionWranglerDeployCommand as productionWranglerDeployCommandBase,
  wranglerDeployRevision,
  wranglerDeployUrls,
} from './build-deployment-policy';
import {
  buildTimeoutRemediation as buildTimeoutRemediationForTaskId,
  canSalvageTimedOutBuildAttempt as canSalvageTimedOutBuildAttemptBase,
  implementationFailureClass as implementationFailureClassBase,
  implementationRetryMode as implementationRetryModeBase,
  implementationToolChoiceForRetryMode as implementationToolChoiceForRetryModeBase,
  outOfPlanVerificationFailurePathsFromTasks,
  remediationHasVerificationFailure as remediationHasVerificationFailureBase,
  staleDownstreamVerificationSurfacePathsFromOrderedTasks,
  staleWorkspaceVerificationRemediation as staleWorkspaceVerificationRemediationFromTasks,
  typeScriptDiagnosticsFromRemediation as typeScriptDiagnosticsFromRemediationBase,
  typeScriptDiagnosticsFromText as typeScriptDiagnosticsFromTextBase,
  verificationFailureSummaryFromCommandError,
  type TypeScriptDiagnostic,
} from './implementation-retry-policy';
import {
  buildReleaseGateRuntimeProbePlan,
  releaseGateRuntimeProbePlanRequiresAdminSecret as runtimeProbePlanRequiresAdminSecret,
  type ReleaseGatePublicAssetProbeFile,
} from './release-gate-runtime-probe-plan';
import {
  routeIntegrationCriterion,
  sessionRouteCriteria,
  sourceScopedDeliveryContracts,
  taskPlanSourceContractCriteria as sourceTaskPlanContractCriteria,
  type SourceScopedDeliveryContracts,
} from './task-plan-source-contracts';
import {
  finalGeneratedSliceTaskId,
  generatedSliceAcceptanceCriterion,
  generatedSliceDependencyHygiene as generatedSliceDependencyHygieneWithPolicy,
  generatedSliceFamilyId,
  generatedSliceFamilyTasks,
  normalizeTaskPlanGeneratedSliceDependencies as normalizeGeneratedSliceDependencies,
} from './task-plan-generated-slices';
import {
  appendDependencies,
  insertTaskAfterDependencies,
  moveTaskAfterDependencies,
  taskCanDependOnTaskList,
  taskCanSafelyDependOn,
  taskDependsOn,
  taskListDependsOn,
  withoutCyclicDependencies as withoutCyclicTaskDependencies,
} from './task-plan-dependencies';
import {
  releaseGateTranscriptFixtureAvailable as transcriptFixtureAvailable,
  releaseGateTranscriptFixtureSchemaGaps as transcriptFixtureSchemaGaps,
  releaseGateTranscriptVersionAuditSql,
  writeReleaseGateTranscriptFixtureFile,
} from './release-gate-transcript-fixture';
import { appendBoundedOutput, availableTcpPort, delay, stopChildProcess } from './process-utils';
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
import {
  missingInstalledPackageNames as workerMissingInstalledPackageNames,
  packageDependencyNames,
  repoUsesTypeScriptWorkerSource as workerRepoUsesTypeScriptWorkerSource,
  workerConfigHygieneGaps as workerConfigHygieneGapsWithGuards,
  workerConfigPath as releaseGateWorkerConfigPath,
  workerConfigSurfacePaths,
  workerConfigTaskPacketPolicy as workerConfigTaskPacketPolicyBase,
  workerEnvBindingAlignmentGaps as workerEnvBindingAlignmentGapsBase,
  workerPackageScaffoldGaps as workerPackageScaffoldGapsWithGuards,
  workersAiBindingGaps as workersAiBindingGapsWithGuards,
  wranglerConfigHasWorkersAiBinding as wranglerConfigHasWorkersAiBindingBase,
  type WorkerHygieneTaskGuards,
} from './worker-hygiene';

export {
  sourceDocumentsDeclareExternalServiceBindings,
  sourceDocumentsDeclareLatestTranscriptContract,
  sourceDocumentsDeclarePages,
  sourceDocumentsDeclareShortLinkLifecycle,
  sourceDocumentsRequiredProfileKinds,
} from './source-policy';

const execFileAsync = promisify(execFile);

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function workflowErrorFailure(error: WorkflowErrorCallbackInfo['error']) {
  const name = stringField(error?.name) ?? 'WorkflowError';
  const message = stringField(error?.message) ?? 'Delivery workflow failed without a serialized error message.';
  return { name, message };
}

function initializedDeliveryRunFailureTarget(errorInfo: WorkflowErrorCallbackInfo) {
  const state = errorInfo.state as Record<string, unknown> | undefined;
  const initData = errorInfo.getInitData?.() as Record<string, unknown> | undefined;
  const repoPath =
    stringField(state?.repoPath) ??
    stringField(state?.projectFolder) ??
    stringField(initData?.repoPath) ??
    stringField(initData?.projectFolder);
  const runId = stringField(state?.runId);

  if (!repoPath || !runId) return undefined;
  return { repoPath, runId };
}

export async function markDeliveryRunFailedOnWorkflowError(errorInfo: WorkflowErrorCallbackInfo) {
  const target = initializedDeliveryRunFailureTarget(errorInfo);
  if (!target) {
    errorInfo.logger.warn('Delivery workflow failed before an initialized delivery run was available', {
      workflowId: errorInfo.workflowId,
      runId: errorInfo.runId,
      resourceId: errorInfo.resourceId,
      error: errorInfo.error?.message,
    });
    return;
  }

  const currentRun = readDeliveryRun(target.repoPath);
  if (currentRun.run_id !== target.runId) {
    errorInfo.logger.warn('Delivery workflow failure did not match the active local delivery run', {
      workflowId: errorInfo.workflowId,
      workflowRunId: errorInfo.runId,
      deliveryRunId: target.runId,
      activeDeliveryRunId: currentRun.run_id,
      repoPath: target.repoPath,
    });
    return;
  }

  const failure = workflowErrorFailure(errorInfo.error);
  try {
    await finishDeliveryRunState({
      repoPath: target.repoPath,
      status: 'failed',
      summary: `Delivery workflow failed: ${failure.message}`,
      failure,
      mastra: errorInfo.mastra,
    });
  } catch (stateError) {
    errorInfo.logger.warn('Failed to mark delivery run failed through Mastra-backed state service; falling back locally', {
      repoPath: target.repoPath,
      deliveryRunId: target.runId,
      error: stateError instanceof Error ? stateError.message : String(stateError),
    });
    finishDeliveryRun({
      repoPath: target.repoPath,
      status: 'failed',
      summary: `Delivery workflow failed: ${failure.message}`,
      failure,
    });
  }

  await safePersistDeliveryStateWithMastra({ repoPath: target.repoPath, mastra: errorInfo.mastra });
}

function compactDiagnostic(error: unknown, limit = 600) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > limit ? `${text.slice(0, limit)}... (${text.length} chars total)` : text;
}

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

function parsePlannerRevisionResponse(response: unknown, label: string) {
  try {
    return {
      revision: parseDeliveryStructuredOutput(plannerRevisionOutputSchema, response, label),
      repairedFromBareTaskPlan: false,
    };
  } catch (error) {
    const taskPlan = parseDeliveryStructuredOutput(taskPlanSchema, response, `${label} taskPlan`);
    return {
      revision: { taskPlan },
      repairedFromBareTaskPlan: true,
      repairReason: compactDiagnostic(error),
    };
  }
}

const normalizeDeliveryWorkflowState = (state?: Partial<DeliveryWorkflowState>): DeliveryWorkflowState => ({
  repoPath: state?.repoPath,
  runId: state?.runId,
  status: state?.status,
  summary: state?.summary,
  maxRetries: state?.maxRetries,
  deployMode: state?.deployMode,
  reviewMode: state?.reviewMode,
  artifacts: state?.artifacts ?? [],
  checks: state?.checks ?? [],
  judgments: state?.judgments ?? [],
  questions: state?.questions ?? [],
  nextSteps: state?.nextSteps ?? [],
  sourcePolicy: state?.sourcePolicy,
  scaffoldManifest: state?.scaffoldManifest,
  scaffoldManifestPath: state?.scaffoldManifestPath,
  taskPlan: state?.taskPlan,
  releaseGate: state?.releaseGate,
  deploymentReport: state?.deploymentReport,
  deploymentReportPath: state?.deploymentReportPath,
});

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

async function syncDeliveryWorkflowState({
  state,
  setState,
  output,
}: {
  state?: Partial<DeliveryWorkflowState>;
  setState: (state: DeliveryWorkflowState) => Promise<void> | void;
  output: Partial<DeliveryWorkflowState> & {
    repoPath?: string;
    runId?: string;
    status?: DeliveryWorkflowState['status'];
    summary?: string;
    artifacts?: string[];
    checks?: CheckSummary[];
    judgments?: JudgmentRef[];
    questions?: string[];
    nextSteps?: string[];
  };
}) {
  const current = normalizeDeliveryWorkflowState(state);
  await setState({
    ...current,
    repoPath: output.repoPath ?? current.repoPath,
    runId: output.runId ?? current.runId,
    status: output.status ?? current.status,
    summary: output.summary ?? current.summary,
    maxRetries: output.maxRetries ?? current.maxRetries,
    deployMode: output.deployMode ?? current.deployMode,
    reviewMode: output.reviewMode ?? current.reviewMode,
    artifacts: output.artifacts ?? current.artifacts,
    checks: output.checks ?? current.checks,
    judgments: output.judgments ?? current.judgments,
    questions: output.questions ?? current.questions,
    nextSteps: output.nextSteps ?? current.nextSteps,
    sourcePolicy: output.sourcePolicy ?? current.sourcePolicy,
    scaffoldManifest: output.scaffoldManifest ?? current.scaffoldManifest,
    scaffoldManifestPath: output.scaffoldManifestPath ?? current.scaffoldManifestPath,
    taskPlan: output.taskPlan ?? current.taskPlan,
    releaseGate: output.releaseGate ?? current.releaseGate,
    deploymentReport: output.deploymentReport ?? current.deploymentReport,
    deploymentReportPath: output.deploymentReportPath ?? current.deploymentReportPath,
  });
}

const checkSummaries = (results: DeterministicGateResult[], suffix?: string): CheckSummary[] =>
  results.map((check) => ({
    check: `${check.check ?? check.id ?? 'unknown'}${suffix ? `:${suffix}` : ''}`,
    passed: check.passed,
    reason: check.reason ?? 'deterministic check',
  }));

const openDecisionRequiredFields = ['topic', 'why it matters', 'options considered', 'follow-up impact'];

function hasOpenDecisionField(decision: string, field: string) {
  return new RegExp(`\\b${field.replaceAll(' ', '\\s+')}\\s*:`, 'i').test(decision);
}

function looksLikeSafeAssumptionOrRisk(decision: string) {
  return (
    /\bconfirm only if\b/i.test(decision) ||
    /\bdefault assumed\b/i.test(decision) ||
    /\bsafe assumption\b/i.test(decision) ||
    /\bwatch\b|\brisk\b/i.test(decision) ||
    /\bwhether\b.*\b(or simply|or only|can be|could be|should simply)\b/i.test(decision)
  );
}

function looksLikeSettledDeliveryPolicy(decision: string) {
  return (
    /\b(?:Pages Functions?|Cloudflare Pages)\b[\s\S]{0,80}\bWorkers?\b/i.test(decision) ||
    /\bWorkers?\b[\s\S]{0,80}\b(?:Pages Functions?|Cloudflare Pages)\b/i.test(decision) ||
    /\b(?:React|Next\.?js|Vue|Svelte|JSX|TSX|Vite|frontend framework)\b/i.test(decision) ||
    /\bGitHub Actions?\b[\s\S]{0,80}\bdeploy/i.test(decision) ||
    /\bdeploy\b[\s\S]{0,80}\bGitHub Actions?\b/i.test(decision) ||
    /\bWrangler\b[\s\S]{0,80}\bdeploy/i.test(decision) ||
    /\bWorkers AI\b[\s\S]{0,80}\bbinding\b/i.test(decision) ||
    /\blocal validation\b|\bproduction approval\b/i.test(decision)
  );
}

function namesTaskScopedBlocker(decision: string) {
  return /\bblocks?\s+T\d[\w-]*\b/i.test(decision) || /\bbefore\s+T\d[\w-]*\b/i.test(decision);
}

function looksLikeSafeExternalServiceAdapterAmbiguity(question: string) {
  return (
    /\b(?:external\s+Worker\s+service|Worker\s+service|service\s+binding|env\.[A-Z][A-Z0-9_]*)\b/i.test(question) &&
    /\b(endpoint|RPC|method|path|parameters?|response envelope|contract|date-window|date window|API shape)\b/i.test(question)
  );
}

export function normalizeReadoutSafeAdapterAmbiguities(readout: Readout) {
  const safeAdapterQuestions = readout.blocking_ambiguities.filter(looksLikeSafeExternalServiceAdapterAmbiguity);
  if (!safeAdapterQuestions.length) return readout;

  const blocking_ambiguities = readout.blocking_ambiguities.filter(
    (question) => !looksLikeSafeExternalServiceAdapterAmbiguity(question),
  );
  const safeAssumptions = safeAdapterQuestions.map(
    (question) =>
      `Safe adapter default: ${question} Proceed with a small typed adapter around the source-declared external Worker service binding; keep the assumed request/response shape isolated and document the contract risk instead of blocking unrelated delivery work.`,
  );

  return {
    ...readout,
    blocking_ambiguities,
    safe_assumptions: Array.from(new Set([...readout.safe_assumptions, ...safeAssumptions])),
  };
}

export function openDecisionHygiene(taskPlan: TaskPlan) {
  for (const [index, decision] of taskPlan.open_decisions.entries()) {
    const missingFields = openDecisionRequiredFields.filter((field) => !hasOpenDecisionField(decision, field));
    if (missingFields.length) {
      return {
        passed: false,
        reason: `open_decisions[${index}] is not decision-shaped; include Topic, Why it matters, Options considered, and Follow-up impact.`,
      };
    }

    if (looksLikeSettledDeliveryPolicy(decision)) {
      return {
        passed: false,
        reason: `open_decisions[${index}] asks about settled delivery policy; move it to readout.safe_assumptions or taskPlan.risks and proceed with the Worker-first defaults.`,
      };
    }

    if (looksLikeSafeAssumptionOrRisk(decision) && !namesTaskScopedBlocker(decision)) {
      return {
        passed: false,
        reason: `open_decisions[${index}] appears to be a safe assumption or risk, not a blocker; move it to readout.safe_assumptions or taskPlan.risks.`,
      };
    }

    if (!/\b(blocks?|blocked|cannot|prevents?|required before|must be resolved before|implementation impossible)\b/i.test(decision)) {
      return {
        passed: false,
        reason: `open_decisions[${index}] does not explain what implementation work it blocks.`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

function taskPlanPagesFunctionSurfaces(taskPlan: TaskPlan) {
  return taskPlan.tasks.flatMap((task) =>
    effectiveOwnedSurfaces(task)
      .map(normalizeDeliveryPathReference)
      .filter((surface) => surface === 'functions' || surface.startsWith('functions/'))
      .map((surface) => `${task.id}:${surface}`),
  );
}

export function pagesFunctionsExceptionHygiene(taskPlan: TaskPlan, sourcePolicy?: SourcePolicy) {
  const pagesSurfaces = taskPlanPagesFunctionSurfaces(taskPlan);
  if (!pagesSurfaces.length) return { passed: true, reason: 'ok' };
  if (sourcePolicy?.pagesRequired) return { passed: true, reason: 'ok' };

  return {
    passed: false,
    reason: `Task plan owns Pages Functions surfaces (${pagesSurfaces.join(', ')}), but vision/spec did not declaratively require Cloudflare Pages. Use standalone Worker routes under src/ or workers/ unless the source docs explicitly say to use Pages.`,
  };
}

const knownRootPathSurfaces = new Set([
  '.env.example',
  '.gitignore',
  'package.json',
  'package-lock.json',
  'README.md',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml',
]);

function looksLikeRepoPathReference(surface: string) {
  const path = normalizeDeliveryPathReference(surface);
  if (!path || /\s/.test(path)) return false;
  if (knownRootPathSurfaces.has(path)) return true;
  if (path.includes('/')) return true;
  return /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(path);
}

function ownedSurfaceReferenceIsConcrete(surface: string) {
  const normalized = normalizeDeliveryPathReference(surface);
  if (/^unknown:\s*\S/i.test(normalized)) return true;
  return looksLikeRepoPathReference(normalized);
}

function ownedSurfaceReferenceIsWildcard(surface: string) {
  const normalized = normalizeDeliveryPathReference(surface);
  if (/^unknown:/i.test(normalized)) return false;
  return /[*?]/.test(normalized);
}

export function ownedSurfaceHygiene(taskPlan: TaskPlan) {
  for (const task of taskPlan.tasks) {
    for (const surface of task.owned_surfaces) {
      if (ownedSurfaceReferenceIsWildcard(surface)) {
        return {
          passed: false,
          reason: `${task.id} owned_surfaces contains wildcard surface "${surface}". Enumerate concrete file paths so missing files, boundaries, and handoffs can be verified deterministically; use "unknown: <why>" only when a path is genuinely unknowable.`,
        };
      }
      if (ownedSurfaceReferenceIsConcrete(surface)) continue;
      return {
        passed: false,
        reason: `${task.id} owned_surfaces contains conceptual surface "${surface}". Use concrete repo paths like wrangler.jsonc, src/index.ts, public/settings.html, migrations/0001_schema.sql, or "unknown: <reason>".`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

function normalizedOwnedSurfaces(task: Task) {
  return task.owned_surfaces.map((surface) => normalizeDeliveryPathReference(surface)).filter(Boolean);
}

function taskSourceTaskId(task: Task) {
  return task.source_task_id?.trim() || task.id;
}

function taskAcceptanceContractCriteria(task: Task) {
  return Array.from(new Set([...(task.source_acceptance_criteria ?? []), ...task.acceptance_criteria].filter(Boolean)));
}

function generatedWorkerTypeOwnershipCriterion(criterion: string) {
  return (
    /\bworker-configuration\.d\.ts\b/i.test(criterion) &&
    /\b(?:engineer-owned|owned generated|committed as part of the scaffold contract|concrete project file rather than relying on an unowned generated artifact)\b/i.test(
      criterion,
    )
  );
}

function withoutGeneratedWorkerTypeOwnership(task: Task) {
  const owned_surfaces = task.owned_surfaces.filter(
    (surface) => normalizeDeliveryPathReference(surface) !== workerConfigTaskPacketPolicy().generated_types.output,
  );
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !generatedWorkerTypeOwnershipCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !generatedWorkerTypeOwnershipCriterion(criterion),
  );

  const unchanged =
    owned_surfaces.length === task.owned_surfaces.length &&
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0);

  if (unchanged) return task;

  return {
    ...task,
    owned_surfaces,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function sourceAcceptanceCriterionBelongsToTask(task: Task, criterion: string) {
  if (generatedSliceAcceptanceCriterion(criterion)) return false;
  if (routeEndpointContractCriterion(criterion)) return routeEndpointCriterionBelongsToTask(task, criterion);

  const references = acceptanceContractReferences(criterion).map(normalizeDeliveryPathReference);
  if (!references.length) return false;

  const owned = new Set(normalizedOwnedSurfaces(task));
  return references.every((reference) => owned.has(reference));
}

function taskVerificationAcceptanceContractCriteria(task: Task) {
  return Array.from(
    new Set([
      ...(task.source_acceptance_criteria ?? []).filter((criterion) => sourceAcceptanceCriterionBelongsToTask(task, criterion)),
      ...task.acceptance_criteria.filter((criterion) => !generatedSliceAcceptanceCriterion(criterion)),
    ]),
  );
}

function acceptanceContractId(task: Task, index: number, criterion?: string) {
  const registryId = criterion ? workerScaffoldAcceptanceContractIdForCriterion(criterion) : undefined;
  if (registryId) return `${taskSourceTaskId(task)}:${registryId}`;
  return `${taskSourceTaskId(task)}-AC${String(index + 1).padStart(2, '0')}`;
}

function ownsExactSurface(task: Task, path: string) {
  return normalizedOwnedSurfaces(task).includes(path);
}

function taskOwnsAnyExactSurface(task: Task, paths: readonly string[]) {
  return paths.some((path) => ownsExactSurface(task, path));
}

function ownsPackageScaffold(task: Task) {
  return ownsExactSurface(task, 'package.json');
}

function ownsWorkerConfigSurface(task: Task) {
  return taskOwnsAnyExactSurface(task, workerConfigSurfacePaths);
}

function isWorkerConfigSurfacePath(path: string) {
  return (workerConfigSurfacePaths as readonly string[]).includes(path);
}

function normalizeScaffoldRootTask(repoPath: string, task: Task, includeWorkerConfig: boolean) {
  const ownedSurfaces = [...task.owned_surfaces];
  const acceptanceCriteria = [...task.acceptance_criteria];
  const typeScriptScaffold = ownsTypeScriptInputSurface(task);

  if (!ownsExactSurface(task, '.gitignore')) {
    ownedSurfaces.push('.gitignore');
  }

  if (includeWorkerConfig && !releaseGateWorkerConfigPath(repoPath) && !ownsWorkerConfigSurface(task)) {
    ownedSurfaces.push('wrangler.jsonc');
  }

  if (typeScriptScaffold && !ownsExactSurface(task, 'tsconfig.json')) {
    ownedSurfaces.push('tsconfig.json');
  }

  if (ownsJavaScriptInputSurface(task) && !typeScriptScaffold) {
    if (!ownsExactSurface(task, 'scripts/check-js.js')) {
      ownedSurfaces.push('scripts/check-js.js');
    }
  }

  const normalizedSurfaces = Array.from(new Set(ownedSurfaces.map(normalizeDeliveryPathReference).filter(Boolean)));
  const entrypointSurface = normalizedSurfaces.find((surface) => /^src\/index\.(?:js|ts)$/.test(surface));
  acceptanceCriteria.push(
    ...canonicalRootWorkerScaffoldAcceptanceCriteria({
      entrypointSurface,
      ownsGitignore: normalizedSurfaces.includes('.gitignore'),
      ownsPackage: normalizedSurfaces.includes('package.json'),
      ownsWorkerConfig: normalizedSurfaces.some(isWorkerConfigSurfacePath),
      typeScript: typeScriptScaffold,
    }),
  );

  return {
    ...task,
    owned_surfaces: Array.from(new Set(ownedSurfaces)),
    acceptance_criteria: Array.from(new Set(acceptanceCriteria)),
  };
}

function workerSourceSurfaceIsTypeScript(surface: string) {
  const normalized = surface.toLowerCase();
  if (/\.d\.(?:ts|mts|cts)$/.test(normalized)) return false;
  return /\.(?:ts|tsx|mts|cts)$/.test(normalized);
}

function workerSourceSurfaceIsJavaScript(surface: string) {
  return /\.(?:js|mjs|cjs)$/.test(surface.toLowerCase());
}

function workerSourceSurfaceIsJavaScriptOrTypeScript(surface: string) {
  return /\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/.test(surface);
}

function workerSourceSurfaceIsConcrete(surface: string) {
  if (surface === 'src/**' || surface === 'workers/**') return true;
  if (surface === 'worker.js' || surface === 'worker.mjs' || surface === 'worker.ts') return true;
  return (
    (surface.startsWith('src/') || surface.startsWith('workers/')) &&
    workerSourceSurfaceIsJavaScriptOrTypeScript(surface)
  );
}

function ownsWorkerSourceInputSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(workerSourceSurfaceIsConcrete);
}

function ownsJavaScriptInputSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) =>
      surface === 'src/**' ||
      surface === 'workers/**' ||
      (surface.startsWith('src/') || surface.startsWith('workers/') || surface.startsWith('worker.')) &&
        workerSourceSurfaceIsJavaScript(surface),
  );
}

function ownsTypeScriptInputSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) =>
      surface === 'src/**' ||
      surface === 'workers/**' ||
      (surface.startsWith('src/') || surface.startsWith('workers/') || surface.startsWith('worker.')) &&
        workerSourceSurfaceIsTypeScript(surface),
  );
}

function ownsWorkerRuntimeSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) =>
      surface === 'wrangler.toml' ||
      surface === 'wrangler.json' ||
      surface === 'wrangler.jsonc' ||
      surface === 'src/**' ||
      surface === 'workers/**' ||
      surface === 'worker.js' ||
      surface === 'worker.mjs' ||
      surface === 'worker.ts' ||
      surface.startsWith('src/') ||
      surface.startsWith('workers/') ||
      surface.startsWith('public/') ||
      surface.startsWith('migrations/'),
  );
}

export function normalizeTaskPlanScaffoldDependencies(repoPath: string, taskPlan: TaskPlan): TaskPlan {
  if (existsSync(join(repoPath, 'package.json'))) return taskPlan;
  if (!taskPlan.tasks.some(ownsWorkerRuntimeSurface)) return taskPlan;

  const rootTasks = taskPlan.tasks.filter((task) => task.depends_on.length === 0);
  const scaffoldRootTask = rootTasks.find((task) => ownsPackageScaffold(task) && ownsWorkerSourceInputSurface(task));
  if (!scaffoldRootTask) return taskPlan;

  let changed = false;
  const planAlreadyOwnsWorkerConfig = taskPlan.tasks.some(ownsWorkerConfigSurface);
  const tasks = taskPlan.tasks.map((task) => {
    if (task.id === scaffoldRootTask.id) {
      const normalizedTask = normalizeScaffoldRootTask(repoPath, task, !planAlreadyOwnsWorkerConfig);
      if (normalizedTask !== task) changed = true;
      return normalizedTask;
    }
    if (task.depends_on.length > 0 || !ownsWorkerRuntimeSurface(task) || ownsPackageScaffold(task)) {
      return task;
    }

    changed = true;
    return {
      ...task,
      depends_on: [scaffoldRootTask.id],
    };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

const profileContractProducerSurfaces = [
  'src/validation.ts',
  'src/contracts.ts',
  'src/domain.ts',
  'src/domain/profileKinds.ts',
  'src/domain/profile.ts',
  'src/domain/profiles.ts',
  'src/domain/profileArtifacts.ts',
];
const profileContractConsumerSurfaces = ['migrations/0001_schema.sql', 'src/storage/profiles.ts', 'src/routes/profiles.ts'];

function profileContractProducerTask(taskPlan: TaskPlan) {
  return taskPlan.tasks.find((task) => taskOwnsAnyExactSurface(task, profileContractProducerSurfaces));
}

function profileContractConsumerTasks(taskPlan: TaskPlan) {
  return taskPlan.tasks.filter(
    (task) => taskOwnsAnyExactSurface(task, profileContractConsumerSurfaces) || taskOwnsD1MigrationFile(task),
  );
}

export function normalizeTaskPlanProfileContractDependencies(taskPlan: TaskPlan): TaskPlan {
  const producer = profileContractProducerTask(taskPlan);
  if (!producer) return taskPlan;

  let changed = false;
  const tasks = taskPlan.tasks.map((task) => {
    if (!profileContractConsumerTasks(taskPlan).some((consumer) => consumer.id === task.id)) return task;
    if (taskDependsOn(taskPlan, task.id, producer.id)) return task;
    if (!taskCanSafelyDependOn(taskPlan, task.id, producer.id)) return task;

    changed = true;
    return {
      ...task,
      depends_on: [...task.depends_on, producer.id],
    };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

export function profileContractDependencyHygiene(taskPlan: TaskPlan) {
  const producer = profileContractProducerTask(taskPlan);
  if (!producer) return { passed: true, reason: 'ok' };

  for (const task of profileContractConsumerTasks(taskPlan)) {
    if (taskDependsOn(taskPlan, task.id, producer.id)) continue;
    return {
      passed: false,
      reason: `${task.id} owns a profile contract consumer surface but does not depend_on ${producer.id}. Schema, storage, and profile routes must run after the validation/domain contract so profile kind values stay aligned.`,
    };
  }

  return { passed: true, reason: 'ok' };
}

function taskOwnedBoundaryPaths(task: Task) {
  return normalizedOwnedSurfaces(task).map(concreteOwnedSurfacePath).filter((path): path is string => Boolean(path));
}

function taskOwnsStatePersistenceSurface(task?: Task) {
  if (!task) return true;
  return taskOwnedBoundaryPaths(task).some(
    (path) =>
      path.startsWith('migrations/') ||
      path.startsWith('src/storage/') ||
      path.startsWith('src/workflows/') ||
      /\bdurable|do-state|state-store\b/i.test(path),
  );
}

export function taskOwnedSurfaceRoleHygiene(taskPlan: TaskPlan) {
  for (const task of taskPlan.tasks) {
    const paths = taskOwnedBoundaryPaths(task);
    if (!paths.length) continue;

    const ownership = fileOwnership({ role: task.owner, paths });
    if (!ownership.passed) {
      return {
        passed: false,
        reason: `${task.id} owner ${task.owner} cannot own one or more surfaces: ${ownership.reason}`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

function designerCanOwnSurface(path: string) {
  return fileOwnership({ role: 'designer', paths: [path] }).passed;
}

function engineerCanOwnSurface(path: string) {
  return fileOwnership({ role: 'engineer', paths: [path] }).passed;
}

export function normalizeTaskPlanRoleBoundaries(taskPlan: TaskPlan): TaskPlan {
  const designerOwnedPaths = new Set(
    taskPlan.tasks
      .filter((task) => task.owner === 'designer')
      .flatMap(taskOwnedBoundaryPaths),
  );

  let changed = false;
  const tasks = taskPlan.tasks.map((task) => {
    if (task.owner !== 'engineer') return task;

    const boundaryPaths = taskOwnedBoundaryPaths(task);
    if (
      boundaryPaths.length > 0 &&
      boundaryPaths.every((path) => !engineerCanOwnSurface(path) && designerCanOwnSurface(path))
    ) {
      changed = true;
      return {
        ...task,
        owner: 'designer' as const,
      };
    }

    const misplacedPaths = new Set(
      boundaryPaths.filter(
        (path) => !engineerCanOwnSurface(path) && designerCanOwnSurface(path) && designerOwnedPaths.has(path),
      ),
    );
    if (!misplacedPaths.size) return task;

    const owned_surfaces = task.owned_surfaces.filter((surface) => {
      const path = concreteOwnedSurfacePath(surface);
      return !path || !misplacedPaths.has(path);
    });
    if (!owned_surfaces.length) return task;

    const acceptance_criteria = task.acceptance_criteria.filter(
      (criterion) => !Array.from(misplacedPaths).some((path) => criterion.includes(path)),
    );

    changed = true;
    return {
      ...task,
      owned_surfaces,
      acceptance_criteria: acceptance_criteria.length ? acceptance_criteria : task.acceptance_criteria,
    };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

const maxImplementationOwnedSurfacesPerTask = 2;
const minImplementationOwnedSurfacesToSplit = 3;

function splittableImplementationSurfacePath(surface: string) {
  const path = concreteOwnedSurfacePath(surface);
  if (!path) return undefined;
  if (path === 'src/index.ts') return undefined;
  if (path === 'package.json' || path === 'tsconfig.json' || path === 'wrangler.toml') return undefined;
  if (path.startsWith('migrations/')) return undefined;
  if (path.startsWith('src/') && /\.[cm]?[jt]s$/.test(path)) return path;
  return undefined;
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function taskIsLargeImplementationTask(task: Task) {
  const surfaces = task.owned_surfaces.map(splittableImplementationSurfacePath);
  return (
    task.owner === 'engineer' &&
    surfaces.length >= minImplementationOwnedSurfacesToSplit &&
    surfaces.every(Boolean)
  );
}

function implementationSliceAcceptanceCriteria(task: Task, surfaces: string[], sliceNumber: number, sliceCount: number) {
  const paths = surfaces.map(
    (surface) => splittableImplementationSurfacePath(surface) ?? normalizeDeliveryPathReference(surface),
  );
  return [
    `Implement delivery slice ${sliceNumber}/${sliceCount}: ${paths.join(', ')}.`,
    `Replace any preflight stubs for this slice with real implementation code before returning.`,
    `Keep this slice compatible with previously completed delivery slices and npm run typecheck.`,
    ...task.acceptance_criteria.filter((criterion) => paths.some((path) => criterion.includes(path))),
  ];
}

function splitLargeImplementationTask(task: Task) {
  if (!taskIsLargeImplementationTask(task)) return [task];

  const chunks = chunkItems(task.owned_surfaces, maxImplementationOwnedSurfacesPerTask);
  const sourceTaskId = taskSourceTaskId(task);
  const sourceAcceptanceCriteria = taskAcceptanceContractCriteria(task);
  return chunks.map((surfaces, index) => {
    const sliceNumber = index + 1;
    const previousSliceId = index === 1 ? task.id : `${task.id}-part-${index}`;
    return {
      ...task,
      id: index === 0 ? task.id : `${task.id}-part-${sliceNumber}`,
      deliverable: `${task.deliverable} (delivery slice ${sliceNumber}/${chunks.length})`,
      depends_on: index === 0 ? task.depends_on : [previousSliceId],
      acceptance_criteria: implementationSliceAcceptanceCriteria(task, surfaces, sliceNumber, chunks.length),
      owned_surfaces: surfaces,
      source_task_id: sourceTaskId,
      source_acceptance_criteria: sourceAcceptanceCriteria,
    };
  });
}

export function normalizeTaskPlanLargeStorageTasks(taskPlan: TaskPlan): TaskPlan {
  const expandedTasks: Task[] = [];
  const splitLastTaskId = new Map<string, string>();
  const splitTaskIds = new Set<string>();
  let changed = false;

  for (const task of taskPlan.tasks) {
    const slices = splitLargeImplementationTask(task);
    expandedTasks.push(...slices);
    if (slices.length > 1) {
      changed = true;
      splitLastTaskId.set(task.id, slices[slices.length - 1].id);
      for (const slice of slices) splitTaskIds.add(slice.id);
    }
  }

  if (!changed) return taskPlan;

  const tasks = expandedTasks.map((task) => {
    if (splitTaskIds.has(task.id)) return task;

    const depends_on = Array.from(new Set(task.depends_on.map((dependency) => splitLastTaskId.get(dependency) ?? dependency)));
    if (
      depends_on.length === task.depends_on.length &&
      depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ) {
      return task;
    }

    return { ...task, depends_on };
  });

  return { ...taskPlan, tasks };
}

function taskOwnsWorkerConfigFile(task: Task) {
  return taskOwnedBoundaryPaths(task).some(isWorkerConfigSurfacePath);
}

function taskOwnsD1MigrationFile(task: Task) {
  return taskOwnedBoundaryPaths(task).some((path) => path.startsWith('migrations/') && path.endsWith('.sql'));
}

function taskD1MigrationSurface(task: Task) {
  return taskOwnedBoundaryPaths(task).find((path) => path.startsWith('migrations/') && path.endsWith('.sql'));
}

function criterionMentionsAny(criterion: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(criterion));
}

const workerConfigCriterionPatterns = [
  /\bwrangler(?:\.(?:jsonc|json|toml))?\b/i,
  /\bcompatibility_(?:date|flags?)\b/i,
  /\bnodejs_compat\b/i,
  /\bobservability\b/i,
  /\b(?:binding|bindings|vars|secrets?)\b/i,
  /\bWorkers AI\b/i,
];

const d1SchemaCriterionPatterns = [
  /\bmigrations?\b/i,
  /\bD1\b/i,
  /\bSQL\b/i,
  /\bschema\b/i,
  /\btables?\b/i,
  /\bindexes?\b/i,
];

function splitConfigSchemaAcceptanceCriteria(task: Task, kind: 'config' | 'schema') {
  const defaults =
    kind === 'config'
      ? [
          'Configure Wrangler separately from D1 schema migrations so bindings, compatibility, and observability can be validated without touching SQL.',
          'Keep Worker config aligned with current Worker policy: wrangler.jsonc for new projects, current compatibility_date, nodejs_compat, observability, and required bindings.',
        ]
      : [
          'Define D1 schema migrations separately from Worker config so SQL can be reviewed, applied, and repaired on its own.',
          'Keep migrations compatible with the Worker code and explicit D1 binding planned in Wrangler config.',
        ];
  const patterns = kind === 'config' ? workerConfigCriterionPatterns : d1SchemaCriterionPatterns;
  const matching = task.acceptance_criteria.filter((criterion) => criterionMentionsAny(criterion, patterns));
  return Array.from(new Set([...defaults, ...matching]));
}

function splitWorkerConfigAndD1SchemaTask(task: Task) {
  if (!taskOwnsWorkerConfigFile(task) || !taskOwnsD1MigrationFile(task)) return [task];

  const configSurfaces: string[] = [];
  const schemaSurfaces: string[] = [];
  const otherSurfaces: string[] = [];

  for (const surface of task.owned_surfaces) {
    const path = concreteOwnedSurfacePath(surface);
    if (path && isWorkerConfigSurfacePath(path)) {
      configSurfaces.push(surface);
    } else if (path && path.startsWith('migrations/') && path.endsWith('.sql')) {
      schemaSurfaces.push(surface);
    } else {
      otherSurfaces.push(surface);
    }
  }

  const schemaTaskId = `${task.id}-d1-schema`;
  const sourceTaskId = taskSourceTaskId(task);
  const sourceAcceptanceCriteria = taskAcceptanceContractCriteria(task);
  return [
    {
      ...task,
      deliverable: `${task.deliverable} (Worker configuration slice)`,
      acceptance_criteria: splitConfigSchemaAcceptanceCriteria(task, 'config'),
      owned_surfaces: [...configSurfaces, ...otherSurfaces],
      source_task_id: sourceTaskId,
      source_acceptance_criteria: sourceAcceptanceCriteria,
    },
    {
      ...task,
      id: schemaTaskId,
      deliverable: `${task.deliverable} (D1 schema slice)`,
      depends_on: [task.id],
      acceptance_criteria: splitConfigSchemaAcceptanceCriteria(task, 'schema'),
      owned_surfaces: schemaSurfaces,
      source_task_id: sourceTaskId,
      source_acceptance_criteria: sourceAcceptanceCriteria,
    },
  ];
}

export function normalizeTaskPlanConfigSchemaTasks(taskPlan: TaskPlan): TaskPlan {
  const expandedTasks: Task[] = [];
  const splitLastTaskId = new Map<string, string>();
  const splitTaskIds = new Set<string>();
  let changed = false;

  for (const task of taskPlan.tasks) {
    const slices = splitWorkerConfigAndD1SchemaTask(task);
    expandedTasks.push(...slices);
    if (slices.length > 1) {
      changed = true;
      splitLastTaskId.set(task.id, slices[slices.length - 1].id);
      for (const slice of slices) splitTaskIds.add(slice.id);
    }
  }

  if (!changed) return taskPlan;

  const tasks = expandedTasks.map((task) => {
    if (splitTaskIds.has(task.id)) return task;

    const depends_on = Array.from(new Set(task.depends_on.map((dependency) => splitLastTaskId.get(dependency) ?? dependency)));
    if (
      depends_on.length === task.depends_on.length &&
      depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ) {
      return task;
    }

    return { ...task, depends_on };
  });

  return { ...taskPlan, tasks };
}

export function configSchemaTaskSplitHygiene(taskPlan: TaskPlan) {
  const combinedTask = taskPlan.tasks.find((task) => taskOwnsWorkerConfigFile(task) && taskOwnsD1MigrationFile(task));
  if (!combinedTask) return { passed: true, reason: 'ok' };

  return {
    passed: false,
    reason: `${combinedTask.id} owns both Wrangler config and D1 migration files. Split Worker config and migrations into separate engineer tasks so config hygiene, SQL review, and Wrangler validation can repair independently.`,
  };
}

function taskOwnsPathMatching(task: Task, pattern: RegExp) {
  return taskOwnedBoundaryPaths(task).some((path) => pattern.test(path));
}

function taskOwnsRouterSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/);
}

function taskOwnsStaticAssetWiringSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/staticAssets\.[cm]?[jt]s$/) || taskOwnedBoundaryPaths(task).includes('wrangler.jsonc');
}

function taskOwnsRouteModule(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:routes(?:\/.*|[A-Z].*)?|[A-Za-z0-9_-]*(?:Routes|Handlers))\.[cm]?[jt]s$/i);
}

function taskOwnsGenericRouteModule(task: Task) {
  return taskOwnsPathMatching(task, /^src\/routes\.[cm]?[jt]s$/i);
}

function taskAcceptanceText(task: Task) {
  return [...task.acceptance_criteria, ...(task.source_acceptance_criteria ?? [])].join('\n');
}

function positiveTaskAcceptanceText(task: Task) {
  return taskAcceptanceText(task)
    .replace(/\b(?:it\s+)?does\s+not\s+introduce\b[^.\n]*/gi, '')
    .replace(/\bmust\s+not\s+(?:introduce|define|persist|include)\b[^.\n]*/gi, '')
    .replace(/\bno\s+(?:database|auth|server state|D1|Durable Objects|Queues|Workflows|server-side file uploads)\b[^.\n]*/gi, '');
}

function genericRouteMentionsProfile(task: Task) {
  return taskOwnsGenericRouteModule(task) && /\bprofiles?\b/i.test(positiveTaskAcceptanceText(task));
}

function genericRouteMentionsRuns(task: Task) {
  return (
    taskOwnsGenericRouteModule(task) &&
    /(?:\/runs(?:\b|\/|:)|\bmanual\/profile\/regeneration endpoints?\b|\bmanual endpoints?\b|\bmanual\s+runs?\b|\bqueued\s+(?:manual\s+)?run\b|\brun\s+(?:creation|detail|status|lifecycle|record|records|repository|transcript|history)\b|\bruns?\s+(?:route|routes|endpoint|endpoints|handler|handlers|repository|lifecycle|record|records))\b/i.test(
      positiveTaskAcceptanceText(task),
    )
  );
}

function genericRouteMentionsManualProfileRegeneration(task: Task) {
  return taskOwnsGenericRouteModule(task) && /\bmanual\/profile\/regeneration endpoints?\b/i.test(positiveTaskAcceptanceText(task));
}

function genericRouteMentionsLatest(task: Task) {
  return (
    genericRouteMentionsManualProfileRegeneration(task) ||
    (taskOwnsGenericRouteModule(task) &&
      /(?:\/latest\b|\blatest\s+(?:route|routes|endpoint|endpoints|transcript|completed))/i.test(
        positiveTaskAcceptanceText(task),
      ))
  );
}

function genericRouteMentionsRegeneration(task: Task) {
  return taskOwnsGenericRouteModule(task) && /\bregenerat/i.test(positiveTaskAcceptanceText(task));
}

function genericRouteMentionsCandidates(task: Task) {
  return taskOwnsGenericRouteModule(task) && /\b(?:candidate routes?|candidate endpoints?|\/candidates?)\b/i.test(positiveTaskAcceptanceText(task));
}

function taskOwnsSessionRoute(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:routes\/session|sessionRoutes)\.[cm]?[jt]s$/i);
}

function taskOwnsProfileRoute(task: Task) {
  return (
    genericRouteMentionsProfile(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*profiles?|routesProfiles|profile(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

function taskOwnsProfileRepositorySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:storage\/profiles|profileRepository)\.[cm]?[jt]s$/i);
}

function taskOwnsRunRoute(task: Task) {
  return (
    genericRouteMentionsRuns(task) ||
    genericRouteMentionsLatest(task) ||
    genericRouteMentionsRegeneration(task) ||
    genericRouteMentionsCandidates(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*(?:runs?|latest|regeneration|regenerate|candidates?)|routes(?:Runs?|Latest|Regeneration|Regenerate|Candidates?)|(?:run|latest|regeneration|regenerate|candidate)(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

function taskOwnsManualRunRoute(task: Task) {
  return (
    genericRouteMentionsRuns(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*runs?|routesRuns?|run(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

function taskOwnsLatestRoute(task: Task) {
  return (
    genericRouteMentionsLatest(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*latest|routesLatest|latest(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

function taskOwnsRegenerationRoute(task: Task) {
  return (
    genericRouteMentionsRegeneration(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*(?:regeneration|regenerate)|routes(?:Regeneration|Regenerate)|regeneration(?:Routes|Handlers)|regenerate(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

function taskOwnsCandidateRoute(task: Task) {
  return (
    genericRouteMentionsCandidates(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*candidates?|routesCandidates?|candidate(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

function taskOwnsRunRepositorySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:storage\/runs|runRepository)\.[cm]?[jt]s$/i);
}

function taskOwnsTranscriptRepositorySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:storage\/transcripts|transcriptRepository)\.[cm]?[jt]s$/i);
}

function taskOwnsWorkflowSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:(?:workflows\/)?weeklyWorkflow|workflow|scheduler)\.[cm]?[jt]s$/i);
}

function taskOwnsWorkflowExecutionSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:(?:workflows\/)?weeklyWorkflow|workflow)\.[cm]?[jt]s$/i);
}

function taskOwnsSchedulerSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/scheduler\.[cm]?[jt]s$/i);
}

function taskOwnsContractSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:contracts|validation)\.[cm]?[jt]s$/i);
}

function taskOwnsProviderAdapterSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/providers\.[cm]?[jt]s$/i);
}

function providerAdapterSurfaceExtension(task: Task) {
  const providerSurface = taskOwnedBoundaryPaths(task).find((path) => /^src\/providers\.[cm]?[jt]s$/i.test(path));
  return providerSurface && /\.(?:ts|mts|cts)$/.test(providerSurface) ? 'ts' : 'js';
}

function providerAdapterBehaviorCriterion(criterion: string) {
  return /\b(?:configured-state validation|missing keyed secrets?|provider adapter failures?|provider_error|timeout_or_network_error|client-safe messages?|raw upstream response body snippets?|missing_binding|client-safe RunResult|unrelated model runs)\b/i.test(
    criterion,
  );
}

function taskLooksLikeProviderAdapterBehaviorTest(task: Task, providerTaskId: string) {
  return (
    task.owner === 'engineer' &&
    task.depends_on.includes(providerTaskId) &&
    taskOwnedBoundaryPaths(task).some((path) => /^test\/.*provider.*\.test\.[cm]?[jt]s$/i.test(path)) &&
    /\bprovider adapters?\b|\bsrc\/providers\.[cm]?[jt]s\b|\bprovider_error\b|\btimeout_or_network_error\b/i.test(
      [task.deliverable, ...task.acceptance_criteria, ...task.owned_surfaces].join('\n'),
    )
  );
}

function taskOwnsAiValidationSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:aiJson|jsonOutput|aiValidation|aiSchemas?|schemas?)\.[cm]?[jt]s$/i);
}

function taskOwnsAiPipelineSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:candidatePipeline|scoring|transcriptGenerator|prompts|aiClient)\.[cm]?[jt]s$/i);
}

function taskOwnsProfileSummarySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:profileSummary|profileSummaryService)\.[cm]?[jt]s$/i);
}

function taskOwnsAuthSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:(?:http\/)?auth|adminAuth|sessionAuth)\.[cm]?[jt]s$/);
}

function taskOwnsOperatorAuthBoundary(task: Task) {
  if (taskOwnsAuthSurface(task)) return true;
  if (!taskOwnsRouterSurface(task)) return false;
  return /\b(?:admin[-_\s]?token|Authorization:\s*Bearer|authorization checks?|credential checks?|secret check)\b/i.test(
    taskAcceptanceText(task),
  );
}

function taskAuthBoundarySurface(task: Task) {
  return (
    taskOwnedBoundaryPaths(task).find((path) => /^src\/(?:(?:http\/)?auth|adminAuth|sessionAuth)\.[cm]?[jt]s$/i.test(path)) ??
    taskOwnedBoundaryPaths(task).find((path) => /^src\/(?:(?:http\/)?router|http|routes)\.[cm]?[jt]s$/i.test(path)) ??
    'src/auth.js'
  );
}

function taskOwnsPublicAppSurface(task: Task) {
  return taskOwnsPathMatching(task, /^public\/(?:index\.html|app\.js)$/);
}

function taskOwnsIndexSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/index\.[cm]?[jt]s$/);
}

function taskOwnsReadme(task: Task) {
  return taskOwnedBoundaryPaths(task).includes('README.md');
}

function taskPlanDeclaresWorkerWorkflow(tasks: Task[]) {
  return tasks.some(
    (task) =>
      taskOwnsWorkflowSurface(task) ||
      /\b(?:WorkflowEntrypoint|WeeklyWorkflow|WEEKLY_WORKFLOW|workflows\.class_name|Workers Workflows?)\b/i.test(
        taskAcceptanceText(task),
      ),
  );
}

function taskPlanHasPersistentRunLifecycle(tasks: Task[]) {
  return tasks.some(
    (task) =>
      taskOwnsWorkflowSurface(task) ||
      taskOwnsD1MigrationFile(task) ||
      taskOwnsRunRepositorySurface(task) ||
      taskOwnsTranscriptRepositorySurface(task),
  );
}

function appendTaskAcceptanceCriteria(task: Task, criteria: string[]) {
  const acceptance_criteria = Array.from(new Set([...task.acceptance_criteria, ...criteria]));
  return acceptance_criteria.length === task.acceptance_criteria.length ? task : { ...task, acceptance_criteria };
}

function appendTaskSourceAcceptanceCriteria(task: Task, criteria: string[]) {
  const sourceCriteria = criteria.filter(Boolean);
  if (!sourceCriteria.length) return task;

  const sourceCriterionSet = new Set(sourceCriteria);
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !sourceCriterionSet.has(criterion));
  const source_acceptance_criteria = Array.from(new Set([...(task.source_acceptance_criteria ?? []), ...sourceCriteria]));
  const unchanged =
    acceptance_criteria.length === task.acceptance_criteria.length &&
    source_acceptance_criteria.length === (task.source_acceptance_criteria?.length ?? 0);

  if (unchanged) return task;

  return {
    ...task,
    acceptance_criteria,
    source_acceptance_criteria,
  };
}

function publicUiRawAdminTokenCriterion(criterion: string) {
  return (
    /\bpublic\/app\.js\b/i.test(criterion) &&
    /\b(?:ADMIN_TOKEN|admin[-_\s]?token)\b/i.test(criterion) &&
    /\b(collects?|sends?|stores?|storage|persist|Authorization:\s*Bearer|raw|handling|entry|entering)\b/i.test(criterion) &&
    !/\b(browser-safe|session|cookie|HttpOnly)\b/i.test(criterion)
  );
}

function withoutPublicUiRawAdminTokenCriteria(task: Task) {
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !publicUiRawAdminTokenCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !publicUiRawAdminTokenCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function sessionSecretFallbackCriterion(criterion: string) {
  return (
    /\bSESSION_SECRET when configured\b/i.test(criterion) ||
    /\bADMIN_TOKEN\b[\s\S]{0,120}\bfallback(?: signing| secret| signing behavior)?\b/i.test(criterion) ||
    /\bfallback(?: signing| secret| signing behavior)?\b[\s\S]{0,120}\bADMIN_TOKEN\b/i.test(criterion)
  );
}

function withoutSessionSecretFallbackCriteria(task: Task) {
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !sessionSecretFallbackCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !sessionSecretFallbackCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function rootScaffoldWorkflowExecutionCriterion(criterion: string) {
  return /\bWorkflow execution receives or resumes a queued run\b/i.test(criterion);
}

function rootScaffoldFuturePreservationCriterion(criterion: string) {
  return /\bchanges preserve the existing default fetch handler\b/i.test(criterion);
}

function taskIsRootScaffold(task: Task) {
  return task.depends_on.length === 0 && ownsPackageScaffold(task) && taskOwnsIndexSurface(task);
}

function withoutRootScaffoldWorkflowExecutionCriteria(task: Task) {
  if (!taskIsRootScaffold(task)) return task;

  const acceptance_criteria = task.acceptance_criteria.filter(
    (criterion) => !rootScaffoldWorkflowExecutionCriterion(criterion) && !rootScaffoldFuturePreservationCriterion(criterion),
  );
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !rootScaffoldWorkflowExecutionCriterion(criterion) && !rootScaffoldFuturePreservationCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function sessionRouteCrossSurfaceCriterion(criterion: string) {
  return /^Protected profile, run, latest, and regeneration routes validate/i.test(criterion);
}

function withoutSessionRouteCrossSurfaceCriteria(task: Task) {
  if (!taskOwnsSessionRoute(task)) return task;

  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !sessionRouteCrossSurfaceCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !sessionRouteCrossSurfaceCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function aiOutputValidationCriterion(criterion: string) {
  return /\bAI output validation treats model JSON as untrusted input\b/i.test(criterion);
}

function withoutAiOutputValidationCriteria(task: Task) {
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !aiOutputValidationCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !aiOutputValidationCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function runLifecycleWithoutEmptyTerminalCriterion(criterion: string) {
  return (
    /\bRun lifecycle contract defines\b/i.test(criterion) &&
    /\bqueued\s*->\s*running\s*->\s*completed\|failed\b/i.test(criterion) &&
    !/\bcompleted_empty\b/i.test(criterion)
  );
}

function workflowCreatesRunningRunCriterion(criterion: string) {
  return /\b(?:WeeklyWorkflow|Workflow)\b[\s\S]{0,80}\bcreates or loads (?:a|the) run\b[\s\S]{0,80}\bmarks it running\b/i.test(
    criterion,
  );
}

function workflowCreateRunStepCriterion(criterion: string) {
  if (/\b(?:manual run routes?|scheduled triggers?)\b[\s\S]{0,80}\bcreate queued run records? only\b/i.test(criterion)) {
    return false;
  }

  return (
    /\b(?:WeeklyWorkflow|weeklyWorkflow\.js|Workflow|workflow steps?)\b[\s\S]{0,120}\b(?:steps?\s+including\s+)?["']?create run["']?/i.test(
      criterion,
    ) || /\b["']?create run["']?\b[\s\S]{0,120}\b(?:Workflow|workflow|weeklyWorkflow\.js)\b/i.test(criterion)
  );
}

function workflowEmptyInputCompletedCriterion(criterion: string) {
  return /\bempty (?:[\w/-]+\s+){0,4}list\b[\s\S]{0,120}\bcompleted run with no (?:transcript|output|artifact|content)\b/i.test(
    criterion,
  );
}

function emptyInputCompletesWithoutOutputCriterion(criterion: string) {
  return /\bempty (?:[\w/-]+\s+){0,4}list\b[\s\S]{0,120}\bcompletes? (?:the )?run\b[\s\S]{0,120}\bwithout (?:a )?(?:transcript|output|artifact|content)\b/i.test(
    criterion,
  );
}

function emptyInputCompletedNoContentCriterion(criterion: string) {
  return /\bempty (?:[\w/-]+\s+){0,4}list\b[\s\S]{0,120}\b(?:completed\/no_content|completed_empty)\b[\s\S]{0,120}\bwithout (?:transcript|output|artifact|content)\b/i.test(
    criterion,
  );
}

function withoutLifecycleDriftCriteria(task: Task) {
  const isDriftCriterion = (criterion: string) =>
    runLifecycleWithoutEmptyTerminalCriterion(criterion) ||
    workflowEmptyInputCompletedCriterion(criterion) ||
    emptyInputCompletesWithoutOutputCriterion(criterion) ||
    emptyInputCompletedNoContentCriterion(criterion) ||
    (taskOwnsWorkflowSurface(task) &&
      (workflowCreatesRunningRunCriterion(criterion) || workflowCreateRunStepCriterion(criterion)));
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !isDriftCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter((criterion) => !isDriftCriterion(criterion));

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function persistentRunLifecycleCriterion(criterion: string) {
  return (
    /\bRun lifecycle contract defines\b/i.test(criterion) ||
    /\bScheduled trigger handling creates or reuses queued run records\b/i.test(criterion) ||
    /\bWorkflow treats an empty (?:[\w/-]+\s+){0,4}list as a completed_empty terminal run\b/i.test(criterion) ||
    /\broute handlers delegate[\s\S]{0,140}\b(?:latest transcript|transcript versioning|D1 state)\b/i.test(criterion) ||
    /\bTranscript regeneration inserts a new transcript row\b/i.test(criterion)
  );
}

function withoutPersistentRunLifecycleCriteria(task: Task) {
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !persistentRunLifecycleCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !persistentRunLifecycleCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function workflowExportDriftCriterion(criterion: string) {
  return (
    /\bminimal WorkflowEntrypoint class\b/i.test(criterion) ||
    /\blater workflow code may delegate to src\/weeklyWorkflow\.js\b/i.test(criterion) ||
    /\bsrc\/weeklyWorkflow\.js\b[\s\S]{0,100}\bexports? (?:the )?WeeklyWorkflow class referenced by wrangler\.jsonc\b/i.test(
      criterion,
    )
  );
}

function withoutWorkflowExportDriftCriteria(task: Task) {
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !workflowExportDriftCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter((criterion) => !workflowExportDriftCriterion(criterion));

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function runCreationOutsideEnqueueBoundaryCriterion(task: Task, criterion: string) {
  if (taskOwnsManualRunRoute(task) || taskOwnsSchedulerSurface(task)) return false;
  return /\bcreates? (?:a|the) run\b[\s\S]{0,120}\b(?:default|previous|seven-day|window)\b/i.test(criterion);
}

function directApiDispatchInEntrypointCriterion(task: Task, criterion: string) {
  if (!taskOwnsIndexSurface(task) || taskHasRouteIntegrationContract(task)) return false;
  return /\bsrc\/index\.js\b[\s\S]{0,120}\bdispatch(?:es)? API routes\b/i.test(criterion);
}

function withoutBoundaryAuthorityDriftCriteria(task: Task) {
  const isDrift = (criterion: string) =>
    runCreationOutsideEnqueueBoundaryCriterion(task, criterion) || directApiDispatchInEntrypointCriterion(task, criterion);
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !isDrift(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter((criterion) => !isDrift(criterion));

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function canonicalizeCompletedEmptyStatusText(criterion: string) {
  return criterion
    .replace(/\bcompleted\/no_content\b/gi, 'completed_empty')
    .replace(/\bcompleted_no_[a-z0-9_]+\b/gi, 'completed_empty')
    .replace(/\bno_[a-z0-9_]+\b/gi, 'completed_empty');
}

function withCanonicalCompletedEmptyStatus(task: Task) {
  const acceptance_criteria = task.acceptance_criteria.map(canonicalizeCompletedEmptyStatusText);
  const source_acceptance_criteria = task.source_acceptance_criteria?.map(canonicalizeCompletedEmptyStatusText);

  if (
    acceptance_criteria.every((criterion, index) => criterion === task.acceptance_criteria[index]) &&
    (source_acceptance_criteria ?? []).every((criterion, index) => criterion === task.source_acceptance_criteria?.[index])
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function canonicalizeProfileMigrationCriterionSurface(task: Task) {
  const migrationSurface = taskD1MigrationSurface(task);
  if (!migrationSurface) return task;

  const canonicalize = (criterion: string) =>
    criterion.replace(
      /\bmigrations\/[A-Za-z0-9_.-]+\.sql(?= enforces at most one active profile_artifacts row)/g,
      migrationSurface,
    );
  const acceptance_criteria = task.acceptance_criteria.map(canonicalize);
  const source_acceptance_criteria = task.source_acceptance_criteria?.map(canonicalize);

  if (
    acceptance_criteria.every((criterion, index) => criterion === task.acceptance_criteria[index]) &&
    (source_acceptance_criteria ?? []).every((criterion, index) => criterion === task.source_acceptance_criteria?.[index])
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function routeEndpointContractCriterion(criterion: string) {
  return (
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./:{}*-]+/i.test(criterion) ||
    /\b(?:endpoint|route)\b[\s\S]{0,80}\b(?:auth|session|protect|persist|store|return|delegate|transcript|candidate|regenerat)/i.test(
      criterion,
    )
  );
}

function routeEndpointCriterionBelongsToTask(task: Task, criterion: string) {
  if (/\/api\//i.test(criterion)) return taskOwnsGenericRouteModule(task) || taskOwnsRouterSurface(task) || taskOwnsIndexSurface(task);
  if (/\/profiles?(?:\b|\/|:)/i.test(criterion)) return taskOwnsProfileRoute(task);
  if (/\/latest\b/i.test(criterion)) return taskOwnsLatestRoute(task);
  if (/(?:\/runs\/:id\/regenerate|regenerat)/i.test(criterion)) return taskOwnsRegenerationRoute(task);
  if (/(?:\/runs\/:id\/candidates?|candidates?)\b/i.test(criterion)) return taskOwnsCandidateRoute(task);
  if (/\/runs(?:\b|\/:id\b)/i.test(criterion)) return taskOwnsManualRunRoute(task);
  if (/\b(?:session|login|logout)\b/i.test(criterion)) return taskOwnsSessionRoute(task);
  if (/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//i.test(criterion)) return false;
  return true;
}

function taskRouteEndpointSourceCriteria(task: Task) {
  if (!taskOwnsRouteModule(task) || !task.source_acceptance_criteria?.length) return [];
  return task.source_acceptance_criteria.filter(
    (criterion) => routeEndpointContractCriterion(criterion) && routeEndpointCriterionBelongsToTask(task, criterion),
  );
}

function routeReachabilityNames(tasks: Task[], routeTasks: Task[], contractScope: SourceScopedDeliveryContracts) {
  return [
    tasks.some(taskOwnsSessionRoute) ? 'browser session' : undefined,
    contractScope.profileState && routeTasks.some(taskOwnsProfileRoute) ? 'profile' : undefined,
    contractScope.latestTranscript && routeTasks.some(taskOwnsManualRunRoute) ? 'run' : undefined,
    contractScope.latestTranscript && routeTasks.some(taskOwnsLatestRoute) ? 'latest' : undefined,
    contractScope.latestTranscript && routeTasks.some(taskOwnsRegenerationRoute) ? 'regenerate' : undefined,
    contractScope.latestTranscript && routeTasks.some(taskOwnsCandidateRoute) ? 'candidate' : undefined,
    'health',
    'static asset fallback',
  ].filter(Boolean);
}

function routeReachabilityCriterion(criterion: string) {
  return /\bmakes? .+ routes reachable through the Worker fetch path\b/i.test(criterion);
}

function taskRouterBoundarySurface(task: Task) {
  return (
    taskOwnedBoundaryPaths(task).find((path) => /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/.test(path)) ??
    'src/router.js'
  );
}

function routeOwnershipDriftCriterion(task: Task, criterion: string) {
  if (taskOwnsRouterSurface(task) && !taskHasRouteIntegrationContract(task)) {
    if (
      /router surface explicitly registers the browser session endpoint/i.test(criterion) ||
      /Route integration defines and enforces the protection matrix/i.test(criterion)
    ) {
      return true;
    }
  }

  if (!taskOwnsRouteModule(task)) return false;
  if (routeEndpointContractCriterion(criterion) && !routeEndpointCriterionBelongsToTask(task, criterion)) return true;

  if (taskOwnsRunRoute(task)) {
    if (/^Run, latest, candidate, and regeneration routes delegate/i.test(criterion)) return true;
    if (!taskOwnsRegenerationRoute(task) && /Transcript regeneration inserts/i.test(criterion)) return true;
  }

  return false;
}

function withoutRouteOwnershipDriftCriteria(task: Task) {
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !routeOwnershipDriftCriterion(task, criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !routeOwnershipDriftCriterion(task, criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function schedulerWorkflowExecutionCriterion(criterion: string) {
  return (
    /^Scheduled triggers and manual run routes create queued run records only/i.test(criterion) ||
    /^Workflow treats an empty (?:[\w/-]+\s+){0,4}list as a completed_empty terminal run/i.test(criterion) ||
    /^Workflow execution receives or resumes a queued run/i.test(criterion) ||
    /^Workflow profile-loading steps call the profile summary service boundary/i.test(criterion)
  );
}

function withoutSchedulerWorkflowExecutionCriteria(task: Task) {
  if (!taskOwnsSchedulerSurface(task) || taskOwnsWorkflowExecutionSurface(task)) return task;
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !schedulerWorkflowExecutionCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !schedulerWorkflowExecutionCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function taskHasRouteIntegrationContract(task: Task) {
  return (
    taskOwnsRouterSurface(task) &&
    task.acceptance_criteria.some((criterion) =>
      /reachable through (?:the )?(?:src\/)?router|all declared (?:api )?endpoints?|routes? reachable through the Worker fetch path/i.test(
        criterion,
      ),
    )
  );
}

function dedupeRouteIntegrationTasks(tasks: Task[]) {
  const integrationTasks = tasks.filter(taskHasRouteIntegrationContract);
  if (integrationTasks.length <= 1) return { tasks, changed: false };

  const [primary, ...duplicates] = integrationTasks;
  const integrationIds = new Set(integrationTasks.map((task) => task.id));
  const duplicateIds = new Set(duplicates.map((task) => task.id));
  const primaryTask = {
    ...primary,
    depends_on: Array.from(
      new Set(integrationTasks.flatMap((task) => task.depends_on).filter((dependency) => !integrationIds.has(dependency))),
    ),
    acceptance_criteria: Array.from(new Set(integrationTasks.flatMap((task) => task.acceptance_criteria))),
    owned_surfaces: Array.from(new Set(integrationTasks.flatMap((task) => task.owned_surfaces))),
  };

  return {
    tasks: tasks
      .filter((task) => !duplicateIds.has(task.id))
      .map((task) => {
        if (task.id === primary.id) return primaryTask;
        const depends_on = Array.from(
          new Set(task.depends_on.map((dependency) => (duplicateIds.has(dependency) ? primary.id : dependency))),
        );
        return depends_on.length === task.depends_on.length &&
          depends_on.every((dependency, index) => dependency === task.depends_on[index])
          ? task
          : { ...task, depends_on };
      }),
    changed: true,
  };
}

function routeModuleStyle(tasks: Task[]) {
  return tasks.some((task) => taskOwnedBoundaryPaths(task).some((path) => path.startsWith('src/routes/'))) ? 'nested' : 'flat';
}

function taskFamilyIncludesWorkflowEntrypointWork(tasks: Task[], task: Task) {
  return generatedSliceFamilyTasks(tasks, task).some(
    (candidate) => taskOwnsWorkflowExecutionSurface(candidate) || taskOwnsSchedulerSurface(candidate),
  );
}

function taskHasFinalWorkerEntrypointContract(task: Task) {
  return task.acceptance_criteria.some((criterion) => /^src\/index\.js is the final Worker module entrypoint/i.test(criterion));
}

function taskCanOwnFinalWorkerEntrypoint(tasks: Task[], task: Task) {
  if (!taskOwnsIndexSurface(task) || taskIsRootScaffold(task)) return false;
  return task.id.startsWith('E99-worker-entrypoint-integration') || taskFamilyIncludesWorkflowEntrypointWork(tasks, task);
}

function finalWorkerEntrypointCriterion(criterion: string) {
  return (
    /^src\/index\.js is the final Worker module entrypoint/i.test(criterion) ||
    /^src\/index\.js delegates fetch handling to src\/(?:router|http)\.[cm]?[jt]s/i.test(criterion) ||
    /^src\/index\.js delegates scheduled handling to src\/scheduler\.js/i.test(criterion) ||
    /^src\/index\.js exports the real WeeklyWorkflow implementation/i.test(criterion)
  );
}

function withoutFinalWorkerEntrypointCriteria(task: Task) {
  if (!taskOwnsIndexSurface(task) || taskIsRootScaffold(task)) return task;
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !finalWorkerEntrypointCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !finalWorkerEntrypointCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function withoutFinalWorkerEntrypointDrift(task: Task, finalDependencyIds: Set<string>) {
  if (!taskOwnsIndexSurface(task) || taskIsRootScaffold(task)) return task;
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !finalWorkerEntrypointCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !finalWorkerEntrypointCriterion(criterion),
  );
  const depends_on = task.depends_on.filter((dependency) => !finalDependencyIds.has(dependency));

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    depends_on.length === task.depends_on.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    depends_on,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function preEntrypointBoundaryDependencyId(tasks: Task[], task: Task) {
  const finalTaskId = finalGeneratedSliceTaskId(tasks, task.id);
  const finalTask = tasks.find((candidate) => candidate.id === finalTaskId);
  if (!finalTask || finalTask.id === task.id) return task.id;
  if (taskOwnsRouteModule(finalTask) || taskOwnsPublicAppSurface(finalTask) || taskOwnsIndexSurface(finalTask)) {
    return task.id;
  }
  return finalTask.id;
}

function routeIntegrationDependencyId(tasks: Task[], task: Task) {
  const finalTaskId = finalGeneratedSliceTaskId(tasks, task.id);
  const finalTask = tasks.find((candidate) => candidate.id === finalTaskId);
  if (!finalTask || finalTask.id === task.id) return task.id;
  if (taskOwnsRouteModule(finalTask)) return finalTask.id;
  if (taskOwnsPublicAppSurface(finalTask) || taskOwnsIndexSurface(finalTask)) return preEntrypointBoundaryDependencyId(tasks, task);
  return finalTask.id;
}

function canUsePreEntrypointGeneratedDependency(tasks: Task[], dependency: string, finalDependency: string) {
  const dependencyTask = tasks.find((candidate) => candidate.id === dependency);
  const finalTask = tasks.find((candidate) => candidate.id === finalDependency);
  if (!dependencyTask || !finalTask) return false;
  if (taskOwnsRouteModule(finalTask)) return false;
  if (!taskOwnsPublicAppSurface(finalTask) && !taskOwnsIndexSurface(finalTask)) return false;
  return preEntrypointBoundaryDependencyId(tasks, dependencyTask) === dependency;
}

function routerBoundaryProviderTasks(tasks: Task[]) {
  return tasks.filter(
    (task) =>
      taskOwnsRouterSurface(task) &&
      !taskOwnsRouteModule(task) &&
      !taskHasRouteIntegrationContract(task) &&
      !taskOwnsStaticAssetWiringSurface(task),
  );
}

function withAuthSessionTask(taskPlan: TaskPlan, tasks: Task[]) {
  const hasPublicApp = tasks.some(taskOwnsPublicAppSurface);
  const authTasks = tasks.filter(taskOwnsOperatorAuthBoundary);
  const routerTasks = routerBoundaryProviderTasks(tasks);
  const sessionTasks = tasks.filter(taskOwnsSessionRoute);
  if (!hasPublicApp || !authTasks.length) return { tasks, changed: false };

  const scaffoldRootTasks = tasks.filter((task) => taskIsRootScaffold(task));
  const routeTasks = tasks.filter(taskOwnsRouteModule);
  const safeAuthTasks = authTasks.filter(
    (authTask) =>
      !taskOwnsRouteModule(authTask) &&
      !routeTasks.some((routeTask) => routeTask.id !== authTask.id && taskListDependsOn(tasks, authTask.id, routeTask.id)),
  );
  const safeRouterTasks = routerTasks.filter(
    (routerTask) =>
      !taskOwnsIndexSurface(routerTask) &&
      !routeTasks.some((routeTask) => routerTask.id !== routeTask.id && taskListDependsOn(tasks, routerTask.id, routeTask.id)),
  );
  const sessionDependencyTasks = safeAuthTasks.length
    ? [...scaffoldRootTasks, ...safeAuthTasks, ...safeRouterTasks]
    : [...scaffoldRootTasks, ...safeRouterTasks];
  const sessionDependencyIds = Array.from(
    new Set(sessionDependencyTasks.map((task) => preEntrypointBoundaryDependencyId(tasks, task))),
  );

  if (sessionTasks.length) {
    let changed = false;
    const expectedDependencies = sessionDependencyIds;
    let nextTasks = tasks.map((task) => {
        if (!taskOwnsSessionRoute(task)) return task;
        const surface = taskOwnedBoundaryPaths(task).find((path) =>
          /^src\/(?:routes\/session|sessionRoutes)\.[cm]?[jt]s$/i.test(path),
        ) ?? 'src/sessionRoutes.js';
        const depends_on = expectedDependencies.filter((dependency) => dependency !== task.id);
        const withCriteria = appendTaskAcceptanceCriteria(task, sessionRouteCriteria(surface));
        const dependenciesUnchanged =
          depends_on.length === task.depends_on.length && depends_on.every((dependency, index) => dependency === task.depends_on[index]);
        if (dependenciesUnchanged && withCriteria === task) {
          return task;
        }
        changed = true;
        return { ...withCriteria, depends_on };
      });
    for (const task of sessionTasks) {
      const moved = moveTaskAfterDependencies(nextTasks, task.id);
      if (moved.changed) changed = true;
      nextTasks = moved.tasks;
    }
    return {
      tasks: nextTasks,
      changed,
    };
  }

  const surface = routeModuleStyle(tasks) === 'nested' ? 'src/routes/session.js' : 'src/sessionRoutes.js';
  const sessionTask = {
    id: uniqueTaskId({ ...taskPlan, tasks }, 'E20-auth-session'),
    owner: 'engineer' as const,
    deliverable: 'Implement the browser-safe auth/session route boundary before protected feature routes and UI work.',
    depends_on: sessionDependencyIds,
    acceptance_criteria: sessionRouteCriteria(surface),
    owned_surfaces: [surface],
  };

  return {
    tasks: insertTaskAfterDependencies(tasks, sessionTask),
    changed: true,
  };
}

function withRouteIntegrationTask(taskPlan: TaskPlan, tasks: Task[], contractScope: SourceScopedDeliveryContracts) {
  const deduped = dedupeRouteIntegrationTasks(tasks);
  tasks = deduped.tasks;

  const routeTasks = tasks.filter(taskOwnsRouteModule);
  const routerTasks = routerBoundaryProviderTasks(tasks);
  if (!routeTasks.length || !routerTasks.length) return { tasks, changed: deduped.changed };

  const alreadyHasIntegration = tasks.some(taskHasRouteIntegrationContract);
  if (alreadyHasIntegration) {
    let changed = deduped.changed;
    const expectedDependencies = Array.from(
      new Set([...routerTasks, ...routeTasks].map((task) => preEntrypointBoundaryDependencyId(tasks, task))),
    );
    tasks = tasks.map((task) => {
      if (!taskHasRouteIntegrationContract(task)) return task;
      const depends_on = expectedDependencies.filter((dependency) => dependency !== task.id);
      const routerSurface = taskOwnedBoundaryPaths(task).find((path) =>
        /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/.test(path),
      ) ?? 'src/router.js';
      const expectedRouteCriterion = routeIntegrationCriterion(routerSurface, routeReachabilityNames(tasks, routeTasks, contractScope));
      let replacedReachability = false;
      const acceptance_criteria = task.acceptance_criteria.map((criterion) => {
        if (!routeReachabilityCriterion(criterion)) return criterion;
        replacedReachability = true;
        return expectedRouteCriterion;
      });
      if (!replacedReachability) acceptance_criteria.push(expectedRouteCriterion);
      const withCriteria = { ...task, acceptance_criteria: Array.from(new Set(acceptance_criteria)) };
      const dependenciesUnchanged =
        depends_on.length === task.depends_on.length && depends_on.every((dependency, index) => dependency === task.depends_on[index]);
      const criteriaUnchanged =
        withCriteria.acceptance_criteria.length === task.acceptance_criteria.length &&
        withCriteria.acceptance_criteria.every((criterion, index) => criterion === task.acceptance_criteria[index]);
      if (dependenciesUnchanged && criteriaUnchanged) {
        return task;
      }
      changed = true;
      return { ...withCriteria, depends_on };
    });
    for (const task of tasks.filter(taskHasRouteIntegrationContract)) {
      const moved = moveTaskAfterDependencies(tasks, task.id);
      if (moved.changed) changed = true;
      tasks = moved.tasks;
    }
    return { tasks, changed };
  }

  const routerSurface = taskOwnedBoundaryPaths(routerTasks[routerTasks.length - 1]).find((path) =>
    /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/.test(path),
  ) ?? 'src/router.js';
  const depends_on = Array.from(
    new Set([...routerTasks, ...routeTasks].map((task) => preEntrypointBoundaryDependencyId(tasks, task))),
  );
  const routeNames = routeReachabilityNames(tasks, routeTasks, contractScope);
  const needsProtectedFeatureMatrix = contractScope.profileState || contractScope.latestTranscript;

  const integrationTask = {
    id: uniqueTaskId({ ...taskPlan, tasks }, 'E98-route-integration'),
    owner: 'engineer' as const,
    deliverable: 'Wire generated API route modules through the Worker router after all route modules exist.',
    depends_on,
    acceptance_criteria: [
      `${routerSurface} is the single API route registration boundary after feature route modules exist.`,
      routeIntegrationCriterion(routerSurface, routeNames),
      'Every declared API endpoint is reachable through the router after this task completes.',
      ...(needsProtectedFeatureMatrix
        ? [
            'Route integration defines and enforces the protection matrix: profile upload, profile activation, GET /profiles, manual runs, regeneration, and run detail endpoints are operator/session protected; GET /latest may be public only when it returns generated transcript fields and never raw profile markdown, profile history, or fetched source content.',
          ]
        : []),
    ],
    owned_surfaces: [routerSurface],
  };

  return {
    tasks: insertTaskAfterDependencies(tasks, integrationTask),
    changed: true,
  };
}

function withWorkerEntrypointIntegrationTask(taskPlan: TaskPlan, tasks: Task[]) {
  const rootScaffoldIndexTask = tasks.find((task) => taskIsRootScaffold(task) && taskOwnsIndexSurface(task));
  const nonRootIndexTasks = tasks.filter((task) => taskOwnsIndexSurface(task) && !taskIsRootScaffold(task));
  const integrationTask = tasks.find(taskHasRouteIntegrationContract);
  const workflowTasks = tasks.filter(taskOwnsWorkflowExecutionSurface);
  const schedulerTasks = tasks.filter(taskOwnsSchedulerSurface);
  if (!integrationTask || !workflowTasks.length || !schedulerTasks.length) return { tasks, changed: false };

  const dependencies = Array.from(
    new Set([
      integrationTask.id,
      ...workflowTasks.map((task) => preEntrypointBoundaryDependencyId(tasks, task)),
      ...schedulerTasks.map((task) => preEntrypointBoundaryDependencyId(tasks, task)),
    ]),
  );
  const routerSurface = taskRouterBoundarySurface(integrationTask);
  const criteria = [
    'src/index.js is the final Worker module entrypoint after route, scheduler, and workflow modules exist.',
    `src/index.js delegates fetch handling to ${routerSurface} and keeps static asset fallback reachable through the ${routerSurface} fetch path.`,
    'src/index.js delegates scheduled handling to src/scheduler.js so scheduled triggers create queued run records and start WEEKLY_WORKFLOW without duplicating workflow execution logic.',
    'src/index.js exports the real WeeklyWorkflow implementation with the configured class name "WeeklyWorkflow" and delegates execution to the workflow module rather than leaving the scaffold stub in place.',
  ];
  const finalDependencyIds = new Set(dependencies);
  const finalIndexTasks = nonRootIndexTasks.filter((task) => taskCanOwnFinalWorkerEntrypoint(tasks, task));

  if (nonRootIndexTasks.length) {
    let changed = false;
    let nextTasks = tasks.map((task) => {
      if (!nonRootIndexTasks.some((indexTask) => indexTask.id === task.id)) return task;
      if (!finalIndexTasks.some((indexTask) => indexTask.id === task.id)) {
        const sanitized = withoutFinalWorkerEntrypointDrift(task, finalDependencyIds);
        if (sanitized !== task) changed = true;
        return sanitized;
      }
      const sanitized = withoutFinalWorkerEntrypointCriteria(task);
      const withDependencies = appendDependencies(sanitized, dependencies);
      const withCriteria = appendTaskAcceptanceCriteria(withDependencies, criteria);
      if (withCriteria !== task) changed = true;
      return withCriteria;
    });
    for (const task of finalIndexTasks) {
      const moved = moveTaskAfterDependencies(nextTasks, task.id);
      if (moved.changed) changed = true;
      nextTasks = moved.tasks;
    }
    if (finalIndexTasks.length) return { tasks: nextTasks, changed };
    tasks = nextTasks;
  }

  if (!rootScaffoldIndexTask) return { tasks, changed: false };

  const entryTask = {
    id: uniqueTaskId({ ...taskPlan, tasks }, 'E99-worker-entrypoint-integration'),
    owner: 'engineer' as const,
    deliverable: 'Wire the final Worker entrypoint after routes, scheduler, and workflow implementation exist.',
    depends_on: dependencies,
    acceptance_criteria: criteria,
    owned_surfaces: ['src/index.js'],
  };

  return {
    tasks: insertTaskAfterDependencies(tasks, entryTask),
    changed: true,
  };
}

function withProfileSummaryTask(taskPlan: TaskPlan, tasks: Task[]) {
  if (tasks.some(taskOwnsProfileSummarySurface)) return { tasks, changed: false };

  const hasProfileState = tasks.some((task) => taskOwnsProfileRoute(task) || taskOwnsProfileRepositorySurface(task));
  const hasAiPipeline = tasks.some((task) => taskOwnsAiPipelineSurface(task) || taskOwnsAiValidationSurface(task));
  if (!hasProfileState || !hasAiPipeline) return { tasks, changed: false };

  const profileDependencies = tasks
    .filter((task) => taskOwnsProfileRepositorySurface(task) || taskOwnsAiPipelineSurface(task) || taskOwnsAiValidationSurface(task))
    .map((task) => finalGeneratedSliceTaskId(tasks, task.id));
  const summaryTask = {
    id: uniqueTaskId({ ...taskPlan, tasks }, 'E21-profile-summary'),
    owner: 'engineer' as const,
    deliverable: 'Implement profile summary creation and persistence as the single derived-profile state boundary.',
    depends_on: Array.from(new Set(profileDependencies)),
    acceptance_criteria: [
      'src/profileSummaryService.js creates or loads compact derived summaries for audience_segments and voice_profile profile artifacts before workflow prompt assembly.',
      'src/profileSummaryService.js stores derived summaries in R2, updates profile_artifacts.derived_summary_r2_key in D1, preserves original markdown as the source of truth, and is safe to call from profile upload or workflow profile-loading code without duplicating summary state logic.',
    ],
    owned_surfaces: ['src/profileSummaryService.js'],
  };

  return {
    tasks: insertTaskAfterDependencies(tasks, summaryTask),
    changed: true,
  };
}

function taskDependsOnAny(task: Task, ids: Set<string>) {
  return task.depends_on.some((dependency) => ids.has(dependency));
}

function withPreEntrypointGeneratedSliceDependencies(taskPlan: TaskPlan, tasks: Task[]) {
  const plan = { ...taskPlan, tasks };
  let changed = false;
  const nextTasks = tasks.map((task) => {
    const taskFamilyId = generatedSliceFamilyId(task.id);
    const depends_on = Array.from(
      new Set(
        task.depends_on.map((dependency) => {
          const dependencyTask = tasks.find((candidate) => candidate.id === dependency);
          if (!dependencyTask) return dependency;
          const replacement = taskHasRouteIntegrationContract(task)
            ? routeIntegrationDependencyId(tasks, dependencyTask)
            : preEntrypointBoundaryDependencyId(tasks, dependencyTask);
          if (replacement === dependency) return dependency;
          if (generatedSliceFamilyId(dependency) === taskFamilyId) return dependency;
          if (!taskCanSafelyDependOn(plan, task.id, replacement)) return dependency;

          changed = true;
          return replacement;
        }),
      ),
    );

    if (
      depends_on.length === task.depends_on.length &&
      depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ) {
      return task;
    }

    return { ...task, depends_on };
  });

  return { tasks: nextTasks, changed };
}

function withCloudflareWorkerDependencyContracts(tasks: Task[]) {
  const sanitized = withoutCyclicTaskDependencies(tasks, {
    preserveTask: (task) => taskHasRouteIntegrationContract(task) || taskOwnsSessionRoute(task),
  });
  tasks = sanitized.tasks;
  const routerTaskIds = new Set(routerBoundaryProviderTasks(tasks).map((task) => preEntrypointBoundaryDependencyId(tasks, task)));
  const sessionTaskIds = new Set(tasks.filter(taskOwnsSessionRoute).map((task) => preEntrypointBoundaryDependencyId(tasks, task)));
  const profileSummaryTaskIds = new Set(tasks.filter(taskOwnsProfileSummarySurface).map((task) => finalGeneratedSliceTaskId(tasks, task.id)));
  const integrationTask = tasks.find(taskHasRouteIntegrationContract);
  let changed = sanitized.changed;

  const next = tasks.map((task) => {
    const dependencies: string[] = [];

    if (taskOwnsRouteModule(task) && !taskOwnsSessionRoute(task)) {
      dependencies.push(...routerTaskIds);
      dependencies.push(...sessionTaskIds);
    }

    if ((taskOwnsProfileRoute(task) || taskOwnsWorkflowExecutionSurface(task)) && !taskOwnsProfileSummarySurface(task)) {
      dependencies.push(...profileSummaryTaskIds);
    }

    if (taskOwnsPublicAppSurface(task)) {
      dependencies.push(...sessionTaskIds);
      if (integrationTask) dependencies.push(integrationTask.id);
    }

    if (
      !taskIsRootScaffold(task) &&
      taskOwnsIndexSurface(task) &&
      !taskOwnsRouterSurface(task) &&
      taskHasFinalWorkerEntrypointContract(task) &&
      integrationTask &&
      task.id !== integrationTask.id
    ) {
      dependencies.push(integrationTask.id);
    }

    const filtered = dependencies.filter(
      (dependency) => dependency !== task.id && taskCanDependOnTaskList(tasks, task.id, dependency),
    );
    if (!filtered.length || taskDependsOnAny(task, new Set(filtered))) {
      const appended = appendDependencies(task, filtered);
      if (appended !== task) changed = true;
      return appended;
    }

    const appended = appendDependencies(task, filtered);
    if (appended !== task) changed = true;
    return appended;
  });

  return { tasks: next, changed };
}

function taskWorkflowImplementationSurface(task: Task) {
  return (
    taskOwnedBoundaryPaths(task).find((path) =>
      /^src\/(?:(?:workflows\/)?weeklyWorkflow|workflow)\.[cm]?[jt]s$/i.test(path),
    ) ?? 'src/workflow.js'
  );
}

function uniqueTaskIdFromTasks(tasks: Task[], baseId: string) {
  const existingIds = new Set(tasks.map((task) => task.id));
  if (!existingIds.has(baseId)) return baseId;

  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

function providerAdapterBehaviorTestTask(providerTask: Task, testId: string, criteria: string[]): Task {
  const extension = providerAdapterSurfaceExtension(providerTask);
  const testSurface = `test/provider-adapters.test.${extension}`;
  return {
    id: testId,
    owner: 'engineer',
    deliverable:
      'Add provider adapter behavior tests that prove failure normalization, secret handling, and Workers AI binding failures with fake provider environments.',
    depends_on: [providerTask.id],
    acceptance_criteria: Array.from(
      new Set([
        `${testSurface} uses fake Workers AI/fetch/provider inputs and does not call real provider APIs.`,
        `${testSurface} proves provider adapter failures normalize to provider_error and timeout_or_network_error RunResult values with client-safe messages from src/contracts.ts.`,
        `${testSurface} proves missing keyed secrets and missing Workers AI binding fail closed before external provider calls.`,
        'npm test passes and includes provider adapter behavior coverage.',
      ]),
    ),
    source_acceptance_criteria: Array.from(new Set(criteria)),
    owned_surfaces: [testSurface],
  };
}

function withProviderAdapterBehaviorTestTasks(tasks: Task[]) {
  let changed = false;
  let next = [...tasks];

  for (const providerTask of tasks) {
    if (!taskOwnsProviderAdapterSurface(providerTask)) continue;
    const evidenceCriteria = Array.from(
      new Set([...providerTask.acceptance_criteria, ...(providerTask.source_acceptance_criteria ?? [])]),
    );
    if (!evidenceCriteria.length) continue;

    const existingTestTask = next.find((task) => taskLooksLikeProviderAdapterBehaviorTest(task, providerTask.id));
    const testId = existingTestTask?.id ?? uniqueTaskIdFromTasks(next, `${providerTask.id}-provider-behavior-tests`);

    if (!existingTestTask) {
      const providerIndex = next.findIndex((task) => task.id === providerTask.id);
      const insertionIndex = providerIndex < 0 ? next.length : providerIndex + 1;
      next = [
        ...next.slice(0, insertionIndex),
        providerAdapterBehaviorTestTask(providerTask, testId, evidenceCriteria),
        ...next.slice(insertionIndex),
      ];
      changed = true;
    }

    next = next.map((task) => {
      if (task.id === testId) {
        const updated = appendTaskSourceAcceptanceCriteria(task, evidenceCriteria);
        if (updated !== task) changed = true;
        return updated;
      }
      if (task.id === testId || !task.depends_on.includes(providerTask.id) || task.depends_on.includes(testId)) return task;
      if (!taskCanDependOnTaskList(next, task.id, testId)) return task;
      changed = true;
      return appendDependencies(task, [testId]);
    });
  }

  return { tasks: next, changed };
}

function taskTestSurfaceExtension(task: Task) {
  return taskOwnedBoundaryPaths(task).some((path) => /\.(?:ts|mts|cts)$/.test(path)) ? 'ts' : 'js';
}

function taskOwnsApiRouteBehaviorSurface(task: Task) {
  return taskOwnsRouteModule(task) || taskOwnsRouterSurface(task) || (!taskIsRootScaffold(task) && taskOwnsIndexSurface(task));
}

function taskLooksLikeApiRouteBehaviorTest(task: Task, routeTaskId: string) {
  return (
    task.owner === 'engineer' &&
    task.depends_on.includes(routeTaskId) &&
    taskOwnedBoundaryPaths(task).some((path) => /^test\/.*(?:api|route).*\.test\.[cm]?[jt]s$/i.test(path)) &&
    /\b(?:api route|route behavior|\/api\/health|\/api\/models|\/api\/run|validation_error)\b/i.test(
      [task.deliverable, ...task.acceptance_criteria, ...task.owned_surfaces].join('\n'),
    )
  );
}

function apiRouteBehaviorTestTask(routeTask: Task, testId: string, criteria: string[]): Task {
  const extension = taskTestSurfaceExtension(routeTask);
  const testSurface = `test/api-routes.test.${extension}`;
  return {
    id: testId,
    owner: 'engineer',
    deliverable:
      'Add API route behavior tests that prove Worker route status codes, JSON shapes, validation failures, and provider-failure response handling with fake bindings.',
    depends_on: [routeTask.id],
    acceptance_criteria: Array.from(
      new Set([
        `${testSurface} imports or exercises the Worker route surface with fake env bindings and no real provider calls.`,
        `${testSurface} proves /api/health, /api/models, and /api/run status codes and JSON response shapes, including validation_error and provider-failure paths when those routes exist.`,
        'npm test passes and includes API route behavior coverage.',
      ]),
    ),
    source_acceptance_criteria: Array.from(new Set(criteria)),
    owned_surfaces: [testSurface],
  };
}

function taskHasApiRouteBehaviorCriterion(task: Task) {
  return [...task.acceptance_criteria, ...(task.source_acceptance_criteria ?? [])].some(
    isApiRouteBehaviorAcceptanceCriterion,
  );
}

function routeTaskBehaviorEvidenceCriterion(task: Task, criterion: string) {
  return (
    isApiRouteBehaviorAcceptanceCriterion(criterion) ||
    (taskHasApiRouteBehaviorCriterion(task) && isBehaviorLikeAcceptanceCriterion(criterion))
  );
}

function withApiRouteBehaviorTestTasks(tasks: Task[]) {
  let changed = false;
  let next = [...tasks];

  for (const routeTask of tasks) {
    if (!taskOwnsApiRouteBehaviorSurface(routeTask)) continue;
    const behaviorCriteria = Array.from(
      new Set(
        [...routeTask.acceptance_criteria, ...(routeTask.source_acceptance_criteria ?? [])].filter((criterion) =>
          routeTaskBehaviorEvidenceCriterion(routeTask, criterion),
        ),
      ),
    );
    if (!behaviorCriteria.length) continue;

    const existingTestTask = next.find((task) => taskLooksLikeApiRouteBehaviorTest(task, routeTask.id));
    const testId = existingTestTask?.id ?? uniqueTaskIdFromTasks(next, `${routeTask.id}-api-route-behavior-tests`);

    if (!existingTestTask) {
      const routeIndex = next.findIndex((task) => task.id === routeTask.id);
      const insertionIndex = routeIndex < 0 ? next.length : routeIndex + 1;
      next = [
        ...next.slice(0, insertionIndex),
        apiRouteBehaviorTestTask(routeTask, testId, behaviorCriteria),
        ...next.slice(insertionIndex),
      ];
      changed = true;
    }

    next = next.map((task) => {
      if (task.id === testId) {
        const updated = appendTaskSourceAcceptanceCriteria(task, behaviorCriteria);
        if (updated !== task) changed = true;
        return updated;
      }
      if (task.id === testId || !task.depends_on.includes(routeTask.id) || task.depends_on.includes(testId)) return task;
      if (!taskCanDependOnTaskList(next, task.id, testId)) return task;
      changed = true;
      return appendDependencies(task, [testId]);
    });
  }

  return { tasks: next, changed };
}

function taskOwnsFrontendBehaviorSurface(task: Task) {
  return taskOwnedBoundaryPaths(task).some((path) => /^public\/.+\.(?:html|css|js|mjs)$/i.test(path));
}

function taskLooksLikeFrontendBehaviorTest(task: Task, frontendTaskId: string) {
  return (
    task.owner === 'engineer' &&
    task.depends_on.includes(frontendTaskId) &&
    taskOwnedBoundaryPaths(task).some((path) => /^test\/.*(?:frontend|ui|dom|browser).*\.test\.[cm]?[jt]s$/i.test(path)) &&
    /\b(?:frontend behavior|frontend shell|ui behavior|ui shell|static shell|layout behavior|dom|browser|public\/app\.js|run controls?|result cards?)\b/i.test(
      [task.deliverable, ...task.acceptance_criteria, ...task.owned_surfaces].join('\n'),
    )
  );
}

function frontendBehaviorTestTask(frontendTask: Task, testId: string, criteria: string[]): Task {
  const extension = taskTestSurfaceExtension(frontendTask);
  const testSurface = `test/frontend-behavior.test.${extension}`;
  return {
    id: testId,
    owner: 'engineer',
    deliverable:
      'Add frontend behavior tests that exercise the vanilla public UI with DOM fixtures, fetch mocks, state changes, run controls, result rendering, sorting, and recovery messages.',
    depends_on: [frontendTask.id],
    acceptance_criteria: Array.from(
      new Set([
        `${testSurface} exercises the vanilla public UI with DOM fixtures and mocked fetch/FileReader behavior instead of a frontend framework build.`,
        `${testSurface} proves UI behavior contracts for state changes, run controls, result cards, sorting/highlighting, and visible recovery messages that exist in the source task.`,
        'npm test passes and includes frontend behavior coverage.',
      ]),
    ),
    source_acceptance_criteria: Array.from(new Set(criteria)),
    owned_surfaces: [testSurface],
  };
}

function withFrontendBehaviorTestTasks(tasks: Task[]) {
  let changed = false;
  let next = [...tasks];

  for (const frontendTask of tasks) {
    if (!taskOwnsFrontendBehaviorSurface(frontendTask)) continue;
    const evidenceCriteria = Array.from(
      new Set([...frontendTask.acceptance_criteria, ...(frontendTask.source_acceptance_criteria ?? [])]),
    );
    if (!evidenceCriteria.length) continue;

    const existingTestTask = next.find((task) => taskLooksLikeFrontendBehaviorTest(task, frontendTask.id));
    const testId = existingTestTask?.id ?? uniqueTaskIdFromTasks(next, `${frontendTask.id}-frontend-behavior-tests`);

    if (!existingTestTask) {
      const frontendIndex = next.findIndex((task) => task.id === frontendTask.id);
      const insertionIndex = frontendIndex < 0 ? next.length : frontendIndex + 1;
      next = [
        ...next.slice(0, insertionIndex),
        frontendBehaviorTestTask(frontendTask, testId, evidenceCriteria),
        ...next.slice(insertionIndex),
      ];
      changed = true;
    }

    next = next.map((task) => {
      if (task.id === testId) {
        const updated = appendTaskSourceAcceptanceCriteria(task, evidenceCriteria);
        if (updated !== task) changed = true;
        return updated;
      }
      if (task.id === testId || !task.depends_on.includes(frontendTask.id) || task.depends_on.includes(testId)) return task;
      if (!taskCanDependOnTaskList(next, task.id, testId)) return task;
      changed = true;
      return appendDependencies(task, [testId]);
    });
  }

  return { tasks: next, changed };
}

function validationBehaviorTestSurface(task: Task) {
  const extension = taskTestSurfaceExtension(task);
  return taskOwnsPathMatching(task, /^src\/validation\.[cm]?[jt]s$/i)
    ? `test/validation.test.${extension}`
    : `test/contracts.test.${extension}`;
}

function taskOwnsValidationBehaviorSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:contracts|validation)\.[cm]?[jt]s$/i);
}

function taskLooksLikeValidationBehaviorTest(task: Task, sourceTaskId: string, testSurface: string) {
  return (
    task.owner === 'engineer' &&
    task.depends_on.includes(sourceTaskId) &&
    taskOwnedBoundaryPaths(task).includes(testSurface) &&
    /\b(?:validation|contract|error shape|single-model|client-safe)\b/i.test(
      [task.deliverable, ...task.acceptance_criteria, ...task.owned_surfaces].join('\n'),
    )
  );
}

function validationBehaviorTestTask(sourceTask: Task, testId: string, testSurface: string, criteria: string[]): Task {
  const isValidation = /\/validation\.test\./.test(testSurface);
  return {
    id: testId,
    owner: 'engineer',
    deliverable: isValidation
      ? 'Add validation behavior tests that prove malformed requests, model selection, size limits, and provider-dispatch prevention with no real provider calls.'
      : 'Add domain contract behavior tests that prove client-safe error shapes, redaction rules, and single-model request contracts.',
    depends_on: [sourceTask.id],
    acceptance_criteria: Array.from(
      new Set([
        `${testSurface} imports the source contract or validation helpers directly and uses fake inputs with no real provider calls.`,
        `${testSurface} proves validation, client-safe error, redaction, and single-model behavior contracts owned by the source task.`,
        'npm test passes and includes validation/domain contract behavior coverage.',
      ]),
    ),
    source_acceptance_criteria: Array.from(new Set(criteria)),
    owned_surfaces: [testSurface],
  };
}

function withValidationBehaviorTestTasks(tasks: Task[]) {
  let changed = false;
  let next = [...tasks];

  for (const sourceTask of tasks) {
    if (!taskOwnsValidationBehaviorSurface(sourceTask)) continue;
    const evidenceCriteria = Array.from(
      new Set([...sourceTask.acceptance_criteria, ...(sourceTask.source_acceptance_criteria ?? [])]),
    );
    if (!evidenceCriteria.length) continue;

    const testSurface = validationBehaviorTestSurface(sourceTask);
    const baseId = /\/validation\.test\./.test(testSurface)
      ? `${sourceTask.id}-validation-behavior-tests`
      : `${sourceTask.id}-contract-behavior-tests`;
    const existingTestTask = next.find((task) => taskLooksLikeValidationBehaviorTest(task, sourceTask.id, testSurface));
    const testId = existingTestTask?.id ?? uniqueTaskIdFromTasks(next, baseId);

    if (!existingTestTask) {
      const sourceIndex = next.findIndex((task) => task.id === sourceTask.id);
      const insertionIndex = sourceIndex < 0 ? next.length : sourceIndex + 1;
      next = [
        ...next.slice(0, insertionIndex),
        validationBehaviorTestTask(sourceTask, testId, testSurface, evidenceCriteria),
        ...next.slice(insertionIndex),
      ];
      changed = true;
    }

    next = next.map((task) => {
      if (task.id === testId) {
        const updated = appendTaskSourceAcceptanceCriteria(task, evidenceCriteria);
        if (updated !== task) changed = true;
        return updated;
      }
      if (task.id === testId || !task.depends_on.includes(sourceTask.id) || task.depends_on.includes(testId)) return task;
      if (!taskCanDependOnTaskList(next, task.id, testId)) return task;
      changed = true;
      return appendDependencies(task, [testId]);
    });
  }

  return { tasks: next, changed };
}

function sourceContractCriteriaForTask(
  task: Task,
  context: {
    contractScope: SourceScopedDeliveryContracts;
    hasAuthBoundary: boolean;
    hasProfileState: boolean;
    hasAiValidationSurface: boolean;
    hasWorkerWorkflow: boolean;
    hasPersistentRunLifecycle: boolean;
    indexOwnerCount: number;
  },
) {
  const authSurface = taskAuthBoundarySurface(task);
  return sourceTaskPlanContractCriteria({
    contractScope: context.contractScope,
    hasAuthBoundary: context.hasAuthBoundary,
    hasProfileState: context.hasProfileState,
    hasAiValidationSurface: context.hasAiValidationSurface,
    hasWorkerWorkflow: context.hasWorkerWorkflow,
    hasPersistentRunLifecycle: context.hasPersistentRunLifecycle,
    indexOwnerCount: context.indexOwnerCount,
    ownsOperatorAuthBoundary: taskOwnsOperatorAuthBoundary(task),
    authSurface,
    authBoundaryIsInternalHelper: !taskOwnsAuthSurface(task) || /\/adminAuth\.[cm]?[jt]s$/i.test(authSurface),
    ownsPublicAppSurface: taskOwnsPublicAppSurface(task),
    ownsD1MigrationFile: taskOwnsD1MigrationFile(task),
    migrationSurface: taskD1MigrationSurface(task) ?? 'migrations/0001_schema.sql',
    ownsProfileRoute: taskOwnsProfileRoute(task),
    ownsManualRunRoute: taskOwnsManualRunRoute(task),
    ownsLatestRoute: taskOwnsLatestRoute(task),
    ownsRegenerationRoute: taskOwnsRegenerationRoute(task),
    ownsCandidateRoute: taskOwnsCandidateRoute(task),
    ownsProfileRepositorySurface: taskOwnsProfileRepositorySurface(task),
    ownsContractSurface: taskOwnsContractSurface(task),
    ownsRunRepositorySurface: taskOwnsRunRepositorySurface(task),
    ownsSchedulerSurface: taskOwnsSchedulerSurface(task),
    ownsWorkflowExecutionSurface: taskOwnsWorkflowExecutionSurface(task),
    isRootScaffold: taskIsRootScaffold(task),
    workflowSurface: taskWorkflowImplementationSurface(task),
    ownsRunRoute: taskOwnsRunRoute(task),
    ownsTranscriptRepositorySurface: taskOwnsTranscriptRepositorySurface(task),
    ownsAiValidationSurface: taskOwnsAiValidationSurface(task),
    ownsAiPipelineSurface: taskOwnsAiPipelineSurface(task),
    ownsRouterSurface: taskOwnsRouterSurface(task),
    hasRouteIntegrationContract: taskHasRouteIntegrationContract(task),
    ownsWorkerConfigFile: taskOwnsWorkerConfigFile(task),
    ownsIndexSurface: taskOwnsIndexSurface(task),
    ownsReadme: taskOwnsReadme(task),
    sourceRouteEndpointCriteria: taskRouteEndpointSourceCriteria(task),
  });
}

export function normalizeTaskPlanCloudflareWorkerContracts(taskPlan: TaskPlan, sourcePolicy?: SourcePolicy): TaskPlan {
  let changed = false;
  const contractScope = sourceScopedDeliveryContracts(sourcePolicy);
  const indexOwnerCount = taskPlan.tasks.filter(taskOwnsIndexSurface).length;
  const hasAuthBoundary = taskPlan.tasks.some(taskOwnsOperatorAuthBoundary);
  const hasProfileState =
    contractScope.profileState &&
    taskPlan.tasks.some((task) => taskOwnsProfileRoute(task) || taskOwnsProfileRepositorySurface(task));
  const hasAiValidationSurface = taskPlan.tasks.some(taskOwnsAiValidationSurface);
  const hasWorkerWorkflow = taskPlanDeclaresWorkerWorkflow(taskPlan.tasks);
  const hasPersistentRunLifecycle = contractScope.latestTranscript && taskPlanHasPersistentRunLifecycle(taskPlan.tasks);

  let tasks = taskPlan.tasks.map((task) => {
    const statusCanonicalized = withCanonicalCompletedEmptyStatus(task);
    if (statusCanonicalized !== task) {
      changed = true;
      task = statusCanonicalized;
    }

    if (!hasPersistentRunLifecycle) {
      const lifecycleSanitized = withoutPersistentRunLifecycleCriteria(task);
      if (lifecycleSanitized !== task) {
        changed = true;
        task = lifecycleSanitized;
      }
    }

    const sessionSecretSanitized = withoutSessionSecretFallbackCriteria(task);
    if (sessionSecretSanitized !== task) {
      changed = true;
      task = sessionSecretSanitized;
    }

    const rootSanitized = withoutRootScaffoldWorkflowExecutionCriteria(task);
    if (rootSanitized !== task) {
      changed = true;
      task = rootSanitized;
    }

    const generatedTypeSanitized = withoutGeneratedWorkerTypeOwnership(task);
    if (generatedTypeSanitized !== task) {
      changed = true;
      task = generatedTypeSanitized;
    }

    if (taskOwnsPublicAppSurface(task)) {
      const sanitized = withoutPublicUiRawAdminTokenCriteria(task);
      if (sanitized !== task) {
        changed = true;
        task = sanitized;
      }
    }

    if (taskOwnsSessionRoute(task)) {
      const sanitized = withoutSessionRouteCrossSurfaceCriteria(task);
      if (sanitized !== task) {
        changed = true;
        task = sanitized;
      }
    }

    const lifecycleSanitized = withoutLifecycleDriftCriteria(task);
    if (lifecycleSanitized !== task) {
      changed = true;
      task = lifecycleSanitized;
    }

    const workflowExportSanitized = withoutWorkflowExportDriftCriteria(task);
    if (workflowExportSanitized !== task) {
      changed = true;
      task = workflowExportSanitized;
    }

    const boundaryAuthoritySanitized = withoutBoundaryAuthorityDriftCriteria(task);
    if (boundaryAuthoritySanitized !== task) {
      changed = true;
      task = boundaryAuthoritySanitized;
    }

    const schedulerSanitized = withoutSchedulerWorkflowExecutionCriteria(task);
    if (schedulerSanitized !== task) {
      changed = true;
      task = schedulerSanitized;
    }

    const routeOwnershipSanitized = withoutRouteOwnershipDriftCriteria(task);
    if (routeOwnershipSanitized !== task) {
      changed = true;
      task = routeOwnershipSanitized;
    }

    const migrationCanonicalized = canonicalizeProfileMigrationCriterionSurface(task);
    if (migrationCanonicalized !== task) {
      changed = true;
      task = migrationCanonicalized;
    }

    if (hasAiValidationSurface && !taskOwnsAiValidationSurface(task)) {
      const sanitized = withoutAiOutputValidationCriteria(task);
      if (sanitized !== task) {
        changed = true;
        task = sanitized;
      }
    }

    const criteria = sourceContractCriteriaForTask(task, {
      contractScope,
      hasAuthBoundary,
      hasProfileState,
      hasAiValidationSurface,
      hasWorkerWorkflow,
      hasPersistentRunLifecycle,
      indexOwnerCount,
    });

    if (!criteria.length) return task;
    const next = appendTaskAcceptanceCriteria(task, criteria);
    if (next !== task) changed = true;
    return next;
  });

  const withSession = withAuthSessionTask(taskPlan, tasks);
  if (withSession.changed) {
    changed = true;
    tasks = withSession.tasks;
  }

  const withIntegration = withRouteIntegrationTask(taskPlan, tasks, contractScope);
  if (withIntegration.changed) {
    changed = true;
    tasks = withIntegration.tasks;
  }

  if (contractScope.profileState) {
    const withSummary = withProfileSummaryTask(taskPlan, tasks);
    if (withSummary.changed) {
      changed = true;
      tasks = withSummary.tasks;
    }
  }

  if (contractScope.latestTranscript) {
    const withEntrypoint = withWorkerEntrypointIntegrationTask(taskPlan, tasks);
    if (withEntrypoint.changed) {
      changed = true;
      tasks = withEntrypoint.tasks;
    }
  }

  const withProviderBehaviorTests = withProviderAdapterBehaviorTestTasks(tasks);
  if (withProviderBehaviorTests.changed) {
    changed = true;
    tasks = withProviderBehaviorTests.tasks;
  }

  const withApiRouteBehaviorTests = withApiRouteBehaviorTestTasks(tasks);
  if (withApiRouteBehaviorTests.changed) {
    changed = true;
    tasks = withApiRouteBehaviorTests.tasks;
  }

  const withFrontendBehaviorTests = withFrontendBehaviorTestTasks(tasks);
  if (withFrontendBehaviorTests.changed) {
    changed = true;
    tasks = withFrontendBehaviorTests.tasks;
  }

  const withValidationBehaviorTests = withValidationBehaviorTestTasks(tasks);
  if (withValidationBehaviorTests.changed) {
    changed = true;
    tasks = withValidationBehaviorTests.tasks;
  }

  const withDependencies = withCloudflareWorkerDependencyContracts(tasks);
  if (withDependencies.changed) {
    changed = true;
    tasks = withDependencies.tasks;
  }

  const withPreEntrypointDependencies = withPreEntrypointGeneratedSliceDependencies(taskPlan, tasks);
  if (withPreEntrypointDependencies.changed) {
    changed = true;
    tasks = withPreEntrypointDependencies.tasks;
  }

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

function taskPlanHasOperatorDocumentation(taskPlan: TaskPlan) {
  return taskPlan.tasks.some((task) => taskOwnedBoundaryPaths(task).includes('README.md'));
}

function uniqueTaskId(taskPlan: TaskPlan, baseId: string) {
  const existingIds = new Set(taskPlan.tasks.map((task) => task.id));
  if (!existingIds.has(baseId)) return baseId;

  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

export function normalizeTaskPlanOperatorDocumentation(taskPlan: TaskPlan): TaskPlan {
  if (taskPlanHasOperatorDocumentation(taskPlan)) return taskPlan;

  const id = uniqueTaskId(taskPlan, 'E99-operator-documentation');
  return {
    ...taskPlan,
    tasks: [
      ...taskPlan.tasks,
      {
        id,
        owner: 'engineer',
        deliverable: "Document local Worker validation, required Cloudflare resources, and Chris's human-approved Wrangler deployment flow.",
        depends_on: taskPlan.tasks.map((task) => task.id),
        acceptance_criteria: [
          'README.md documents local development and validation with Wrangler CLI, including npm scripts and expected ports.',
          'README.md lists required Cloudflare resources, bindings, secrets, and Workers AI binding expectations.',
          'README.md explains source-control expectations: local git checkpoints are allowed, while pushes/PRs through gh require explicit human direction, and production deploy waits for human approval before running wrangler deploy --env production.',
        ],
        owned_surfaces: ['README.md'],
      },
    ],
  };
}

export function operatorDocumentationHygiene(taskPlan: TaskPlan) {
  if (taskPlanHasOperatorDocumentation(taskPlan)) return { passed: true, reason: 'ok' };

  return {
    passed: false,
    reason:
      'Task plan does not include README.md operator documentation. Add an engineer-owned README.md task that captures local Wrangler validation, required Cloudflare resources/bindings, local git checkpoints, explicit human direction before gh push/PR actions, and human-approved wrangler deploy --env production.',
  };
}

function generatedSliceDependencyPolicy(taskPlan: TaskPlan) {
  return {
    canTaskDependOn: (taskId: string, dependencyId: string) => taskCanSafelyDependOn(taskPlan, taskId, dependencyId),
    canUsePreEntrypointGeneratedDependency: (dependencyId: string, finalDependencyId: string) =>
      canUsePreEntrypointGeneratedDependency(taskPlan.tasks, dependencyId, finalDependencyId),
  };
}

export function normalizeTaskPlanGeneratedSliceDependencies(taskPlan: TaskPlan): TaskPlan {
  return normalizeGeneratedSliceDependencies(taskPlan, generatedSliceDependencyPolicy(taskPlan));
}

function allTaskAcceptanceContractCriteria(taskPlan: TaskPlan) {
  return taskPlan.tasks.flatMap((task) =>
    taskAcceptanceContractCriteria(task).map((criterion, index) => ({
      taskId: task.id,
      sourceTaskId: taskSourceTaskId(task),
      contractId: acceptanceContractId(task, index, criterion),
      criterion,
    })),
  );
}

function allProductAcceptanceContractCriteria(taskPlan: TaskPlan) {
  return allTaskAcceptanceContractCriteria(taskPlan).filter(
    (contract) =>
      !generatedSliceAcceptanceCriterion(contract.criterion) &&
      !conditionalGeneratedPolicyAcceptanceCriterion(contract.criterion),
  );
}

function revisedPlanCarriesCriterion(taskPlan: TaskPlan, criterion: string) {
  return taskPlan.tasks.some((task) => taskAcceptanceContractCriteria(task).includes(criterion));
}

function conditionalGeneratedPolicyAcceptanceCriterion(criterion: string) {
  return (
    generatedWorkerTypeOwnershipCriterion(criterion) ||
    /src\/index\.js exports a minimal class named WeeklyWorkflow that extends WorkflowEntrypoint when wrangler\.jsonc defines workflows\.class_name "WeeklyWorkflow"/i.test(
      criterion,
    ) ||
    /src\/index\.js changes preserve the existing default fetch handler[\s\S]*WeeklyWorkflow export/i.test(criterion) ||
    /src\/index\.js preserves a stable WeeklyWorkflow export/i.test(criterion) ||
    /README\.md documents direct Authorization: Bearer <ADMIN_TOKEN>[\s\S]*SESSION_SECRET/i.test(criterion) ||
    /^Profile (?:upload|storage|repository|upload, profile activation)/i.test(criterion) ||
    /^Cookie-authenticated (?:profile|run|regeneration)/i.test(criterion) ||
    /^POST \/profiles accepts multipart\/form-data uploads for audience_segments and voice_profile markdown/i.test(criterion) ||
    /^POST \/profiles\/:id\/activate atomically activates the selected profile/i.test(criterion) ||
    /^GET \/profiles returns profile metadata and active-state summaries/i.test(criterion) ||
    /^POST \/runs creates a queued manual run record with a default previous-seven-day window/i.test(criterion) ||
    /^GET \/runs\/:id returns run status, requested window, profile artifact IDs used/i.test(criterion) ||
    /^GET \/latest returns the latest completed transcript with title, hook, transcript, captions, sourceUrls/i.test(criterion) ||
    /^run, latest route handlers delegate/i.test(criterion) ||
    /^Route integration defines and enforces the protection matrix/i.test(criterion) ||
    /^The router surface explicitly registers the browser session endpoint/i.test(criterion)
  );
}

function revisedContractTargetIndex(tasks: Task[], contract: { taskId: string; sourceTaskId: string }) {
  const exact = tasks.findIndex((task) => task.id === contract.taskId);
  if (exact >= 0) return exact;

  const sourceMatch = tasks.findIndex((task) => taskSourceTaskId(task) === contract.sourceTaskId);
  if (sourceMatch >= 0) return sourceMatch;

  const familyId = generatedSliceFamilyId(contract.taskId);
  return tasks.findIndex((task) => generatedSliceFamilyId(task.id) === familyId);
}

export function preserveTaskPlanAcceptanceContracts(previousTaskPlan: TaskPlan, revisedTaskPlan: TaskPlan) {
  const missing = allProductAcceptanceContractCriteria(previousTaskPlan).filter(
    (contract) => !revisedPlanCarriesCriterion(revisedTaskPlan, contract.criterion),
  );
  if (!missing.length) return { taskPlan: revisedTaskPlan, carried: 0 };

  const tasks = revisedTaskPlan.tasks.map((task) => ({
    ...task,
    source_acceptance_criteria: task.source_acceptance_criteria ? [...task.source_acceptance_criteria] : undefined,
  }));
  let carried = 0;

  for (const contract of missing) {
    const targetIndex = revisedContractTargetIndex(tasks, contract);
    if (targetIndex < 0) continue;

    const target = tasks[targetIndex];
    if (taskAcceptanceContractCriteria(target).includes(contract.criterion)) continue;

    tasks[targetIndex] = {
      ...target,
      source_acceptance_criteria: Array.from(
        new Set([...(target.source_acceptance_criteria ?? []), contract.criterion]),
      ),
    };
    carried += 1;
  }

  return carried ? { taskPlan: { ...revisedTaskPlan, tasks }, carried } : { taskPlan: revisedTaskPlan, carried: 0 };
}

export function taskPlanAcceptanceContractRegression(previousTaskPlan: TaskPlan, revisedTaskPlan: TaskPlan) {
  const missing = allProductAcceptanceContractCriteria(previousTaskPlan).filter(
    (contract) => !revisedPlanCarriesCriterion(revisedTaskPlan, contract.criterion),
  );

  if (!missing.length) return { passed: true, reason: 'ok' };

  const examples = missing
    .slice(0, 5)
    .map((contract) => `${contract.taskId}/${contract.contractId}: ${contract.criterion}`)
    .join(' | ');
  const suffix = missing.length > 5 ? `; ${missing.length - 5} more contract(s) omitted` : '';
  return {
    passed: false,
    reason: `Task plan revision dropped acceptance contract(s) from the prior plan. Preserve each criterion verbatim in acceptance_criteria or source_acceptance_criteria when splitting/refining tasks: ${examples}${suffix}`,
  };
}

export function generatedSliceDependencyHygiene(taskPlan: TaskPlan) {
  return generatedSliceDependencyHygieneWithPolicy(taskPlan, generatedSliceDependencyPolicy(taskPlan));
}

function entrypointFetchDelegationSurfaces(criteria: string[]) {
  const surfaces = new Set<string>();
  for (const criterion of criteria) {
    for (const match of criterion.matchAll(/\bsrc\/index\.js delegates fetch handling to (src\/(?:router|http)\.[cm]?[jt]s)\b/gi)) {
      if (match[1]) surfaces.add(normalizeDeliveryPathReference(match[1]));
    }
  }
  return surfaces;
}

export function routeBoundaryConsistencyHygiene(taskPlan: TaskPlan) {
  const routeIntegrationSurfaces = new Set(
    taskPlan.tasks.filter(taskHasRouteIntegrationContract).map((task) => taskRouterBoundarySurface(task)),
  );
  const expectedIntegrationSurface = routeIntegrationSurfaces.size === 1 ? [...routeIntegrationSurfaces][0] : undefined;

  for (const task of taskPlan.tasks) {
    const criteria = taskAcceptanceContractCriteria(task);
    const delegatedSurfaces = entrypointFetchDelegationSurfaces(criteria);
    if (delegatedSurfaces.size > 1) {
      return {
        passed: false,
        reason: `${task.id} has contradictory final entrypoint fetch delegation surfaces: ${[...delegatedSurfaces].join(', ')}. Choose the same route boundary used by route integration.`,
      };
    }

    if (
      criteria.some((criterion) => /\bsrc\/index\.js does not reference src\/router\.js\b/i.test(criterion)) &&
      criteria.some((criterion) => /\bsrc\/index\.js delegates fetch handling to src\/router\.js\b/i.test(criterion))
    ) {
      return {
        passed: false,
        reason: `${task.id} says src/index.js must not reference src/router.js while also delegating fetch handling to src/router.js.`,
      };
    }

    const [delegatedSurface] = [...delegatedSurfaces];
    if (
      expectedIntegrationSurface &&
      delegatedSurface &&
      taskHasFinalWorkerEntrypointContract(task) &&
      delegatedSurface !== expectedIntegrationSurface
    ) {
      return {
        passed: false,
        reason: `${task.id} delegates fetch handling to ${delegatedSurface}, but route integration owns ${expectedIntegrationSurface}. Use one route boundary.`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

export function projectScaffoldHygiene(repoPath: string, taskPlan: TaskPlan) {
  if (existsSync(join(repoPath, 'package.json'))) return { passed: true, reason: 'ok' };

  const plansRuntimeWork = taskPlan.tasks.some(ownsWorkerRuntimeSurface);
  if (!plansRuntimeWork) return { passed: true, reason: 'ok' };

  const rootTasks = taskPlan.tasks.filter((task) => task.depends_on.length === 0);
  const scaffoldRootTask = rootTasks.find(ownsPackageScaffold);
  if (!scaffoldRootTask) {
    return {
      passed: false,
      reason:
        'Target repo has no package.json. The task plan needs a root scaffold task that owns package.json, .gitignore, and a concrete Worker source entry before Worker runtime files so automated verification can run.',
    };
  }

  if (!ownsWorkerSourceInputSurface(scaffoldRootTask)) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns package.json but no Worker source input. Bare Worker scaffolds need an owned source surface such as src/index.js, workers/app.js, or src/index.ts before later tasks.`,
    };
  }

  if (ownsTypeScriptInputSurface(scaffoldRootTask) && !ownsExactSurface(scaffoldRootTask, 'tsconfig.json')) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns TypeScript Worker source but not tsconfig.json. TypeScript Worker scaffolds need tsconfig.json so npm run typecheck can pass before later tasks.`,
    };
  }

  if (!releaseGateWorkerConfigPath(repoPath) && !ownsWorkerConfigSurface(scaffoldRootTask)) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns the new Worker package scaffold but not wrangler.jsonc. New Worker scaffolds should include wrangler.jsonc in the root task so the first build slice can run Wrangler dry-run validation before downstream runtime tasks.`,
    };
  }

  const plannedTomlConfig = taskPlan.tasks.find((task) => ownsExactSurface(task, 'wrangler.toml'));
  if (plannedTomlConfig && !existsSync(join(repoPath, 'wrangler.toml'))) {
    return {
      passed: false,
      reason: `${plannedTomlConfig.id} owns wrangler.toml, but this repo has no existing wrangler.toml. New Worker project plans should own wrangler.jsonc so config schema validation, bindings, and local Wrangler checks use the current JSONC config path.`,
    };
  }

  const unscaffoldedRootRuntimeTask = rootTasks.find((task) => ownsWorkerRuntimeSurface(task) && !ownsPackageScaffold(task));
  if (unscaffoldedRootRuntimeTask) {
    return {
      passed: false,
      reason: `${unscaffoldedRootRuntimeTask.id} owns Worker/runtime surfaces before the package scaffold. Make it depend_on ${scaffoldRootTask.id}, or include package.json and the Worker source entry in the same root scaffold task.`,
    };
  }

  return { passed: true, reason: 'ok' };
}

function normalizeTaskPlanForDelivery(repoPath: string, taskPlan: TaskPlan): TaskPlan {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  return normalizeTaskPlanOperatorDocumentation(
    normalizeTaskPlanCloudflareWorkerContracts(
      normalizeTaskPlanGeneratedSliceDependencies(
        normalizeTaskPlanLargeStorageTasks(
          normalizeTaskPlanConfigSchemaTasks(
            normalizeTaskPlanRoleBoundaries(
              normalizeTaskPlanProfileContractDependencies(normalizeTaskPlanScaffoldDependencies(repoPath, taskPlan)),
            ),
          ),
        ),
      ),
      sourcePolicy,
    ),
  );
}

const taskPlanDeterministicResults = ({
  repoPath,
  taskPlan,
  sourcePolicy,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  sourcePolicy?: SourcePolicy;
}): DeterministicGateResult[] => [
  { id: 'tasks_structurally_complete', check: 'plan_schema_complete', ...planSchemaComplete(taskPlan) },
  { id: 'no_circular_dependencies', check: 'dependency_graph_acyclic', ...dependencyGraphAcyclic(taskPlan) },
  { id: 'open_decisions_hygiene', check: 'open_decision_hygiene', ...openDecisionHygiene(taskPlan) },
  { id: 'owned_surfaces_concrete', check: 'owned_surface_hygiene', ...ownedSurfaceHygiene(taskPlan) },
  { id: 'owned_surfaces_match_roles', check: 'task_owned_surfaces_in_role_boundary', ...taskOwnedSurfaceRoleHygiene(taskPlan) },
  { id: 'pages_functions_source_declared', check: 'pages_functions_exception', ...pagesFunctionsExceptionHygiene(taskPlan, sourcePolicy) },
  { id: 'root_project_scaffolded', check: 'project_scaffold_hygiene', ...projectScaffoldHygiene(repoPath, taskPlan) },
  { id: 'config_schema_tasks_split', check: 'config_schema_task_split_hygiene', ...configSchemaTaskSplitHygiene(taskPlan) },
  { id: 'operator_documentation_planned', check: 'operator_documentation_hygiene', ...operatorDocumentationHygiene(taskPlan) },
  {
    id: 'generated_slice_dependencies_finalized',
    check: 'generated_slice_dependency_hygiene',
    ...generatedSliceDependencyHygiene(taskPlan),
  },
  {
    id: 'profile_contract_dependency_order',
    check: 'profile_contract_dependency_order',
    ...profileContractDependencyHygiene(taskPlan),
  },
  {
    id: 'route_boundary_consistent',
    check: 'route_boundary_consistency',
    ...routeBoundaryConsistencyHygiene(taskPlan),
  },
];

function topoOrderTasks(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      if (byId.has(dependency)) indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue = tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0);
  const ordered: Task[] = [];
  while (queue.length) {
    const task = queue.shift();
    if (!task) continue;
    ordered.push(task);
    for (const candidate of tasks) {
      if (candidate.depends_on.includes(task.id)) {
        indegree.set(candidate.id, (indegree.get(candidate.id) ?? 0) - 1);
        if (indegree.get(candidate.id) === 0) queue.push(candidate);
      }
    }
  }

  if (ordered.length !== tasks.length) {
    throw new Error('task dependency graph is cyclic or incomplete');
  }

  return ordered;
}

const buildRoleForTask = (task: Task) => (task.owner === 'designer' ? 'designer' : 'engineer') as 'designer' | 'engineer';

const taskStatusSummary = (state: Record<string, 'complete' | 'stuck' | 'blocked'>) =>
  Object.entries(state).map(([id, status]) => `${id}:${status}`);

export const hasExecutableRootTask = (taskPlan: TaskPlan) =>
  taskPlan.tasks.some((task) => task.depends_on.length === 0 && task.acceptance_criteria.length && task.owned_surfaces.length);

export function isTrueBlockingAmbiguity(question: string) {
  if (looksLikeSettledDeliveryPolicy(question)) return false;
  if (looksLikeSafeAssumptionOrRisk(question)) return false;
  const namesBlockingImpact =
    /\b(blocks?|blocked|cannot|prevents?|required before|must be resolved before|implementation impossible|missing required)\b/i.test(
      question,
    );
  if (!namesBlockingImpact) return false;

  return /\b(?:vision|spec|source docs?|requirements?|explicitly|TBD|not specified|missing required|omits required|unprovided|unavailable)\b/i.test(
    question,
  );
}

export const shouldSuspendForPlannerQuestions = (readout: Readout, taskPlan: TaskPlan) =>
  readout.blocking_ambiguities.some(isTrueBlockingAmbiguity) && !hasExecutableRootTask(taskPlan);

function weakDimensionIsNonActionableForTask(
  dimension: AggregatedJudgment['dimensions_scored'][number],
  task?: Task,
) {
  if (dimension.id === 'implementation_note_quality') return true;
  if (dimension.id !== 'state_explicitness') return false;
  if (taskOwnsStatePersistenceSurface(task)) return false;
  return /\b(database|db|d1|sql|schema|table|check constraints?|indexes?|indices)\b/i.test(dimension.evidence);
}

export function implementationWeakDimensionRemediation(judgment: AggregatedJudgment, task?: Task) {
  return judgment.dimensions_scored
    .filter((dimension) => dimension.score <= 3)
    .filter((dimension) => !weakDimensionIsNonActionableForTask(dimension, task))
    .map(
      (dimension) =>
        `DIMENSION ${dimension.id} scored ${dimension.score}/5. Improve this before continuing: ${compactDiagnostic(
          dimension.evidence,
          500,
        )}`,
    );
}

export function implementationActionableJudgmentRemediation(judgment: AggregatedJudgment, task?: Task) {
  const nonActionableDimensionIds = new Set(
    judgment.dimensions_scored
      .filter((dimension) => dimension.score <= 3)
      .filter((dimension) => weakDimensionIsNonActionableForTask(dimension, task))
      .map((dimension) => dimension.id),
  );

  return judgment.remediation.filter((item) => {
    for (const dimensionId of nonActionableDimensionIds) {
      if (item.startsWith(`DIMENSION ${dimensionId} `)) return false;
    }
    return true;
  });
}

function implementationFindingSteps(taskId: string, judgment: AggregatedJudgment, task?: Task) {
  const remediation = [
    ...implementationActionableJudgmentRemediation(judgment, task),
    ...implementationWeakDimensionRemediation(judgment, task),
  ];
  return remediation.length ? remediation : [`${taskId} did not produce a passing implementation judgment`];
}

export function shouldProceedAfterNonActionableImplementationJudgment({
  judgment,
  deterministicResults,
  note,
  task,
}: {
  judgment: AggregatedJudgment;
  deterministicResults: DeterministicGateResult[];
  note: ImplementationNote;
  task?: Task;
}) {
  if (judgment.passed) return false;
  if (judgment.gates_failed.length || judgment.dimensions_missing.length) return false;
  if (implementationActionableJudgmentRemediation(judgment, task).length) return false;
  if (implementationWeakDimensionRemediation(judgment, task).length) return false;
  if (!deterministicResults.every((result) => result.passed)) return false;
  if (!note.verification.performed.length) return false;
  if (note.verification.missing.some((item) => /\bfailed:/i.test(item))) return false;
  return true;
}

export function implementationJudgmentCanComplete({
  judgment,
  deterministicResults,
  note,
  task,
}: {
  judgment: AggregatedJudgment;
  deterministicResults: DeterministicGateResult[];
  note: ImplementationNote;
  task?: Task;
}) {
  if (judgment.passed && !judgment.gates_failed.length && !judgment.dimensions_missing.length) return true;
  return shouldProceedAfterNonActionableImplementationJudgment({ judgment, deterministicResults, note, task });
}

function repoFileContents(repoPath: string, paths: Array<string | undefined>) {
  return paths
    .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    .map((path) => {
      const normalizedPath = normalizeDeliveryPathReference(path);
      const fullPath = isAbsolute(normalizedPath) ? normalizedPath : join(resolve(repoPath), normalizedPath);
      if (!existsSync(fullPath)) return undefined;
      return {
        path: normalizedPath,
        content: readFileSync(fullPath, 'utf8'),
      };
    })
    .filter((file): file is { path: string; content: string } => Boolean(file));
}

function concreteTaskSurfacePaths(task: Task) {
  return normalizedOwnedSurfaces(task)
    .filter((surface) => !surface.includes('*'))
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => typeof path === 'string' && !/^unknown:/i.test(path));
}

export function directDependencySurfacePaths(taskPlan: TaskPlan, task: Task) {
  const byId = new Map(taskPlan.tasks.map((candidate) => [candidate.id, candidate]));
  const paths = task.depends_on.flatMap((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return dependency ? concreteTaskSurfacePaths(dependency) : [];
  });
  return Array.from(new Set(paths.filter((path) => !taskOwnedBoundaryPaths(task).includes(path))));
}

function focusedRepairContextPaths(taskPlan: TaskPlan, task: Task, boundarySurfaces: string[]) {
  const boundaryPaths = boundarySurfaces
    .filter((surface) => !surface.includes('*'))
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path));
  const dependencyPaths = directDependencySurfacePaths(taskPlan, task).filter(
    (path) => path.startsWith('src/') || path.startsWith('migrations/'),
  );
  return Array.from(new Set([...boundaryPaths, ...dependencyPaths]));
}

const implementationWriteTools = new Set<string>([
  'Write',
  'Edit',
  'MultiEdit',
  'auto_repair',
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
]);

function responseText(response: unknown) {
  if (!response || typeof response !== 'object') return undefined;
  const text = (response as { text?: unknown }).text;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function knownSecretValues() {
  return Object.entries(process.env)
    .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(name) && typeof value === 'string')
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value && value.length >= 8));
}

function redactSecretsFromText(text: string) {
  return knownSecretValues().reduce((current, secret) => current.split(secret).join('[REDACTED]'), text);
}

function redactTraceValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsFromText(value);
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactTraceValue(item)]));
}

function serializeAgentResponse(response: unknown) {
  if (!response || typeof response !== 'object') return redactTraceValue(response);
  const record = response as Record<string, unknown>;
  return redactTraceValue({
    text: record.text,
    object: record.object,
    finishReason: record.finishReason,
    usage: record.usage,
    warnings: record.warnings,
  });
}

async function writeStageTraceArtifact({
  repoPath,
  mastra,
  artifactType,
  artifactPath,
  trace,
}: {
  repoPath: string;
  mastra: any;
  artifactType: string;
  artifactPath: string;
  trace: unknown;
}) {
  writeDeliveryArtifact({
    repoPath,
    artifactPath,
    artifact: redactTraceValue(trace),
  });
  await recordDeliveryArtifactState({
    repoPath,
    type: artifactType,
    path: artifactPath,
    mastra,
  });
  return artifactPath;
}

function existingOwnedFiles(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task).filter((surface) => {
    if (surface.includes('*')) return false;
    const path = concreteOwnedSurfacePath(surface);
    return path ? existsSync(join(resolve(repoPath), path)) : false;
  });
}

function concreteOwnedSurfacePath(surface: string) {
  const trimmed = normalizeDeliveryPathReference(surface);
  if (!trimmed || trimmed.includes('*') || /^unknown\b/i.test(trimmed)) return undefined;
  if (!looksLikeRepoPathReference(trimmed)) return undefined;
  return trimmed;
}

function workflowStepOwnedSurfaces(task: Task) {
  return effectiveOwnedSurfaces(task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => /^src\/workflows\/steps\/[^/]+\.[cm]?[jt]s$/.test(path) && !/\/index\.[cm]?[jt]s$/.test(path));
}

function workflowStepSlug(path: string) {
  return path.split('/').pop()?.replace(/\.[cm]?[jt]s$/, '');
}

function workflowStepExportedNames(repoPath: string, stepPath: string) {
  const fullPath = join(resolve(repoPath), stepPath);
  if (!existsSync(fullPath)) return [];

  const source = readFileSync(fullPath, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  return [...names];
}

function withoutImportStatements(source: string) {
  return source.replace(/^\s*import\s+[\s\S]*?;\s*$/gm, '');
}

export function workflowStepIntegrationGaps(repoPath: string, task: Task) {
  const steps = workflowStepOwnedSurfaces(task);
  if (!steps.length) return [];

  const weeklySurface = firstExistingRepoPath(
    repoPath,
    moduleSourceExtensions.map((extension) => `src/workflows/weekly.${extension}`),
  );
  if (!weeklySurface) return [];

  const weeklyPath = join(resolve(repoPath), weeklySurface);
  const weeklySource = readFileSync(weeklyPath, 'utf8');
  const weeklyImplementationSource = withoutImportStatements(weeklySource);
  return steps
    .filter((step) => existsSync(join(resolve(repoPath), step)))
    .flatMap((step) => {
      const slug = workflowStepSlug(step);
      const exportedNames = workflowStepExportedNames(repoPath, step);
      const callsExportedStep = exportedNames.some((name) =>
        new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(weeklyImplementationSource),
      );
      if (slug && weeklySource.includes(`./steps/${slug}`) && callsExportedStep) return [];
      return [
        `Workflow step ${step} is not called from ${weeklySurface}; the step can pass in isolation while the Cloudflare Workflow still runs the old pass-through stub.`,
      ];
    });
}

export function workflowEntrypointImportGaps(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => /\.(?:[cm]?[jt]s)$/.test(path))
    .filter((path) => existsSync(join(resolve(repoPath), path)))
    .flatMap((path) => {
      const source = readFileSync(join(resolve(repoPath), path), 'utf8');
      if (!/\bextends\s+WorkflowEntrypoint\b/.test(source)) return [];
      if (/import\s*\{[^}]*\bWorkflowEntrypoint\b[^}]*\}\s*from\s*['"]cloudflare:workers['"]/.test(source)) return [];
      return [`${path} extends WorkflowEntrypoint but does not import WorkflowEntrypoint from cloudflare:workers.`];
    });
}

function routeOwnedSurfaces(task: Task) {
  return effectiveOwnedSurfaces(task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => /^src\/routes\/[^/]+\.[cm]?[jt]s$/.test(path) && !/\/index\.[cm]?[jt]s$/.test(path));
}

export function routeMiddlewareBypassGaps(repoPath: string, task: Task) {
  const routeSurfaces = routeOwnedSurfaces(task);
  if (!routeSurfaces.length) return [];

  const indexSurface = firstExistingRepoPath(
    repoPath,
    moduleSourceExtensions.map((extension) => `src/index.${extension}`),
  );
  const routerSurface = firstExistingRepoPath(
    repoPath,
    moduleSourceExtensions.map((extension) => `src/http/router.${extension}`),
  );
  if (!indexSurface || !routerSurface) return [];

  const indexPath = join(resolve(repoPath), indexSurface);
  const indexSource = readFileSync(indexPath, 'utf8');
  if (!/\brouteRequest\s*\(/.test(indexSource)) return [];

  return routeSurfaces.flatMap((surface) => {
    const slug = surface.split('/').pop()?.replace(/\.[cm]?[jt]s$/, '');
    if (!slug) return [];

    const routeImportPattern = new RegExp(
      `\\bfrom\\s+['"]\\.\\/routes\\/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.(?:js|mjs|cjs|ts|mts|cts))?['"]`,
    );
    if (!routeImportPattern.test(indexSource)) return [];

    return [
      `Route surface ${surface} is imported directly from ${indexSurface} while the existing routeRequest router is present; register it through the router/barrel/middleware path instead of dispatching before routeRequest.`,
    ];
  });
}

function repoTextIfExists(repoPath: string, path: string) {
  const fullPath = join(resolve(repoPath), path);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
}

function stringLiteralsFromText(text: string) {
  return Array.from(text.matchAll(/['"]([^'"]+)['"]/g)).map((match) => match[1]).filter(Boolean);
}

function validationProfileKinds(repoPath: string) {
  for (const path of profileContractProducerSurfaces) {
    const source = repoTextIfExists(repoPath, path);
    if (!source) continue;

    const arrayMatch = source.match(/\bPROFILE_KINDS\s*=\s*\[([\s\S]*?)\]\s*as\s+const\b/);
    if (arrayMatch) return stringLiteralsFromText(arrayMatch[1]);

    const typeMatch = source.match(/\bexport\s+type\s+ProfileKind\s*=\s*([\s\S]*?);/);
    if (typeMatch) return stringLiteralsFromText(typeMatch[1]);
  }

  return [];
}

function storageProfileKinds(repoPath: string) {
  const source = repoTextIfExists(repoPath, 'src/storage/profiles.ts');
  if (!source) return [];
  const match = source.match(/\bexport\s+type\s+Profile(?:Artifact)?Kind\s*=\s*([\s\S]*?);/);
  return match ? stringLiteralsFromText(match[1]) : [];
}

function migrationProfileKinds(repoPath: string) {
  const migrationsDir = join(resolve(repoPath), 'migrations');
  if (!existsSync(migrationsDir)) return [];

  const sources = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(migrationsDir, file), 'utf8'));

  const source = sources.join('\n');
  if (!source) return [];
  const table = source.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+profile_artifacts\s*\([\s\S]*?\n\);/i)?.[0] ?? source;
  const match = table.match(/CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i);
  return match ? stringLiteralsFromText(match[1]) : [];
}

function missingProfileKinds(expected: string[], actual: string[]) {
  if (!expected.length || !actual.length) return [];
  return expected.filter((kind) => !actual.includes(kind));
}

function taskOwnsProfileContractProducer(task: Task) {
  return effectiveOwnedSurfaces(task).some((surface) => {
    const path = concreteOwnedSurfacePath(surface);
    return path ? profileContractProducerSurfaces.includes(path) : false;
  });
}

function taskOwnsProfileMigration(task: Task) {
  return taskOwnsD1MigrationFile(task);
}

function taskOwnsProfileStorage(task: Task) {
  return effectiveOwnedSurfaces(task).some((surface) => concreteOwnedSurfacePath(surface) === 'src/storage/profiles.ts');
}

export function profileKindContractGaps(repoPath: string, task: Task) {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  const requiredProfileKinds = sourcePolicy.requiredProfileKinds;
  const expected = validationProfileKinds(repoPath);
  const gaps: string[] = [];

  if (taskOwnsProfileContractProducer(task)) {
    if (requiredProfileKinds.length && !expected.length) {
      gaps.push(
        `Profile contract producer must export PROFILE_KINDS or ProfileKind with source-required profile kinds: ${requiredProfileKinds.join(', ')}.`,
      );
    } else if (requiredProfileKinds.length) {
      const missingRequired = missingProfileKinds(requiredProfileKinds, expected);
      if (missingRequired.length) {
        gaps.push(
          `Profile contract producer omits source-required profile kind(s): ${missingRequired.join(', ')}. Use the profile kind values declared by vision.md/spec.md; do not replace them with generic R2 artifact object categories.`,
        );
      }
    }
  }

  if (!expected.length) return gaps;

  if (taskOwnsProfileMigration(task)) {
    const missing = missingProfileKinds(expected, migrationProfileKinds(repoPath));
    if (missing.length) {
      gaps.push(
        `migrations/*.sql profile_artifacts.kind omits profile contract kind(s): ${missing.join(', ')}. Keep schema kind values aligned with PROFILE_KINDS or ProfileKind from the validation/domain profile contract.`,
      );
    }
  }

  if (taskOwnsProfileStorage(task)) {
    const missing = missingProfileKinds(expected, storageProfileKinds(repoPath));
    if (missing.length) {
      gaps.push(
        `src/storage/profiles.ts ProfileKind/ProfileArtifactKind omits profile contract kind(s): ${missing.join(', ')}. Storage profile metadata kind must match PROFILE_KINDS or ProfileKind from the validation/domain profile contract, not artifact object categories.`,
      );
    }
  }

  return gaps;
}

function taskBoundaryCanConfigureWorkersAi(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .some(
      (path) =>
        ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].includes(path) || workerSourceSurfaceIsConcrete(path),
    );
}

function workerSourceSearchRoots(repoPath: string) {
  const root = resolve(repoPath);
  return [
    join(root, 'src'),
    join(root, 'workers'),
    join(root, 'worker.js'),
    join(root, 'worker.mjs'),
    join(root, 'worker.ts'),
    join(root, 'worker.mts'),
    join(root, 'worker.cts'),
  ];
}

function sourceTextContainsRouteLiteral(text: string, route: string) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp("(['\"`])" + escaped + '\\1').test(text);
}

function sourceTreeContainsRouteLiteral(rootPath: string, route: string, scanned = { count: 0 }): boolean {
  if (!existsSync(rootPath) || scanned.count > 150) return false;

  const rootStat = statSync(rootPath);
  if (rootStat.isFile()) {
    if (!/\.[cm]?[jt]sx?$/.test(rootPath)) return false;
    scanned.count += 1;
    if (scanned.count > 150) return false;
    try {
      return sourceTextContainsRouteLiteral(readFileSync(rootPath, 'utf8'), route);
    } catch {
      return false;
    }
  }

  if (!rootStat.isDirectory()) return false;

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.delivery') continue;

    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (sourceTreeContainsRouteLiteral(path, route, scanned)) return true;
      continue;
    }

    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    scanned.count += 1;
    if (scanned.count > 150) return false;

    try {
      if (sourceTextContainsRouteLiteral(readFileSync(path, 'utf8'), route)) return true;
    } catch {
      continue;
    }
  }

  return false;
}

function workerSourceContainsRouteLiteral(repoPath: string, route: string) {
  const scanned = { count: 0 };
  return workerSourceSearchRoots(repoPath).some((sourceRoot) => sourceTreeContainsRouteLiteral(sourceRoot, route, scanned));
}

export function workerConfigTaskPacketPolicy() {
  return workerConfigTaskPacketPolicyBase();
}

function currentWorkerCompatibilityDate() {
  return workerConfigTaskPacketPolicy().compatibility_date;
}

export function workerConfigTaskPacketPolicyForTask(task: Task) {
  return taskOwnsWorkerConfigFile(task) ? workerConfigTaskPacketPolicy() : null;
}

export function generatedTaskSurfacePaths(task: Task) {
  const policy = workerConfigTaskPacketPolicyForTask(task);
  const output = policy?.generated_types.output;
  return output ? [output] : [];
}

function isGeneratedTaskSurfacePath(task: Task, path: string) {
  return generatedTaskSurfacePaths(task).includes(path);
}

function repoUsesTypeScriptWorkerSource(repoPath: string, task?: Task) {
  return (
    (task !== undefined && (ownsTypeScriptInputSurface(task) || ownsExactSurface(task, 'tsconfig.json'))) ||
    workerRepoUsesTypeScriptWorkerSource(repoPath)
  );
}

function workerHygieneTaskGuards(): WorkerHygieneTaskGuards {
  return {
    taskCanConfigureWorkerConfig: taskBoundaryCanConfigureWorkerConfig,
    taskCanConfigureWorkersAi: taskBoundaryCanConfigureWorkersAi,
    taskOwnsPackageManifest,
    repoUsesTypeScriptWorkerSource,
  };
}

export function workerEnvBindingAlignmentGaps(repoPath: string) {
  return workerEnvBindingAlignmentGapsBase(repoPath);
}

export function workerConfigHygieneGaps(repoPath: string, task?: Task) {
  return workerConfigHygieneGapsWithGuards(repoPath, task, workerHygieneTaskGuards());
}

export function wranglerConfigHasWorkersAiBinding(repoPath: string) {
  return wranglerConfigHasWorkersAiBindingBase(repoPath);
}

export function workersAiBindingGaps(repoPath: string, task?: Task) {
  return workersAiBindingGapsWithGuards(repoPath, task, workerHygieneTaskGuards());
}

export function profileKindTaskPacketPolicy(sourcePolicy: SourcePolicy) {
  if (!sourcePolicy.requiredProfileKinds.length) return null;
  return {
    required_persistent_kinds: sourcePolicy.requiredProfileKinds,
    producer_surfaces: profileContractProducerSurfaces,
    guidance: 'Use the persistent profile kind values declared by the source docs. Do not substitute generic creator, voice, audience, topic, or R2 artifact object categories.',
  };
}

export function profileKindTaskPacketPolicyForTask(task: Task, sourcePolicy = sourcePolicyFromDocuments([])) {
  return (taskOwnsProfileContractProducer(task) || taskOwnsProfileMigration(task) || taskOwnsProfileStorage(task)) &&
    sourcePolicy.requiredProfileKinds.length
    ? profileKindTaskPacketPolicy(sourcePolicy)
    : null;
}

function taskBoundaryCanConfigureWorkerConfig(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .some((path) => ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].includes(path));
}

export function missingOwnedSurfacePaths(repoPath: string, task: Task) {
  return effectiveOwnedSurfaces(task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => !isGeneratedTaskSurfacePath(task, path))
    .filter((path) => !existsSync(join(resolve(repoPath), path)));
}

const deliveryPreflightStubMarker = 'Delivery preflight stub';

function surfaceLooksLikeWorkerEntrypoint(path: string) {
  return (
    /^worker\.(?:js|mjs|cjs|ts|mts|cts)$/.test(path) ||
    /^src\/index\.(?:js|mjs|cjs|ts|mts|cts)$/.test(path) ||
    /^workers\/.+\.(?:js|mjs|cjs|ts|mts|cts)$/.test(path)
  );
}

function compileSafeStubForSurface(path: string) {
  if (surfaceLooksLikeWorkerEntrypoint(path)) {
    return [
      `// ${deliveryPreflightStubMarker}. The implementation agent should replace this with task code.`,
      'export default {',
      '  fetch() {',
      '    return Response.json({ status: "preflight_stub" });',
      '  },',
      '};',
      '',
    ].join('\n');
  }

  if (/\.(?:ts|mts|cts)$/.test(path)) {
    return [
      `// ${deliveryPreflightStubMarker}. The implementation agent should replace this with task code.`,
      'export {};',
      '',
    ].join('\n');
  }
  if (/\.(?:js|mjs|cjs)$/.test(path)) {
    return `// ${deliveryPreflightStubMarker}. The implementation agent should replace this with task code.\n`;
  }
  if (/\.json$/.test(path)) return '{}\n';
  if (/\.(?:sql)$/.test(path)) return `-- ${deliveryPreflightStubMarker}. The implementation agent should replace this with task SQL.\n`;
  if (/\.(?:toml|ya?ml)$/.test(path)) return `# ${deliveryPreflightStubMarker}. The implementation agent should replace this with task config.\n`;
  if (/\.css$/.test(path)) return `/* ${deliveryPreflightStubMarker}. The implementation agent should replace this with task styles. */\n`;
  if (/\.html?$/.test(path)) return `<!doctype html>\n<!-- ${deliveryPreflightStubMarker}. The implementation agent should replace this with task markup. -->\n`;
  return '';
}

export async function createMissingOwnedSurfaceStubs({
  repoPath,
  task,
  stage,
  mastra,
}: {
  repoPath: string;
  task: Task;
  stage: string;
  mastra?: any;
}) {
  const created: string[] = [];
  for (const path of missingOwnedSurfacePaths(repoPath, task)) {
    const fullPath = join(resolve(repoPath), path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, compileSafeStubForSurface(path));
    created.push(path);
  }

  if (created.length) {
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'preflight_stub_created',
        stage,
        task: task.id,
        paths: created,
      },
    }).catch(() => undefined);
  }

  return created;
}

export function unreplacedPreflightStubPaths(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => {
      const fullPath = join(resolve(repoPath), path);
      if (!existsSync(fullPath)) return false;
      return readFileSync(fullPath, 'utf8').includes(deliveryPreflightStubMarker);
    });
}

const moduleSourceExtensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'] as const;

function firstExistingRepoPath(repoPath: string, candidates: string[]) {
  return candidates.find((candidate) => existsSync(join(resolve(repoPath), candidate)));
}

export function taskBoundarySurfaces(repoPath: string, task: Task) {
  const surfaces = new Set(effectiveOwnedSurfaces(task));
  for (const surface of effectiveOwnedSurfaces(task)) {
    const path = concreteOwnedSurfacePath(surface);
    if (!path || !path.includes('/')) continue;
    const parts = path.split('/');
    parts.pop();
    const directory = parts.join('/');
    if (!directory) continue;
    const barrel = firstExistingRepoPath(
      repoPath,
      moduleSourceExtensions.map((extension) => `${directory}/index.${extension}`),
    );
    if (barrel) surfaces.add(barrel);

    const workerEntry = firstExistingRepoPath(
      repoPath,
      moduleSourceExtensions.map((extension) => `src/index.${extension}`),
    );
    if (directory === 'src/routes' && workerEntry) {
      surfaces.add(workerEntry);
    }

    const workflowEntry = firstExistingRepoPath(
      repoPath,
      moduleSourceExtensions.map((extension) => `src/workflows/weekly.${extension}`),
    );
    if (directory === 'src/workflows/steps' && workflowEntry) {
      surfaces.add(workflowEntry);
    }
  }

  return [...surfaces];
}

export function taskSourceBoundarySurfaces(repoPath: string, task: Task) {
  const generated = new Set(generatedTaskSurfacePaths(task));
  return taskBoundarySurfaces(repoPath, task).filter((surface) => {
    const path = concreteOwnedSurfacePath(surface);
    return !path || !generated.has(path);
  });
}

function sqlHasCheckConstraintForColumn(sql: string, column: string) {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`CHECK\\s*\\([^)]*\\b${escaped}\\b\\s+IN\\s*\\(`, 'i').test(sql);
}

export function lifecycleStatusSchemaGaps(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path && /\.sql$/i.test(path)))
    .flatMap((path) => {
      const fullPath = join(resolve(repoPath), path);
      if (!existsSync(fullPath)) return [];
      const sql = readFileSync(fullPath, 'utf8');
      const gaps: string[] = [];
      const statusColumnPattern = /^\s*([a-z_]*status)\s+TEXT\s+NOT\s+NULL\b([^,\n]*)/gim;
      for (const match of sql.matchAll(statusColumnPattern)) {
        const column = match[1];
        const definition = match[0];
        if (/\bCHECK\s*\(/i.test(definition) || sqlHasCheckConstraintForColumn(sql, column)) continue;
        gaps.push(`${path}:${column} is a lifecycle status column without a D1 CHECK constraint`);
      }
      return gaps;
    });
}

export function staleDownstreamVerificationSurfacePaths({
  repoPath,
  taskPlan,
  currentTaskIndex,
  failure,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  currentTaskIndex: number;
  failure: string;
}) {
  return staleDownstreamVerificationSurfacePathsFromOrderedTasks({
    repoPath,
    orderedTasks: topoOrderTasks(taskPlan.tasks),
    currentTaskIndex,
    failure,
    taskBoundarySurfaces: (task) => taskBoundarySurfaces(repoPath, task),
    reusableImplementationArtifactForTask: (task) => reusableImplementationArtifactForTask(repoPath, task),
  });
}

export function outOfPlanVerificationFailurePaths({
  repoPath,
  taskPlan,
  failure,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  failure: string;
}) {
  return outOfPlanVerificationFailurePathsFromTasks({
    repoPath,
    tasks: taskPlan.tasks,
    failure,
    taskBoundarySurfaces: (task) => taskBoundarySurfaces(repoPath, task),
  });
}

function deliveryImplementationNoteTouchedPaths(repoPath: string) {
  const artifactsDir = join(resolve(repoPath), '.delivery', 'artifacts');
  const touched = new Set<string>();

  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.startsWith('note-') || !entry.endsWith('.json')) continue;

      try {
        const note = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        const record = note && typeof note === 'object' ? (note as Record<string, unknown>) : undefined;
        if (record?.artifact_type !== 'implementation-note' || !Array.isArray(record.files_touched)) continue;
        for (const file of record.files_touched) {
          if (typeof file !== 'string') continue;
          const normalized = normalizeDeliveryPathReference(file);
          if (normalized) touched.add(normalized);
        }
      } catch {
        // Partial or unrelated JSON artifacts are not provenance evidence.
      }
    }
  };

  visit(artifactsDir);
  return touched;
}

export function staleOutOfPlanVerificationSurfacePaths({
  repoPath,
  taskPlan,
  failure,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  failure: string;
}) {
  const deliveryTouchedPaths = deliveryImplementationNoteTouchedPaths(repoPath);
  if (!deliveryTouchedPaths.size) return [];

  return outOfPlanVerificationFailurePaths({ repoPath, taskPlan, failure }).filter((path) =>
    deliveryTouchedPaths.has(path),
  );
}

function staleWorkspaceVerificationRemediation({
  repoPath,
  taskPlan,
  failure,
}: {
  repoPath: string;
  taskPlan?: TaskPlan;
  failure: string;
}) {
  return staleWorkspaceVerificationRemediationFromTasks({
    repoPath,
    tasks: taskPlan?.tasks,
    failure,
    taskBoundarySurfaces: (task) => taskBoundarySurfaces(repoPath, task),
    compactDiagnostic,
  });
}

export async function repairStaleDownstreamVerificationSurfaces({
  repoPath,
  mastra,
  stage,
  taskPlan,
  currentTaskIndex,
  failure,
}: {
  repoPath: string;
  mastra?: any;
  stage: string;
  taskPlan: TaskPlan;
  currentTaskIndex: number;
  failure: string;
}) {
  const paths = staleDownstreamVerificationSurfacePaths({
    repoPath,
    taskPlan,
    currentTaskIndex,
    failure,
  });
  if (!paths.length) return false;

  for (const path of paths) {
    writeFileSync(join(resolve(repoPath), path), compileSafeStubForSurface(path));
  }

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths,
      output_summary:
        'Reset stale downstream task surfaces to compile-safe preflight stubs after repo-wide verification failed.',
    },
  }).catch(() => undefined);
  return true;
}

export async function repairStaleOutOfPlanVerificationSurfaces({
  repoPath,
  mastra,
  stage,
  taskPlan,
  failure,
}: {
  repoPath: string;
  mastra?: any;
  stage: string;
  taskPlan: TaskPlan;
  failure: string;
}) {
  const paths = staleOutOfPlanVerificationSurfacePaths({
    repoPath,
    taskPlan,
    failure,
  });
  if (!paths.length) return false;

  for (const path of paths) {
    writeFileSync(join(resolve(repoPath), path), compileSafeStubForSurface(path));
  }

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths,
      output_summary:
        'Reset stale out-of-plan delivery-generated surfaces to compile-safe preflight stubs after repo-wide verification failed.',
    },
  }).catch(() => undefined);
  return true;
}

function policyDeniedWriteEvents(events: DeliveryEvent[], stage: string) {
  return stageSlice(events, stage).filter(
    (event) =>
      event.type === 'tool_use' &&
      event.ok === false &&
      /\b(outside this task's owned surfaces|outside .* owned globs|forbidden glob)\b/i.test(String(event.error ?? '')),
  );
}

export function implementationEnginePolicyMismatch({
  repoPath,
  stage,
  role,
  task,
  events,
}: {
  repoPath: string;
  stage: string;
  role: 'engineer' | 'designer';
  task: Task;
  events: DeliveryEvent[];
}) {
  const taskSurfaces = taskBoundarySurfaces(repoPath, task);
  const mismatchedPaths = policyDeniedWriteEvents(events, stage)
    .flatMap((event) => event.paths ?? [])
    .filter((path) => {
      const clean = normalizeDeliveryPathReference(path);
      if (!clean || clean.startsWith('.delivery/')) return false;
      return fileOwnership({ role, paths: [clean] }).passed && matchesAny(clean, taskSurfaces);
    });

  const uniquePaths = Array.from(new Set(mismatchedPaths.map(normalizeDeliveryPathReference)));
  if (!uniquePaths.length) return [];

  return [
    `ENGINE_POLICY_MISMATCH ${task.id}: workspace policy rejected path(s) that normalize inside ${role}/${task.id} boundaries: ${uniquePaths.join(', ')}. This is a delivery engine boundary bug; do not spend model retries on it.`,
  ];
}

function taskOwnsPackageManifest(task: Task) {
  return effectiveOwnedSurfaces(task).some((surface) => {
    const path = concreteOwnedSurfacePath(surface);
    return path === 'package.json' || path === 'package-lock.json';
  });
}

export function missingInstalledPackageNames(repoPath: string) {
  return workerMissingInstalledPackageNames(repoPath);
}

export function workerPackageScaffoldGaps(repoPath: string, task?: Task) {
  return workerPackageScaffoldGapsWithGuards(repoPath, task, workerHygieneTaskGuards());
}

export type { TypeScriptDiagnostic };

export function typeScriptDiagnosticsFromText(text: string) {
  return typeScriptDiagnosticsFromTextBase(text);
}

export function typeScriptDiagnosticsFromRemediation(remediation: string[]) {
  return typeScriptDiagnosticsFromRemediationBase(remediation);
}

export function implementationFailureClass(remediation: string[]) {
  return implementationFailureClassBase(remediation);
}

export function canSalvageTimedOutBuildAttempt({
  stageHadToolUse,
  missingSurfaces,
  unreplacedStubs,
}: {
  stageHadToolUse: boolean;
  missingSurfaces: string[];
  unreplacedStubs: string[];
}) {
  return canSalvageTimedOutBuildAttemptBase({ stageHadToolUse, missingSurfaces, unreplacedStubs });
}

export function implementationRetryMode({
  remediation,
  missingSurfaces,
  unreplacedStubs = [],
}: {
  remediation: string[];
  missingSurfaces: string[];
  unreplacedStubs?: string[];
}) {
  return implementationRetryModeBase({ remediation, missingSurfaces, unreplacedStubs });
}

export function implementationToolChoiceForRetryMode(retryMode: ReturnType<typeof implementationRetryMode>) {
  return implementationToolChoiceForRetryModeBase(retryMode);
}

function judgeRepairAlreadyAttempted(remediation: string[]) {
  return remediation.some((item) => /^JUDGE repair attempt:/i.test(item));
}

function implementationJudgeRepairRemediation(judgmentPath: string, remediation: string[]) {
  return [`JUDGE repair attempt: fix failed implementation judgment ${judgmentPath}`, ...remediation];
}

function implementationJudgeTimeoutRemediation(taskId: string, attemptNumber: number, timeoutMs: number) {
  return [
    `JUDGE_TIMEOUT ${taskId}.a${attemptNumber}: implementation judgment timed out after ${timeoutMs}ms. Preserve working code, improve direct evidence or the implementation note if needed, and retry with bounded judgment.`,
  ];
}

export function buildTimeoutRemediation({
  task,
  timeoutMs,
  missingSurfaces,
  repairRecovery,
  noToolCall = false,
  readBudgetExceeded = false,
  priorRemediation = [],
}: {
  task: Task;
  timeoutMs: number;
  missingSurfaces: string[];
  repairRecovery: boolean;
  noToolCall?: boolean;
  readBudgetExceeded?: boolean;
  priorRemediation?: string[];
}) {
  return buildTimeoutRemediationForTaskId({
    taskId: task.id,
    timeoutMs,
    missingSurfaces,
    repairRecovery,
    noToolCall,
    readBudgetExceeded,
    priorRemediation,
  });
}

export function priorStoppedBuildTaskIds({
  taskPlan,
  taskIndex,
  taskStatuses,
}: {
  taskPlan: TaskPlan;
  taskIndex: number;
  taskStatuses: Record<string, { status?: string } | undefined>;
}) {
  return topoOrderTasks(taskPlan.tasks)
    .slice(0, taskIndex)
    .filter((task) => ['stuck', 'blocked'].includes(String(taskStatuses[task.id]?.status)))
    .map((task) => task.id);
}

export function reusableImplementationArtifactForTask(repoPath: string, task: Task) {
  if (process.env.DELIVERY_REUSE_TASK_ARTIFACTS === '0') return undefined;
  if (missingOwnedSurfacePaths(repoPath, task).length) return undefined;
  if (workflowStepIntegrationGaps(repoPath, task).length) return undefined;
  if (workersAiBindingGaps(repoPath, task).length) return undefined;

  const judgmentDir = join(resolve(repoPath), '.delivery/artifacts/judgments');
  if (!existsSync(judgmentDir)) return undefined;

  const prefix = `implementation-${task.id}-a`;
  const candidates = readdirSync(judgmentDir)
    .map((file) => {
      const match = file.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\\.judgment\\.json$`));
      return match ? { file, attempt: Number(match[1]) } : undefined;
    })
    .filter((candidate): candidate is { file: string; attempt: number } => Boolean(candidate))
    .sort((a, b) => b.attempt - a.attempt);

  for (const candidate of candidates) {
    const judgmentPath = `.delivery/artifacts/judgments/${candidate.file}`;
    const judgment = readJsonArtifact(repoPath, judgmentPath) as Partial<AggregatedJudgment> | undefined;
    if (!judgment?.passed || typeof judgment.overall !== 'number') continue;

    const notePath = `.delivery/artifacts/note-${task.id}.a${candidate.attempt}.json`;
    const note = implementationNoteSchema.safeParse(readJsonArtifact(repoPath, notePath));
    if (!note.success || note.data.task !== task.id) continue;

    const ownership = runDeterministicCheck({
      name: 'file_ownership',
      role: buildRoleForTask(task),
      paths: note.data.files_touched,
    });
    if (!ownership.passed) continue;

    const judgeOutputPath = judgmentPath.replace(/\.judgment\.json$/, '.judge.json');
    return {
      note: note.data,
      notePath,
      judgment,
      judgmentPath,
      judgeOutputPath: existsSync(join(resolve(repoPath), judgeOutputPath)) ? judgeOutputPath : undefined,
      attempt: candidate.attempt,
    };
  }

  return undefined;
}

export function deliveryBuildResumePlan(repoPath: string, taskPlan: TaskPlan) {
  const orderedTasks = topoOrderTasks(taskPlan.tasks);
  const reusableTaskIds: string[] = [];
  const reusableSet = new Set<string>();

  for (const task of orderedTasks) {
    if (!task.depends_on.every((dependency) => reusableSet.has(dependency))) break;
    if (!reusableImplementationArtifactForTask(repoPath, task)) break;
    reusableTaskIds.push(task.id);
    reusableSet.add(task.id);
  }

  const nextTask = orderedTasks[reusableTaskIds.length];
  return {
    reusableTaskIds,
    resumeAfterTaskId: reusableTaskIds.at(-1),
    nextTaskId: nextTask?.id,
    totalTasks: orderedTasks.length,
  };
}

function deliveryBuildResumeReason(plan: ReturnType<typeof deliveryBuildResumePlan>) {
  if (!plan.reusableTaskIds.length) return undefined;
  const resumeAfter = plan.resumeAfterTaskId ?? 'none';
  const nextTask = plan.nextTaskId ?? 'release gate';
  return `Resume cursor: ${plan.reusableTaskIds.length}/${plan.totalTasks} implementation task(s) already have passing artifacts; resume after ${resumeAfter}, next ${nextTask}.`;
}

function effectiveOwnedSurfaces(task: Task) {
  const surfaces = new Set(task.owned_surfaces);
  const taskText = [task.deliverable, ...task.acceptance_criteria].join('\n');

  if (/\bsrc\/\s+directories\b|\bproject structure\b|\bsrc\/\s+directories for\b/i.test(taskText)) {
    surfaces.add('src/**');
  }

  return [...surfaces];
}

export function implementationFilesTouched({
  repoPath,
  stage,
  task,
  events,
}: {
  repoPath: string;
  stage: string;
  task: Task;
  events: DeliveryEvent[];
}) {
  const stageEvents = implementationStageEvents(events, stage);
  const written = stageEvents
    .filter((event) => event.ok !== false && implementationWriteTools.has(String(event.tool)))
    .flatMap((event) => {
      const paths = event.paths ?? [];
      if (String(event.tool) !== 'auto_repair') return paths;
      return paths.filter((path) => taskBoundaryAllowsRepairPath(repoPath, task, path));
    })
    .filter((path) => path && !path.startsWith('.delivery/'));

  return Array.from(new Set(written.length ? written : existingOwnedFiles(repoPath, task)));
}

function implementationStageEvents(events: DeliveryEvent[], stage: string) {
  const stageEvents: DeliveryEvent[] = [];
  let active = false;

  for (const event of events) {
    if (event.type === 'stage_start' && event.stage === stage) {
      active = true;
      stageEvents.push(event);
      continue;
    }

    if (!active) continue;

    stageEvents.push(event);
    if (event.type === 'stage_end' && event.stage === stage) {
      active = false;
    }
  }

  return stageEvents;
}

export function buildVerificationCommandPlan(repoPath: string) {
  return buildVerificationCommandPlanBase(repoPath);
}

export function buildVerificationCommandPlans(repoPath: string) {
  return buildVerificationCommandPlansBase(repoPath);
}

async function ensureNodeDependencies({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}): Promise<{ command: string; ok: boolean; reason: string; output_summary?: string; error?: string } | undefined> {
  const root = resolve(repoPath);
  const packagePath = join(root, 'package.json');
  const packageLockPath = join(root, 'package-lock.json');
  const nodeModulesPath = join(root, 'node_modules');
  if (!existsSync(packagePath)) return undefined;
  const missingPackages = missingInstalledPackageNames(repoPath);
  if (existsSync(nodeModulesPath) && existsSync(packageLockPath)) {
    try {
      if (statSync(packageLockPath).mtimeMs >= statSync(packagePath).mtimeMs && missingPackages.length === 0) {
        return undefined;
      }
    } catch {
      // Fall through to npm install when mtimes cannot be read.
    }
  }

  const command = 'npm install --include=dev';
  const reason = missingPackages.length
    ? `Node dependencies were missing before local validation (${missingPackages.slice(0, 8).join(', ')}${missingPackages.length > 8 ? ', ...' : ''}), so npm install --include=dev is required evidence.`
    : 'Node dependencies were missing or stale before local validation, so npm install --include=dev is required evidence.';
  await recordRunCodeStart({ repoPath, mastra, stage, command, timeoutMs: 180_000 });
  try {
    const result = await execFileAsync('npm', ['install', '--include=dev'], {
      cwd: root,
      timeout: 180_000,
      maxBuffer: 1_000_000,
      env: { ...process.env, NODE_ENV: 'development', npm_config_production: 'false' },
    });
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command,
        ok: true,
        output_summary: compactDiagnostic(`${result.stdout}\n${result.stderr}`, 500),
      },
    });
    return {
      command,
      ok: true,
      reason,
      output_summary: compactDiagnostic(`${result.stdout}\n${result.stderr}`, 500),
    };
  } catch (error) {
    const failure = commandFailureSummary(error, 1000);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command,
        ok: false,
        error: failure,
      },
    });
    return {
      command,
      ok: false,
      reason,
      error: failure,
    };
  }
}

async function recordRunCodeStart({
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

async function runBuildVerification({
  repoPath,
  mastra,
  stage,
  taskPlan,
  taskIndex,
  allowRepair = true,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  taskPlan?: TaskPlan;
  taskIndex?: number;
  allowRepair?: boolean;
}) {
  const verificationCommands = buildVerificationCommandPlans(repoPath);
  if (!verificationCommands.length) {
    return {
      performed: [] as string[],
      missing: ['No package verification script or Wrangler config found for this build task.'],
    };
  }

  await ensureNodeDependencies({ repoPath, mastra, stage });

  const performed: string[] = [];
  for (const verificationCommand of verificationCommands) {
    const command = verificationCommand.command;
    await recordRunCodeStart({ repoPath, mastra, stage, command, timeoutMs: verificationCommand.timeoutMs });
    try {
      const result = await execFileAsync(verificationCommand.executable, verificationCommand.args, {
        cwd: resolve(repoPath),
        timeout: verificationCommand.timeoutMs,
        maxBuffer: 1_000_000,
        env: process.env,
      });
      const outputSummary = compactDiagnostic(`${result.stdout}\n${result.stderr}`, 500);
      await appendDeliveryEventState({
        repoPath,
        mastra,
        event: {
          type: 'run_code',
          stage,
          command,
          ok: true,
          output_summary: outputSummary,
        },
      });
      performed.push(outputSummary ? `${command} passed: ${outputSummary}` : `${command} passed`);
    } catch (error) {
      const failure = commandFailureSummary(error, 1000);
      await appendDeliveryEventState({
        repoPath,
        mastra,
        event: {
          type: 'run_code',
          stage,
          command,
          ok: false,
          error: failure,
        },
      });

      if (allowRepair && (await applyBuildVerificationRepair({ repoPath, mastra, stage, taskPlan, taskIndex, failure }))) {
        return runBuildVerification({ repoPath, mastra, stage, taskPlan, taskIndex, allowRepair: false });
      }

      const staleWorkspaceFailure = staleWorkspaceVerificationRemediation({ repoPath, taskPlan, failure });
      if (staleWorkspaceFailure) {
        return {
          performed,
          missing: [`${command} failed: ${staleWorkspaceFailure}`],
        };
      }

      return {
        performed,
        missing: [`${command} failed: ${commandFailureSummary(error, 600)}`],
      };
    }
  }

  return {
    performed,
    missing: [] as string[],
  };
}

const releaseGateLocalAdminToken = 'release-gate-local-admin-token';

function parseDevVarsValue(text: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, 'm').exec(text);
  if (!match) return undefined;
  const raw = match[1].trim();
  const quoted = /^["'](.*)["']$/.exec(raw);
  return quoted ? quoted[1] : raw;
}

function releaseGateLocalWorkerEnvironment(repoPath: string) {
  return releaseGateWorkerConfigPath(repoPath) ? 'staging' : undefined;
}

export function releaseGateLocalAdminSecretPath(repoPath: string) {
  const root = resolve(repoPath);
  const environmentName = releaseGateLocalWorkerEnvironment(repoPath);
  const candidates = environmentName
    ? [
        `.dev.vars.${environmentName}`,
        '.dev.vars',
        `.env.${environmentName}.local`,
        '.env.local',
        `.env.${environmentName}`,
        '.env',
      ]
    : ['.dev.vars', '.env.local', '.env'];
  const existing = candidates.find((file) => existsSync(join(root, file)));

  return join(root, existing ?? (environmentName ? `.dev.vars.${environmentName}` : '.dev.vars'));
}

function prepareReleaseGateLocalAdminSecret(repoPath: string) {
  const devVarsPath = releaseGateLocalAdminSecretPath(repoPath);
  if (existsSync(devVarsPath)) {
    const original = readFileSync(devVarsPath, 'utf8');
    const existingToken = parseDevVarsValue(original, 'ADMIN_TOKEN');
    if (existingToken) return { token: existingToken, restore: () => undefined };

    writeFileSync(devVarsPath, `${original.replace(/\s*$/, '\n')}ADMIN_TOKEN=${releaseGateLocalAdminToken}\n`);
    return {
      token: releaseGateLocalAdminToken,
      restore: () => writeFileSync(devVarsPath, original),
    };
  }

  writeFileSync(devVarsPath, `ADMIN_TOKEN=${releaseGateLocalAdminToken}\n`);
  return {
    token: releaseGateLocalAdminToken,
    restore: () => {
      if (existsSync(devVarsPath)) unlinkSync(devVarsPath);
    },
  };
}

export function releaseGateLocalD1DatabaseName(repoPath: string) {
  return releaseGateLocalD1DatabaseNameBase(repoPath);
}

function releaseGateRepoHasRoute(repoPath: string, route: string) {
  const root = resolve(repoPath);
  if (
    route === '/health' &&
    ['src/routes/health.ts', 'src/routes/health.js', 'src/routes/health.mjs'].some((path) => existsSync(join(root, path)))
  ) {
    return true;
  }
  if (
    route === '/api/health' &&
    ['src/routes/api/health.ts', 'src/routes/api/health.js', 'src/routes/api/health.mjs'].some((path) =>
      existsSync(join(root, path)),
    )
  ) {
    return true;
  }
  return workerSourceContainsRouteLiteral(repoPath, route);
}

function releaseGateHealthRoutes(repoPath: string) {
  return ['/api/health', '/health'].filter((route) => releaseGateRepoHasRoute(repoPath, route));
}

function releaseGateMigrationText(repoPath: string) {
  return releaseGateMigrationTextBase(repoPath);
}

function releaseGateTranscriptFixtureContext(repoPath: string) {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  return {
    repoPath,
    sourcePolicy,
    latestRoutePresent: releaseGateRepoHasRoute(repoPath, '/latest'),
    localD1DatabaseName: releaseGateLocalD1DatabaseName(repoPath),
    migrationText: releaseGateMigrationText(repoPath),
  };
}

export function releaseGateTranscriptFixtureSchemaGaps(repoPath: string) {
  return transcriptFixtureSchemaGaps(releaseGateTranscriptFixtureContext(repoPath));
}

function releaseGateTranscriptFixtureAvailable(repoPath: string) {
  return transcriptFixtureAvailable(releaseGateTranscriptFixtureContext(repoPath));
}

export function releaseGateWorkerDevCommand(
  repoPath: string,
  port: number | '<port>' = '<port>',
  persistTo?: string | '<persist-to>',
) {
  return releaseGateWorkerDevCommandBase(repoPath, port, persistTo);
}

export function releaseGateWorkerDeployDryRunCommand(repoPath: string) {
  return releaseGateWorkerDeployDryRunCommandBase(repoPath);
}

export function releaseGateWorkerStartupCheckCommand(repoPath: string) {
  return releaseGateWorkerStartupCheckCommandBase(repoPath);
}

export function releaseGateWorkerTypesCheckCommand(repoPath: string) {
  return releaseGateWorkerTypesCheckCommandBase(repoPath);
}

function releaseGateStaticAssetTextMarker(repoPath: string, file: ReleaseGatePublicAssetProbeFile) {
  const assetPath = join(resolve(repoPath), 'public', file);
  if (!existsSync(assetPath)) return undefined;
  const text = readFileSync(assetPath, 'utf8').trim();
  return text ? text.slice(0, 120) : undefined;
}

export function releaseGateRuntimeProbePlanRequiresAdminSecret(plan: ReleaseGateRuntimeProbePlan | undefined) {
  return runtimeProbePlanRequiresAdminSecret(plan);
}

export function releaseGateRuntimeProbePlan(
  repoPath: string,
  adminToken = releaseGateLocalAdminToken,
): ReleaseGateRuntimeProbePlan | undefined {
  const sourceDocuments = sourceDocumentsFromRepo(repoPath);
  const sourcePolicy = sourcePolicyFromDocuments(sourceDocuments);
  return buildReleaseGateRuntimeProbePlan({
    command: releaseGateWorkerDevCommand(repoPath),
    adminToken,
    publicAssetTextMarker: (file) => releaseGateStaticAssetTextMarker(repoPath, file),
    healthRoutes: releaseGateHealthRoutes(repoPath),
    hasRoute: (route) => releaseGateRepoHasRoute(repoPath, route),
    latestTranscriptRequired: sourcePolicy.latestTranscriptRequired,
    shortLinkLifecycleRequired: sourceDocumentsDeclareShortLinkLifecycle(sourceDocuments),
    transcriptFixtureAvailable: releaseGateTranscriptFixtureAvailable(repoPath),
  });
}

function createReleaseGateRuntimeStatePath(repoPath: string) {
  const stateRoot = join(resolve(repoPath), '.delivery', 'tmp');
  mkdirSync(stateRoot, { recursive: true });
  const persistTo = join(stateRoot, `wrangler-state-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
  mkdirSync(persistTo, { recursive: true });
  return persistTo;
}

export function releaseGateEvidenceCommandPlan(repoPath: string, persistTo?: string): ReleaseGateEvidenceCommand[] {
  return releaseGateEvidenceCommandPlanFromOptions({
    repoPath,
    persistTo,
    packageVerificationScripts: packageVerificationScripts(repoPath),
    transcriptFixtureAvailable: releaseGateTranscriptFixtureAvailable(repoPath),
    writeTranscriptFixtureFile: () => writeReleaseGateTranscriptFixtureFile(repoPath),
    transcriptVersionAuditSql: releaseGateTranscriptVersionAuditSql(),
  });
}

export function releaseGateStaticEvidenceResults(repoPath: string): ReleaseGateEvidenceResult[] {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  return releaseGateStaticEvidenceResultsFromOptions({
    repoPath,
    latestTranscriptRequired: sourcePolicy.latestTranscriptRequired,
    latestRoutePresent: releaseGateRepoHasRoute(repoPath, '/latest'),
    migrationText: releaseGateMigrationText(repoPath),
    transcriptFixtureGaps: releaseGateTranscriptFixtureSchemaGaps(repoPath),
  });
}

export function releaseGateRequiredStaticEvidenceFailures(results: ReleaseGateEvidenceResult[]) {
  return releaseGateRequiredStaticEvidenceFailuresBase(results);
}

async function recordReleaseGateStaticEvidenceResult({
  repoPath,
  mastra,
  stage,
  result,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  result: ReleaseGateEvidenceResult;
}) {
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'run_code',
      stage,
      command: result.command,
      ok: result.ok,
      output_summary: result.output_summary,
      error: result.error,
    },
  });
}

async function runReleaseGateEvidenceCommand({
  repoPath,
  mastra,
  stage,
  command,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  command: ReleaseGateEvidenceCommand;
}): Promise<ReleaseGateEvidenceResult> {
  await recordRunCodeStart({
    repoPath,
    mastra,
    stage,
    command: command.command,
    timeoutMs: command.tier === 'smoke' ? 120_000 : 180_000,
  });
  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd: resolve(repoPath),
      timeout: command.tier === 'smoke' ? 120_000 : 180_000,
      maxBuffer: 1_000_000,
      env: process.env,
    });
    const output = compactDiagnostic(`${result.stdout}\n${result.stderr}`, 700);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command: command.command,
        ok: true,
        output_summary: output,
      },
    });
    return {
      tier: command.tier,
      command: command.command,
      ok: true,
      required: command.required,
      reason: command.reason,
      output_summary: output,
    };
  } catch (error) {
    const failure = commandFailureSummary(error, 1000);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command: command.command,
        ok: false,
        error: failure,
      },
    });
    return {
      tier: command.tier,
      command: command.command,
      ok: false,
      required: command.required,
      reason: command.reason,
      error: failure,
    };
  }
}

async function runReleaseGateRuntimeProbe({
  repoPath,
  mastra,
  stage,
  persistTo,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  persistTo?: string;
}): Promise<ReleaseGateEvidenceResult | undefined> {
  const initialPlan = releaseGateRuntimeProbePlan(repoPath);
  if (!initialPlan) return undefined;

  const adminSecret = releaseGateRuntimeProbePlanRequiresAdminSecret(initialPlan)
    ? prepareReleaseGateLocalAdminSecret(repoPath)
    : undefined;
  const plan = adminSecret ? releaseGateRuntimeProbePlan(repoPath, adminSecret.token) : initialPlan;
  if (!plan) return undefined;

  const port = await availableTcpPort();
  const command = releaseGateWorkerDevCommand(repoPath, port, persistTo ?? createReleaseGateRuntimeStatePath(repoPath));
  if (!command) return undefined;

  let output = '';
  let processError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let probes: ReleaseGateHttpProbeResult[] = [];
  await recordRunCodeStart({ repoPath, mastra, stage, command: command.command, timeoutMs: 75_000 });
  const child = spawn(command.executable, command.args, {
    cwd: resolve(repoPath),
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      ...(adminSecret ? { ADMIN_TOKEN: adminSecret.token } : {}),
      CI: process.env.CI ?? '1',
      NO_COLOR: '1',
      WRANGLER_SEND_METRICS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => {
    output = appendBoundedOutput(output, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output = appendBoundedOutput(output, chunk);
  });
  child.once('error', (error) => {
    processError = error;
  });
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 75_000;
  try {
    while (Date.now() < deadline) {
      if (processError) throw processError;
      if (exit) throw new Error(`Worker runtime command exited before probes passed: code ${exit.code}, signal ${exit.signal}.`);

      probes = [];
      const probeVariables: Record<string, string> = {};
      for (const probe of plan.probes) {
        probes.push(await runHttpProbe(baseUrl, probe, probeVariables));
      }

      if (probes.every((probe) => probe.ok)) {
        const outputSummary = compactDiagnostic(output.trim() || 'wrangler dev served all runtime probes.', 900);
        await appendDeliveryEventState({
          repoPath,
          mastra,
          event: {
            type: 'run_code',
            stage,
            command: command.command,
            ok: true,
            output_summary: outputSummary,
            probes,
          },
        });
        return {
          tier: plan.tier,
          command: command.command,
          ok: true,
          required: plan.required,
          reason: plan.reason,
          output_summary: outputSummary,
          probes,
        };
      }

      await delay(1_000);
    }

    throw new Error(`Worker runtime probes did not pass within 75s. Last probe results: ${JSON.stringify(probes)}`);
  } catch (error) {
    const failure = compactDiagnostic(`${compactDiagnostic(error, 900)}\n${output}`, 1_400);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command: command.command,
        ok: false,
        error: failure,
        probes,
      },
    });
    return {
      tier: plan.tier,
      command: command.command,
      ok: false,
      required: plan.required,
      reason: plan.reason,
      error: failure,
      probes,
    };
  } finally {
    await stopChildProcess(child);
    adminSecret?.restore();
  }
}

async function collectReleaseGateEvidence({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}): Promise<ReleaseGateEvidence> {
  const dependencyInstall = await ensureNodeDependencies({ repoPath, mastra, stage });

  const runtimePlan = releaseGateRuntimeProbePlan(repoPath);
  const runtimePersistTo = runtimePlan ? createReleaseGateRuntimeStatePath(repoPath) : undefined;
  const plan = releaseGateEvidenceCommandPlan(repoPath, runtimePersistTo);
  const staticResults = releaseGateStaticEvidenceResults(repoPath);
  const requiredStaticFailures = releaseGateRequiredStaticEvidenceFailures(staticResults);
  const notes: string[] = [];
  if (!plan.some((command) => command.tier === 'smoke')) {
    notes.push('No package verification script was available; smoke tier must be marked not_required or blocked with a reason.');
  }
  if (!plan.some((command) => command.tier === 'api') && !runtimePlan) {
    notes.push('No local D1 migration command or Worker runtime probe was planned; API tier should be not_required unless other API evidence exists.');
  }
  if (!runtimePlan) {
    notes.push('No Wrangler Worker config was detected, so local Worker runtime startup was not probed.');
  }
  if (releaseGateTranscriptFixtureAvailable(repoPath)) {
    notes.push(
      'Release gate seeds D1 with a completed run containing original and regenerated transcript versions, then probes GET /latest against the same local Wrangler state.',
    );
  }
  if (requiredStaticFailures.length) {
    notes.push(
      `Skipped dynamic Worker API evidence because required static release-gate checks failed: ${requiredStaticFailures
        .map((result) => result.command)
        .join(', ')}.`,
    );
  }
  notes.push('No browser E2E harness is started by this workflow; E2E and full_matrix tiers should be not_required unless cited evidence exists.');

  const commands: ReleaseGateEvidenceResult[] = [];
  if (dependencyInstall) {
    commands.push({
      tier: 'smoke',
      command: dependencyInstall.command,
      ok: dependencyInstall.ok,
      required: true,
      reason: dependencyInstall.reason,
      output_summary: dependencyInstall.output_summary,
      error: dependencyInstall.error,
    });
  }
  const dynamicPlan = plan.filter((command) => command.tier !== 'smoke');
  for (const command of plan.filter((item) => item.tier === 'smoke')) {
    commands.push(await runReleaseGateEvidenceCommand({ repoPath, mastra, stage, command }));
  }
  for (const result of staticResults) {
    await recordReleaseGateStaticEvidenceResult({ repoPath, mastra, stage, result });
    commands.push(result);
  }
  if (!requiredStaticFailures.length) {
    for (const command of dynamicPlan) {
      commands.push(await runReleaseGateEvidenceCommand({ repoPath, mastra, stage, command }));
    }
    const runtimeResult = await runReleaseGateRuntimeProbe({ repoPath, mastra, stage, persistTo: runtimePersistTo });
    if (runtimeResult) commands.push(runtimeResult);
  }

  return {
    artifact_type: 'test-evidence',
    stage,
    commands,
    notes,
  };
}

export function acceptanceContractsForTask({
  repoPath,
  task,
  verification,
}: {
  repoPath?: string;
  task: Task;
  verification: { performed: string[]; missing: string[] };
}) {
  return acceptanceContractsForCriteria({
    repoPath,
    task,
    verification,
    criteria: taskVerificationAcceptanceContractCriteria(task),
    contractIdForCriterion: (criterion, index) => acceptanceContractId(task, index, criterion),
  });
}

export function verificationWithAcceptanceGaps({
  repoPath,
  task,
  verification,
}: {
  repoPath?: string;
  task: Task;
  verification: { performed: string[]; missing: string[] };
}) {
  return verificationWithAcceptanceContractGaps({
    repoPath,
    task,
    verification,
    criteria: taskVerificationAcceptanceContractCriteria(task),
    missingOwnedSurfacePaths: repoPath ? missingOwnedSurfacePaths(repoPath, task) : [],
  });
}

function taskBoundaryAllowsRepairPath(repoPath: string, task: Task, path: string) {
  return matchesAny(path, taskBoundarySurfaces(repoPath, task));
}

function repairUnknownNumberIntegerLine(line: string) {
  return line.replace(/\bNumber\.isInteger\(([_$A-Za-z][_$A-Za-z0-9]*)\)\s*&&/g, (match, identifier, offset) => {
    const prefix = line.slice(0, offset);
    const narrowingPattern = new RegExp(`typeof\\s+${identifier}\\s*===\\s*["']number["']`);
    if (narrowingPattern.test(prefix)) return match;
    return `typeof ${identifier} === "number" && ${match}`;
  });
}

export async function repairUnknownNumberIntegerNarrowing({
  repoPath,
  mastra,
  stage,
  taskPlan,
  currentTaskIndex,
  failure,
}: {
  repoPath: string;
  mastra?: any;
  stage: string;
  taskPlan: TaskPlan;
  currentTaskIndex: number;
  failure: string;
}) {
  const currentTask = topoOrderTasks(taskPlan.tasks)[currentTaskIndex];
  if (!currentTask) return false;

  const diagnostics = typeScriptDiagnosticsFromText(failure).filter(
    (diagnostic) => diagnostic.code === 'TS18046' && /\bunknown\b/i.test(diagnostic.message),
  );
  if (!diagnostics.length) return false;

  const repairedPaths: string[] = [];
  for (const path of new Set(diagnostics.map((diagnostic) => diagnostic.path))) {
    if (!taskBoundaryAllowsRepairPath(repoPath, currentTask, path)) continue;
    const fullPath = join(resolve(repoPath), path);
    if (!existsSync(fullPath)) continue;

    const source = readFileSync(fullPath, 'utf8');
    const next = source
      .split('\n')
      .map((line) => repairUnknownNumberIntegerLine(line))
      .join('\n');
    if (next === source) continue;

    writeFileSync(fullPath, next);
    repairedPaths.push(path);
  }

  if (!repairedPaths.length) return false;

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths: repairedPaths,
      output_summary:
        'Added typeof number narrowing before Number.isInteger checks after TS18046 unknown-value typecheck failures.',
    },
  }).catch(() => undefined);
  return true;
}

async function applyBuildVerificationRepair({
  repoPath,
  mastra,
  stage,
  taskPlan,
  taskIndex,
  failure,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  taskPlan?: TaskPlan;
  taskIndex?: number;
  failure: string;
}) {
  if (
    taskPlan &&
    typeof taskIndex === 'number' &&
    (await repairStaleDownstreamVerificationSurfaces({
      repoPath,
      mastra,
      stage,
      taskPlan,
      currentTaskIndex: taskIndex,
      failure,
    }))
  ) {
    return true;
  }

  if (
    taskPlan &&
    (await repairStaleOutOfPlanVerificationSurfaces({
      repoPath,
      mastra,
      stage,
      taskPlan,
      failure,
    }))
  ) {
    return true;
  }

  if (
    taskPlan &&
    typeof taskIndex === 'number' &&
    (await repairUnknownNumberIntegerNarrowing({
      repoPath,
      mastra,
      stage,
      taskPlan,
      currentTaskIndex: taskIndex,
      failure,
    }))
  ) {
    return true;
  }

  if (!/Cannot find name 'WorkflowEvent'/.test(failure)) return false;

  const path = 'src/workflows/weekly.ts';
  const fullPath = join(resolve(repoPath), path);
  if (!existsSync(fullPath)) return false;

  const source = readFileSync(fullPath, 'utf8');
  const next = source.replace(
    "import { WorkflowEntrypoint } from 'cloudflare:workers';",
    "import { WorkflowEntrypoint, type WorkflowEvent } from 'cloudflare:workers';",
  );
  if (next === source) return false;

  writeFileSync(fullPath, next);
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths: [path],
      output_summary: 'Imported WorkflowEvent from cloudflare:workers after typecheck failure.',
    },
  });
  return true;
}

function commandFailureSummary(error: unknown, limit = 1000) {
  return verificationFailureSummaryFromCommandError(error, limit);
}

function synthesizeImplementationNote({
  repoPath,
  stage,
  task,
  taskPlan,
  events,
  buildResponse,
  verification,
}: {
  repoPath: string;
  stage: string;
  task: Task;
  taskPlan: TaskPlan;
  events: DeliveryEvent[];
  buildResponse: unknown;
  verification: { performed: string[]; missing: string[] };
}): ImplementationNote {
  const filesTouched = implementationFilesTouched({ repoPath, stage, task, events });
  const summary = responseText(buildResponse);
  const honestVerification = verificationWithAcceptanceGaps({ repoPath, task, verification });
  const acceptanceContracts = acceptanceContractsForTask({ repoPath, task, verification: honestVerification });

  return {
    artifact_type: 'implementation-note',
    task: task.id,
    changes: [
      `Implemented ${task.id}: ${task.deliverable}`,
      ...(summary ? [`Engineer response: ${compactDiagnostic(summary, 500)}`] : []),
    ],
    files_touched: filesTouched,
    acceptance_contracts: acceptanceContracts,
    assumptions: taskPlan.open_decisions,
    verification: honestVerification,
    risks: taskPlan.risks,
  };
}

function acceptanceContractGaps(note: ImplementationNote) {
  const contractGaps = (note.acceptance_contracts ?? [])
    .filter((contract) => contract.status !== 'verified')
    .filter((contract) => !isBehaviorLikeAcceptanceCriterion(contract.criterion))
    .map((contract) => `${contract.id}: ${contract.criterion}${contract.gaps.length ? ` (${contract.gaps.join('; ')})` : ''}`);
  if (contractGaps.length) return contractGaps;

  return note.verification.missing
    .filter((item) => /^Acceptance criterion not verified by automated checks:/i.test(item))
    .map((item) => item.replace(/^Acceptance criterion not verified by automated checks:\s*/i, ''))
    .filter((criterion) => !isBehaviorLikeAcceptanceCriterion(criterion));
}

export function implementationDeterministicResults({
  repoPath,
  stage,
  role,
  task,
  note,
  events,
  verification,
}: {
  repoPath: string;
  stage: string;
  role: 'engineer' | 'designer';
  task: Task;
  note: ImplementationNote;
  events: DeliveryEvent[];
  verification: { performed: string[]; missing: string[] };
}): DeterministicGateResult[] {
  const files = repoFileContents(repoPath, note.files_touched);
  const missingSurfaces = missingOwnedSurfacePaths(repoPath, task);
  const unreplacedStubs = unreplacedPreflightStubPaths(repoPath, task);
  const workflowIntegrationGaps = workflowStepIntegrationGaps(repoPath, task);
  const workflowEntrypointGaps = workflowEntrypointImportGaps(repoPath, task);
  const routeMiddlewareGaps = routeMiddlewareBypassGaps(repoPath, task);
  const aiBindingGaps = workersAiBindingGaps(repoPath, task);
  const workerConfigGaps = workerConfigHygieneGaps(repoPath, task);
  const workerPackageGaps = workerPackageScaffoldGaps(repoPath, task);
  const lifecycleStatusGaps = lifecycleStatusSchemaGaps(repoPath, task);
  const profileKindGaps = profileKindContractGaps(repoPath, task);
  const acceptanceGaps = acceptanceContractGaps(note);
  const noteOwnership = runDeterministicCheck({
    name: 'file_ownership',
    role,
    paths: note.files_touched,
  });
  const eventOwnership = runDeterministicCheck({
    name: 'write_paths_in_boundary',
    events,
    stage,
    role,
  });
  const ownership = noteOwnership.passed ? eventOwnership : noteOwnership;
  const moduleLoads = runDeterministicCheck({
    name: 'ran_code_before_complete',
    events,
    stage,
  });
  const crypto = noBcryptWeakHash(files);
  const failedVerification = verification.missing.find((item) => /\bfailed:/i.test(item));

  return [
    { id: 'file_ownership', check: 'write_paths_in_boundary', ...ownership },
    {
      id: 'owned_surfaces_present',
      check: 'owned_surfaces_present',
      passed: missingSurfaces.length === 0,
      reason: missingSurfaces.length ? `missing owned surfaces: ${missingSurfaces.join(', ')}` : 'ok',
    },
    {
      id: 'preflight_stubs_replaced',
      check: 'preflight_stubs_replaced',
      passed: unreplacedStubs.length === 0,
      reason: unreplacedStubs.length ? `preflight stubs remain: ${unreplacedStubs.join(', ')}` : 'ok',
    },
    {
      id: 'workflow_step_integrated',
      check: 'workflow_step_integrated',
      passed: workflowIntegrationGaps.length === 0,
      reason: workflowIntegrationGaps.length ? workflowIntegrationGaps.join('; ') : 'ok',
    },
    {
      id: 'workflow_entrypoint_imported',
      check: 'workflow_entrypoint_imported',
      passed: workflowEntrypointGaps.length === 0,
      reason: workflowEntrypointGaps.length ? workflowEntrypointGaps.join('; ') : 'ok',
    },
    {
      id: 'route_middleware_layering',
      check: 'middleware_layering',
      passed: routeMiddlewareGaps.length === 0,
      reason: routeMiddlewareGaps.length ? routeMiddlewareGaps.join('; ') : 'ok',
    },
    {
      id: 'workers_ai_binding_required',
      check: 'workers_ai_binding_required',
      passed: aiBindingGaps.length === 0,
      reason: aiBindingGaps.length ? aiBindingGaps.join('; ') : 'ok',
    },
    {
      id: 'cloudflare_worker_config_current',
      check: 'worker_config_hygiene',
      passed: workerConfigGaps.length === 0,
      reason: workerConfigGaps.length ? workerConfigGaps.join('; ') : 'ok',
    },
    {
      id: 'worker_package_scaffold_current',
      check: 'worker_package_hygiene',
      passed: workerPackageGaps.length === 0,
      reason: workerPackageGaps.length ? workerPackageGaps.join('; ') : 'ok',
    },
    {
      id: 'lifecycle_status_schema_constrained',
      check: 'state_explicitness',
      passed: lifecycleStatusGaps.length === 0,
      reason: lifecycleStatusGaps.length ? lifecycleStatusGaps.join('; ') : 'ok',
    },
    {
      id: 'profile_kind_contract_aligned',
      check: 'profile_kind_contract',
      passed: profileKindGaps.length === 0,
      reason: profileKindGaps.length ? profileKindGaps.join('; ') : 'ok',
    },
    {
      id: 'acceptance_contracts_satisfied',
      check: 'acceptance_criteria_contracts',
      passed: acceptanceGaps.length === 0,
      reason: acceptanceGaps.length ? acceptanceGaps.slice(0, 8).join('; ') : 'ok',
    },
    { id: 'module_loads', check: 'ran_code_before_complete', ...moduleLoads },
    {
      id: 'verification_passed',
      check: 'build_verification_passed',
      passed: verification.performed.length > 0 && !failedVerification,
      reason: failedVerification ?? (verification.performed.length ? 'ok' : 'no build verification command passed'),
    },
    { id: 'crypto_compliance', check: 'no_bcrypt_weak_hash', ...crypto },
  ];
}

export function implementationDeterministicRemediation(results: DeterministicGateResult[]) {
  return results
    .filter((result) => !result.passed)
    .filter((result) =>
      [
        'file_ownership',
        'write_paths_in_boundary',
        'owned_surfaces_present',
        'preflight_stubs_replaced',
        'workflow_step_integrated',
        'workflow_entrypoint_imported',
        'route_middleware_layering',
        'middleware_layering',
        'workers_ai_binding_required',
        'cloudflare_worker_config_current',
        'worker_config_hygiene',
        'worker_package_scaffold_current',
        'worker_package_hygiene',
        'lifecycle_status_schema_constrained',
        'state_explicitness',
        'profile_kind_contract_aligned',
        'profile_kind_contract',
        'acceptance_contracts_satisfied',
        'acceptance_criteria_contracts',
        'module_loads',
        'ran_code_before_complete',
        'verification_passed',
        'build_verification_passed',
      ].includes(String(result.id ?? result.check)),
    )
    .map((result) => {
      const id = String(result.id ?? result.check ?? 'deterministic_check');
      return `DETERMINISTIC ${id} failed: ${result.reason ?? 'no reason recorded'}`;
    });
}

export function releaseGateRequiredEvidencePassed(evidence?: ReleaseGateEvidence): DeterministicGateResult {
  if (!evidence) {
    return {
      id: 'required_evidence_passed',
      check: 'required_evidence_passed',
      passed: false,
      reason: 'release gate evidence artifact was not available',
    };
  }

  const required = evidence.commands.filter((command) => command.required);
  const failed = required.filter((command) => !command.ok);
  if (failed.length) {
    return {
      id: 'required_evidence_passed',
      check: 'required_evidence_passed',
      passed: false,
      reason: `required release-gate evidence failed: ${failed
        .map((command) => `${command.command}: ${command.error ?? 'failed'}`)
        .join('; ')}`,
    };
  }

  return {
    id: 'required_evidence_passed',
    check: 'required_evidence_passed',
    passed: true,
    reason: required.length
      ? `all required release-gate evidence passed: ${required.map((command) => command.command).join(', ')}`
      : 'no required release-gate evidence commands were planned',
  };
}

function releaseGateDeterministicResults({
  stage,
  gate,
  events,
  evidence,
}: {
  stage: string;
  gate: ReleaseGate;
  events: DeliveryEvent[];
  evidence?: ReleaseGateEvidence;
}): DeterministicGateResult[] {
  return [
    { id: 'decision_explicit', check: 'plan_schema_complete', ...planSchemaComplete(gate) },
    { id: 'tier_order', check: 'tier_order', ...runDeterministicCheck({ name: 'tier_order', subject: gate }) },
    {
      id: 'pass_with_open_blockers',
      check: 'release_blockers_zero',
      ...runDeterministicCheck({ name: 'release_blockers_zero', subject: gate }),
    },
    {
      id: 'critical_area_evidence_trajectory',
      check: 'harness_run_before_findings',
      ...runDeterministicCheck({ name: 'harness_run_before_findings', events, stage }),
    },
    releaseGateRequiredEvidencePassed(evidence),
  ];
}

export function releaseGateForInvalidTesterOutput(error: unknown): ReleaseGate {
  const diagnostic = compactDiagnostic(error, 900);
  const reason = `Tester did not return a structured release-gate object: ${diagnostic}`;

  return {
    artifact_type: 'release-gate',
    decision: 'fail',
    event_type: 'pre_deployment',
    tiers: [
      {
        tier: 'smoke',
        status: 'failed',
        reason,
      },
      {
        tier: 'api',
        status: 'skipped',
        reason: 'Structured release-gate output was unavailable after tester execution.',
      },
      {
        tier: 'e2e',
        status: 'skipped',
        reason: 'Structured release-gate output was unavailable after tester execution.',
      },
      {
        tier: 'full_matrix',
        status: 'skipped',
        reason: 'Structured release-gate output was unavailable after tester execution.',
      },
    ],
    critical_areas: [
      'auth',
      'billing',
      'state_integrity',
      'data_safety',
      'deployment_correctness',
      'error_responses',
    ].map((area) => ({
      area: area as ReleaseGate['critical_areas'][number]['area'],
      status: 'missing' as const,
      reason,
    })),
    blockers: [
      reason,
      'Rerun the release gate and return only { "gate": <release-gate> } after executing evidence commands.',
    ],
    cosmetic_issues: [],
    summary: 'Release gate failed closed because the tester returned malformed structured output.',
  };
}

function deploymentDeterministicResults({
  stage,
  releaseGate,
  events,
}: {
  stage: string;
  releaseGate: ReleaseGate;
  events: DeliveryEvent[];
}): DeterministicGateResult[] {
  return [
    {
      id: 'no_deploy_through_blockers',
      check: 'release_blockers_zero',
      ...runDeterministicCheck({ name: 'release_blockers_zero', subject: releaseGate, mode: 'deployable' }),
    },
    {
      id: 'no_deploy_through_blockers_trajectory',
      check: 'release_gate_read_before_deploy',
      ...runDeterministicCheck({ name: 'release_gate_read_before_deploy', events, stage }),
    },
    {
      id: 'verification_evidence_present_trajectory',
      check: 'live_verify_after_deploy',
      ...runDeterministicCheck({ name: 'live_verify_after_deploy', events, stage }),
    },
  ];
}

function latestArtifactPath(artifacts: string[], needle: string, fallback: string) {
  return [...artifacts].reverse().find((path) => path.includes(needle) && !path.includes('/judgments/')) ?? fallback;
}

function latestReleaseGateEvidencePath(artifacts: string[]) {
  const path = latestArtifactPath(artifacts, 'test-evidence', '');
  return path || undefined;
}

function readReleaseGateEvidenceArtifact(repoPath: string, artifacts: string[]) {
  const evidencePath = latestReleaseGateEvidencePath(artifacts);
  if (!evidencePath) return undefined;

  const evidence = readJsonArtifact(repoPath, evidencePath);
  if (!evidence || typeof evidence !== 'object') return undefined;
  if ((evidence as { artifact_type?: unknown }).artifact_type !== 'test-evidence') return undefined;
  return evidence as ReleaseGateEvidence;
}

export function localDeploymentReportFromReleaseGateEvidence({
  runId,
  releaseGate,
  evidence,
  releaseGatePath,
  evidencePath,
}: {
  runId: string;
  releaseGate: ReleaseGate;
  evidence?: ReleaseGateEvidence;
  releaseGatePath: string;
  evidencePath?: string;
}): DeploymentReport {
  return localDeploymentReportFromReleaseGateEvidenceBase({ runId, releaseGate, evidence, releaseGatePath, evidencePath });
}

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

export function deploymentReportSuccessNextSteps(report: DeploymentReport, repoPath: string) {
  return deploymentReportSuccessNextStepsBase(report, repoPath);
}

async function runProductionWranglerDeployment({
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

const requiredAgent = (mastra: any, id: string) => {
  const agent = mastra?.getAgentById(id);
  if (!agent) throw new Error(`${id} agent is not registered`);
  return agent as {
    generate: (message: string, options: Record<string, unknown>) => Promise<{ object?: unknown; text?: string }>;
  };
};

const structuredNoToolOptions = {
  activeTools: [] as string[],
  maxSteps: 1,
};

const implementationWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
] as string[];

const implementationWriteOnlyWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
] as string[];

const implementationRepairWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
] as string[];

const envTimeoutMs = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const deliveryAgentTimeouts = {
  standard: envTimeoutMs('DELIVERY_AGENT_CALL_TIMEOUT_MS', 300_000),
  build: envTimeoutMs('DELIVERY_BUILD_CALL_TIMEOUT_MS', 180_000),
  buildNoTool: envTimeoutMs('DELIVERY_BUILD_NO_TOOL_TIMEOUT_MS', 60_000),
  buildPostWriteQuiet: envTimeoutMs('DELIVERY_BUILD_POST_WRITE_QUIET_TIMEOUT_MS', 60_000),
  judge: envTimeoutMs('DELIVERY_JUDGE_CALL_TIMEOUT_MS', 300_000),
};

const repairPostWriteQuietTimeoutMs = 8_000;
const preWriteReadBudgetBlockLimit = 2;

class DeliveryStageTimeoutError extends Error {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number,
    message?: string,
  ) {
    super(message ?? `Delivery stage "${stage}" timed out after ${timeoutMs}ms`);
    this.name = 'DeliveryStageTimeoutError';
  }
}

class DeliveryNoToolCallTimeoutError extends DeliveryStageTimeoutError {
  constructor(stage: string, timeoutMs: number) {
    super(stage, timeoutMs, `Delivery stage "${stage}" made no tool calls after ${timeoutMs}ms`);
    this.name = 'DeliveryNoToolCallTimeoutError';
  }
}

class DeliveryPostWriteQuietTimeoutError extends DeliveryStageTimeoutError {
  constructor(stage: string, timeoutMs: number) {
    super(stage, timeoutMs, `Delivery stage "${stage}" made no progress for ${timeoutMs}ms after a workspace write`);
    this.name = 'DeliveryPostWriteQuietTimeoutError';
  }
}

class DeliveryReadBudgetExceededError extends DeliveryStageTimeoutError {
  constructor(
    stage: string,
    readonly blockCount: number,
  ) {
    super(stage, 0, `Delivery stage "${stage}" exhausted the pre-write read/list budget ${blockCount} times`);
    this.name = 'DeliveryReadBudgetExceededError';
  }
}

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

async function stageHasToolUse({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  try {
    return stageSlice(readDeliveryEvents(repoPath), stage).some((event) => event.type === 'tool_use');
  } catch {
    // Fall back to the Mastra-backed state reader only if the local projection cannot be read.
  }

  const events = await readDeliveryEventsState({ repoPath, mastra }).catch(() => []);
  return stageSlice(events, stage).some((event) => event.type === 'tool_use');
}

const writeToolNames = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);

export function latestSuccessfulWorkspaceWriteEventTimestamp(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  const scoped = stageSlice(events, stage);
  for (let index = scoped.length - 1; index >= 0; index -= 1) {
    const event = scoped[index];
    if (event.type !== 'tool_use' || event.ok !== true || typeof event.tool !== 'string') continue;
    if (!writeToolNames.has(event.tool)) continue;

    const timestamp = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

const readBudgetExceededPattern = /already used \d+ read\/list tool calls before any write/i;

export function readBudgetBlockedToolCount(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  return stageSlice(events, stage).filter(
    (event) => event.type === 'tool_use' && event.ok === false && readBudgetExceededPattern.test(String(event.error ?? '')),
  ).length;
}

async function latestStageSuccessfulWriteTimestamp({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  try {
    return latestSuccessfulWorkspaceWriteEventTimestamp(readDeliveryEvents(repoPath), { stage });
  } catch {
    // Fall back to the Mastra-backed state reader only if the local projection cannot be read.
  }

  const events = await readDeliveryEventsState({ repoPath, mastra }).catch(() => []);
  return latestSuccessfulWorkspaceWriteEventTimestamp(events, { stage });
}

async function stageReadBudgetBlockedToolCount({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  try {
    return readBudgetBlockedToolCount(readDeliveryEvents(repoPath), { stage });
  } catch {
    // Fall back to Mastra storage when local projection is unavailable.
  }

  const events = await readDeliveryEventsState({ repoPath, mastra }).catch(() => []);
  return readBudgetBlockedToolCount(events, { stage });
}

async function runWithDeliveryStageTimeout<T>({
  repoPath,
  mastra,
  stage,
  timeoutMs,
  firstToolTimeoutMs,
  firstToolCheck,
  postWriteQuietTimeoutMs,
  latestWriteCheck,
  readBudgetBlockLimit,
  readBudgetBlockCheck,
  operation,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  timeoutMs: number;
  firstToolTimeoutMs?: number;
  firstToolCheck?: () => Promise<boolean>;
  postWriteQuietTimeoutMs?: number;
  latestWriteCheck?: () => Promise<number | undefined>;
  readBudgetBlockLimit?: number;
  readBudgetBlockCheck?: () => Promise<number>;
  operation: (abortSignal: AbortSignal) => Promise<T>;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstToolTimer: ReturnType<typeof setTimeout> | undefined;
  let postWriteQuietTimer: ReturnType<typeof setInterval> | undefined;
  let readBudgetTimer: ReturnType<typeof setInterval> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(`Delivery stage "${stage}" timed out after ${timeoutMs}ms`);
      reject(new DeliveryStageTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
  const firstToolTimeout =
    firstToolTimeoutMs && firstToolCheck
      ? new Promise<never>((_, reject) => {
          firstToolTimer = setTimeout(() => {
            firstToolCheck()
              .then((hasToolUse) => {
                if (hasToolUse) return;
                controller.abort(`Delivery stage "${stage}" made no tool calls after ${firstToolTimeoutMs}ms`);
                reject(new DeliveryNoToolCallTimeoutError(stage, firstToolTimeoutMs));
              })
              .catch(() => undefined);
          }, firstToolTimeoutMs);
          firstToolTimer.unref?.();
        })
      : undefined;
  const postWriteQuietTimeout =
    postWriteQuietTimeoutMs && latestWriteCheck
      ? new Promise<never>((_, reject) => {
          const pollMs = Math.min(5_000, postWriteQuietTimeoutMs);
          postWriteQuietTimer = setInterval(() => {
            latestWriteCheck()
              .then((latestWriteAt) => {
                if (!latestWriteAt) return;
                if (Date.now() - latestWriteAt < postWriteQuietTimeoutMs) return;

                controller.abort(
                  `Delivery stage "${stage}" made no progress for ${postWriteQuietTimeoutMs}ms after a workspace write`,
                );
                reject(new DeliveryPostWriteQuietTimeoutError(stage, postWriteQuietTimeoutMs));
              })
              .catch(() => undefined);
          }, pollMs);
          postWriteQuietTimer.unref?.();
        })
      : undefined;
  const readBudgetExceeded =
    readBudgetBlockLimit && readBudgetBlockCheck
      ? new Promise<never>((_, reject) => {
          readBudgetTimer = setInterval(() => {
            readBudgetBlockCheck()
              .then((blockCount) => {
                if (blockCount < readBudgetBlockLimit) return;
                controller.abort(
                  `Delivery stage "${stage}" exhausted the pre-write read/list budget ${blockCount} times`,
                );
                reject(new DeliveryReadBudgetExceededError(stage, blockCount));
              })
              .catch(() => undefined);
          }, 2_000);
          readBudgetTimer.unref?.();
        })
      : undefined;

  const work = operation(controller.signal);
  work.catch(() => undefined);

  try {
    return await Promise.race([
      work,
      timeout,
      ...(firstToolTimeout ? [firstToolTimeout] : []),
      ...(postWriteQuietTimeout ? [postWriteQuietTimeout] : []),
      ...(readBudgetExceeded ? [readBudgetExceeded] : []),
    ]);
  } catch (error) {
    if (error instanceof DeliveryStageTimeoutError) {
      await appendDeliveryEventState({
        repoPath,
        mastra,
        event:
          error instanceof DeliveryNoToolCallTimeoutError
            ? { type: 'stage_no_tool_timeout', stage, timeout_ms: error.timeoutMs }
            : error instanceof DeliveryPostWriteQuietTimeoutError
              ? { type: 'stage_post_write_quiet_timeout', stage, timeout_ms: error.timeoutMs }
              : error instanceof DeliveryReadBudgetExceededError
                ? { type: 'stage_read_budget_exceeded', stage, blocked_reads: error.blockCount }
            : { type: 'stage_timeout', stage, timeout_ms: error.timeoutMs },
      }).catch(() => undefined);
      await endDeliveryStageState({ repoPath, stage, reason: 'max_turns', mastra }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (firstToolTimer) clearTimeout(firstToolTimer);
    if (postWriteQuietTimer) clearInterval(postWriteQuietTimer);
    if (readBudgetTimer) clearInterval(readBudgetTimer);
  }
}

async function judgeDeliveryArtifact({
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

const createSyncDeliveryStageStateStep = (id: string, description: string) =>
  createStep({
    id,
    description,
    inputSchema: deliveryStageOutputSchema,
    outputSchema: deliveryStageOutputSchema,
    stateSchema: deliveryWorkflowStateSchema,
    execute: async ({ inputData, state, setState, mastra }) => {
      await syncDeliveryWorkflowState({ state, setState, output: inputData });
      await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
      return inputData;
    },
  });

const syncPlanStateStep = createSyncDeliveryStageStateStep(
  'sync-plan-state',
  'Persist plan gate output into the native workflow state snapshot.',
);
const syncReviewStateStep = createSyncDeliveryStageStateStep(
  'sync-review-state',
  'Persist architect review output into the native workflow state snapshot.',
);
const syncBuildStateStep = createSyncDeliveryStageStateStep(
  'sync-build-state',
  'Persist build aggregation output into the native workflow state snapshot.',
);
const syncReleaseGateStateStep = createSyncDeliveryStageStateStep(
  'sync-release-gate-state',
  'Persist release gate output into the native workflow state snapshot.',
);

const syncDeploymentReportStateStep = createStep({
  id: 'sync-deployment-report-state',
  description: 'Persist deployment report output into the native workflow state snapshot.',
  inputSchema: deploymentReportStageSchema,
  outputSchema: deploymentReportStageSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state, setState, mastra }) => {
    await syncDeliveryWorkflowState({ state, setState, output: inputData });
    if (inputData.repoPath) await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    return inputData;
  },
});

const syncFinalDeliveryStateStep = createStep({
  id: 'sync-final-delivery-state',
  description: 'Persist final delivery workflow output into the native workflow state snapshot.',
  inputSchema: workflowOutputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state, setState, mastra }) => {
    await syncDeliveryWorkflowState({ state, setState, output: inputData });
    if (inputData.repoPath) await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    return inputData;
  },
});

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

function planGateRevisionRemediation({
  deterministicResults,
  judgment,
}: {
  deterministicResults: DeterministicGateResult[];
  judgment: AggregatedJudgment;
}) {
  const failedChecks = deterministicResults.filter((check) => !check.passed);
  if (failedChecks.length) {
    return failedChecks.map((check) => check.reason ?? 'deterministic task-plan check failed');
  }
  if (!judgment.passed) return judgment.remediation;
  return [];
}

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

    const resumePlan = deliveryBuildResumePlan(inputData.repoPath, inputData.taskPlan);
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
  execute: async ({ inputData, mastra }) => {
    if (inputData.terminal) return inputData;
    if (!inputData.taskPlan) throw new Error('build task attempt did not include a task plan');
    if (!inputData.task) throw new Error('build task attempt did not include a task');

    const taskPlan = inputData.taskPlan;
    const task = inputData.task;
    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];
    const role = buildRoleForTask(task);
    const agent = requiredAgent(mastra, role);
    const attempt = inputData.attempt;
    const attemptNumber = attempt + 1;
    const stage = `build:${task.id}`;
    const sourceBoundarySurfaces = taskSourceBoundarySurfaces(inputData.repoPath, task).filter(
      (surface) => !/^unknown\b/i.test(surface),
    );
    const generatedSurfaces = generatedTaskSurfacePaths(task);
    await updateDeliveryTaskState({
      repoPath: inputData.repoPath,
      id: task.id,
      status: 'building',
      owner: role,
      note: attempt > 0 ? `retry ${attemptNumber}` : undefined,
      bumpRetries: attempt > 0,
      mastra,
    });
    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      role,
      surfaces: sourceBoundarySurfaces.length ? sourceBoundarySurfaces : undefined,
      mastra,
    });

    const preflightCreatedSurfaces = await createMissingOwnedSurfaceStubs({
      repoPath: inputData.repoPath,
      task,
      stage,
      mastra,
    });
    const missingSurfaces = missingOwnedSurfacePaths(inputData.repoPath, task);
    const unreplacedStubs = unreplacedPreflightStubPaths(inputData.repoPath, task);
    const verificationRecovery = remediationHasVerificationFailureBase(inputData.remediation);
    const retryMode = implementationRetryMode({
      remediation: inputData.remediation,
      missingSurfaces,
      unreplacedStubs,
    });
    const failureClass = implementationFailureClass(inputData.remediation);
    const writeFirstRecovery = retryMode === 'write-first';
    const replaceStubsRecovery = retryMode === 'replace-stubs';
    const focusedRepairRecovery = retryMode === 'focused-repair';
    const activeTools = writeFirstRecovery
      ? implementationWriteOnlyWorkspaceTools
      : replaceStubsRecovery || focusedRepairRecovery
        ? implementationRepairWorkspaceTools
        : implementationWorkspaceTools;
    const toolChoice = implementationToolChoiceForRetryMode(retryMode);
    const maxSteps = writeFirstRecovery ? 3 : replaceStubsRecovery ? 5 : focusedRepairRecovery ? 4 : 8;
    const packageManifestOwned = taskOwnsPackageManifest(task);
    const existingPackageDependencies = packageDependencyNames(inputData.repoPath);
    const dependencySurfaces = directDependencySurfacePaths(taskPlan, task);
    const verificationFailureDiagnostics = typeScriptDiagnosticsFromRemediation(inputData.remediation);
    const focusedRepairFileContext = replaceStubsRecovery || focusedRepairRecovery
      ? repoFileContents(inputData.repoPath, focusedRepairContextPaths(taskPlan, task, sourceBoundarySurfaces))
      : [];
    const taskPacket = {
      scope: taskPlan.scope,
      task,
      acceptance_contracts: taskVerificationAcceptanceContractCriteria(task).map((criterion, index) => ({
        id: acceptanceContractId(task, index, criterion),
        criterion,
        status: 'required',
      })),
      technology_decisions: taskPlan.technology_decisions,
      open_decisions: taskPlan.open_decisions,
      risks: taskPlan.risks,
      remediation: inputData.remediation,
      scaffold_manifest: scaffoldManifestPromptSummary(inputData.scaffoldManifest),
      failure_class: failureClass,
      missing_owned_surfaces: missingSurfaces,
      unreplaced_preflight_stubs: unreplacedStubs,
      preflight_created_surfaces: preflightCreatedSurfaces,
      boundary_surfaces: sourceBoundarySurfaces,
      generated_surfaces: generatedSurfaces,
      direct_dependency_surfaces: dependencySurfaces,
      verification_failure_diagnostics: verificationFailureDiagnostics,
      package_manifest_owned: packageManifestOwned,
      existing_package_dependencies: existingPackageDependencies,
      focused_repair_file_context: focusedRepairFileContext,
      worker_config_policy: workerConfigTaskPacketPolicyForTask(task),
      profile_kind_policy: profileKindTaskPacketPolicyForTask(task, inputData.sourcePolicy),
      platform_policy_findings: [
        ...workersAiBindingGaps(inputData.repoPath, task),
        ...workerConfigHygieneGaps(inputData.repoPath, task),
        ...workerPackageScaffoldGaps(inputData.repoPath, task),
      ],
      domain_contract_findings: profileKindContractGaps(inputData.repoPath, task),
    };

    const buildPrompt = `Implement build task ${task.id}.

Use this task packet as the source of truth. Do not reread .delivery planning or review artifacts unless a specific required field is missing from the packet.

Task packet:
${JSON.stringify(taskPacket, null, 2)}

Execution rules:
- Make the smallest coherent code change for this task.
- Treat task_packet.acceptance_contracts as mandatory contracts. Do not return until every listed AC has concrete code evidence in the task's boundary surfaces, or until you surface a real blocker.
- Do not replace a product acceptance contract with a weaker "slice completed" claim. If the contract names behavior, implement the behavior or leave the task incomplete.
- Touch only the boundary surfaces in the task packet unless a dependency blocks the task.
- generated_surfaces are workflow-generated evidence outputs, not source files. Do not write or edit generated_surfaces directly; configure their source inputs and scripts so workflow verification generates them.
- If preflight_created_surfaces is non-empty, replace those stubs with the real implementation for this task.
- If an owned surface is still missing, create it.
- If unreplaced_preflight_stubs is non-empty, replace every listed stub before editing any other file.
- Spend at most one quick list/read pass on the existing repo shape before writing files.
- For schema/storage/route tasks, read the relevant direct_dependency_surfaces before writing when they define or consume shared domain contracts.
- Keep domain values aligned across validation, D1 schema, repository modules, and route adapters; profile kind values are not the same thing as R2 artifact object categories.
- direct_dependency_surfaces are read-only context unless a listed path is also present in boundary_surfaces.
- Do not run shell commands; the workflow runs verification after your edits.
- If this is a retry, edit the files needed to resolve the remediation before doing any broad investigation.
- If verification_failure_diagnostics is non-empty, fix each listed file/line diagnostic directly before any other cleanup.
- In write-first or focused repair mode, you must call an available workspace write/edit tool before returning; a text-only response is a failed attempt.
- If failure_class is missing_surface, create every missing_owned_surface before editing any other file.
- If failure_class is preflight_stub, replace every unreplaced_preflight_stub before editing any other file.
- If failure_class is policy_boundary, do not repeat blocked writes; use only normalized boundary_surfaces paths.
- Do not introduce runtime dependencies that are absent from existing_package_dependencies unless package_manifest_owned is true and you update the package manifest in this task.
- If verification says a module cannot be found, prefer the existing Worker/router pattern or native Web/Cloudflare APIs over adding a new dependency.
- For TS18046 on unknown values, narrow with typeof/asRecord/Array.isArray before property access or numeric comparison. Number.isInteger(value) alone does not narrow unknown to number.
- Treat platform_policy_findings as mandatory corrections, even when the original task text is stale.
- Treat domain_contract_findings as mandatory corrections, even when TypeScript is already passing.
- When worker_config_policy is not null, use the policy exactly: wrangler.jsonc for new projects, "$schema" from worker_config_policy.schema, compatibility_date from worker_config_policy.compatibility_date, compatibility_flags including "nodejs_compat", explicit observability enabled with head_sampling_rate, Workers Static Assets from worker_config_policy.static_assets when public/ UI files exist, worker_config_policy.deployment_environments with env.staging/env.production and the listed staging/prod Wrangler commands, worker_config_policy.generated_types for TypeScript source, and Wrangler binding names that exactly match generated Env binding property names.
- For worker_config_policy.generated_types, do not hand-write worker-configuration.d.ts. Add scripts.generate-types and tsconfig include so "wrangler types" creates it during workflow verification.
- For Worker scaffolds, use current Cloudflare tooling: Wrangler "latest" or v4+, scripts.dev as "wrangler dev --env staging", and scripts.deploy as "wrangler deploy --env production". For TypeScript Worker source, add scripts.generate-types as "wrangler types", scripts.typecheck as "npm run generate-types && tsc --noEmit", @types/node, and tsconfig.json. Do not add @cloudflare/workers-types; Wrangler generates Worker binding/runtime types from config.
- Do not add React, Vite, Next, Vue, Svelte, or frontend build dependencies/scripts. Chris's Worker frontends are vanilla HTML/CSS/JS served as static assets.
- When TypeScript is used, configure tsconfig.json for Workers: target ES2022 or newer, module ESNext, moduleResolution Bundler, lib includes ES2022+ and WebWorker, include contains src/**/*.ts and worker-configuration.d.ts, compilerOptions.types contains node when nodejs_compat is enabled, and strict is true. Do not put worker-configuration.d.ts in compilerOptions.types; TypeScript types entries are package names.
- .gitignore must exclude node_modules/, .wrangler/, .delivery/, .dev.vars*, .env*, and *.cpuprofile.
- For placeholder Worker route/error responses, include actionable next steps such as available route expectations, pending setup, or the next implementation surface instead of only returning "not found".
- When profile_kind_policy is not null, use it exactly: PROFILE_KINDS must include every value in profile_kind_policy.required_persistent_kinds as persistent profile kind values; do not substitute generic creator, voice, audience, topic, or R2 artifact object categories.
- For lifecycle/status storage, make state explicit: constrained status values, timestamps, query indexes, and failed/stuck states when the lifecycle can fail. Schema tasks must encode this in D1 CHECK constraints and indexes, not only TypeScript constants.
- For route tasks, integrate new endpoints through the existing Worker router/barrel/middleware path. Do not import route handlers into the Worker entrypoint and dispatch them before routeRequest when routeRequest already exists.
- If failure_class is judge_timeout, preserve working code and make only the smallest evidence-improving or obvious correctness edit before the workflow retries judgment.
- Do not inspect node_modules; rely on project types and workflow verification.
- If timeout recovery is active, do not investigate. Create the missing owned surfaces immediately.
- After you have written or edited the task's owned surfaces, stop reading/listing files and return your summary so the workflow can typecheck and judge the result.
- Return a brief natural-language summary; the workflow will create the implementation note from files, events, and verification.`;
    const recoveryPrompt = writeFirstRecovery
      ? `

Timeout recovery is active.
- Missing owned surfaces: ${missingSurfaces.join(', ')}
- Use only write/mkdir tools.
- The tool choice is required; call the workspace write tool now.
- Do not read or list files in this attempt.
- Create compile-safe placeholders that satisfy the task packet and allow workflow verification to run.`
      : '';
    const replaceStubsPrompt = replaceStubsRecovery
      ? `

Preflight stub replacement mode is active.
- Replace every unreplaced_preflight_stub before doing anything else:
${unreplacedStubs.map((item) => `  - ${item}`).join('\n') || '  - none'}
- Use mastra_workspace_write_file or mastra_workspace_edit_file now; a text-only response is a failed attempt.
- Do not list or read files in this attempt.
- Use focused_repair_file_context as your source for current file contents and dependency context.
- Prefer one write/edit per listed stub path, and do not return until every listed stub has real compile-safe implementation code.
- Do not edit dependency context files unless they also appear in boundary_surfaces.`
      : '';
    const repairPrompt = focusedRepairRecovery
      ? `

Focused repair mode is active.
- Fix the remediation below before doing anything else:
${inputData.remediation.map((item) => `  - ${item}`).join('\n')}
- Resolve every verification_failure_diagnostic before returning:
${verificationFailureDiagnostics.map((item) => `  - ${item.path}:${item.line}:${item.column} ${item.code} ${item.message}`).join('\n') || '  - none'}
- If unreplaced_preflight_stubs is non-empty, replace every listed stub before doing anything else:
${unreplacedStubs.map((item) => `  - ${item}`).join('\n') || '  - none'}
- Use focused_repair_file_context as your source for current file contents. It includes boundary files plus direct dependency files needed for type and domain contracts.
- Do not list or read files in this attempt.
- The tool choice is required; call mastra_workspace_edit_file or mastra_workspace_write_file now.
- Do not edit generated_surfaces directly; fix the source config, source code, or package scripts that generate them.
- Do not edit dependency context files unless they also appear in boundary_surfaces.
- Do not read spec.md, wrangler.toml, package.json, or package-lock.json unless that exact file is listed in boundary_surfaces.
- Do not add or import a package that is not already listed in existing_package_dependencies unless package_manifest_owned is true.`
      : '';
    const finalBuildPrompt = `${buildPrompt}${recoveryPrompt}${replaceStubsPrompt}${repairPrompt}`;
    const postWriteQuietTimeoutMs =
      writeFirstRecovery || replaceStubsRecovery || focusedRepairRecovery
        ? Math.min(deliveryAgentTimeouts.buildPostWriteQuiet, repairPostWriteQuietTimeoutMs)
        : deliveryAgentTimeouts.buildPostWriteQuiet;
    let buildResponse: unknown;
    try {
      buildResponse = await runWithDeliveryStageTimeout({
        repoPath: inputData.repoPath,
        mastra,
        stage,
        timeoutMs: deliveryAgentTimeouts.build,
        firstToolTimeoutMs: deliveryAgentTimeouts.buildNoTool,
        firstToolCheck: () => stageHasToolUse({ repoPath: inputData.repoPath, mastra, stage }),
        postWriteQuietTimeoutMs,
        latestWriteCheck: () => latestStageSuccessfulWriteTimestamp({ repoPath: inputData.repoPath, mastra, stage }),
        readBudgetBlockLimit: preWriteReadBudgetBlockLimit,
        readBudgetBlockCheck: () => stageReadBudgetBlockedToolCount({ repoPath: inputData.repoPath, mastra, stage }),
        operation: (abortSignal) =>
          agent.generate(
            finalBuildPrompt,
            {
              abortSignal,
              activeTools,
              toolChoice,
              maxSteps,
              toolCallConcurrency: 1,
              memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: task.owner }),
              requestContext: createDeliveryControlRequestContext(inputData.repoPath),
            },
          ),
      });
    } catch (error) {
      if (!(error instanceof DeliveryStageTimeoutError)) throw error;

      const missingSurfacesAfterTimeout = missingOwnedSurfacePaths(inputData.repoPath, task);
      const unreplacedStubsAfterTimeout = unreplacedPreflightStubPaths(inputData.repoPath, task);
      const stageHadToolUse = await stageHasToolUse({ repoPath: inputData.repoPath, mastra, stage });
      if (
        canSalvageTimedOutBuildAttempt({
          stageHadToolUse,
          missingSurfaces: missingSurfacesAfterTimeout,
          unreplacedStubs: unreplacedStubsAfterTimeout,
        })
      ) {
        await appendDeliveryEventState({
          repoPath: inputData.repoPath,
          mastra,
          event: {
            type: 'build_timeout_salvaged',
            stage,
            ok: true,
            task: task.id,
            attempt: attemptNumber,
            timeout_ms: error.timeoutMs,
            reason:
              'Build attempt timed out after file edits, but owned surfaces are present and preflight stubs are replaced; running workflow verification instead of marking stuck.',
          },
        });
        await startDeliveryStageState({
          repoPath: inputData.repoPath,
          stage,
          role,
          surfaces: sourceBoundarySurfaces.length ? sourceBoundarySurfaces : undefined,
          mastra,
        });
        buildResponse = {
          text: `Build attempt timed out after ${error.timeoutMs}ms after making file changes; workflow recovered by running verification against the edited boundary surfaces.`,
          finishReason: 'timeout-salvaged',
        };
      } else {
      const remediation = buildTimeoutRemediation({
        task,
        timeoutMs: error.timeoutMs,
        missingSurfaces: missingSurfacesAfterTimeout,
        repairRecovery: focusedRepairRecovery || verificationRecovery,
        noToolCall: error instanceof DeliveryNoToolCallTimeoutError,
        readBudgetExceeded: error instanceof DeliveryReadBudgetExceededError,
        priorRemediation: inputData.remediation,
      });
      if (attempt >= inputData.maxRetries) {
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: remediation.join(' | ').slice(0, 300),
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
          summary: `Build task ${task.id} timed out.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: remediation,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation,
        };
      }

      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'building',
        owner: role,
        note: `retry after timeout ${attemptNumber}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'reviewed' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} timed out and needs another implementation attempt.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: remediation,
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: undefined,
        attempt: attempt + 1,
        terminal: false,
        remediation,
      };
      }
    }
    const buildTracePath = await writeStageTraceArtifact({
      repoPath: inputData.repoPath,
      mastra,
      artifactType: `trace-build-${task.id}-a${attemptNumber}`,
      artifactPath: `.delivery/artifacts/traces/build-${task.id}-a${attemptNumber}.json`,
      trace: {
        artifact_type: 'agent-turn-trace',
        stage,
        role,
        task: task.id,
        attempt: attemptNumber,
        prompt: finalBuildPrompt,
        response: serializeAgentResponse(buildResponse),
        activeTools,
        toolChoice,
        retryMode,
      },
    });
    artifacts.push(buildTracePath);

    const verification = await runBuildVerification({
      repoPath: inputData.repoPath,
      mastra,
      stage,
      taskPlan,
      taskIndex: inputData.taskIndex,
    });
    const buildEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const note = synthesizeImplementationNote({
      repoPath: inputData.repoPath,
      stage,
      task,
      taskPlan,
      events: buildEvents,
      buildResponse,
      verification,
    });
    const notePath = `.delivery/artifacts/note-${task.id}.a${attemptNumber}.json`;
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: notePath,
      artifact: note,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: `note-${task.id}`,
      path: notePath,
      mastra,
    });
    artifacts.push(notePath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      reason: 'complete_stage',
      mastra,
    });

    const deliveryEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const deterministicResults = implementationDeterministicResults({
      repoPath: inputData.repoPath,
      stage,
      role,
      task,
      note,
      events: deliveryEvents,
      verification,
    });
    checks.push(...checkSummaries(deterministicResults, `${task.id}.a${attemptNumber}`));

    const deterministicRemediation = implementationDeterministicRemediation(deterministicResults);
    if (deterministicRemediation.length) {
      const enginePolicyMismatch = implementationEnginePolicyMismatch({
        repoPath: inputData.repoPath,
        stage,
        role,
        task,
        events: deliveryEvents,
      });
      const staleWorkspaceVerification = deterministicRemediation.filter((item) =>
        /\bSTALE_WORKSPACE_VERIFICATION\b/i.test(item),
      );
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'implementation_deterministic_blocker',
          stage,
          ok: false,
          task: task.id,
          attempt: attemptNumber,
          remediation: deterministicRemediation,
          engine_policy_mismatch: enginePolicyMismatch,
        },
      });

      if (staleWorkspaceVerification.length) {
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: staleWorkspaceVerification.join(' | ').slice(0, 300),
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
          summary: `Build task ${task.id} stopped because repo-wide verification failed outside the current task plan.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: staleWorkspaceVerification,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation: staleWorkspaceVerification,
        };
      }

      if (enginePolicyMismatch.length) {
        const remediation = [...enginePolicyMismatch, ...deterministicRemediation];
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: remediation.join(' | ').slice(0, 300),
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
          summary: `Build task ${task.id} stopped on a delivery engine policy mismatch.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: remediation,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation,
        };
      }

      if (attempt >= inputData.maxRetries) {
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: deterministicRemediation.join(' | ').slice(0, 300),
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
          summary: `Build task ${task.id} failed deterministic implementation gates.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: deterministicRemediation,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation: deterministicRemediation,
        };
      }

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'reviewed' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} needs another attempt after deterministic implementation gates.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: deterministicRemediation,
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: undefined,
        attempt: attempt + 1,
        terminal: false,
        remediation: deterministicRemediation,
      };
    }

    let implementationJudge: Awaited<ReturnType<typeof judgeDeliveryArtifact>>;
    try {
      implementationJudge = await judgeDeliveryArtifact({
        mastra,
        repoPath: inputData.repoPath,
        runId: inputData.runId,
        rubricName: 'implementation',
        subjectName: notePath,
        subject: {
          task,
          note,
          files: repoFileContents(inputData.repoPath, note.files_touched),
          task_plan: taskPlan,
        },
        deterministicResults,
        slug: `implementation-${task.id}-a${attemptNumber}`,
      });
    } catch (error) {
      if (!(error instanceof DeliveryStageTimeoutError)) throw error;

      const remediation = implementationJudgeTimeoutRemediation(task.id, attemptNumber, error.timeoutMs);
      if (attempt >= inputData.maxRetries) {
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: remediation.join(' | ').slice(0, 300),
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
          summary: `Build task ${task.id} judgment timed out.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: remediation,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation,
        };
      }

      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'building',
        owner: role,
        note: `retry after judge timeout ${attemptNumber}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'reviewed' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} judgment timed out and needs another bounded attempt.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: remediation,
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: undefined,
        attempt: attempt + 1,
        terminal: false,
        remediation,
      };
    }
    artifacts.push(implementationJudge.judgeOutputPath, implementationJudge.judgmentPath, implementationJudge.tracePath);
    judgments.push(implementationJudge.ref);

    if (
      implementationJudgmentCanComplete({
        judgment: implementationJudge.judgment,
        deterministicResults,
        note,
        task,
      })
    ) {
      const acceptedByFastPath = !implementationJudge.judgment.passed;
      if (acceptedByFastPath) {
        const check = {
          check: `non_actionable_implementation_judgment:${task.id}.a${attemptNumber}`,
          passed: true,
          reason: `Implementation judgment scored ${implementationJudge.judgment.overall} without failed gates, failed deterministic checks, or actionable remediation.`,
        };
        checks.push(check);
        await appendDeliveryEventState({
          repoPath: inputData.repoPath,
          mastra,
          event: {
            type: 'implementation_judgment_non_actionable',
            stage,
            ok: true,
            task: task.id,
            attempt: attemptNumber,
            overall: implementationJudge.judgment.overall,
            judgmentPath: implementationJudge.judgmentPath,
          },
        });
      }
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'complete',
        owner: role,
        note: acceptedByFastPath
          ? `accepted non-actionable judgment ${implementationJudge.judgment.overall}`
          : `judged ${implementationJudge.judgment.overall}`,
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
        summary: acceptedByFastPath
          ? `Build task ${task.id} completed with a non-actionable implementation score recorded for release-gate follow-up.`
          : `Build task ${task.id} completed.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: acceptedByFastPath
          ? ['Continue the delivery build loop; release gate should verify any missing acceptance checks.']
          : ['Continue the delivery build loop.'],
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: 'complete' as const,
        attempt,
        terminal: true,
        remediation: [],
      };
    }

    const remediation = implementationFindingSteps(task.id, implementationJudge.judgment, task);
    if (attempt >= inputData.maxRetries) {
      if (!judgeRepairAlreadyAttempted(inputData.remediation)) {
        const judgeRepairRemediation = implementationJudgeRepairRemediation(
          implementationJudge.judgmentPath,
          remediation,
        );
        return {
          repoPath: inputData.repoPath,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          reviewMode: inputData.reviewMode,
          taskPlan,
          releaseGate: inputData.releaseGate,
          status: 'reviewed' as const,
          runId: inputData.runId,
          summary: `Build task ${task.id} passed deterministic checks and needs one focused judge repair attempt.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: judgeRepairRemediation,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          taskId: task.id,
          taskStatus: undefined,
          attempt: attempt + 1,
          terminal: false,
          remediation: judgeRepairRemediation,
        };
      }

      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'stuck',
        owner: role,
        note: remediation.join(' | ').slice(0, 300) || 'implementation did not pass judgment',
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
        summary: `Build task ${task.id} did not pass implementation judgment.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: remediation,
        taskId: task.id,
        taskStatus: 'stuck' as const,
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        attempt,
        terminal: true,
        remediation,
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan,
      releaseGate: inputData.releaseGate,
      status: 'reviewed' as const,
      runId: inputData.runId,
      summary: `Build task ${task.id} needs another implementation attempt.`,
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: remediation,
      task,
      taskIndex: inputData.taskIndex,
      skipped: false,
      taskId: task.id,
      taskStatus: undefined,
      attempt: attempt + 1,
      terminal: false,
      remediation,
    };
  },
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

    const tester = requiredAgent(mastra, 'tester');
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

    const evidenceEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const gateResponse = await runWithDeliveryStageTimeout({
      repoPath: inputData.repoPath,
      mastra,
      stage,
      timeoutMs: deliveryAgentTimeouts.build,
      operation: (abortSignal) =>
        tester.generate(
          `Synthesize a release gate for pre-deployment from the evidence below.

Do not call tools. Do not claim evidence that is not listed here.
Use decision "pass" only when all critical areas are verified or not_applicable and blockers is empty.
Use decision "fail" when any critical area is missing, any required evidence command failed, or any acceptance-critical behavior is unproven.
For event_type "pre_deployment", tiers must be "passed" when supported by evidence or "not_required" with a reason when no tier-specific harness exists. Use "failed" only for an evidence command that actually failed.

Known task plan:
${JSON.stringify(inputData.taskPlan, null, 2)}

Known implementation judgment refs:
${JSON.stringify(judgments.slice(-12), null, 2)}

Delivery artifacts:
${JSON.stringify(artifacts.slice(-24), null, 2)}

Evidence artifact path: ${evidencePath}
Evidence:
${JSON.stringify(evidence, null, 2)}

Stage events:
${JSON.stringify(evidenceEvents.filter((event) => event.stage === stage).slice(-30), null, 2)}

${inputData.remediation.length ? `This is a bounce. Fix exactly these release-gate findings:\n${inputData.remediation.map((item) => `- ${item}`).join('\n')}\n` : ''}
Return a release-gate object with event_type "pre_deployment". Every critical area must be verified with cited evidence, missing and therefore blocking, or not_applicable with a reason. Fail closed on unproven critical behavior.`,
          {
            ...structuredNoToolOptions,
            abortSignal,
            memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: 'tester' }),
            requestContext: createDeliveryControlRequestContext(inputData.repoPath),
            structuredOutput: {
              schema: testerOutputSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only { "gate": <release-gate> }.',
            },
          },
        ),
    });

    let gate: ReleaseGate;
    try {
      gate = parseDeliveryStructuredOutput(testerOutputSchema, gateResponse, 'tester release gate').gate;
    } catch (error) {
      gate = releaseGateForInvalidTesterOutput(error);
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'structured_output_invalid',
          stage,
          role: 'tester',
          ok: false,
          artifact_type: 'release-gate',
          path: gatePath,
          error: compactDiagnostic(error, 900),
        },
      });
    }

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

    const gateJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      runId: inputData.runId,
      rubricName: 'release-gate',
      subjectName: gatePath,
      subject: {
        gate,
        evidence_events: deliveryEvents.filter((event) => event.stage === stage),
      },
      deterministicResults,
      slug: `release-gate-a${attemptNumber}`,
    });
    artifacts.push(gateJudge.judgeOutputPath, gateJudge.judgmentPath);
    judgments.push(gateJudge.ref);

    if (gateJudge.judgment.passed) {
      if (gate.decision !== 'pass') {
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
          nextSteps: gate.blockers.length ? gate.blockers : ['Fix release-gate blockers and rerun test stage.'],
          attempt,
          terminal: true,
          remediation: [],
        };
      }

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

    const remediation = gateJudge.judgment.remediation;
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
      status: 'stuck' as const,
      runId: inputData.runId,
      summary: 'Release gate did not pass judgment within retry budget.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: remediation.length ? remediation : ['Inspect release gate evidence and rerun tester stage.'],
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

const createDeploymentJudgmentStep = createStep({
  id: 'judge-deployment-report',
  description: 'Run deployment deterministic gates and rubric judgment, then finish the delivery run.',
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
    if (!inputData.releaseGate) throw new Error('release gate stage did not provide a gate for deployment judgment');
    if (!inputData.deploymentReport || !inputData.deploymentReportPath) {
      throw new Error('deployment report stage did not provide a deployment report for judgment');
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

    const deploymentJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      runId: inputData.runId,
      rubricName: 'deployment-report',
      subjectName: inputData.deploymentReportPath,
      subject: {
        report: inputData.deploymentReport,
        release_gate: inputData.releaseGate,
        evidence_events: deliveryEvents.filter((event) => event.stage === stage),
      },
      deterministicResults,
      slug: 'deployment-report',
    });
    artifacts.push(deploymentJudge.judgeOutputPath, deploymentJudge.judgmentPath);
    judgments.push(deploymentJudge.ref);

    const complete = inputData.deploymentReport.result === 'success' && deploymentJudge.judgment.passed;
    await finishRun(complete ? 'complete' : 'failed');

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      status: complete ? ('complete' as const) : ('failed' as const),
      runId: inputData.runId,
      summary: complete
        ? `Deployment complete: ${inputData.deploymentReport.environment} ${inputData.deploymentReport.revision}`
        : 'Deployment failed judgment or reported failure.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: complete
        ? deploymentReportSuccessNextSteps(inputData.deploymentReport, inputData.repoPath)
        : deploymentJudge.judgment.remediation,
    };
  },
});

export const deliveryDeploymentWorkflow = createWorkflow({
  id: 'delivery-deployment',
  description: 'Run local or approved production deployment, judge the deployment report, and finish the run.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(createDeploymentReportStep)
  .then(syncDeploymentReportStateStep)
  .then(createDeploymentJudgmentStep)
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
