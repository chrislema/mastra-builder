import {
  implementationRepairWorkspaceTools,
  implementationWorkspaceTools,
  implementationWriteOnlyWorkspaceTools,
  deliveryAgentTimeouts,
  repairPostWriteQuietTimeoutMs,
} from '../agent-runtime/options';
import { remediationHasVerificationFailure } from '../implementation-retry-policy';
import { acceptanceContractId } from '../planning/acceptance-contract-preservation';
import { taskVerificationAcceptanceContractCriteria } from '../planning/cloudflare-worker-contracts-policy';
import { repoFileContents } from '../repo-files';
import { taskPacketRailsForTask } from '../task-packet-rails';
import { packageDependencyNames } from '../worker-hygiene';
import type { DeliveryWorkflowState, SourcePolicy, Task, TaskPlan } from '../workflow-schemas';
import {
  profileKindContractGaps,
  profileKindTaskPacketPolicyForTask,
} from './deterministic-gates';
import {
  directDependencySurfacePaths,
  focusedRepairContextPaths,
} from './task-packet';
import {
  missingOwnedSurfacePaths,
  taskOwnsPackageManifest,
  unreplacedPreflightStubPaths,
  workerConfigHygieneGaps,
  workerConfigTaskPacketPolicyForTask,
  workerPackageScaffoldGaps,
  workersAiBindingGaps,
} from './task-boundaries';
import {
  implementationFailureClass,
  implementationRetryMode,
  implementationToolChoiceForRetryMode,
  typeScriptDiagnosticsFromRemediation,
} from './retry-runtime';

export function buildImplementationAttemptPrompt({
  repoPath,
  taskPlan,
  task,
  scaffoldManifest,
  scaffoldManifestSummary,
  sourcePolicy,
  maxRetries,
  remediation,
  sourceBoundarySurfaces,
  generatedSurfaces,
  preflightCreatedSurfaces,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  task: Task;
  scaffoldManifest?: DeliveryWorkflowState['scaffoldManifest'];
  scaffoldManifestSummary: unknown;
  sourcePolicy?: SourcePolicy;
  maxRetries: number;
  remediation: string[];
  sourceBoundarySurfaces: string[];
  generatedSurfaces: string[];
  preflightCreatedSurfaces: string[];
}) {
  const missingSurfaces = missingOwnedSurfacePaths(repoPath, task);
  const unreplacedStubs = unreplacedPreflightStubPaths(repoPath, task);
  const verificationRecovery = remediationHasVerificationFailure(remediation);
  const retryMode = implementationRetryMode({
    remediation,
    missingSurfaces,
    unreplacedStubs,
  });
  const failureClass = implementationFailureClass(remediation);
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
  const existingPackageDependencies = packageDependencyNames(repoPath);
  const dependencySurfaces = directDependencySurfacePaths(taskPlan, task);
  const verificationFailureDiagnostics = typeScriptDiagnosticsFromRemediation(remediation);
  const acceptanceContracts = taskVerificationAcceptanceContractCriteria(task).map((criterion, index) => ({
    id: acceptanceContractId(task, index, criterion),
    criterion,
    status: 'required' as const,
  }));
  const taskRails = taskPacketRailsForTask({
    taskPlan,
    task,
    scaffoldManifest,
    boundarySurfaces: sourceBoundarySurfaces,
    generatedSurfaces,
    directDependencySurfaces: dependencySurfaces,
    sourceContracts: task.source_acceptance_criteria,
    maxAttempts: maxRetries + 1,
    maxToolStepsPerAttempt: maxSteps,
  });
  const focusedRepairFileContext = replaceStubsRecovery || focusedRepairRecovery
    ? repoFileContents(repoPath, focusedRepairContextPaths(taskPlan, task, sourceBoundarySurfaces))
    : [];
  const taskPacket = {
    scope: taskPlan.scope,
    task,
    task_rails: taskRails,
    acceptance_contracts: acceptanceContracts,
    technology_decisions: taskPlan.technology_decisions,
    open_decisions: taskPlan.open_decisions,
    risks: taskPlan.risks,
    remediation,
    scaffold_manifest: scaffoldManifestSummary,
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
    profile_kind_policy: profileKindTaskPacketPolicyForTask(task, sourcePolicy),
    platform_policy_findings: [
      ...workersAiBindingGaps(repoPath, task),
      ...workerConfigHygieneGaps(repoPath, task),
      ...workerPackageScaffoldGaps(repoPath, task),
    ],
    domain_contract_findings: profileKindContractGaps(repoPath, task),
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
- For Worker scaffolds, use the deterministic delivery-scaffold package versions rather than "latest"; scripts.dev is "wrangler dev --env staging", and scripts.deploy is "wrangler deploy --env production". For TypeScript Worker source, add scripts.generate-types as "wrangler types", scripts.typecheck as "npm run generate-types && tsc --noEmit", @types/node, and tsconfig.json. Do not add @cloudflare/workers-types; Wrangler generates Worker binding/runtime types from config.
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
${remediation.map((item) => `  - ${item}`).join('\n')}
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

  return {
    missingSurfaces,
    unreplacedStubs,
    verificationRecovery,
    retryMode,
    failureClass,
    writeFirstRecovery,
    replaceStubsRecovery,
    focusedRepairRecovery,
    activeTools,
    toolChoice,
    maxSteps,
    verificationFailureDiagnostics,
    finalBuildPrompt: `${buildPrompt}${recoveryPrompt}${replaceStubsPrompt}${repairPrompt}`,
    postWriteQuietTimeoutMs:
      writeFirstRecovery || replaceStubsRecovery || focusedRepairRecovery
        ? Math.min(deliveryAgentTimeouts.buildPostWriteQuiet, repairPostWriteQuietTimeoutMs)
        : deliveryAgentTimeouts.buildPostWriteQuiet,
  };
}
