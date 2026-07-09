import { createStep, createWorkflow } from '@mastra/core/workflows';
import { deliveryScaffoldStepScorers } from './scorers';
import { safePersistDeliveryStateWithMastra } from './observability';
import { deliveryWorkflowInputSchema } from './run-input';
import { markDeliveryRunFailedOnWorkflowError } from './workflow-support/errors';
import { syncDeliveryWorkflowState } from './workflow-support/state-sync';
import { annotateTaskPlanWithTypedMetadata } from './task-plan-metadata';
import {
  deliveryWorkflowStateSchema,
  planStageOutputSchema,
  workflowOutputSchema,
} from './workflow-schemas';
import { executeDeliveryScaffold } from './scaffold-workflow';
import { deliveryPlanningWorkflow } from './workflows/planning.workflow';
import { deliveryReviewWorkflow } from './workflows/review.workflow';
import { deliveryBuildWorkflow } from './workflows/build.workflow';
import { deliveryReleaseGateWorkflow } from './workflows/release-gate.workflow';
import { deliveryDeploymentWorkflow } from './workflows/deployment.workflow';

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
export { deliveryPlanningWorkflow } from './workflows/planning.workflow';
export { deliveryReviewWorkflow } from './workflows/review.workflow';
export { deliveryBuildTaskWorkflow } from './workflows/build-task.workflow';
export { deliveryBuildWorkflow } from './workflows/build.workflow';
export { deliveryReleaseGateWorkflow } from './workflows/release-gate.workflow';
export { deliveryDeploymentWorkflow } from './workflows/deployment.workflow';

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
