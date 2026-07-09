import { isBehaviorLikeAcceptanceCriterion } from '../acceptance-evidence-policy';
import {
  acceptanceContractsForCriteria,
  verificationWithAcceptanceContractGaps,
} from '../acceptance-contracts';
import { compactDiagnostic } from '../agent-runtime/diagnostics';
import { responseText } from '../agent-runtime/trace-artifacts';
import {
  noBcryptWeakHash,
  runDeterministicCheck,
  type DeliveryEvent,
} from '../checks';
import type { DeterministicGateResult } from '../judgment';
import { acceptanceContractId } from '../planning/acceptance-contract-preservation';
import { taskVerificationAcceptanceContractCriteria } from '../planning/cloudflare-worker-contracts-policy';
import { repoFileContents } from '../repo-files';
import type { ImplementationNote, Task, TaskPlan } from '../workflow-schemas';
import {
  lifecycleStatusSchemaGaps,
  profileKindContractGaps,
  routeMiddlewareBypassGaps,
  workflowEntrypointImportGaps,
  workflowStepIntegrationGaps,
} from './deterministic-gates';
import { implementationFilesTouched } from './reusable-artifacts';
import {
  missingOwnedSurfacePaths,
  unreplacedPreflightStubPaths,
  workerConfigHygieneGaps,
  workerPackageScaffoldGaps,
  workersAiBindingGaps,
} from './task-boundaries';

export function acceptanceContractsForTask({
  repoPath,
  task,
  taskPlan,
  verification,
}: {
  repoPath?: string;
  task: Task;
  taskPlan?: TaskPlan;
  verification: { performed: string[]; missing: string[] };
}) {
  return acceptanceContractsForCriteria({
    repoPath,
    task,
    verification,
    criteria: taskVerificationAcceptanceContractCriteria(task, taskPlan),
    contractIdForCriterion: (criterion, index) => acceptanceContractId(task, index, criterion),
  });
}

export function verificationWithAcceptanceGaps({
  repoPath,
  task,
  taskPlan,
  verification,
}: {
  repoPath?: string;
  task: Task;
  taskPlan?: TaskPlan;
  verification: { performed: string[]; missing: string[] };
}) {
  return verificationWithAcceptanceContractGaps({
    repoPath,
    task,
    verification,
    criteria: taskVerificationAcceptanceContractCriteria(task, taskPlan),
    missingOwnedSurfacePaths: repoPath ? missingOwnedSurfacePaths(repoPath, task) : [],
  });
}

export function synthesizeImplementationNote({
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
  const honestVerification = verificationWithAcceptanceGaps({ repoPath, task, taskPlan, verification });
  const acceptanceContracts = acceptanceContractsForTask({ repoPath, task, taskPlan, verification: honestVerification });

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
