import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
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
import { isBehaviorLikeAcceptanceCriterion } from './acceptance-evidence-policy';
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
import {
  responseText,
  serializeAgentResponse,
  writeStageTraceArtifact,
} from './agent-runtime/trace-artifacts';
import { compactDiagnostic } from './agent-runtime/diagnostics';
import {
  judgeDeliveryArtifact,
  judgeProviderErrorDetails,
  judgeUnavailableOutputForRubric,
  judgeUnavailableRemediation,
} from './agent-runtime/judge-runtime';
import {
  deliveryAgentTimeouts,
  implementationRepairWorkspaceTools,
  implementationWorkspaceTools,
  implementationWriteOnlyWorkspaceTools,
  preWriteReadBudgetBlockLimit,
  repairPostWriteQuietTimeoutMs,
  requiredAgent,
  structuredNoToolOptions,
} from './agent-runtime/options';
import {
  DeliveryNoToolCallTimeoutError,
  DeliveryReadBudgetExceededError,
  DeliveryStageTimeoutError,
  latestStageSuccessfulWriteTimestamp,
  latestSuccessfulWorkspaceWriteEventTimestamp,
  readBudgetBlockedToolCount,
  runWithDeliveryStageTimeout,
  stageHasToolUse,
  stageReadBudgetBlockedToolCount,
} from './agent-runtime/stage-timeout';
import {
  normalizeReadoutSafeAdapterAmbiguities,
  openDecisionHygiene,
  shouldSuspendForPlannerQuestions,
} from './planning/readout-policy';
import {
  acceptanceContractId,
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
import { taskVerificationAcceptanceContractCriteria } from './planning/cloudflare-worker-contracts-policy';
import { normalizeTaskPlanForDelivery } from './planning/task-plan-normalizer';
import { parsePlannerRevisionResponse, planGateRevisionRemediation } from './planning/task-plan-revision';
import {
  legacyProjectScaffoldHygiene,
  projectScaffoldHygiene,
} from './planning/scaffold-policy';
import {
  compileSafeStubForSurface,
  createMissingOwnedSurfaceStubs,
  currentWorkerCompatibilityDate,
  generatedTaskSurfacePaths,
  missingInstalledPackageNames,
  missingOwnedSurfacePaths,
  taskBoundaryAllowsRepairPath,
  taskBoundarySurfaces,
  taskOwnsPackageManifest,
  taskSourceBoundarySurfaces,
  unreplacedPreflightStubPaths,
  workerConfigHygieneGaps,
  workerConfigTaskPacketPolicy,
  workerConfigTaskPacketPolicyForTask,
  workerEnvBindingAlignmentGaps,
  workerPackageScaffoldGaps,
  workersAiBindingGaps,
  wranglerConfigHasWorkersAiBinding,
} from './implementation/task-boundaries';
import {
  directDependencySurfacePaths,
  focusedRepairContextPaths,
} from './implementation/task-packet';
import {
  lifecycleStatusSchemaGaps,
  profileKindContractGaps,
  profileKindTaskPacketPolicy,
  profileKindTaskPacketPolicyForTask,
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
  implementationFindingSteps,
  implementationJudgmentCanComplete,
  implementationWeakDimensionRemediation,
  shouldProceedAfterNonActionableImplementationJudgment,
} from './implementation/judgment-policy';
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
  acceptanceContractsForCriteria,
  verificationWithAcceptanceContractGaps,
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
import { synthesizeReleaseGateFromEvidence } from './release-gate-synthesis';
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
import { concreteOwnedSurfacePath } from './task-plan-surface-policy';
import { topoOrderTasks } from './task-plan-dependencies';
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
  packageDependencyNames,
  workerConfigPath as releaseGateWorkerConfigPath,
} from './worker-hygiene';

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

const execFileAsync = promisify(execFile);

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
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  return buildReleaseGateRuntimeProbePlan({
    command: releaseGateWorkerDevCommand(repoPath),
    adminToken,
    publicAssetTextMarker: (file) => releaseGateStaticAssetTextMarker(repoPath, file),
    healthRoutes: releaseGateHealthRoutes(repoPath),
    hasRoute: (route) => releaseGateRepoHasRoute(repoPath, route),
    latestTranscriptRequired: sourcePolicy.latestTranscriptRequired,
    shortLinkLifecycleRequired: sourcePolicy.shortLinkLifecycleRequired,
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

function deploymentGateFailureNextSteps({
  report,
  failedChecks,
}: {
  report: DeploymentReport;
  failedChecks: DeterministicGateResult[];
}) {
  const deterministicRemediation = failedChecks.map((check) => {
    const id = check.id ?? check.check ?? 'deployment_gate';
    return `Fix deterministic deployment gate ${id}: ${check.reason}`;
  });
  const reportRemediation = report.issues.map((issue) => `${issue.description}: ${issue.action}`);

  return [
    ...deterministicRemediation,
    ...reportRemediation,
    ...(report.result === 'failure' && !reportRemediation.length
      ? [`Deployment report result was failure; next action is ${report.next_action}.`]
      : []),
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
    const acceptanceContracts = taskVerificationAcceptanceContractCriteria(task).map((criterion, index) => ({
      id: acceptanceContractId(task, index, criterion),
      criterion,
      status: 'required' as const,
    }));
    const taskRails = taskPacketRailsForTask({
      taskPlan,
      task,
      scaffoldManifest: inputData.scaffoldManifest,
      boundarySurfaces: sourceBoundarySurfaces,
      generatedSurfaces,
      directDependencySurfaces: dependencySurfaces,
      sourceContracts: task.source_acceptance_criteria,
      maxAttempts: inputData.maxRetries + 1,
      maxToolStepsPerAttempt: maxSteps,
    });
    const focusedRepairFileContext = replaceStubsRecovery || focusedRepairRecovery
      ? repoFileContents(inputData.repoPath, focusedRepairContextPaths(taskPlan, task, sourceBoundarySurfaces))
      : [];
    const taskPacket = {
      scope: taskPlan.scope,
      task,
      task_rails: taskRails,
      acceptance_contracts: acceptanceContracts,
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
- task_packet.task_rails is binding policy: edit only task_rails.allowed_surfaces, treat task_rails.direct_dependency_surfaces as read-only context, and do not edit task_rails.scaffold_owned_readonly_surfaces.
- task_rails.verification_command_class is the verification class this task is preparing for; do not change runtime config to escape it.
- Stay within task_rails.model_budget. If the task cannot be completed inside the allowed surfaces, return a blocker instead of expanding scope.
- Treat task_packet.acceptance_contracts as mandatory contracts. Do not return until every listed AC has concrete code evidence in the task's boundary surfaces, or until you surface a real blocker.
- Do not replace a product acceptance contract with a weaker "slice completed" claim. If the contract names behavior, implement the behavior or leave the task incomplete.
- Touch only the boundary surfaces in the task packet unless a dependency blocks the task; task_rails.allowed_surfaces is the normalized edit list.
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
